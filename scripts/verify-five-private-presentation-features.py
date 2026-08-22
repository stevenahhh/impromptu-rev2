#!/usr/bin/env python3
"""Run the Core-5 browser acceptance runner against the local private topology.

Every long-lived service is launched in its own process group with Popen rather
than a shell background job. Readiness consumes each process's stdout stream,
so it waits for the named readiness event without sleeps or health polling.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / ".omo/evidence/task-25"
RESULT = EVIDENCE / "core5-e2e.json"
AUDIO = EVIDENCE / "fake-korean.wav"


def dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


def wait_for_line(process: subprocess.Popen[str], expected: str) -> None:
    if process.stdout is None:
        raise RuntimeError(f"{process.args!r} has no stdout")
    while True:
        line = process.stdout.readline()
        if line:
            print(line, end="", file=sys.stderr)
            if expected in line:
                return
            continue
        code = process.poll()
        if code is not None:
            raise RuntimeError(f"{process.args!r} exited {code} before {expected!r}")


def drain(process: subprocess.Popen[str], log: Path, collected: list[str]) -> threading.Thread:
    """Keeps consuming service stdout so no service ever blocks on a full pipe."""

    def pump() -> None:
        assert process.stdout is not None
        with log.open("a", encoding="utf-8") as sink:
            for line in process.stdout:
                sink.write(line)
                sink.flush()
                collected.append(line)

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    return thread


def start(
    command: list[str], cwd: Path, env: dict[str, str], ready: str, name: str
) -> tuple[subprocess.Popen[str], list[str]]:
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    wait_for_line(process, ready)
    log = EVIDENCE / f"{name}.log"
    log.write_text("", encoding="utf-8")
    collected: list[str] = []
    drain(process, log, collected)
    return process, collected


def recommendation_stages(lines: list[str]) -> list[dict[str, object]]:
    """Extracts the private-backend structured per-stage model latencies."""
    stages: list[dict[str, object]] = []
    for line in lines:
        stripped = line.strip()
        if "/internal/recommendation/" not in stripped:
            continue
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        path = event.get("path")
        if not isinstance(path, str) or not path.startswith("/internal/recommendation/"):
            continue
        stages.append(
            {
                "stage": path.rsplit("/", 1)[1],
                "outcome": event.get("outcome"),
                "durationMs": event.get("durationMs"),
                "timestampMs": event.get("timestampMs"),
            }
        )
    return stages


def deterministic_mismatches(lines: list[str]) -> list[dict[str, object]]:
    """Extracts the deterministic-gate rejections with their exact category and value token.

    The pipeline emits one structured line per rejected fact as
    path=/internal/recommendation/deterministic with outcome "CATEGORY:value", so a
    DETERMINISTIC_MISMATCH abstain can be attributed without guessing from prose.
    """
    mismatches: list[dict[str, object]] = []
    for line in lines:
        stripped = line.strip()
        if "/internal/recommendation/deterministic" not in stripped:
            continue
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if event.get("path") != "/internal/recommendation/deterministic":
            continue
        outcome = event.get("outcome")
        category, _, value = str(outcome).partition(":")
        mismatches.append(
            {
                "category": category or None,
                "value": value or None,
                "timestampMs": event.get("timestampMs"),
            }
        )
    return mismatches


def recommendation_requests(lines: list[str]) -> list[dict[str, object]]:
    """Extracts the top-level /v1/recommendations outcomes with their wall-clock latency."""
    requests: list[dict[str, object]] = []
    for line in lines:
        stripped = line.strip()
        if '"path":"/v1/recommendations"' not in stripped and '"path": "/v1/recommendations"' not in stripped:
            continue
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if event.get("path") != "/v1/recommendations":
            continue
        requests.append(
            {
                "outcome": event.get("outcome"),
                "durationMs": event.get("durationMs"),
                "timestampMs": event.get("timestampMs"),
            }
        )
    return requests


def stage_summary(stages: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    """Summarizes per-stage model latency so budget overruns are attributable without eyeballing."""
    summary: dict[str, dict[str, object]] = {}
    by_stage: dict[str, list[int]] = {}
    for stage in stages:
        duration = stage.get("durationMs")
        name = str(stage.get("stage"))
        if isinstance(duration, (int, float)):
            by_stage.setdefault(name, []).append(int(duration))
    for name in sorted(by_stage):
        values = sorted(by_stage[name])
        summary[name] = {
            "n": len(values),
            "min": values[0],
            "median": values[len(values) // 2] if len(values) % 2 else (values[len(values) // 2 - 1] + values[len(values) // 2]) // 2,
            "max": values[-1],
        }
    return summary


def stop(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=15)


def available_port() -> int:
    """Picks an ephemeral port free on both wildcard stacks.

    Binding only 127.0.0.1 misses a port held by an IPv6 wildcard listener, which
    then makes service startup collide with an unrelated dev-stack process.
    """
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as v4:
            v4.bind(("", 0))
            port = int(v4.getsockname()[1])
        try:
            with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as v6:
                v6.bind(("::", port))
        except OSError:
            continue
        return port


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    private_port, projection_port, console_port, stage_port = (available_port() for _ in range(4))
    # Coordinator and gateway state live in PostgreSQL keyed by these strings, so each run gets a
    # unique key: a fixed key restored every previous run's presentations and grew the persisted
    # snapshot without bound (the same pollution class that broke the WP5 command-latency SLA).
    # The runner deletes this run's own rows in its finally block.
    state_nonce = uuid.uuid4().hex[:16]
    private_state_key = f"five-features-{state_nonce}-private"
    projection_state_key = f"five-features-{state_nonce}-projection"
    console_origin = f"http://localhost:{console_port}"
    stage_origin = f"http://localhost:{stage_port}"
    private_origin = f"http://127.0.0.1:{private_port}"
    projection_origin = f"http://127.0.0.1:{projection_port}"
    if shutil.which("say") is None or shutil.which("ffmpeg") is None:
        raise RuntimeError("fake-device capture requires macOS say and ffmpeg")
    # The fixture is deterministic text spoken through Chromium's fake microphone;
    # the Console still records browser-produced audio/webm;codecs=opus.
    aiff = AUDIO.with_suffix(".aiff")
    subprocess.run(["say", "-v", "Yuna", "-o", str(aiff), "형식 중립 근거 자료 이천이십육"], check=True)
    subprocess.run(["ffmpeg", "-y", "-i", str(aiff), "-ar", "48000", "-ac", "1", str(AUDIO)], check=True, capture_output=True)
    aiff.unlink(missing_ok=True)

    env = os.environ.copy()
    env.update(dotenv(ROOT / ".env.local"))
    env["CHAT_MODEL_API_KEY"] = env["OPENCODE_ZEN_API_KEY"]
    # Model slots follow the shipped configuration instead of a copy that can drift from it.
    shipped = dotenv(ROOT / ".env.example")
    models = {key: shipped[key] for key in ("RERANK_MODEL", "LLM_MODEL", "VERIFIER_MODEL")}
    env.update(
        {
            "CONSOLE_ORIGIN": console_origin,
            "CONTROLLER_ACCOUNT_ID": "account_local_demo",
            "CONTROLLER_USERNAME": "localdemo",
            "CONTROLLER_PASSWORD": "demo-2026-password",
            "DECK_ARTIFACT_ROOT": "/tmp",
            "DECK_STAGING_ROOT": "/tmp",
            "FFMPEG_BINARY_PATH": "/opt/homebrew/bin/ffmpeg",
            "WHISPER_CPP_BINARY_PATH": "/opt/homebrew/bin/whisper-cli",
            "WHISPER_CPP_MODEL_PATH": "/Users/gahn/.cache/whisper.cpp/ggml-small-q5_1.bin",
            "CHAT_MODEL_BASE_URL": "https://opencode.ai/zen/go/v1",
            "EMBEDDING_MODEL_API_KEY": "local-embedding-token",
            "EMBEDDING_MODEL_BASE_URL": "https://127.0.0.1:8443/v1",
            "EMBEDDING_MODEL": "embeddinggemma",
            "NODE_EXTRA_CA_CERTS": "/Users/gahn/Library/Application Support/mkcert/rootCA.pem",
            **models,
            # E2E uses the CI role; private_app lacks prepared_evidence_state privileges.
            "PRIVATE_DATABASE_URL": "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_private",
            "PRIVATE_BACKEND_PORT": str(private_port),
            "PRIVATE_PREPARED_EVIDENCE_STATE_KEY": private_state_key,
            "PROJECTION_GATEWAY_ORIGIN": projection_origin,
            "PROJECTION_GATEWAY_PORT": str(projection_port),
            "PROJECTION_DATABASE_URL": "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_projection",
            "PROJECTION_GATEWAY_STATE_KEY": projection_state_key,
            "FIVE_FEATURES_PRIVATE_STATE_KEY": private_state_key,
            "FIVE_FEATURES_PROJECTION_STATE_KEY": projection_state_key,
            "PRIVATE_BACKEND_ORIGIN": private_origin,
            "STAGE_ORIGIN": stage_origin,
            "SERVICE_AUTH_TOKEN": "five-features-acceptance-token",
            "CONSOLE_PRIVATE_API_ORIGIN": private_origin,
            "FIVE_FEATURES_CONSOLE_ORIGIN": console_origin,
            "FIVE_FEATURES_PRIVATE_ORIGIN": private_origin,
            "FIVE_FEATURES_RESULT_PATH": str(RESULT),
            "FIVE_FEATURES_AUDIO_WAV": str(AUDIO),
        }
    )
    processes: list[subprocess.Popen[str]] = []
    try:
        gateway, _ = start(["bun", "run", "dev"], ROOT / "services/projection-gateway", env, "projection-gateway listening", "projection-gateway")
        processes.append(gateway)
        private, private_lines = start(["bun", "run", "dev"], ROOT / "services/private-backend", env, "private-backend listening", "private-backend")
        processes.append(private)
        console, _ = start(["bun", "run", "dev", "--", "--port", str(console_port)], ROOT / "apps/console", env, "Ready", "console")
        processes.append(console)
        stage, _ = start(["bun", "run", "dev", "--", "--port", str(stage_port)], ROOT / "apps/stage", env, "Local", "stage")
        processes.append(stage)
        runner = subprocess.run(
            ["bun", "run", "tests/e2e/five-features.runner.ts"], cwd=ROOT, env=env, text=True, capture_output=True
        )
        (EVIDENCE / "runner.stdout.log").write_text(runner.stdout, encoding="utf-8")
        (EVIDENCE / "runner.stderr.log").write_text(runner.stderr, encoding="utf-8")
        if runner.stdout:
            print(runner.stdout, end="")
        if runner.stderr:
            print(runner.stderr, end="", file=sys.stderr)
        if RESULT.exists():
            result = json.loads(RESULT.read_text(encoding="utf-8"))
            result["models"] = models
            result["recommendationStageLatencyMs"] = recommendation_stages(private_lines)
            result["stageLatencySummaryMs"] = stage_summary(result["recommendationStageLatencyMs"])
            result["recommendationRequests"] = recommendation_requests(private_lines)
            result["deterministicMismatches"] = deterministic_mismatches(private_lines)
            RESULT.write_text(f"{json.dumps(result, indent=2, ensure_ascii=False)}\n", encoding="utf-8")
        return runner.returncode
    finally:
        for process in reversed(processes):
            stop(process)


if __name__ == "__main__":
    raise SystemExit(main())
