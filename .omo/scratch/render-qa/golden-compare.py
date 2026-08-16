"""Golden comparison: PowerPoint's own effect metadata vs our parsed timeline.

Usage:
  python golden-compare.py <golden.json> <render.json>

PowerPoint MsoAnimEffect ids we author in the golden deck:
  10 = Fade (entrance), 2 = Fly In (entrance), 54 = Change Fill Color (emphasis)
MsoAnimTriggerType: 1 = OnPageClick, 2 = WithPrevious, 3 = AfterPrevious
"""

import json
import sys
from pathlib import Path

_EFFECT_CLASS = {10: "entrance", 2: "entrance", 54: "emphasis"}
_TRIGGER = {1: "on_click", 2: "with_previous", 3: "after_previous"}


def main() -> int:
    golden = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    render = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    if isinstance(golden, dict):
        golden = [golden]

    ours = [
        {
            "shape": effect["target"]["shape_name"],
            "effect_class": effect["effect_class"],
            "trigger": effect["trigger"],
            "duration_ms": effect["duration_ms"],
            "svg": effect["target"]["svg_element_id"],
        }
        for timeline in render["timelines"]
        for group in timeline["click_groups"]
        for effect in group
    ]
    theirs = [
        {
            "shape": entry["shape"],
            "effect_class": _EFFECT_CLASS.get(entry["effectType"], f"unknown:{entry['effectType']}"),
            "trigger": _TRIGGER.get(entry["trigger"], f"unknown:{entry['trigger']}"),
            "duration_ms": round(entry["durationSeconds"] * 1000),
        }
        for slide in golden
        for entry in slide.get("effects", [])
    ]

    print(f"PowerPoint 효과 {len(theirs)}개 / 우리 파서 {len(ours)}개")
    mismatches = 0
    for index in range(max(len(theirs), len(ours))):
        left = theirs[index] if index < len(theirs) else None
        right = ours[index] if index < len(ours) else None
        if left is None or right is None:
            print(f"  [{index}] 개수 불일치: powerpoint={left} ours={right}")
            mismatches += 1
            continue
        same = (
            left["shape"] == right["shape"]
            and left["effect_class"] == right["effect_class"]
            and left["trigger"] == right["trigger"]
            and abs(left["duration_ms"] - right["duration_ms"]) <= 50
        )
        mark = "OK " if same else "DIFF"
        if not same:
            mismatches += 1
        print(
            f"  [{index}] {mark} powerpoint={left['shape']}/{left['effect_class']}/"
            f"{left['trigger']}/{left['duration_ms']}ms  ours={right['shape']}/"
            f"{right['effect_class']}/{right['trigger']}/{right['duration_ms']}ms -> {right['svg']}"
        )
    print("GOLDEN SEMANTIC: " + ("PASS" if mismatches == 0 else f"FAIL ({mismatches})"))
    return 0 if mismatches == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
