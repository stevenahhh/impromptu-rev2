#!/usr/bin/env python3
"""Measure the Core-5 positive recommendation path against the local private topology.

Boots projection-gateway + private-backend on ephemeral ports (never the developer
stack's 4173/4174), signs in over HTTP, uploads one deck fixture, then issues N
sequential /v1/recommendations calls with the exact acceptance query. Per-request
model stage latencies are read from the backend's structured stdout, so no stage is
inferred. Results are written as JSON for the evidence trail.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import statistics
import subprocess
import sys
import threading
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / ".omo/evidence/task-29/bench"
QUERY = "형식 중립 근거 자료 2026"


def dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


def available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class Service:
    def __init__(self, name: str, command: list[str], cwd: Path, env: dict[str, str], ready: str):
        self.name = name
        self.lines: list[str] = []
        self.stages: list[dict[str, object]] = []
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        assert self.process.stdout is not None
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError(f"{name} exited {self.process.poll()} before {ready!r}")
            print(f"[{name}] {line}", end="", file=sys.stderr)
            self._record(line)
            if ready in line:
                break
        self.thread = threading.Thread(target=self._drain, daemon=True)
        self.thread.start()

    def _record(self, line: str) -> None:
        self.lines.append(line)
        stripped = line.strip()
        if not stripped.startswith("{"):
            return
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            return
        path = event.get("path")
        if isinstance(path, str) and path.startswith("/internal/recommendation/"):
            self.stages.append(
                {
                    "stage": path.rsplit("/", 1)[-1],
                    "latencyMs": event.get("durationMs"),
                    "outcome": event.get("outcome"),
                }
            )

    def _drain(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            print(f"[{self.name}] {line}", end="", file=sys.stderr)
            self._record(line)

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=20)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=20)


class Client:
    def __init__(self, origin: str, console_origin: str):
        self.origin = origin
        self.console_origin = console_origin
        self.cookie = ""
        self.csrf = ""

    def _open(self, request: urllib.request.Request) -> tuple[int, bytes, object]:
        request.add_header("origin", self.console_origin)
        request.add_header("referer", f"{self.console_origin}/")
        if self.cookie:
            request.add_header("cookie", self.cookie)
        if self.csrf and request.get_method() != "GET":
            request.add_header("x-csrf-token", self.csrf)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:  # noqa: PERF203 - explicit status surface
            return error.code, error.read(), error.headers

    def sign_in(self, username: str, password: str) -> None:
        body = json.dumps({"username": username, "password": password}).encode()
        request = urllib.request.Request(
            f"{self.origin}/v1/account-sessions",
            data=body,
            method="POST",
            headers={"content-type": "application/json"},
        )
        status, payload, headers = self._open(request)
        if status != 201:
            raise RuntimeError(f"sign-in returned {status}: {payload!r}")
        cookies = headers.get_all("set-cookie") or []
        self.cookie = "; ".join(value.split(";", 1)[0] for value in cookies)
        self.csrf = json.loads(payload)["csrfToken"]

    def upload(self, fixture: Path) -> dict[str, object]:
        boundary = f"----bench{uuid.uuid4().hex}"
        mime = (
            "application/pdf"
            if fixture.suffix == ".pdf"
            else "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        )
        head = (
            f"--{boundary}\r\n"
            f'content-disposition: form-data; name="file"; filename="{fixture.name}"\r\n'
            f"content-type: {mime}\r\n\r\n"
        ).encode()
        body = head + fixture.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        request = urllib.request.Request(
            f"{self.origin}/v1/deck-uploads",
            data=body,
            method="POST",
            headers={"content-type": f"multipart/form-data; boundary={boundary}"},
        )
        status, payload, _ = self._open(request)
        if status != 201:
            raise RuntimeError(f"upload returned {status}: {payload!r}")
        return json.loads(payload)

    def recommend(self, deck_version: str, manifest_hash: str) -> dict[str, object]:
        body = json.dumps(
            {
                "query": QUERY,
                "deckVersion": deck_version,
                "manifestHash": manifest_hash,
                "maxResults": 3,
            }
        ).encode()
        request = urllib.request.Request(
            f"{self.origin}/v1/recommendations",
            data=body,
            method="POST",
            headers={"content-type": "application/json"},
        )
        status, payload, _ = self._open(request)
        if status != 200:
            raise RuntimeError(f"recommendation returned {status}: {payload!r}")
        return json.loads(payload)


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


def service_env(
    *,
    private_port: int,
    projection_port: int,
    console_origin: str,
    rerank: str,
    llm: str,
    verifier: str,
    suffix: str,
) -> dict[str, str]:
    """Acceptance-identical environment with only the three model slots parameterised."""
    private_origin = f"http://127.0.0.1:{private_port}"
    projection_origin = f"http://127.0.0.1:{projection_port}"
    env = os.environ.copy()
    env.update(dotenv(ROOT / ".env.local"))
    env["CHAT_MODEL_API_KEY"] = env["OPENCODE_ZEN_API_KEY"]
    env.update(
        {
            "CONSOLE_ORIGIN": console_origin,
            "CONTROLLER_ACCOUNT_ID": "account_local_demo",
            "CONTROLLER_USERNAME": "localdemo",
            "CONTROLLER_PASSWORD": "demo-2026-password",
            "DECK_ARTIFACT_ROOT": "/tmp",
            "DECK_STAGING_ROOT": "/tmp",
            "FFMPEG_BINARY_PATH": "/opt/homebrew/bin/ffmpeg",
            "CHAT_MODEL_BASE_URL": "https://opencode.ai/zen/go/v1",
            "EMBEDDING_MODEL_API_KEY": "local-embedding-token",
            "EMBEDDING_MODEL_BASE_URL": "https://127.0.0.1:8443/v1",
            "EMBEDDING_MODEL": "embeddinggemma",
            "NODE_EXTRA_CA_CERTS": "/Users/gahn/Library/Application Support/mkcert/rootCA.pem",
            "RERANK_MODEL": rerank,
            "LLM_MODEL": llm,
            "VERIFIER_MODEL": verifier,
            "PRIVATE_DATABASE_URL": "postgresql://private_app@127.0.0.1:5432/impromptu_private",
            "PRIVATE_BACKEND_PORT": str(private_port),
            "PRIVATE_PREPARED_EVIDENCE_STATE_KEY": f"bench-private-{suffix}",
            "PROJECTION_GATEWAY_ORIGIN": projection_origin,
            "PROJECTION_GATEWAY_PORT": str(projection_port),
            "PROJECTION_DATABASE_URL": "postgresql://projection_app@127.0.0.1:5432/impromptu_projection",
            "PROJECTION_GATEWAY_STATE_KEY": f"bench-projection-{suffix}",
            "PRIVATE_BACKEND_ORIGIN": private_origin,
            "STAGE_ORIGIN": console_origin,
            "SERVICE_AUTH_TOKEN": f"bench-token-{suffix}",
            "CONSOLE_PRIVATE_API_ORIGIN": private_origin,
        }
    )
    env.pop("WHISPER_CPP_BINARY_PATH", None)
    env.pop("WHISPER_CPP_MODEL_PATH", None)
    return env


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--rerank", default="deepseek-v4-flash")
    parser.add_argument("--llm", default="deepseek-v4-flash")
    parser.add_argument("--verifier", default="deepseek-v4-flash")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--fixture", default="korean-text-layer.pdf")
    arguments = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    private_port, projection_port, console_port = (available_port() for _ in range(3))
    console_origin = f"http://localhost:{console_port}"
    private_origin = f"http://127.0.0.1:{private_port}"
    projection_origin = f"http://127.0.0.1:{projection_port}"
    state_suffix = uuid.uuid4().hex[:8]

    env = service_env(
        private_port=private_port,
        projection_port=projection_port,
        console_origin=console_origin,
        rerank=arguments.rerank,
        llm=arguments.llm,
        verifier=arguments.verifier,
        suffix=state_suffix,
    )

    services: list[Service] = []
    try:
        services.append(
            Service(
                "projection-gateway",
                ["bun", "run", "dev"],
                ROOT / "services/projection-gateway",
                env,
                "projection-gateway listening",
            )
        )
        backend = Service(
            "private-backend",
            ["bun", "run", "dev"],
            ROOT / "services/private-backend",
            env,
            "private-backend listening",
        )
        services.append(backend)

        client = Client(private_origin, console_origin)
        client.sign_in("localdemo", "demo-2026-password")
        receipt = client.upload(ROOT / "tests/fixtures/format-neutral-decks" / arguments.fixture)
        deck_version = str(receipt["deckVersion"])
        manifest_hash = str(receipt["privateDeck"]["manifestHash"])  # type: ignore[index]

        runs: list[dict[str, object]] = []
        for index in range(arguments.warmup + arguments.runs):
            marker = len(backend.stages)
            outcome = client.recommend(deck_version, manifest_hash)
            stages = backend.stages[marker:]
            runs.append(
                {
                    "index": index,
                    "warmup": index < arguments.warmup,
                    "outcome": outcome.get("outcome"),
                    "reason": outcome.get("reason"),
                    "latencyMs": outcome.get("latencyMs"),
                    "stages": stages,
                }
            )
            print(
                f"run {index}: {outcome.get('outcome')}{'' if outcome.get('reason') is None else ':' + str(outcome.get('reason'))}"
                f" {outcome.get('latencyMs')}ms stages={[(s['stage'], s['latencyMs']) for s in stages]}",
                file=sys.stderr,
            )

        measured = [run for run in runs if not run["warmup"]]
        latencies = [float(run["latencyMs"]) for run in measured]  # type: ignore[arg-type]
        recommend = sum(1 for run in measured if run["outcome"] == "RECOMMEND")
        summary = {
            "label": arguments.label,
            "models": {
                "rerank": arguments.rerank,
                "llm": arguments.llm,
                "verifier": arguments.verifier,
            },
            "fixture": arguments.fixture,
            "runs": len(measured),
            "recommend": recommend,
            "p50Ms": round(statistics.median(latencies)) if latencies else 0,
            "p95Ms": round(percentile(latencies, 0.95)),
            "maxMs": round(max(latencies)) if latencies else 0,
            "reasons": {
                reason: sum(1 for run in measured if run["reason"] == reason)
                for reason in sorted({str(run["reason"]) for run in measured if run["reason"]})
            },
            "detail": runs,
        }
        (OUT / f"{arguments.label}.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps({k: v for k, v in summary.items() if k != "detail"}, ensure_ascii=False))
        return 0
    finally:
        for service in reversed(services):
            service.stop()


if __name__ == "__main__":
    raise SystemExit(main())
