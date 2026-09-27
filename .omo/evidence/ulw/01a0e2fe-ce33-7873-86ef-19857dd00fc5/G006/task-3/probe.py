#!/usr/bin/env python3
"""task-3 live baseline probe against the running impromptu-ulw-g003-demo stack.

Captures: login, deck uploads (valid / scanned / invalid), /v1/recommendations,
audio grant -> SSE -> frames -> stop ordering (two-FINAL deferred-provider probe),
spoken-question clip edges, session end, report read (coaching persisted), Q&A ask.

Never writes credentials, cookies, or CSRF tokens to disk.
"""
from __future__ import annotations

import http.client
import json
import re
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path("/Users/gahn/projects/impromptu-rev2")
FIX = Path("/tmp/task3/fixtures")
EVID = ROOT / ".omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/task-3"
BASE = "http://127.0.0.1:3001"


def dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        k, v = raw.split("=", 1)
        out[k] = v.strip().strip('"').strip("'")
    return out


ENV = dotenv(ROOT / ".env")
ORIGIN = ENV["CONSOLE_PUBLIC_ORIGIN"]
REFERER = ORIGIN + "/"

LOG: list[str] = []


def log(line: str) -> None:
    LOG.append(line)
    print(line, flush=True)


def b2s(b: bytes, limit: int = 4000) -> str:
    t = b.decode("utf-8", "replace")
    return t if len(t) <= limit else t[:limit] + "...<truncated>"


def req(method: str, path: str, *, body=None, headers=None, cookies=None, timeout=180):
    """Minimal JSON/bytes HTTP helper. Returns (status, headers, body_bytes, elapsed_ms)."""
    url = BASE + path
    data = None
    h = {"Origin": ORIGIN, "Referer": REFERER}
    if headers:
        h.update(headers)
    if cookies:
        h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if isinstance(body, (bytes, bytearray)):
        data = bytes(body)
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        h.setdefault("Content-Type", "application/json")
    started = time.monotonic()
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            payload = resp.read()
            return resp.status, dict(resp.headers), payload, int((time.monotonic() - started) * 1000)
    except urllib.error.HTTPError as e:
        payload = e.read()
        return e.code, dict(e.headers), payload, int((time.monotonic() - started) * 1000)


def multipart_file(field: str, filename: str, content_type: str, data: bytes):
    boundary = "task3boundary" + str(int(time.time() * 1000))
    head = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; "
        f"filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return boundary, head + data + tail


def redact_login(payload: bytes) -> str:
    try:
        obj = json.loads(payload)
        if "csrfToken" in obj:
            obj["csrfToken"] = "<redacted>"
        return json.dumps(obj)
    except Exception:
        return "<unparsed>"


def summary(payload: bytes, limit: int = 3000) -> str:
    try:
        obj = json.loads(payload)
        s = json.dumps(obj)
        return s if len(s) <= limit else s[:limit] + "...<truncated>"
    except Exception:
        return b2s(payload, 500)


def main() -> int:
    EVID.mkdir(parents=True, exist_ok=True)
    log(f"# task-3 live baseline probe  target={BASE}  origin={ORIGIN}")
    log(f"# time={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")

    # ---------- 1. login ----------
    log("\n## 1. POST /v1/account-sessions (login)")
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/account-sessions",
        body={
            "username": ENV["CONTROLLER_USERNAME"],
            "password": ENV["CONTROLLER_PASSWORD"],
        },
    )
    log(f"HTTP {status} in {ms}ms  body={redact_login(payload)}")
    if status != 201:
        log("FATAL: login failed; aborting live probes")
        return 2
    account_cookie = None
    for k, v in hdrs.items():
        if k.lower() == "set-cookie" and "__Host-account=" in v:
            account_cookie = v.split(";", 1)[0].split("=", 1)[1]
    csrf = json.loads(payload)["csrfToken"]
    actor = json.loads(payload)["account"]["actorId"]
    cookies = {"__Host-account": account_cookie}
    mut_headers = {"x-csrf-token": csrf}
    log(f"actor={actor} cookie=<redacted> csrf=<redacted>")

    # ---------- 2. deck uploads ----------
    uploads: dict[str, dict] = {}
    for label, fname, ctype in [
        ("valid-pdf", "korean-text-layer.pdf", "application/pdf"),
        ("scanned-pdf", "korean-scanned.pdf", "application/pdf"),
        ("invalid-pdf", "invalid-deck.pdf", "application/pdf"),
    ]:
        data = (FIX / fname).read_bytes()
        boundary, body = multipart_file("file", fname, ctype, data)
        log(f"\n## 2.{label}: POST /v1/deck-uploads file={fname} bytes={len(data)}")
        status, hdrs, payload, ms = req(
            "POST",
            "/v1/deck-uploads",
            body=body,
            headers={**mut_headers, "Content-Type": f"multipart/form-data; boundary={boundary}"},
            cookies=cookies,
            timeout=600,
        )
        log(f"HTTP {status} in {ms}ms")
        log(f"body={summary(payload)}")
        if status == 201:
            obj = json.loads(payload)
            uploads[label] = obj
            log(
                f"presentationSessionId={obj['presentationSessionId']} "
                f"epoch={obj['presentationSessionEpoch']} deckVersion={obj['deckVersion']} "
                f"slides={len(obj['publicDeck'].get('slides', []))}"
            )

    primary = uploads.get("valid-pdf")
    scanned = uploads.get("scanned-pdf")
    if primary is None:
        log("FATAL: valid upload failed; skipping dependent probes")
        return 3
    ps1 = primary["presentationSessionId"]
    epoch1 = primary["presentationSessionEpoch"]
    deck_version = primary["deckVersion"]
    manifest_hash = primary["privateDeck"]["manifestHash"]

    # ---------- 3. /v1/recommendations ----------
    log("\n## 3. POST /v1/recommendations (deck-grounded query)")
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/recommendations",
        body={
            "query": "한빛유통의 2025년 매출은 얼마였나?",
            "deckVersion": deck_version,
            "manifestHash": manifest_hash,
        },
        headers=mut_headers,
        cookies=cookies,
        timeout=60,
    )
    log(f"HTTP {status} in {ms}ms  outcome={summary(payload, 1200)}")

    log("\n## 3b. POST /v1/recommendations invalid body (unsupported input)")
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/recommendations",
        body={"query": ""},
        headers=mut_headers,
        cookies=cookies,
        timeout=60,
    )
    log(f"HTTP {status} in {ms}ms  outcome={summary(payload, 800)}")

    # ---------- 4. audio capture: grant -> SSE -> frames -> stop ----------
    log("\n## 4. Audio capture grant + SSE ordering probe (two-FINAL)")
    consent = {
        "consentRecordId": f"consent_task3_{int(time.time())}",
        "presentationSessionId": ps1,
        "presentationSessionEpoch": epoch1,
        "actorId": actor,
        "captureDeviceId": "device_task3_probe",
        "notice": {
            "purpose": "task-3 baseline transcription probe",
            "vendors": ["local-whisper"],
            "region": "local",
            "retention": "memory queue only",
            "deletion": "stream close",
        },
        "explicitlyAccepted": True,
        "acceptedAtMs": int(time.time() * 1000) - 500,
    }
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/audio/grants",
        body={"mimeType": "audio/webm;codecs=opus", "consent": consent},
        headers=mut_headers,
        cookies=cookies,
    )
    log(f"POST /v1/audio/grants -> HTTP {status} in {ms}ms body={summary(payload, 400)}")
    capture_id = None
    if status == 201:
        for k, v in hdrs.items():
            if k.lower() == "set-cookie" and "__Host-capture=" in v:
                capture_id = v.split(";", 1)[0].split("=", 1)[1]
    if capture_id is None:
        log("FATAL: no capture grant")
        return 4
    allcookies = {**cookies, "__Host-capture": capture_id}

    # SSE reader thread with per-event arrival timestamps.
    sse_events: list[dict] = []
    sse_lock = threading.Lock()
    sse_t0 = time.monotonic()

    def sse_reader():
        conn = http.client.HTTPConnection("127.0.0.1", 3001, timeout=240)
        conn.putrequest("GET", "/v1/audio/events")
        conn.putheader("Origin", ORIGIN)
        conn.putheader("Cookie", f"__Host-account={account_cookie}; __Host-capture={capture_id}")
        conn.endheaders()
        resp = conn.getresponse()
        with sse_lock:
            sse_events.append(
                {"t_ms": int((time.monotonic() - sse_t0) * 1000), "meta": f"HTTP {resp.status}"}
            )
        if resp.status != 200:
            return
        buf = b""
        try:
            while True:
                chunk = resp.read1(4096) if hasattr(resp, "read1") else resp.read(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n\n" in buf:
                    raw, buf = buf.split(b"\n\n", 1)
                    text = raw.decode("utf-8", "replace")
                    data_line = None
                    ev_kind = None
                    for line in text.split("\n"):
                        if line.startswith("event:"):
                            ev_kind = line[6:].strip()
                        if line.startswith("data:"):
                            data_line = line[5:].strip()
                    rec = {"t_ms": int((time.monotonic() - sse_t0) * 1000), "event": ev_kind}
                    if data_line:
                        try:
                            obj = json.loads(data_line)
                            rec["data"] = obj
                        except Exception:
                            rec["raw"] = text[:300]
                    with sse_lock:
                        sse_events.append(rec)
        except (socket.timeout, http.client.HTTPException, OSError) as e:
            with sse_lock:
                sse_events.append(
                    {"t_ms": int((time.monotonic() - sse_t0) * 1000), "error": f"{type(e).__name__}: {e}"}
                )

    thread = threading.Thread(target=sse_reader, daemon=True)
    thread.start()
    # subscribe-before-trigger: wait for READY before starting the stream
    deadline = time.monotonic() + 15
    ready = False
    while time.monotonic() < deadline:
        with sse_lock:
            ready = any(e.get("event") == "READY" for e in sse_events)
        if ready:
            break
        time.sleep(0.02)
    log(f"SSE READY observed={ready}")

    status, hdrs, payload, ms = req(
        "POST", "/v1/audio/stream/start", headers=mut_headers, cookies=allcookies
    )
    log(f"POST /v1/audio/stream/start -> HTTP {status} in {ms}ms body={summary(payload, 200)}")

    # frames: split two-final.webm into ~2s chunks with declared durations
    clip = (FIX / "two-final.webm").read_bytes()
    chunk_size = 8192
    seq = 0
    total_ms = 30622  # measured decode duration
    n_chunks = (len(clip) + chunk_size - 1) // chunk_size
    per_chunk_ms = max(1, total_ms // n_chunks)
    t_push0 = time.monotonic()
    for off in range(0, len(clip), chunk_size):
        piece = clip[off : off + chunk_size]
        status, hdrs, payload, ms = req(
            "POST",
            "/v1/audio/frames",
            body=piece,
            headers={
                **mut_headers,
                "Content-Type": "application/octet-stream",
                "x-audio-sequence": str(seq),
                "x-audio-duration-ms": str(min(per_chunk_ms, 30000)),
            },
            cookies=allcookies,
        )
        seq += 1
        if status != 202:
            log(f"frame seq={seq - 1} -> HTTP {status} body={summary(payload, 200)}")
            break
    log(f"pushed {seq} frames ({len(clip)} bytes) in {int((time.monotonic()-t_push0)*1000)}ms")

    status, hdrs, payload, ms = req(
        "POST", "/v1/audio/stream/stop", headers=mut_headers, cookies=allcookies
    )
    log(f"POST /v1/audio/stream/stop -> HTTP {status} in {ms}ms body={summary(payload, 200)}")

    # wait for TERMINAL (bounded, event-driven)
    deadline = time.monotonic() + 150
    terminal = False
    while time.monotonic() < deadline:
        with sse_lock:
            terminal = any(e.get("event") == "TERMINAL" for e in sse_events)
        if terminal:
            break
        time.sleep(0.05)
    log(f"SSE TERMINAL observed={terminal}")
    thread.join(timeout=5)

    with sse_lock:
        ordered = list(sse_events)
    log("\n## SSE arrival order (t_ms since SSE open):")
    for e in ordered:
        if "meta" in e:
            log(f"  t={e['t_ms']:>6}  [{e['meta']}]")
            continue
        if "error" in e:
            log(f"  t={e['t_ms']:>6}  ERROR {e['error']}")
            continue
        kind = e.get("event")
        d = e.get("data", {})
        if kind == "TRANSCRIPT":
            ev = d.get("event", {})
            tr = ev.get("transcript", {})
            log(
                f"  t={e['t_ms']:>6}  TRANSCRIPT {ev.get('kind')} seg={ev.get('segmentId')} "
                f"finalSegmentId={ev.get('finalSegmentId')} text={tr.get('text', '')!r} "
                f"dur={tr.get('durationMs')}"
            )
        elif kind == "RECOMMENDATION":
            rec = d.get("recommendation", {})
            log(
                f"  t={e['t_ms']:>6}  RECOMMENDATION finalSegmentId={d.get('finalSegmentId')} "
                f"outcome={rec.get('outcome')} reason={rec.get('reason')} "
                f"latencyMs={rec.get('latencyMs')}"
            )
        else:
            log(f"  t={e['t_ms']:>6}  {kind} {json.dumps(d)[:240]}")

    # ---------- 5. spoken-question clip probes ----------
    log("\n## 5. POST /v1/question-clips/transcription edges")
    short_clip = (FIX / "clip.webm").read_bytes()
    probes = [
        ("happy webm opus clip", short_clip, "audio/webm;codecs=opus", str(2615)),
        ("wrong codec", short_clip, "audio/wav", str(2615)),
        ("empty body", b"", "audio/webm;codecs=opus", str(100)),
        ("corrupt body", b"\x00\x11\x22\x33not-webm", "audio/webm;codecs=opus", str(100)),
        ("declared too long", short_clip, "audio/webm;codecs=opus", str(120_001)),
    ]
    for name, blob, ctype, dur in probes:
        status, hdrs, payload, ms = req(
            "POST",
            "/v1/question-clips/transcription",
            body=blob,
            headers={
                **mut_headers,
                "Content-Type": ctype,
                "x-audio-duration-ms": dur,
            },
            cookies=cookies,
            timeout=120,
        )
        log(f"[{name}] HTTP {status} in {ms}ms body={summary(payload, 400)}")

    # ---------- 6. end session + report (coaching persisted) ----------
    log(f"\n## 6. POST /v1/presentation-sessions/{ps1}/end")
    status, hdrs, payload, ms = req(
        "POST",
        f"/v1/presentation-sessions/{ps1}/end",
        headers=mut_headers,
        cookies=cookies,
    )
    log(f"HTTP {status} in {ms}ms body={summary(payload, 300)}")

    # bounded re-read of finalized report (event-driven on state, not a fixed sleep)
    log(f"## GET /v1/presentation-sessions/{ps1}/report")
    report_body = None
    for attempt in range(40):
        status, hdrs, payload, ms = req(
            "GET", f"/v1/presentation-sessions/{ps1}/report", cookies=cookies
        )
        if status == 200:
            report_body = json.loads(payload)
            log(f"attempt {attempt}: HTTP 200 (finalized)")
            break
        if attempt == 0 or attempt % 5 == 0:
            log(f"attempt {attempt}: HTTP {status} body={summary(payload, 200)}")
        time.sleep(1.0)
    if report_body is None:
        log("report stayed non-200 within bound")
    else:
        rep = report_body.get("report", report_body)
        speech = rep.get("speech", rep.get("speechSummary"))
        coaching = rep.get("coaching", rep.get("coachingAggregate"))
        log(f"report keys={sorted(rep.keys())}")
        log(f"speech={json.dumps(speech)[:400]}")
        log(f"coaching={json.dumps(coaching)[:600]}")

    # ---------- 7. Q&A defense (recommendation pipeline over ended session) ----------
    log(f"\n## 7. POST /v1/presentation-sessions/{ps1}/qa-defense (open)")
    status, hdrs, payload, ms = req(
        "POST",
        f"/v1/presentation-sessions/{ps1}/qa-defense",
        headers=mut_headers,
        cookies=cookies,
    )
    log(f"HTTP {status} in {ms}ms body={summary(payload, 500)}")
    log("## POST /v1/qa-defense (typed ask)")
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/qa-defense",
        body={
            "presentationSessionId": ps1,
            "questionText": "한빛유통의 2025년 매출은 얼마였나?",
            "origin": "TYPED",
        },
        headers=mut_headers,
        cookies=cookies,
        timeout=60,
    )
    log(f"HTTP {status} in {ms}ms body={summary(payload, 900)}")

    # ---------- 8. cleanup: revoke grant + logout ----------
    log("\n## 8. cleanup")
    status, hdrs, payload, ms = req(
        "DELETE", "/v1/audio/grant", headers=mut_headers, cookies=allcookies
    )
    log(f"DELETE /v1/audio/grant -> HTTP {status} body={summary(payload, 200)}")
    status, hdrs, payload, ms = req(
        "DELETE", "/v1/account-session", headers=mut_headers, cookies=cookies
    )
    log(f"DELETE /v1/account-session -> HTTP {status} body={summary(payload, 200)}")
    # second session created by scanned upload share same account session; nothing else to clean
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        log(f"FATAL exception: {type(e).__name__}: {e}")
        code = 9
    (EVID / "live-probe.log").write_text("\n".join(LOG) + "\n", encoding="utf-8")
    sys.exit(code)
