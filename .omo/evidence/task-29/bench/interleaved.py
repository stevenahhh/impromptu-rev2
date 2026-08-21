#!/usr/bin/env python3
"""Interleaved A/B/C of model configurations against one shared provider window.

Boots one private topology per configuration on ephemeral ports and issues the
recommendation requests round-robin, so upstream provider drift (which is several
seconds wide on this endpoint) is charged equally to every configuration instead of
to whichever one happened to run during a bad window.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
import uuid
from pathlib import Path

MODULE = Path(__file__).with_name("bench.py")
spec = importlib.util.spec_from_file_location("bench", MODULE)
assert spec is not None and spec.loader is not None
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)

ROOT = bench.ROOT
OUT = Path(__file__).parent


class Topology:
    def __init__(self, label: str, rerank: str, llm: str, verifier: str, fixture: str):
        self.label = label
        self.models = {"rerank": rerank, "llm": llm, "verifier": verifier}
        private_port, projection_port, console_port = (bench.available_port() for _ in range(3))
        console_origin = f"http://localhost:{console_port}"
        self.private_origin = f"http://127.0.0.1:{private_port}"
        env = bench.service_env(
            private_port=private_port,
            projection_port=projection_port,
            console_origin=console_origin,
            rerank=rerank,
            llm=llm,
            verifier=verifier,
            suffix=uuid.uuid4().hex[:8],
        )
        self.services = [
            bench.Service(
                f"{label}-projection",
                ["bun", "run", "dev"],
                ROOT / "services/projection-gateway",
                env,
                "projection-gateway listening",
            )
        ]
        self.backend = bench.Service(
            f"{label}-private",
            ["bun", "run", "dev"],
            ROOT / "services/private-backend",
            env,
            "private-backend listening",
        )
        self.services.append(self.backend)
        self.client = bench.Client(self.private_origin, console_origin)
        self.client.sign_in("localdemo", "demo-2026-password")
        receipt = self.client.upload(ROOT / "tests/fixtures/format-neutral-decks" / fixture)
        self.deck_version = str(receipt["deckVersion"])
        self.manifest_hash = str(receipt["privateDeck"]["manifestHash"])
        self.runs: list[dict[str, object]] = []

    def request(self, index: int, warmup: bool) -> dict[str, object]:
        marker = len(self.backend.stages)
        outcome = self.client.recommend(self.deck_version, self.manifest_hash)
        run = {
            "index": index,
            "warmup": warmup,
            "outcome": outcome.get("outcome"),
            "reason": outcome.get("reason"),
            "latencyMs": outcome.get("latencyMs"),
            "stages": self.backend.stages[marker:],
        }
        self.runs.append(run)
        return run

    def stop(self) -> None:
        for service in reversed(self.services):
            service.stop()

    def summary(self) -> dict[str, object]:
        measured = [run for run in self.runs if not run["warmup"]]
        latencies = [float(run["latencyMs"]) for run in measured]
        return {
            "label": self.label,
            "models": self.models,
            "runs": len(measured),
            "recommend": sum(1 for run in measured if run["outcome"] == "RECOMMEND"),
            "p50Ms": round(statistics.median(latencies)) if latencies else 0,
            "p95Ms": round(bench.percentile(latencies, 0.95)),
            "maxMs": round(max(latencies)) if latencies else 0,
            "reasons": {
                reason: sum(1 for run in measured if run["reason"] == reason)
                for reason in sorted({str(run["reason"]) for run in measured if run["reason"]})
            },
            "detail": self.runs,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument(
        "--config",
        action="append",
        required=True,
        help="name=rerank,llm,verifier",
    )
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--fixture", default="korean-text-layer.pdf")
    arguments = parser.parse_args()

    topologies: list[Topology] = []
    try:
        for raw in arguments.config:
            name, models = raw.split("=", 1)
            rerank, llm, verifier = models.split(",")
            topologies.append(Topology(name, rerank, llm, verifier, arguments.fixture))
        for index in range(arguments.warmup + arguments.runs):
            warmup = index < arguments.warmup
            for topology in topologies:
                run = topology.request(index, warmup)
                print(
                    f"[{topology.label}] run {index}{' (warmup)' if warmup else ''}: "
                    f"{run['outcome']}{'' if run['reason'] is None else ':' + str(run['reason'])} "
                    f"{run['latencyMs']}ms "
                    f"stages={[(s['stage'], s['latencyMs']) for s in run['stages']]}",
                    file=sys.stderr,
                    flush=True,
                )
        report = [topology.summary() for topology in topologies]
        (OUT / f"{arguments.label}.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        for entry in report:
            print(
                json.dumps({k: v for k, v in entry.items() if k != "detail"}, ensure_ascii=False)
            )
        return 0
    finally:
        for topology in reversed(topologies):
            topology.stop()


if __name__ == "__main__":
    raise SystemExit(main())
