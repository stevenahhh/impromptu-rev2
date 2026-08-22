# Task 43 — format-neutral fixture 본문 밀도 확충 실측

Date: 2026-08-22 · Commit under test: working tree on top of `dd29b77` · Machine: Apple M5 Pro (arm64)

## (a) 생성기 변경 요약

`scripts/generate-format-neutral-deck-fixtures.py` 를 수정해 세 fixture 를 모두
**6슬라이드 한국어 사업 발표 자료**(가상 회사 한빛유통, 2026년 사업 전략)로 재생성했다.
손으로 바이너리를 만지지 않았고 제너레이터만 고쳤다.

- sentinel `형식 중립 근거 자료 2026` 는 슬라이드 1 제목으로 **글자 그대로 유지**된다.
- 본문에는 deterministic gate 가 축자 검증할 수 있는 사실 토큰이 포함됐다:
  숫자(`482`, `217`, `265`, `151`, `12,400`, `19,000`, `20,000`, `85`, `610`),
  단위/비율(`억 원`, `명`, `%`, `23%`, `78%`, `42.7%`, `18.2%`, `9.6%`, `8.5%`),
  기간(`2025년`, `2026년 3월`, `4분기`, `1~3분기`, `2028년`),
  고유명사(`한빛유통`, `단비`, `모아마켓`, `경영기획본부`).
- PPTX 는 줄마다 네이티브 textbox 1개, text-layer PDF 는 줄마다 `insert_text` 1회로
  **동일한 순서의 TextElement 튜플**을 만들도록 설계했다.
- scanned PDF 는 같은 6페이지를 2x 래스터화한 image-only 페이지이다.
- manifest 에 기계 검증용 밀도 고정값 `density`(slideCount=6, textElementCount=24,
  totalTextCharacters=638)를 추가했고 registry id 를 v2 로 올렸다.
- 재생성 결정성 확인: 동일 커밋에서 3회 재생성 모두 SHA-256 동일
  (pptx `16d089f5…`, pdf `1495ab69…`, scanned `642dc706…`).

## (b) chunk 실측 — 전/후

인덱싱은 실제 업로드 경로로 확인했다: 임시 포트의 private-backend 에
`POST /v1/account-sessions` 로 로그인 후 multipart 필드 `file` 로 업로드(HTTP 201),
그 artifact 를 운영 코드와 동일한 `PostgresDeckRetrievalStore.prepare()` 로 인덱싱했다
(`upload-and-index.py`, `index-chunks.ts`, `upload-receipts.json`, `chunk-evidence.json`).

| 항목 | 이전 (c291450) | 이후 |
|---|---|---|
| 슬라이드 수 | 1 | 6 |
| 텍스트 요소 | 1 (16자) | 24 |
| chunk 수 / deck | 1 (16자) | **6** |
| chunk 길이 | 16자 | **61 / 120 / 110 / 108 / 102 / 132자** |

- 과거 코호트 관측의 "deck 당 2 chunk"는 두 구조 포맷(pdf+pptx) 업로드 분의 합계다 —
  각 deck 은 슬라이드 1장짜리 16자 chunk 1개였다.
- RLS 확인: 조회를 `SELECT set_config('app.tenant_id', 'account_local_demo', true)`
  트랜잭션 안에서 수행해 해당 tenant 의 6행씩 정확히 반환됨.
  bootstrap 역할은 RLS 를 우회하므로(러너 주석 참조) 무컨텍스트 카운트 18은 우회 값이다.
- 인덱스 행은 이 fixture 들의 실재하는 최신 인덱스(deck_version = fixture sha)이므로
  삭제하지 않았다. 다음 recommendation 측정의 prepare 가 그대로 재사용한다.

## (c) PDF/PPTX 텍스트 동일성

- 어댑터 추출 TextElement 튜플: pptx 24개 == pdf 24개, **완전 동일** (`test_frozen_pdf_and_pptx_share_korean_structural_content`).
- 인덱싱된 chunk 내용 6쌍 전부 문자열 동일 (`chunk-evidence.json` 의 `identity.identicalContents: true`).

## (d) OCR sentinel 복원 (OCR_GREEN)

- pinned tessdata_fast(kor `6b85e11d…`, eng `7d4322bd…`) 해시 검증 후 사용.
- 신규 6페이지 scanned fixture 를 실제 Tesseract(PSM 6, 200 DPI)로 실행:
  **슬라이드 1의 sentinel 줄이 오차 없이 정확 복원** — `형식 중립 근거 자료 2026`.
- 10페이지 복제 프로브(`ocr_resource_probe.py`, exit 0): pageCount 10, ocrAppliedPages 10,
  sentinel-bearing 페이지(1, 7번) 양쪽 모두 정확 복원(`exactSentinelPages: 2`).
  본문 줄의 OCR 은 tessdata_fast 특유의 공백 왜곡이 있으나 gate 대상이 아니다.
- 프로브 메트릭을 밀도에 맞게 갱신: 페이지 전체가 sentinel 하나였던 구형
  `exactSentinelPages`(줄 단위 아님) 대신 **줄 단위 정확 복원** 으로 계산하도록 수정.

## (e) VERIFY exit codes

| 명령 | 위치 | exit |
|---|---|---|
| `uv run pytest` | services/ingestion | 0 (109 passed) |
| `uv run ruff check src tests` | services/ingestion | 0 |
| `uv run basedpyright` | services/ingestion | 0 |
| `bun run lint` | repo root | 0 |
| `bun run typecheck` | repo root | 0 |

## 파일 목록

- `upload-and-index.py` — 실제 HTTP 업로드 하니스(임시 포트, IPv4+IPv6 여유 탐지)
- `index-chunks.ts` — 실제 `PostgresDeckRetrievalStore.prepare()` 인덱싱 + RLS 테넌트 컨텍스트 조회
- `upload-receipts.json` / `private-backend.log` — 업로드 201 영수증과 서버 로그
- `chunk-evidence.json` — deck 당 chunk 수·길이·내용과 동일성 판정
- `ocr-probe.json` — OCR 10페이지 프로브 원본 결과
