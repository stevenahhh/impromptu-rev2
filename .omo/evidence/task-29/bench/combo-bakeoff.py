#!/usr/bin/env python3
"""Cross-compare claim producers against verifier models on the real evidence chunk.

Each trial generates one structured recommendation per llm model, then submits that exact
recommendation to every verifier model, so verdict differences are attributable to the
verifier alone. Payloads are identical to the shipped adapter.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
from pathlib import Path

MODULE = Path(__file__).with_name("model-bakeoff.py")
spec = importlib.util.spec_from_file_location("model_bakeoff", MODULE)
assert spec is not None and spec.loader is not None
bakeoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bakeoff)

OUT = Path(__file__).parent


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--llm-models", nargs="+", required=True)
    parser.add_argument("--verifier-models", nargs="+", required=True)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--label", default="combo-bakeoff")
    arguments = parser.parse_args()

    results: dict[str, dict[str, object]] = {}
    for llm_model in arguments.llm_models:
        for _ in range(arguments.trials):
            llm_ms, structured = bakeoff.call(
                llm_model,
                {
                    "task": "CREATE_STRUCTURED_RECOMMENDATION",
                    "constraints": {
                        "maySelectTools": False,
                        "maySelectUrls": False,
                        "mayAuthorize": False,
                        "mayPublish": False,
                    },
                    "query": bakeoff.QUERY,
                    "untrustedData": bakeoff.EVIDENCE,
                },
                bakeoff.LLM_SHAPE,
                bakeoff.LLM_SCHEMA,
                512,
            )
            if "error" in structured:
                print(f"{llm_model}: llm error {structured['error']}", file=sys.stderr)
                continue
            for verifier_model in arguments.verifier_models:
                verifier_ms, verdict = bakeoff.call(
                    verifier_model,
                    {
                        "task": "VERIFY_RECOMMENDATION",
                        "constraints": {
                            "untrustedEvidence": True,
                            "mayAuthorize": False,
                            "mayPublish": False,
                        },
                        "recommendation": structured,
                        "untrustedData": bakeoff.EVIDENCE,
                    },
                    bakeoff.VERIFIER_SHAPE,
                    bakeoff.VERIFIER_SCHEMA,
                    256,
                )
                key = f"llm={llm_model} verifier={verifier_model}"
                entry = results.setdefault(
                    key, {"trials": [], "llmMs": [], "verifierMs": [], "verdicts": []}
                )
                entry["llmMs"].append(round(llm_ms))  # type: ignore[union-attr]
                entry["verifierMs"].append(round(verifier_ms))  # type: ignore[union-attr]
                entry["verdicts"].append(verdict.get("verdict"))  # type: ignore[union-attr]
                entry["trials"].append(  # type: ignore[union-attr]
                    {"claim": structured.get("claim"), "verdict": verdict}
                )

    for key, entry in results.items():
        verdicts = entry["verdicts"]  # type: ignore[index]
        supported = sum(1 for verdict in verdicts if verdict == "SUPPORTED")
        entry["supported"] = f"{supported}/{len(verdicts)}"
        entry["llmP50Ms"] = round(statistics.median(entry["llmMs"]))  # type: ignore[arg-type]
        entry["verifierP50Ms"] = round(statistics.median(entry["verifierMs"]))  # type: ignore[arg-type]
        print(
            f"{key}: supported={entry['supported']} llmP50={entry['llmP50Ms']}ms "
            f"verifierP50={entry['verifierP50Ms']}ms verdicts={verdicts}",
            file=sys.stderr,
        )
    (OUT / f"{arguments.label}.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
