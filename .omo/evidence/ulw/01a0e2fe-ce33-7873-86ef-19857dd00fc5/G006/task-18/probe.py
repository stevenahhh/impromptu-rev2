#!/usr/bin/env python3
"""task-18 F2 probe: zero-activity session end + report read.

Run twice: once against the RUNNING shared stack (expected: HTTP 500 repro), once against a
throwaway container running THIS worktree's fixed sources on the same network/DB (expected:
202 + finalized report). Never writes credentials, cookies, or CSRF tokens to disk.
"""
from __future__ import annotations

import json
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/Users/gahn/.omo/wt/tb8009af622/m")
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3001"


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
ORIGIN = ENV["CONSOLE_ORIGIN"]
REFERER = ORIGIN + "/"


def req(method: str, path: str, *, body=None, headers=None, cookies=None, timeout=60):
    data = None
    h = {"Origin": ORIGIN, "Referer": REFERER}
    if headers:
        h.update(headers)
    if cookies:
        h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h.setdefault("Content-Type", "application/json")
    started = time.monotonic()
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            payload = resp.read()
            return resp.status, dict(resp.headers), payload, int((time.monotonic() - started) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), int((time.monotonic() - started) * 1000)


def summary(payload: bytes, limit: int = 1200) -> str:
    try:
        obj = json.loads(payload)
        if "csrfToken" in obj:
            obj["csrfToken"] = "<redacted>"
        s = json.dumps(obj)
        return s if len(s) <= limit else s[:limit] + "...<truncated>"
    except Exception:
        return payload.decode("utf-8", "replace")[:limit]


def main() -> int:
    print(f"# task-18 F2 zero-activity probe  target={BASE}")
    print(f"# time={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")

    status, hdrs, payload, ms = req(
        "POST",
        "/v1/account-sessions",
        body={"username": ENV["CONTROLLER_USERNAME"], "password": ENV["CONTROLLER_PASSWORD"]},
    )
    print(f"login -> HTTP {status} in {ms}ms  body={summary(payload, 300)}")
    if status != 201:
        print("FATAL: login failed")
        return 2
    account_cookie = None
    for k, v in hdrs.items():
        if k.lower() == "set-cookie" and "__Host-account=" in v:
            account_cookie = v.split(";", 1)[0].split("=", 1)[1]
    csrf = json.loads(payload)["csrfToken"]
    cookies = {"__Host-account": account_cookie}
    mut = {"x-csrf-token": csrf}

    run = secrets.token_hex(4)
    manifest = secrets.token_hex(32)
    image = secrets.token_hex(32)
    deck_body = {
        "privateDeck": {
            "deckId": f"private_deck_t18_{run}",
            "deckVersion": f"deck_t18_{run}",
            "manifestHash": manifest,
            "title": f"Task18 zero-activity {run}",
            "ownerAccountId": ENV["CONTROLLER_ACCOUNT_ID"],
            "aclPolicyVersion": "acl-1",
            "privateObjectPrefix": f"private-decks/task18/{run}",
            "slides": [
                {
                    "privateSlideId": f"private_slide_t18_{run}",
                    "publicSlideKey": f"slide_t18_{run}",
                    "ordinal": 1,
                    "speakerNotes": "task-18 F2 probe",
                    "extractedText": "Zero activity probe slide",
                    "sourceAssetIds": [f"asset_t18_{run}"],
                }
            ],
        },
        "publicDeck": {
            "deckVersion": f"deck_t18_{run}",
            "manifestHash": manifest,
            "title": f"Task18 zero-activity {run}",
            "slides": [
                {
                    "publicSlideKey": f"slide_t18_{run}",
                    "ordinal": 1,
                    "image": {
                        "url": f"https://public.example.test/t18/{run}/one.png",
                        "contentHash": image,
                        "width": 1920,
                        "height": 1080,
                    },
                    "accessibilityLabel": "Zero activity probe slide",
                }
            ],
        },
    }
    status, hdrs, payload, ms = req(
        "POST", "/v1/presentation-sessions", body=deck_body, headers=mut, cookies=cookies
    )
    print(f"create presentation -> HTTP {status} in {ms}ms  body={summary(payload, 600)}")
    if status != 201:
        print("FATAL: presentation create failed")
        return 3
    ps = json.loads(payload)["lifecycle"]["presentationSessionId"]
    print(f"presentationSessionId={ps}  (no slide visits, no QA - zero activity)")

    status, hdrs, payload, ms = req(
        "POST", f"/v1/presentation-sessions/{ps}/end", headers=mut, cookies=cookies
    )
    print(f"POST /end -> HTTP {status} in {ms}ms  body={summary(payload, 300)}")

    report_status = None
    report_body = None
    for _ in range(10):
        status, hdrs, payload, ms = req(
            "GET", f"/v1/presentation-sessions/{ps}/report", cookies=cookies
        )
        print(f"GET /report -> HTTP {status}  body={summary(payload, 800)}")
        report_status = status
        if status == 200:
            report_body = json.loads(payload)
            break
        if status != 202:
            break
    if report_body is not None:
        rep = report_body.get("report", report_body)
        print(f"report keys={sorted(rep.keys())}")
        print(
            "speech=" + json.dumps(rep.get("speech", {})),
        )
        status, hdrs, payload, ms = req(
            "GET", f"/v1/presentation-sessions/{ps}/report", cookies=cookies
        )
        print(f"GET /report re-read -> HTTP {status}  identical={payload == json.dumps(report_body).encode() or json.loads(payload) == report_body}")

    print(f"RESULT end={report_status is not None and 'see-log'} report_status={report_status}")
    return 0 if report_status == 200 else 4


if __name__ == "__main__":
    sys.exit(main())
