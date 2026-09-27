#!/usr/bin/env python3
"""task-3 live baseline probe, second pass — private-backend rebuilt at HEAD e407007.

Same probes as pass 1 but against the post-fix build (decoupled recommendation lane +
report recovery seam). Origin is taken from the container env (authoritative).
Never writes credentials, cookies, or CSRF tokens to disk.
"""
from __future__ import annotations

import http.client
import json
import socket
import subprocess
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
ORIGIN = subprocess.check_output(
    ["docker", "exec", "impromptu-ulw-g003-demo-private-backend-1", "printenv", "CONSOLE_ORIGIN"],
    text=True,
).strip()


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
LOG: list[str] = []


def log(line: str) -> None:
    LOG.append(line)
    print(line, flush=True)


def summary(payload: bytes, limit: int = 3000) -> str:
    try:
        obj = json.loads(payload)
        s = json.dumps(obj, ensure_ascii=False)
        return s if len(s) <= limit else s[:limit] + "...<truncated>"
    except Exception:
        t = payload.decode("utf-8", "replace")
        return t[:500]


def req(method: str, path: str, *, body=None, headers=None, cookies=None, timeout=180):
    url = BASE + path
    data = None
    h = {"Origin": ORIGIN, "Referer": ORIGIN + "/"}
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
    boundary = "task3head" + str(int(time.time() * 1000))
    head = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; "
        f"filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return boundary, head + data + tail


def main() -> int:
    log(f"# task-3 live baseline probe (post-fix build)  target={BASE}  origin={ORIGIN}")
    log(f"# time={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")

    # 1. login
    log("\n## 1. login")
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/account-sessions",
        body={"username": ENV["CONTROLLER_USERNAME"], "password": ENV["CONTROLLER_PASSWORD"]},
    )
    log(f"HTTP {status} in {ms}ms")
    if status != 201:
        log(f"FATAL login body={summary(payload, 300)}")
        return 2
    account_cookie = [
        v for k, v in hdrs.items() if k.lower() == "set-cookie" and "__Host-account=" in v
    ][0].split(";", 1)[0].split("=", 1)[1]
    csrf = json.loads(payload)["csrfToken"]
    actor = json.loads(payload)["account"]["actorId"]
    cookies = {"__Host-account": account_cookie}
    mut = {"x-csrf-token": csrf}
    log(f"actor={actor}")

    # 2. upload valid text-layer pdf
    data = (FIX / "korean-text-layer.pdf").read_bytes()
    boundary, body = multipart_file("file", "korean-text-layer.pdf", "application/pdf", data)
    log("\n## 2. POST /v1/deck-uploads korean-text-layer.pdf")
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/deck-uploads",
        body=body,
        headers={**mut, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        cookies=cookies,
        timeout=600,
    )
    log(f"HTTP {status} in {ms}ms")
    up = json.loads(payload)
    ps = up["presentationSessionId"]
    epoch = up["presentationSessionEpoch"]
    deck_version = up["deckVersion"]
    manifest_hash = up["privateDeck"]["manifestHash"]
    log(f"presentationSessionId={ps} epoch={epoch} deckVersion={deck_version}")

    # 3. audio grant + SSE ordering
    log("\n## 3. audio grant + two-FINAL SSE ordering")
    consent = {
        "consentRecordId": f"consent_task3b_{int(time.time())}",
        "presentationSessionId": ps,
        "presentationSessionEpoch": epoch,
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
        headers=mut,
        cookies=cookies,
    )
    log(f"grant -> HTTP {status} in {ms}ms body={summary(payload, 200)}")
    capture = [
        v for k, v in hdrs.items() if k.lower() == "set-cookie" and "__Host-capture=" in v
    ][0].split(";", 1)[0].split("=", 1)[1]
    allcookies = {**cookies, "__Host-capture": capture}

    sse_events: list[dict] = []
    lock = threading.Lock()
    t0 = time.monotonic()

    def sse_reader():
        conn = http.client.HTTPConnection("127.0.0.1", 3001, timeout=240)
        conn.putrequest("GET", "/v1/audio/events")
        conn.putheader("Origin", ORIGIN)
        conn.putheader(
            "Cookie", f"__Host-account={account_cookie}; __Host-capture={capture}"
        )
        conn.endheaders()
        resp = conn.getresponse()
        with lock:
            sse_events.append({"t_ms": int((time.monotonic() - t0) * 1000), "meta": f"HTTP {resp.status}"})
        if resp.status != 200:
            return
        buf = b""
        try:
            while True:
                chunk = resp.read1(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n\n" in buf:
                    raw, buf = buf.split(b"\n\n", 1)
                    text = raw.decode("utf-8", "replace")
                    ev_kind = None
                    data_line = None
                    for line in text.split("\n"):
                        if line.startswith("event:"):
                            ev_kind = line[6:].strip()
                        elif line.startswith("data:"):
                            data_line = line[5:].strip()
                    rec = {"t_ms": int((time.monotonic() - t0) * 1000), "event": ev_kind}
                    if data_line:
                        try:
                            rec["data"] = json.loads(data_line)
                        except Exception:
                            rec["raw"] = text[:300]
                    with lock:
                        sse_events.append(rec)
            with lock:
                sse_events.append({"t_ms": int((time.monotonic() - t0) * 1000), "meta": "EOF"})
        except (socket.timeout, http.client.HTTPException, OSError) as e:
            with lock:
                sse_events.append(
                    {"t_ms": int((time.monotonic() - t0) * 1000), "error": f"{type(e).__name__}: {e}"}
                )

    thread = threading.Thread(target=sse_reader, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    ready = False
    while time.monotonic() < deadline:
        with lock:
            ready = any(e.get("event") == "READY" for e in sse_events)
        if ready:
            break
        time.sleep(0.02)
    log(f"SSE READY observed={ready}")

    status, hdrs, payload, ms = req(
        "POST", "/v1/audio/stream/start", headers=mut, cookies=allcookies
    )
    log(f"stream/start -> HTTP {status} in {ms}ms {summary(payload, 120)}")

    clip = (FIX / "two-final.webm").read_bytes()
    seq = 0
    for off in range(0, len(clip), 8192):
        piece = clip[off : off + 8192]
        status, hdrs, payload, ms = req(
            "POST",
            "/v1/audio/frames",
            body=piece,
            headers={
                **mut,
                "Content-Type": "application/octet-stream",
                "x-audio-sequence": str(seq),
                "x-audio-duration-ms": "2040",
            },
            cookies=allcookies,
        )
        seq += 1
        if status != 202:
            log(f"frame {seq-1} -> HTTP {status} {summary(payload, 160)}")
            break
    log(f"pushed {seq} frames")
    status, hdrs, payload, ms = req(
        "POST", "/v1/audio/stream/stop", headers=mut, cookies=allcookies
    )
    log(f"stream/stop -> HTTP {status} in {ms}ms {summary(payload, 120)}")

    deadline = time.monotonic() + 120
    terminal = False
    while time.monotonic() < deadline:
        with lock:
            terminal = any(e.get("event") == "TERMINAL" for e in sse_events)
            dead = any(("error" in e) or (e.get("meta") == "EOF") for e in sse_events)
        if terminal or dead:
            break
        time.sleep(0.05)
    log(f"SSE TERMINAL observed={terminal}")
    thread.join(timeout=5)

    with lock:
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
                f"dur={tr.get('durationMs')} words={len(tr.get('words', []))}"
            )
        elif kind == "RECOMMENDATION":
            rec = d.get("recommendation", {})
            log(
                f"  t={e['t_ms']:>6}  RECOMMENDATION finalSegmentId={d.get('finalSegmentId')} "
                f"outcome={rec.get('outcome')} reason={rec.get('reason')} latencyMs={rec.get('latencyMs')}"
            )
        else:
            log(f"  t={e['t_ms']:>6}  {kind} {json.dumps(d, ensure_ascii=False)[:240]}")

    # 4. spoken-question happy path + edges on HEAD build
    log("\n## 4. POST /v1/question-clips/transcription")
    for name, blob, ctype, dur in [
        ("happy", (FIX / "clip.webm").read_bytes(), "audio/webm;codecs=opus", "2615"),
        ("wrong codec", b"x" * 64, "audio/wav", "100"),
        ("empty body", b"", "audio/webm;codecs=opus", "100"),
        ("too long", (FIX / "clip.webm").read_bytes(), "audio/webm;codecs=opus", "120001"),
    ]:
        status, hdrs, payload, ms = req(
            "POST",
            "/v1/question-clips/transcription",
            body=blob,
            headers={**mut, "Content-Type": ctype, "x-audio-duration-ms": dur},
            cookies=cookies,
            timeout=120,
        )
        log(f"[{name}] HTTP {status} in {ms}ms {summary(payload, 300)}")

    # 5. end + report (verify provisioning edge: this session had audio FINALs but no
    #    slide visits and no QA exchange yet)
    log(f"\n## 5. POST /v1/presentation-sessions/{ps}/end (audio-only session)")
    status, hdrs, payload, ms = req("POST", f"/v1/presentation-sessions/{ps}/end", headers=mut, cookies=cookies)
    log(f"HTTP {status} in {ms}ms {summary(payload, 200)}")
    status, hdrs, payload, ms = req("GET", f"/v1/presentation-sessions/{ps}/report", cookies=cookies)
    log(f"GET /report -> HTTP {status} {summary(payload, 200)}")

    # open Q&A (works on ENDED), ask once -> provisions rows + records exchange
    status, hdrs, payload, ms = req(
        "POST", f"/v1/presentation-sessions/{ps}/qa-defense", headers=mut, cookies=cookies
    )
    log(f"POST qa-defense open -> HTTP {status} {summary(payload, 400)}")
    status, hdrs, payload, ms = req(
        "POST",
        "/v1/qa-defense",
        body={
            "presentationSessionId": ps,
            "questionText": "한빛유통의 2025년 매출은 얼마였나?",
            "origin": "TYPED",
        },
        headers=mut,
        cookies=cookies,
        timeout=60,
    )
    log(f"POST /v1/qa-defense -> HTTP {status} in {ms}ms {summary(payload, 700)}")

    log("## GET /report after provisioning")
    for i in range(20):
        status, hdrs, payload, ms = req(
            "GET", f"/v1/presentation-sessions/{ps}/report", cookies=cookies
        )
        if status == 200:
            break
        log(f"  attempt {i}: HTTP {status} {summary(payload, 120)}")
        time.sleep(1.0)
    log(f"final: HTTP {status}")
    if status == 200:
        rep = json.loads(payload)["report"]
        (EVID / "report-final.json").write_text(
            json.dumps(rep, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        speech = rep.get("speech", {})
        log(f"report keys={sorted(rep.keys())}")
        log(f"speech={json.dumps(speech, ensure_ascii=False)[:600]}")

    # 6. cleanup
    log("\n## 6. cleanup")
    status, hdrs, payload, ms = req("DELETE", "/v1/audio/grant", headers=mut, cookies=allcookies)
    log(f"DELETE /v1/audio/grant -> HTTP {status} {summary(payload, 120)}")
    status, hdrs, payload, ms = req("DELETE", "/v1/account-session", headers=mut, cookies=cookies)
    log(f"DELETE /v1/account-session -> HTTP {status} {summary(payload, 120)}")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        log(f"FATAL {type(e).__name__}: {e}")
        code = 9
    (EVID / "live-probe-head.log").write_text("\n".join(LOG) + "\n", encoding="utf-8")
    sys.exit(code)
