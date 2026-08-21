#!/usr/bin/env python3
"""task-27 representative PDF/PPTX cold/warm smoke.

Cold = first deck-upload + first /v1/recommendations call against a freshly
booted private-backend + projection-gateway pair (JIT, connection pools, and
any lazy provider handshakes are cold). Warm = a second /v1/recommendations
call issued immediately after, same process, same deck.

This script records measured values only. Per task-27 scope it does not pass
or fail the run on cold/warm numbers -- there is no cold/concurrent capacity
or long-run p95 claim made here.
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from measure_final_to_console import ROOT, Client, boot_stack, commit_sha  # noqa: E402

OUT = ROOT / ".omo/evidence/task-27"
FIXTURES = ["korean-text-layer.pdf", "korean-structural.pptx"]


def smoke_one(fixture: str) -> dict[str, object]:
    suffix = uuid.uuid4().hex[:8]
    services, client, private_port, projection_port, _console_origin = boot_stack(f"smoke-{suffix}")
    try:
        client.sign_in("localdemo", "demo-2026-password")

        upload_started = time.monotonic()
        receipt = client.upload(ROOT / "tests/fixtures/format-neutral-decks" / fixture)
        upload_ms = (time.monotonic() - upload_started) * 1000
        deck_version = str(receipt["deckVersion"])
        manifest_hash = str(receipt["privateDeck"]["manifestHash"])  # type: ignore[index]

        cold_body, cold_ms = client.recommend(deck_version, manifest_hash)
        warm_body, warm_ms = client.recommend(deck_version, manifest_hash)

        return {
            "fixture": fixture,
            "uploadMs": round(upload_ms, 3),
            "cold": {
                "latencyMs": round(cold_ms, 3),
                "serverLatencyMs": cold_body.get("latencyMs"),
                "outcome": cold_body.get("outcome"),
                "reason": cold_body.get("reason"),
            },
            "warm": {
                "latencyMs": round(warm_ms, 3),
                "serverLatencyMs": warm_body.get("latencyMs"),
                "outcome": warm_body.get("outcome"),
                "reason": warm_body.get("reason"),
            },
        }
    finally:
        for service in reversed(services):
            service.stop()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    results = [smoke_one(fixture) for fixture in FIXTURES]
    for entry in results:
        print(json.dumps(entry, ensure_ascii=False), file=sys.stderr)
    payload = {
        "task": "task-27-pdf-pptx-cold-warm-smoke",
        "commitSha": commit_sha(),
        "command": "python3 .omo/evidence/task-27/bench/smoke_cold_warm.py",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": (
            "Measured values only, no pass/fail judgment (task-27 scope excludes cold/"
            "concurrent capacity and long-run p95 conclusions). 'cold' is the first "
            "/v1/recommendations call against a just-booted private-backend + "
            "projection-gateway pair on ephemeral ports; 'warm' is the second call on the "
            "same process immediately after, same deck."
        ),
        "results": results,
    }
    (OUT / "pdf-pptx-cold-warm-smoke.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
