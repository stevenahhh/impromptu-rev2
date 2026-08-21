#!/usr/bin/env python3
"""task-27 performance regression measurement.

Cohort A: confirmed FINAL (audio ingest SSE) -> automatic /v1/recommendations
          dispatch -> RECOMMENDATION SSE event, driven end-to-end over the real
          HTTP surface (grant -> SSE -> frame -> stop) with the real local
          whisper.cpp STT adapter and real chat/embedding providers.
Cohort B: existing direct POST /v1/recommendations flow (no audio ingest),
          same deck, same real providers.

Never touches the developer stack on 4173/4174/3001/3002; every service is
booted on an ephemeral 127.0.0.1 port with its own Popen process group whose
stdout is drained continuously. Nothing here mutates product source.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import signal
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / ".omo/evidence/task-27"
AUDIO = Path(__file__).resolve().parent / "final-clip.webm"
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
            if ready in line:
                break
        self.thread = threading.Thread(target=self._drain, daemon=True)
        self.thread.start()

    def _drain(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            print(f"[{self.name}] {line}", end="", file=sys.stderr)

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
    """Minimal HTTP + SSE client for the private-backend browser surface."""

    def __init__(self, host: str, port: int, console_origin: str):
        self.host = host
        self.port = port
        self.console_origin = console_origin
        self.cookie = ""
        self.csrf = ""
        self.account_id = ""
        self.actor_id = ""

    def _open(self, method: str, path: str, body: bytes | None = None,
               headers: dict[str, str] | None = None) -> tuple[int, bytes, http.client.HTTPMessage]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
        try:
            send_headers = {"origin": self.console_origin, "referer": f"{self.console_origin}/"}
            if self.cookie:
                send_headers["cookie"] = self.cookie
            if method != "GET" and self.csrf:
                send_headers["x-csrf-token"] = self.csrf
            if headers:
                send_headers.update(headers)
            conn.request(method, path, body=body, headers=send_headers)
            response = conn.getresponse()
            payload = response.read()
            return response.status, payload, response.headers
        finally:
            conn.close()

    def sign_in(self, username: str, password: str) -> None:
        body = json.dumps({"username": username, "password": password}).encode()
        status, payload, headers = self._open(
            "POST", "/v1/account-sessions", body, {"content-type": "application/json"}
        )
        if status != 201:
            raise RuntimeError(f"sign-in returned {status}: {payload!r}")
        cookies = headers.get_all("set-cookie") or []
        self.cookie = "; ".join(value.split(";", 1)[0] for value in cookies)
        parsed = json.loads(payload)
        self.csrf = parsed["csrfToken"]
        self.account_id = parsed["account"]["accountId"]
        self.actor_id = parsed["account"]["actorId"]

    def upload(self, fixture: Path) -> dict[str, object]:
        boundary = f"----t27{uuid.uuid4().hex}"
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
        status, payload, _ = self._open(
            "POST",
            "/v1/deck-uploads",
            body,
            {"content-type": f"multipart/form-data; boundary={boundary}"},
        )
        if status != 201:
            raise RuntimeError(f"upload returned {status}: {payload!r}")
        return json.loads(payload)

    def new_presentation(self, private_deck: object, public_deck: object) -> tuple[str, str]:
        """Creates a fresh presentation lifecycle for an already-uploaded deck so each
        cohort-A iteration gets its own presentationSessionId. The audio-ingest FINAL ->
        recommend trigger is exactly-once per (presentationSessionId, sessionGeneration,
        finalSegmentId); the local whisper.cpp adapter always starts a fresh streamStt()
        at segmentIndex 0, so finalSegmentId repeats across grants and only a distinct
        presentationSessionId keeps each measured run's FINAL from being deduped away."""
        body = json.dumps({"privateDeck": private_deck, "publicDeck": public_deck}).encode()
        status, payload, _ = self._open(
            "POST", "/v1/presentation-sessions", body, {"content-type": "application/json"}
        )
        if status != 201:
            raise RuntimeError(f"presentation-sessions returned {status}: {payload!r}")
        lifecycle = json.loads(payload)["lifecycle"]
        return str(lifecycle["presentationSessionId"]), str(lifecycle["presentationSessionEpoch"])

    def recommend(self, deck_version: str, manifest_hash: str) -> tuple[dict[str, object], float]:
        body = json.dumps(
            {"query": QUERY, "deckVersion": deck_version, "manifestHash": manifest_hash, "maxResults": 3}
        ).encode()
        started = time.monotonic()
        status, payload, _ = self._open(
            "POST", "/v1/recommendations", body, {"content-type": "application/json"}
        )
        elapsed_ms = (time.monotonic() - started) * 1000
        if status != 200:
            raise RuntimeError(f"recommendation returned {status}: {payload!r}")
        return json.loads(payload), elapsed_ms

    # --- audio ingest (cohort A) ---

    def issue_grant(self, presentation_session_id: str, presentation_session_epoch: str) -> None:
        consent = {
            "consentRecordId": f"consent_{uuid.uuid4().hex[:8]}",
            "presentationSessionId": presentation_session_id,
            "presentationSessionEpoch": presentation_session_epoch,
            "actorId": self.actor_id,
            "captureDeviceId": f"device_{uuid.uuid4().hex[:8]}",
            "notice": {
                "purpose": "Korean transcription",
                "vendors": ["local-whisper"],
                "region": "local",
                "retention": "memory queue only",
                "deletion": "stream close",
            },
            "explicitlyAccepted": True,
            "acceptedAtMs": int(time.time() * 1000),
        }
        body = json.dumps({"mimeType": "audio/webm;codecs=opus", "consent": consent}).encode()
        status, payload, headers = self._open(
            "POST", "/v1/audio/grants", body, {"content-type": "application/json"}
        )
        if status != 201:
            raise RuntimeError(f"grant returned {status}: {payload!r}")
        cookies = headers.get_all("set-cookie") or []
        capture_cookie = next((c.split(";", 1)[0] for c in cookies if c.startswith("__Host-capture=")), None)
        if capture_cookie is None:
            raise RuntimeError("capture cookie missing from grant response")
        self.cookie = f"{self.cookie}; {capture_cookie}"

    def open_events(self) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        conn = http.client.HTTPConnection(self.host, self.port, timeout=30)
        headers = {
            "origin": self.console_origin,
            "referer": f"{self.console_origin}/",
            "cookie": self.cookie,
            "accept": "text/event-stream",
        }
        conn.request("GET", "/v1/audio/events", headers=headers)
        response = conn.getresponse()
        if response.status != 200:
            raise RuntimeError(f"audio/events returned {response.status}")
        return conn, response

    def read_sse_event(self, response: http.client.HTTPResponse) -> dict[str, object]:
        buffer = ""
        while True:
            line = response.fp.readline()
            if not line:
                raise RuntimeError("audio SSE ended before expected event")
            text = line.decode("utf-8")
            buffer += text
            if text in ("\n", "\r\n"):
                for part in buffer.splitlines():
                    if part.startswith("data: "):
                        return json.loads(part[len("data: "):])
                buffer = ""

    def mutation(self, path: str) -> int:
        status, payload, _ = self._open("POST", path)
        if status not in (200, 202):
            raise RuntimeError(f"{path} returned {status}: {payload!r}")
        return status

    def revoke_grant(self) -> None:
        self._open("DELETE", "/v1/audio/grant")


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


def summarize(label: str, samples: list[dict[str, object]]) -> dict[str, object]:
    measured = [s for s in samples if not s.get("warmup")]
    ok = [s for s in measured if s.get("httpOk")]
    latencies = [float(s["latencyMs"]) for s in ok]
    return {
        "label": label,
        "runs": len(measured),
        "httpSuccessCount": len(ok),
        "p50Ms": round(statistics.median(latencies), 1) if latencies else None,
        "p95Ms": round(percentile(latencies, 0.95), 1) if latencies else None,
        "maxMs": round(max(latencies), 1) if latencies else None,
        "outcomes": {
            outcome: sum(1 for s in measured if s.get("outcome") == outcome)
            for outcome in sorted({str(s.get("outcome")) for s in measured})
        },
        "samples": samples,
    }


def service_env(*, private_port: int, projection_port: int, console_origin: str, suffix: str) -> dict[str, str]:
    private_origin = f"http://127.0.0.1:{private_port}"
    projection_origin = f"http://127.0.0.1:{projection_port}"
    env = os.environ.copy()
    env.update(dotenv(ROOT / ".env.local"))
    models = dotenv(ROOT / ".env.example")
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
            "WHISPER_CPP_BINARY_PATH": "/opt/homebrew/bin/whisper-cli",
            "WHISPER_CPP_MODEL_PATH": "/Users/gahn/.cache/whisper.cpp/ggml-small-q5_1.bin",
            "CHAT_MODEL_BASE_URL": "https://opencode.ai/zen/go/v1",
            "EMBEDDING_MODEL_API_KEY": "local-embedding-token",
            "EMBEDDING_MODEL_BASE_URL": "https://127.0.0.1:8443/v1",
            "EMBEDDING_MODEL": "embeddinggemma",
            "NODE_EXTRA_CA_CERTS": "/Users/gahn/Library/Application Support/mkcert/rootCA.pem",
            "RERANK_MODEL": models["RERANK_MODEL"],
            "LLM_MODEL": models["LLM_MODEL"],
            "VERIFIER_MODEL": models["VERIFIER_MODEL"],
            "PRIVATE_DATABASE_URL": "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_private",
            "PRIVATE_BACKEND_PORT": str(private_port),
            "PRIVATE_PREPARED_EVIDENCE_STATE_KEY": f"task27-private-{suffix}",
            "PROJECTION_GATEWAY_ORIGIN": projection_origin,
            "PROJECTION_GATEWAY_PORT": str(projection_port),
            "PROJECTION_DATABASE_URL": "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_projection",
            "PROJECTION_GATEWAY_STATE_KEY": f"task27-projection-{suffix}",
            "PRIVATE_BACKEND_ORIGIN": private_origin,
            "STAGE_ORIGIN": console_origin,
            "SERVICE_AUTH_TOKEN": f"task27-token-{suffix}",
            "CONSOLE_PRIVATE_API_ORIGIN": private_origin,
        }
    )
    return env


def boot_stack(suffix: str) -> tuple[list[Service], Client, int, int, str]:
    private_port, projection_port, console_port = (available_port() for _ in range(3))
    console_origin = f"http://localhost:{console_port}"
    env = service_env(
        private_port=private_port, projection_port=projection_port, console_origin=console_origin, suffix=suffix
    )
    services: list[Service] = []
    services.append(
        Service("projection-gateway", ["bun", "run", "dev"], ROOT / "services/projection-gateway", env, "projection-gateway listening")
    )
    services.append(
        Service("private-backend", ["bun", "run", "dev"], ROOT / "services/private-backend", env, "private-backend listening")
    )
    client = Client("127.0.0.1", private_port, console_origin)
    return services, client, private_port, projection_port, console_origin


def run_cohort_a(client: Client, private_deck: object, public_deck: object,
                  runs: int, warmup: int) -> list[dict[str, object]]:
    audio_bytes = AUDIO.read_bytes()
    duration_ms = 2615
    samples: list[dict[str, object]] = []
    for index in range(warmup + runs):
        entry: dict[str, object] = {"index": index, "warmup": index < warmup}
        try:
            presentation_session_id, presentation_session_epoch = client.new_presentation(
                private_deck, public_deck
            )
            client.issue_grant(presentation_session_id, presentation_session_epoch)
            conn, response = client.open_events()
            try:
                ready = client.read_sse_event(response)
                if ready.get("kind") != "READY":
                    raise RuntimeError(f"expected READY, got {ready}")
                client.mutation("/v1/audio/stream/start")
                # frame requires custom headers, so bypass client.mutation()
                status, payload, _ = client._open(
                    "POST",
                    "/v1/audio/frames",
                    audio_bytes,
                    {
                        "content-type": "application/octet-stream",
                        "x-audio-sequence": "0",
                        "x-audio-duration-ms": str(duration_ms),
                    },
                )
                if status != 202:
                    raise RuntimeError(f"frame post returned {status}: {payload!r}")
                stop_sent_at = time.monotonic()
                client.mutation("/v1/audio/stream/stop")

                final_at = None
                recommendation_at = None
                recommendation_body = None
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    event = client.read_sse_event(response)
                    kind = event.get("kind")
                    if kind == "TRANSCRIPT":
                        inner = event.get("event")
                        if isinstance(inner, dict) and inner.get("kind") == "FINAL":
                            final_at = time.monotonic()
                    elif kind == "RECOMMENDATION":
                        recommendation_at = time.monotonic()
                        recommendation_body = event.get("recommendation")
                        break
                    elif kind == "TERMINAL":
                        break
                if final_at is None or recommendation_at is None:
                    raise RuntimeError("did not observe FINAL -> RECOMMENDATION pair")
                latency_ms = (recommendation_at - final_at) * 1000
                total_from_stop_ms = (recommendation_at - stop_sent_at) * 1000
                outcome = None
                reason = None
                server_latency_ms = None
                if isinstance(recommendation_body, dict):
                    outcome = recommendation_body.get("outcome")
                    reason = recommendation_body.get("reason")
                    server_latency_ms = recommendation_body.get("latencyMs")
                entry.update(
                    {
                        "httpOk": True,
                        "latencyMs": round(latency_ms, 3),
                        "totalFromStreamStopMs": round(total_from_stop_ms, 3),
                        "serverLatencyMs": server_latency_ms,
                        "outcome": outcome,
                        "reason": reason,
                    }
                )
            finally:
                conn.close()
            client.revoke_grant()
        except Exception as error:  # noqa: BLE001 - measurement harness must record, not raise
            entry.update({"httpOk": False, "error": str(error)})
        finally:
            client.cookie = client.cookie.split("; __Host-capture=")[0]
        print(f"[cohort-a] run {index}: {entry}", file=sys.stderr)
        samples.append(entry)
    return samples


def run_cohort_b(client: Client, deck_version: str, manifest_hash: str, runs: int, warmup: int) -> list[dict[str, object]]:
    samples: list[dict[str, object]] = []
    for index in range(warmup + runs):
        entry: dict[str, object] = {"index": index, "warmup": index < warmup}
        try:
            body, wall_ms = client.recommend(deck_version, manifest_hash)
            entry.update(
                {
                    "httpOk": True,
                    "latencyMs": round(wall_ms, 3),
                    "serverLatencyMs": body.get("latencyMs"),
                    "outcome": body.get("outcome"),
                    "reason": body.get("reason"),
                }
            )
        except Exception as error:  # noqa: BLE001
            entry.update({"httpOk": False, "error": str(error)})
        print(f"[cohort-b] run {index}: {entry}", file=sys.stderr)
        samples.append(entry)
    return samples


def commit_sha() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--fixture", default="korean-text-layer.pdf")
    arguments = parser.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    suffix = uuid.uuid4().hex[:8]
    services, client, private_port, projection_port, console_origin = boot_stack(suffix)
    try:
        client.sign_in("localdemo", "demo-2026-password")
        receipt = client.upload(ROOT / "tests/fixtures/format-neutral-decks" / arguments.fixture)
        deck_version = str(receipt["deckVersion"])
        manifest_hash = str(receipt["privateDeck"]["manifestHash"])  # type: ignore[index]

        cohort_a_samples = run_cohort_a(
            client, receipt["privateDeck"], receipt["publicDeck"], arguments.runs, arguments.warmup
        )
        cohort_b_samples = run_cohort_b(client, deck_version, manifest_hash, arguments.runs, arguments.warmup)

        result = {
            "task": "task-27-performance-and-scope",
            "commitSha": commit_sha(),
            "command": "python3 .omo/evidence/task-27/bench/measure_final_to_console.py",
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "fixture": arguments.fixture,
            "ports": {"private": private_port, "projection": projection_port},
            "models": {
                key: os.environ.get(key)
                for key in ("RERANK_MODEL", "LLM_MODEL", "VERIFIER_MODEL", "EMBEDDING_MODEL")
            },
            "note": (
                "Both cohorts use real OpenCode Zen chat providers and the real local "
                "whisper.cpp STT adapter (no fake/scripted model router). Cohort A latency "
                "is measured from the FINAL transcript SSE event to the automatically "
                "dispatched RECOMMENDATION SSE event (services/private-backend/src/main.ts "
                "onFinal -> recommendations.recommend wiring), i.e. the same recommendation "
                "pipeline wall-clock as cohort B, triggered by the audio-ingest path instead "
                "of a manual POST /v1/recommendations call. 'httpOk' means the HTTP/SSE "
                "round trip completed (RECOMMEND or ABSTAIN), not that outcome=='RECOMMEND'; "
                "the recommendation pipeline enforces its own <=5,000ms deadline "
                "(services/private-backend/src/verifier/recommendation-pipeline.ts) so a "
                "bounded response is a structural guarantee independent of provider verdict."
            ),
            "cohortA_confirmedFinalToConsoleRecommendation": summarize(
                "confirmed-final-to-console-recommendation", cohort_a_samples
            ),
            "cohortB_existingRecommendationFlow": summarize(
                "existing-recommendation-flow", cohort_b_samples
            ),
        }
        (OUT / "performance-and-scope.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            json.dumps(
                {
                    "cohortA": {k: v for k, v in result["cohortA_confirmedFinalToConsoleRecommendation"].items() if k != "samples"},
                    "cohortB": {k: v for k, v in result["cohortB_existingRecommendationFlow"].items() if k != "samples"},
                },
                ensure_ascii=False,
            )
        )
        return 0
    finally:
        for service in reversed(services):
            service.stop()


if __name__ == "__main__":
    raise SystemExit(main())
