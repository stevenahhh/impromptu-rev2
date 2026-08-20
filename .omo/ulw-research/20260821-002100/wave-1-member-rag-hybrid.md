# wave-1 / rag-hybrid (축 완주, 9m28s)

## 결론
현 규모에서 **pgvector/ANN 과 reranker 를 넣지 말 것**. 순서:
구조적 원문 추출 → Kiwi 기반 한국어 lexeme `tsvector`+GIN → 기존 exact dense → RRF.
수천~수만 authorized chunks/query 로 커질 때 pgvector exact → HNSW 재평가.

## 코드 현실 vs 신청서 (신규 결함 발견)
- ACL-first 순서는 **좋은 기반**: `prepare()` 권한 확인 → `prefilter()` tenant/deck_version/manifest_hash/auth-version 으로 object id 제한 → `search()` 가 그 id 만 읽음.
- 그러나 **`source_revision` 에 실제 문서 revision 이 아니라 chunk content SHA-256 을 저장**.
  `title` 은 `Slide N`, `anchor` 는 `slide=N&chunk=M` 뿐.
  **없음: 사용자/그룹 ACL, 원문 heading/page/line/JSON Pointer, authored/modified/indexed 시각, 원문 경로.** `created_at` 만 존재.
  → 신청서 7항("각 검색 단위에 접근 가능 사용자·그룹 / 문서 ID·revision / heading·page·line·JSON Pointer / 작성·수정·색인 시각 / 원문 경로·content hash 결합") **미충족.**
- `extractSvgText()` 는 **XML 파서가 아니라 regex**. 태그 제거 후 `&lt;...&gt;` 를 디코드하므로
  **escaped `<date/time>` sentinel 이 태그 제거 단계를 우회.** (fix-1 의 문자열 제거는 증상 대응이었음)
- `chunkText()` 는 **의미 경계 없이 2,000자 절단**.
- DB 는 `postgres:17-alpine` 그대로이고 custom Dockerfile 없음 → pg_bigm/PGroonga/pgvector 도입 시
  **DB 이미지 소유·빌드·패치 책임이 새로 생김.** `pg_trgm` 은 contrib 라 가장 가벼움.

## 한국어 lexical 전수 비교 (2026-08-20 유지보수 상태 확인)
| 선택지 | 설치/운영 | 한국어 품질 | 유지보수 | 라이선스 | 판단 |
|---|---|---|---|---|---|
| pg_trgm / 앱 ngram | contrib 또는 `array_to_tsvector`, Alpine 부담 최소 | 형태소 모름. 띄어쓰기 파손·부분문자열·오타에 강함. 인덱스 부피↑ | core | PostgreSQL | baseline / A-B |
| pg_bigm | C ext 를 custom PG17 Alpine 이미지에 빌드 | 공백 의존 약한 언어에 높은 recall. 조사·어미 구분 없음, index bloat | 2026-08-04 커밋, PG19 지원 | PostgreSQL | DB-only 최간단 대안 |
| PGroonga | 공식 패키지 Debian/Ubuntu 중심, **Alpine 이 가장 복잡** | ngram/normalizer/highlight 최강. 기본은 형태소가 아니라 language-agnostic | 2026-08-20 커밋, PG12~18 | PGroonga PostgreSQL / Groonga LGPL2.1 | 기능 최강, **운영 과중** |
| textsearch_ko + mecab-ko | MeCab+사전+PG ext 3중 native 빌드. README 는 PG15 예시 | 형태소/원형 precision | **핵심 코드 커밋 2016**, Rust 포크는 drop-in 아님 | BSD-2 + MeCab tri-license | **신규 채택 비추천** |
| **Kiwi/kiwipiepy 외부 토크나이징 + tsvector** | Python wheel 을 ingestion 에 고정, DB 는 표준 tsvector+GIN | 활발. 복합어/오탈자/`space_tolerance` | **2026-08 활발** | **LGPL 2.1-or-later** | **추천** |

추천 구조: ingestion 이 visible OOXML text 에서 Kiwi 표제어/주요품사 lexeme + 2-gram 보조 lexeme 생성,
tokenizer/model/dict version 저장 → PG17 공식 `array_to_tsvector(text[])` + GIN → query 도 같은 Kiwi 버전.
**원문 canonical text 는 보존하고 정규화 텍스트/lexeme 는 별도 필드** (Kiwi 띄어쓰기 보정이 원문을 덮으면 인용 무결성 파손).
품질은 일반 benchmark 가 아니라 **이 덱의 질문-관련 chunk 라벨로 Recall@k / nDCG@10 / MRR** 측정.
→ 네 방식의 한국어 동일-corpus 독립 benchmark 는 **찾지 못함**(공백).

## pgvector — 지금은 보류 (MEASURED)
Bun/Float64Array 동형 벤치: 768d **50행 p50 0.57 / p95 0.62ms (payload 0.293MiB)**,
**500행 4.78 / 4.95ms (2.93MiB)**, **5,000행 47.6 / 48.5ms (29.3MiB)**.
→ 수십 chunk/덱 에서는 embedding/LLM/network 보다 훨씬 작음. 지금 도입은 성능 해결이 아니라 운영 surface 확대.
도입 조건: authorized candidate 수 / DB bytes / search p95 계측 후 **수천 candidate/query 또는 payload·코사인이 실제로 예산 침범할 때.**
경로: `CREATE EXTENSION vector`; `double precision[]`→`vector(768)` cast 는 pgvector 공식 cast test 지원.
운영 데이터는 새 컬럼 → batch backfill → 차원/finite 검증 → dual-read 비교 → swap. vector 는 2,000차원까지라 768 은 범위 내.
**첫 단계는 ANN 이 아니라 exact `ORDER BY embedding <=> q LIMIT k`.** ANN 필요 시 동적 증분 corpus 에는 HNSW 우세(training 불필요).
**중요 반증**: pgvector 공식 문서가 ANN 에서 `WHERE` filter 가 index scan **뒤** 적용돼 결과 부족/recall 저하,
multi-tenant 공유 ANN 에서 타 tenant 벡터가 recall/speed 에 영향을 준다고 명시.
→ "권한을 검색 전에 적용" 을 엄격히 지키려면 authorized exact set / tenant·ACL partition / partial index / iterative scan 이 선행.
**임의 사용자·그룹 ACL 에서 global HNSW 성급 도입 금지.**

## fusion
- 라벨 0인 현재: lexical top 20~50 + dense top 20~50 을 **RRF `Σ 1/(k+rank)`, k=60 시작점**. scale 보정 불필요, 감사 쉬움.
- 라벨 40~100 확보 후: BM25/`ts_rank_cd` 와 cosine 을 query 별 정규화한 convex weighted sum 튜닝 (Bruch TOIS 2023).
- learned fusion/LTR 은 그 이후. 수십 chunk + 라벨 0 에서는 누수·과적합이 이득보다 큼.
- **두 branch 는 동일 materialized `authorized_current_chunks` 에서 시작하고, fusion/rerank 뒤가 아니라 branch 실행 전에 ACL+현재 revision+content hash 확인 불가 행을 제외.**

## reranking
`BAAI/bge-reranker-v2-m3`: Apache-2.0, XLM-R 24층/hidden 1024/max pos 8194, FP32 **2,271,071,852 bytes**.
model card 의 "lightweight" 문구와 달리 실시간 경로에서 공짜 아님.
적용 시: RRF top 10~20, query+chunk 최대 512 tokens, batch, **private/local process 로만**,
한국어 덱 eval + 대상 CPU/GPU cold/warm p50·p95 통과 후 **opt-in**.
**원격 LLM rerank 는 배제** — 25초 tail 실측 + authorized private chunk 를 외부 모델로 보내는 정책/감사 문제.

## 청킹 (2,000자 절단 → 계층형)
- **parent = slide**: 제목/page/deck heading/source·revision·hash·path 보존. 슬라이드 경계 넘어 합치지 않음.
- **child = shape/불릿 그룹/표 행 묶음**: 희소 슬라이드는 slide 전체 1 child. 밀집은 제목을 각 child 에 prefix,
  의미 경계 기준 **약 80~250 tokens**. oversized 요소만 문장 경계 + 작은 overlap 으로 절단.
- child 로 retrieval → parent slide(+필요시 앞뒤 1 slide) 로 generation context 확장 (AWS hierarchical chunking).
- title/shape/page boundary 우선, 일반 sliding window 는 최후 수단 (Unstructured `by_title` 의 overlap "pollution" 경고).
- Azure 의 512-token/25% overlap 은 generic 시작점이지 짧은 slide 에 그대로 적용할 값 아님.
- 각 child 는 결합된 원소 provenance 목록을 유지해 heading/page/line/JSON Pointer 를 잃지 않아야 함.

## SVG 텍스트 품질 — 근본 해결은 OOXML sidecar
**root fix**: ingestion 은 이미 PPTX slide XML 과 SVG 를 동시에 읽고 shape id/center 를 `map_slide()` 에서 대응시킴.
검색 시 SVG 를 regex 로 다시 긁지 말고, **ingestion 에서 visible OOXML text 를 shape id/좌표/placeholder type 과 함께
private `retrieval.json` sidecar 로 생성**. 그러면 package path(`ppt/slides/slideN.xml`), shape id 기반 JSON Pointer,
page, heading, text run/line, source hash 를 직접 보존하고 **DateTime/Footer/PageNumber 를 OOXML placeholder type 으로 제거**.
단기 SVG extractor 유지 시: bounded XML parser(DOCTYPE/ENTITY 거부) → `Page` 아래 `<text>/<tspan>` 만 수집하고
DateTime/Footer/PageNumber/Header class 그룹 제외(프로젝트 `render/source.py` 에 동일 ignore set 이 이미 있음) →
inherited transform + x/y/dx/dy + font size + writing mode 계산, mapped shape 내부 DOM 순서 우선,
shape 간에는 title first → column segmentation → y-baseline cluster → x 순서(**단순 전역 y/x 정렬은 2단 layout 을 섞음**) →
Unicode NFC, NBSP/zero-width 정리, punctuation 주변만 정규화(**Hangul 사이 모든 공백을 지우지 말 것**;
같은 glyph run 에서 실제 whitespace node 없이 geometry 가 연속인 fragment 만 결합) →
Kiwi spacing 보정은 normalized-search field 에만 → escaped sentinel 은 **decode 후** exact token allowlist 로 제거.
**현재 regex 순서는 이 조건을 만족하지 못함.**

## 권장 스키마
`retrieval_documents(tenant_id, document_id, current_revision, source_path, source_content_hash, authored_at, modified_at, indexed_at, acl_snapshot_hash)`
`retrieval_acl_grants(tenant_id, document_id, revision, subject_type USER|GROUP, subject_id)`
`retrieval_chunks(document_id, revision, chunk_id, parent_slide_id, heading, page_number, line_start, line_end, json_pointer, canonical_content, normalized_content, lexical tsvector, embedding double precision[768], content_hash, tokenizer_version, embedding_model_version, indexed_at)`
query: principal user/group → authorized grants join → document current_revision exact join + non-null revision/hash/path →
lexical & dense branch → RRF → metadata/hash/revision 재검증 → optional local rerank. **확인 불가/null 은 fail-closed 제외.**

## EXPAND (미해결)
- 4-way 한국어 lexical benchmark (Kiwi / pg_bigm / PGroonga / ngram) on 실제 slide corpus — 공개 동일-corpus 비교 없음
- bge-reranker-v2-m3 의 실제 배포 지연 (Apple M5 / 한국어 top-20 p95, PyTorch MPS vs ONNX/OpenVINO/TEI)
- strict ACL + ANN 충돌 (materialized authorized CTE exact vs tenant partition HNSW iterative scan)
- **PDF-origin provenance — OOXML sidecar root fix 가 PDF 를 커버하지 않음** (PyMuPDF blocks/spans 좌표, page/line anchor)
