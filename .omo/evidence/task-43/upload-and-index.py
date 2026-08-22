#!/usr/bin/env python3
"""Uploads the regenerated format-neutral fixtures through the real private-backend
HTTP boundary and records the receipts used for retrieval-chunk indexing evidence.

Evidence-only harness for task-43. Starts one private-backend instance on a free
ephemeral port (checked against both wildcard stacks), signs in the controller
account, and uploads korean-structural.pptx and korean-text-layer.pdf exactly as
the Console would (multipart field `file`, session cookie, CSRF header).
"""
from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
FIXTURE_DIR = ROOT / "tests/fixtures/format-neutral-decks"


def dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    return values


def available_port() -> int:
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


def wait_for_line(process: subprocess.Popen[str], expected: str) -> None:
    assert process.stdout is not None
    while True:
        line = process.stdout.readline()
        if line:
            print(line, end="", file=sys.stderr)
            if expected in line:
                return
            continue
        code = process.poll()
        if code is not None:
            raise RuntimeError(f"private-backend exited {code} before {expected!r}")


def drain(process: subprocess.Popen[str], log: Path) -> None:
    def pump() -> None:
        assert process.stdout is not None
        with log.open("a", encoding="utf-8") as sink:
            for line in process.stdout:
                sink.write(line)
                sink.flush()

    threading.Thread(target=pump, daemon=True).start()


CONSOLE_ORIGIN = "http://localhost:4173"


def http(method: str, url: str, *, headers: dict[str, str] | None = None, body: bytes | None = None):
    merged = {"Origin": CONSOLE_ORIGIN, "Referer": f"{CONSOLE_ORIGIN}/", **(headers or {})}
    request = urllib.request.Request(url, data=body, method=method, headers=merged)
    try:
        response = urllib.request.urlopen(request, timeout=180)
        return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def main() -> int:
    private_port = available_port()
    artifact_root = Path("/tmp/task43-deck-artifacts")
    staging_root = Path("/tmp/task43-deck-staging")
    artifact_root.mkdir(parents=True, exist_ok=True)
    staging_root.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env.update(dotenv(ROOT / ".env.local"))
    env["CHAT_MODEL_API_KEY"] = env["OPENCODE_ZEN_API_KEY"]
    shipped = dotenv(ROOT / ".env.example")
    models = {key: shipped[key] for key in ("RERANK_MODEL", "LLM_MODEL", "VERIFIER_MODEL")}
    env.update(
        {
            "EMBEDDING_MODEL": "embeddinggemma",
            "NODE_EXTRA_CA_CERTS": "/Users/gahn/Library/Application Support/mkcert/rootCA.pem",
            "CHAT_MODEL_BASE_URL": "https://opencode.ai/zen/go/v1",
            "EMBEDDING_MODEL_API_KEY": "local-embedding-token",
            "EMBEDDING_MODEL_BASE_URL": "https://127.0.0.1:8443/v1",
            **models,
            "CONSOLE_ORIGIN": "http://localhost:4173",
            "CONTROLLER_ACCOUNT_ID": "account_local_demo",
            "CONTROLLER_USERNAME": "localdemo",
            "CONTROLLER_PASSWORD": "demo-2026-password",
            "DECK_ARTIFACT_ROOT": str(artifact_root),
            "DECK_STAGING_ROOT": str(staging_root),
            "PRIVATE_DATABASE_URL": "postgresql://impromptu_bootstrap@127.0.0.1:5432/impromptu_private",
            "PRIVATE_BACKEND_PORT": str(private_port),
            "PRIVATE_BACKEND_ORIGIN": f"http://127.0.0.1:{private_port}",
            "PRIVATE_PREPARED_EVIDENCE_STATE_KEY": f"task43-{uuid.uuid4().hex[:12]}",
            "PROJECTION_GATEWAY_ORIGIN": "http://127.0.0.1:1",
            "SERVICE_AUTH_TOKEN": "task43-evidence-token",
        }
    )

    process = subprocess.Popen(
        ["bun", "run", "dev"],
        cwd=ROOT / "services/private-backend",
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    service_log = EVIDENCE / "private-backend.log"
    service_log.write_text("", encoding="utf-8")
    try:
        wait_for_line(process, "listening")
        drain(process, service_log)

        origin = f"http://127.0.0.1:{private_port}"
        credentials = {"username": "localdemo", "password": "demo-2026-password"}
        status, _, _ = http(
            "POST",
            f"{origin}/v1/accounts",
            headers={"content-type": "application/json"},
            body=json.dumps(credentials).encode(),
        )
        registered = status in (201, 409)  # 409 USERNAME_TAKEN means the dev account exists

        status, headers, payload = http(
            "POST",
            f"{origin}/v1/account-sessions",
            headers={"content-type": "application/json"},
            body=json.dumps(credentials).encode(),
        )
        if status != 201:
            print(f"sign-in failed: {status} {payload!r}", file=sys.stderr)
            return 1
        session = json.loads(payload)
        cookie_line = next(
            (value for key, value in headers.items() if key.lower() == "set-cookie"),
            "",
        )
        cookie = cookie_line.split(";", 1)[0]

        receipts: dict[str, object] = {"registrationStatus": registered}
        mime_by_name = {
            "korean-text-layer.pdf": "application/pdf",
            "korean-structural.pptx": (
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            ),
        }
        for filename in ("korean-text-layer.pdf", "korean-structural.pptx"):
            content = (FIXTURE_DIR / filename).read_bytes()
            boundary = f"----task43{uuid.uuid4().hex}"
            part = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                f"Content-Type: {mime_by_name[filename]}\r\n\r\n"
            ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
            started = time.perf_counter()
            status, _, payload = http(
                "POST",
                f"{origin}/v1/deck-uploads",
                headers={
                    "content-type": f"multipart/form-data; boundary={boundary}",
                    "cookie": cookie,
                    "x-csrf-token": session["csrfToken"],
                },
                body=part,
            )
            elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
            receipts[filename] = {
                "status": status,
                "uploadMs": elapsed_ms,
                "response": json.loads(payload) if status == 201 else payload.decode("utf-8", "replace"),
            }
            print(f"{filename}: upload status {status} in {elapsed_ms}ms", file=sys.stderr)

        (EVIDENCE / "upload-receipts.json").write_text(
            json.dumps(receipts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        ok = all(
            isinstance(receipts[name], dict) and receipts[name]["status"] == 201  # type: ignore[index]
            for name in ("korean-text-layer.pdf", "korean-structural.pptx")
        )
        return 0 if ok else 1
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=15)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
