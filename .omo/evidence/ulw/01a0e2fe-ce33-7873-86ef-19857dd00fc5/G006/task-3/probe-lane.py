#!/usr/bin/env python3
"""task-3 follow-up: capture recommendation-lane ordering while stream stays STARTED.

Holds the stream open until RECOMMENDATION events for the two full segments land
(bounded), then stops. Also captures unauthenticated audio rejections.
"""
from __future__ import annotations

import http.client
import json
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path("/Users/gahn/projects/impromptu-rev2")
FIX = Path("/tmp/task3/fixtures")
EVID = ROOT / ".omo/evidence/ulw/01a0e2fe-ce33-7873-86ef-19857dd00fc5/G006/task-3"
BASE = "http://127.0.0.1:3001"
ORIGIN = subprocess.check_output(
    ["docker", "exec", "impromptu-ulw-g003-demo-private-backend-1", "printenv", "CONSOLE_ORIGIN"],
    text=True,
).strip()
PS = "ps_57565c7b75497505f16ae2f1b32aa5aa"  # ended presentation from probe-head
EPOCH = "pse_1"


def dotenv(path):
    out = {}
    for raw in path.read_text().splitlines():
        raw = raw.strip()
        if raw and not raw.startswith("#") and "=" in raw:
            k, v = raw.split("=", 1)
            out[k] = v.strip().strip('"').strip("'")
    return out


ENV = dotenv(ROOT / ".env")
LOG = []


def log(s):
    LOG.append(s)
    print(s, flush=True)


def summary(p, limit=400):
    try:
        s = json.dumps(json.loads(p), ensure_ascii=False)
        return s[:limit]
    except Exception:
        return p[:200].decode("utf-8", "replace")


def req(method, path, *, body=None, headers=None, cookies=None, timeout=120):
    h = {"Origin": ORIGIN, "Referer": ORIGIN + "/"}
    if headers:
        h.update(headers)
    if cookies:
        h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    data = None
    if isinstance(body, (bytes, bytearray)):
        data = bytes(body)
    elif body is not None:
        data = json.dumps(body).encode()
        h.setdefault("Content-Type", "application/json")
    t = time.monotonic()
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read(), int((time.monotonic() - t) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), int((time.monotonic() - t) * 1000)


def main():
    log(f"# task-3 lane probe  target={BASE}  origin={ORIGIN}")
    s, h, p, ms = req(
        "POST",
        "/v1/account-sessions",
        body={"username": ENV["CONTROLLER_USERNAME"], "password": ENV["CONTROLLER_PASSWORD"]},
    )
    log(f"login HTTP {s}")
    ck = [v for k, v in h.items() if k.lower() == "set-cookie" and "__Host-account=" in v][0].split(
        ";", 1
    )[0].split("=", 1)[1]
    csrf = json.loads(p)["csrfToken"]
    actor = json.loads(p)["account"]["actorId"]
    cookies = {"__Host-account": ck}
    mut = {"x-csrf-token": csrf}

    # unauthenticated edge probes first
    log("\n## unauthenticated/edge audio probes")
    s, h, p, ms = req("GET", "/v1/audio/events", cookies=cookies)
    log(f"GET /v1/audio/events no capture cookie -> HTTP {s} {summary(p, 120)}")
    s, h, p, ms = req(
        "POST", "/v1/audio/frames", body=b"xx", headers={**mut, "Content-Type": "application/octet-stream"}, cookies=cookies
    )
    log(f"POST /v1/audio/frames no capture cookie -> HTTP {s} {summary(p, 120)}")
    s, h, p, ms = req("POST", "/v1/audio/grants", body={"mimeType": "audio/webm;codecs=opus"}, headers=mut, cookies=cookies)
    log(f"POST /v1/audio/grants missing consent -> HTTP {s} {summary(p, 160)}")

    # NOTE: the presentation is ENDED now; resolveContext requires ACTIVE, so a grant on it
    # would produce transcripts but no recommendations. Upload a fresh deck for an ACTIVE one.
    boundary = "task3lane" + str(int(time.time() * 1000))
    data = (FIX / "korean-text-layer.pdf").read_bytes()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"korean-text-layer.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    s, h, p, ms = req(
        "POST",
        "/v1/deck-uploads",
        body=body,
        headers={**mut, "Content-Type": f"multipart/form-data; boundary={boundary}"},
        cookies=cookies,
        timeout=600,
    )
    up = json.loads(p)
    ps = up["presentationSessionId"]
    epoch = up["presentationSessionEpoch"]
    log(f"\nupload -> HTTP {s} ps={ps}")

    consent = {
        "consentRecordId": f"consent_task3c_{int(time.time())}",
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
    s, h, p, ms = req(
        "POST",
        "/v1/audio/grants",
        body={"mimeType": "audio/webm;codecs=opus", "consent": consent},
        headers=mut,
        cookies=cookies,
    )
    log(f"grant -> HTTP {s} {summary(p, 160)}")
    cap = [v for k, v in h.items() if k.lower() == "set-cookie" and "__Host-capture=" in v][0].split(
        ";", 1
    )[0].split("=", 1)[1]
    allc = {**cookies, "__Host-capture": cap}

    events = []
    lock = threading.Lock()
    t0 = time.monotonic()

    def reader():
        conn = http.client.HTTPConnection("127.0.0.1", 3001, timeout=240)
        conn.putrequest("GET", "/v1/audio/events")
        conn.putheader("Origin", ORIGIN)
        conn.putheader("Cookie", f"__Host-account={ck}; __Host-capture={cap}")
        conn.endheaders()
        resp = conn.getresponse()
        with lock:
            events.append({"t": int((time.monotonic() - t0) * 1000), "meta": f"HTTP {resp.status}"})
        if resp.status != 200:
            return
        buf = b""
        try:
            while True:
                c = resp.read1(4096)
                if not c:
                    break
                buf += c
                while b"\n\n" in buf:
                    raw, buf = buf.split(b"\n\n", 1)
                    ev = None
                    dl = None
                    for line in raw.decode("utf-8", "replace").split("\n"):
                        if line.startswith("event:"):
                            ev = line[6:].strip()
                        elif line.startswith("data:"):
                            dl = line[5:].strip()
                    rec = {"t": int((time.monotonic() - t0) * 1000), "event": ev}
                    if dl:
                        try:
                            rec["data"] = json.loads(dl)
                        except Exception:
                            rec["raw"] = dl[:200]
                    with lock:
                        events.append(rec)
            with lock:
                events.append({"t": int((time.monotonic() - t0) * 1000), "meta": "EOF"})
        except (socket.timeout, http.client.HTTPException, OSError) as e:
            with lock:
                events.append({"t": int((time.monotonic() - t0) * 1000), "error": f"{type(e).__name__}: {e}"})

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    dl = time.monotonic() + 15
    while time.monotonic() < dl:
        with lock:
            if any(e.get("event") == "READY" for e in events):
                break
        time.sleep(0.02)

    s, h, p, ms = req("POST", "/v1/audio/stream/start", headers=mut, cookies=allc)
    log(f"start -> HTTP {s}")
    clip = (FIX / "two-final.webm").read_bytes()
    seq = 0
    for off in range(0, len(clip), 8192):
        s, h, p, ms = req(
            "POST",
            "/v1/audio/frames",
            body=clip[off : off + 8192],
            headers={
                **mut,
                "Content-Type": "application/octet-stream",
                "x-audio-sequence": str(seq),
                "x-audio-duration-ms": "2040",
            },
            cookies=allc,
        )
        seq += 1
        if s != 202:
            log(f"frame {seq-1} HTTP {s} {summary(p, 120)}")
            break
    log(f"pushed {seq} frames; holding stream open until recommendations land (bounded 75s)")

    # wait for 2 RECOMMENDATION events or bound (stream stays STARTED so jobs publish)
    dl = time.monotonic() + 75
    recs = 0
    while time.monotonic() < dl:
        with lock:
            recs = sum(1 for e in events if e.get("event") == "RECOMMENDATION")
            dead = any("error" in e or e.get("meta") == "EOF" for e in events)
        if recs >= 2 or dead:
            break
        time.sleep(0.05)
    log(f"RECOMMENDATION events observed while STARTED: {recs}")

    s, h, p, ms = req("POST", "/v1/audio/stream/stop", headers=mut, cookies=allc)
    log(f"stop -> HTTP {s}")
    dl = time.monotonic() + 60
    term = False
    while time.monotonic() < dl:
        with lock:
            term = any(e.get("event") == "TERMINAL" for e in events)
            dead = any("error" in e or e.get("meta") == "EOF" for e in events)
        if term or dead:
            break
        time.sleep(0.05)
    log(f"TERMINAL observed={term}")
    thread.join(timeout=5)

    log("\n## SSE arrival order:")
    with lock:
        ordered = list(events)
    for e in ordered:
        if "meta" in e:
            log(f"  t={e['t']:>6} [{e['meta']}]")
            continue
        if "error" in e:
            log(f"  t={e['t']:>6} ERROR {e['error']}")
            continue
        k = e.get("event")
        d = e.get("data", {})
        if k == "TRANSCRIPT":
            ev = d.get("event", {})
            tr = ev.get("transcript", {})
            log(
                f"  t={e['t']:>6} TRANSCRIPT {ev.get('kind')} seg={ev.get('segmentId')} "
                f"finalId={ev.get('finalSegmentId')} text={tr.get('text','')!r} dur={tr.get('durationMs')}"
            )
        elif k == "RECOMMENDATION":
            r_ = d.get("recommendation", {})
            log(
                f"  t={e['t']:>6} RECOMMENDATION finalId={d.get('finalSegmentId')} "
                f"outcome={r_.get('outcome')} reason={r_.get('reason')} latencyMs={r_.get('latencyMs')}"
            )
        else:
            log(f"  t={e['t']:>6} {k} {json.dumps(d, ensure_ascii=False)[:200]}")

    log("\n## end + report")
    s, h, p, ms = req("POST", f"/v1/presentation-sessions/{ps}/end", headers=mut, cookies=cookies)
    log(f"end -> HTTP {s} {summary(p, 200)}")
    s, h, p, ms = req("GET", f"/v1/presentation-sessions/{ps}/report", cookies=cookies)
    log(f"GET /report -> HTTP {s} {summary(p, 160)}")
    # provision via qa then re-read so this session also lands finalized
    s, h, p, ms = req("POST", f"/v1/presentation-sessions/{ps}/qa-defense", headers=mut, cookies=cookies)
    log(f"qa open -> HTTP {s} {summary(p, 300)}")
    s, h, p, ms = req(
        "POST",
        "/v1/qa-defense",
        body={"presentationSessionId": ps, "questionText": "한빛유통 매출?", "origin": "TYPED"},
        headers=mut,
        cookies=cookies,
        timeout=60,
    )
    log(f"qa ask -> HTTP {s} {summary(p, 400)}")
    for i in range(20):
        s, h, p, ms = req("GET", f"/v1/presentation-sessions/{ps}/report", cookies=cookies)
        if s == 200:
            break
        time.sleep(1.0)
    log(f"GET /report -> HTTP {s}")
    if s == 200:
        rep = json.loads(p)["report"]
        log(f"speech={json.dumps(rep.get('speech'), ensure_ascii=False)[:400]}")

    log("\n## cleanup")
    s, h, p, ms = req("DELETE", "/v1/audio/grant", headers=mut, cookies=allc)
    log(f"DELETE grant -> HTTP {s} {summary(p, 120)}")
    s, h, p, ms = req("DELETE", "/v1/account-session", headers=mut, cookies=cookies)
    log(f"logout -> HTTP {s}")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        log(f"FATAL {type(e).__name__}: {e}")
        code = 9
    (EVID / "live-probe-lane.log").write_text("\n".join(LOG) + "\n", encoding="utf-8")
    sys.exit(code)
