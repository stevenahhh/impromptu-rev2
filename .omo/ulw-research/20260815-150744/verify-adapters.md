# Verify: 렌더링 경계 부재 (adapters/base.py)

**Claim**: C21 — `services/ingestion`의 `adapters/base.py`가 `render_slides()`에서 `RenderingUnsupportedError`를 던져 렌더링이 의도적으로 부재 (HIGH RISK, run의 핵심 발견)

**Verification path**: lead 직접 재독 (Read tool, 전체 파일)

**Observed (verbatim)**:
```python
class RenderingUnsupportedError(RuntimeError):
    """Raised when callers cross the intentionally absent rendering boundary."""

@staticmethod
def render_slides() -> NoReturn:
    raise RenderingUnsupportedError(
        "slide rendering is not configured; structural extraction cannot verify fidelity"
    )
```

**Verdict**: **CONFIRMED** — 2개 독립 관측자 수렴 (ingestion-integration 워커 + lead 직접 재독). render_slides는 스태틱 메서드로 NoReturn 시그니처이며 예외를 던진다. 파생 주장(C50 전체 adapters/ 오디트, C21)도 render-pipeline이 전체 디렉토리를 감사해 지지.

**파생 영향**: 설계포크 D2의 근거 — 첫 데모는 private upload + operator 수동 렌더 경로 (b).
