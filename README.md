# impromptu-rev2

발표 보조 **PWA** 프로젝트. `impromptu-r2`에서 이어받은 구현 저장소이며, Public **Stage**(프로젝션 화면)와 Private **Presenter Console**(발표자 기기)을 분리하고, Windows 확장/복제 디스플레이 환경을 모두 지원한다. 준비된 증거(prepared evidence)를 큐레이션하고, 비자명한 AI 연산은 전부 서버 측에서 수행한다.

- **근거 문서:** `docs/신청서.pdf`(요구사항), `docs/PWA-구현-최적화-연구보고서.md`(+HTML/PDF)
- **구현 계획(승인됨):** `.omo/plans/impromptu-r2-hyperplan.md`
- **진행 상태:** WP0~WP10 전 워크팩 검증 완료(`plan-complete`), 이후 render 파이프라인(PPTX → SVG → 슬라이드 타임라인) 작업 추가 진행 중

---

## 제품 계약

- 프로젝션 머신은 public-only **Stage** 프로필로 동작한다.
- 별도로 인증된 기기가 private **Console**을 실행한다(보안 기본값은 두 화면 모드 동일).
- 큐레이션된 증거가 첫 번째 산출물이며, live evidence는 안전·유용성 게이트를 통과하기 전까지 private으로 유지된다.
- 발행(publish)은 서버가 승인하는 명시적 전환으로, 닫힌 public DTO를 만든다.
- STT, OCR/VLM, embedding, reranking, LLM 추론, 검증, DLP, 코칭 추론, 보고서 요약 생성은 **서버에서만** 실행된다.

## 보안 경계

- Stage는 public projection gateway/store만 접근한다. private 세션 권위, transcript, 후보, private deck, RAG, 팀 메시지 경로에 credential이나 네트워크 경로가 없다.
- 브라우저 번들에는 WebGPU/ONNX/WASM 모델 런타임, 모델 가중치, 토크나이저, AI provider SDK/키가 포함될 수 없다. (`config/browser-forbidden-dependencies.json`으로 강제)
- 상세: `docs/AI-BOUNDARY.md`

---

## 저장소 구조

```text
apps/                    브라우저 PWA
  console/               Private Presenter Console (Vite, port 4173)
  stage/                 Public Stage (Vite, port 4174)
services/                서버 배포 단위
  private-backend/       private 세션·증거·추천·AI 라우팅 백엔드 (Bun)
  projection-gateway/    public projection 전용 게이트웨이 (Bun)
  model-router/          타입화된 서버 모델 라우터 (라이브러리)
  ingestion/             구조적 deck ingestion 워커 (Python 3.14+, uv)
packages/                공유 라이브러리
  contracts/             도메인 계약·스키마 (role-scoped)
  state/                 리듀서·권위·에포크·리스 상태
  slide-runtime/         브라우저 슬라이드 타임라인 재생
  ui/                    공유 UI 컴포넌트
  test-harness/          테스트 헬퍼·하니스
infra/                   DB 마이그레이션(cluster/private/projection)·Docker 하니스
tests/                   교차 contract·보안·E2E·property·soak 검증
scripts/                 repo 검증·브라우저 경계·릴리스 게이트 스크립트
docs/                    제품·보안·연구·운영 문서, runbooks
config/                  브라우저 금지 의존성 목록
.omo/                    에이전트 작업 맥락 (계획·연구·증거) — 아래 참고
```

## 기술 스택

- **Bun 1.3+** — 런타임·패키지 매니저·테스트 러너 (`packageManager: bun@1.3.14`)
- **TypeScript 5.9**, **React 19**, **Vite 7** (React Router 7)
- **Biome** — 린트/포맷
- **happy-dom + Testing Library + fast-check** — 단위·속성 테스트
- **playwright-core** — 브라우저 E2E/시각 QA
- **Python 3.14 + uv** — ingestion 워커 (`services/ingestion/`)
- **PostgreSQL(Docker)** — infra/database (cluster/private/projection 3-way 분리)

---

## 빠른 시작 (다른 컴퓨터에서 이어서 작업)

```bash
git clone <repo-url> impromptu-rev2
cd impromptu-rev2
bun install
bun run check        # 전체 검증 게이트 (아래 참고)
```

개발 서버:

```bash
bun run dev:console      # Console → http://localhost:4173
bun run dev:stage        # Stage   → http://localhost:4174
bun run --cwd services/private-backend dev     # private 백엔드
bun run --cwd services/projection-gateway dev  # projection 게이트웨이
cd services/ingestion && uv sync && uv run ... # ingestion 워커
```

## 명령 모음 (루트 package.json)

| 명령 | 용도 |
|---|---|
| `bun run dev:console` / `bun run dev:stage` | PWA 개발 서버 |
| `bun run build` | ui → console → stage 빌드 |
| `bun run check` | **전체 게이트**: repo 정책 → 아키텍처 경계 → 빌드 → 브라우저 경계 → lint → typecheck → 전체 테스트 → 브라우저 런타임 |
| `bun run check:repo` | 저장소 정책 검증 (계획·신청서·산출물 존재 등) |
| `bun run check:boundaries` | 서비스 아키텍처 경계 검증 |
| `bun run check:browser*` | 브라우저 의존성·런타임 경계 검증 |
| `bun run lint` / `bun run typecheck` | Biome / tsc |
| `bun test` | 전체 테스트 (최대 동시성 1, 30s 데드라인) |
| `bun run test:e2e` | WP3/WP4 E2E (prepared evidence, Windows topology) |
| `bun run test:soak` | WP5 실시간 soak (500 커맨드, 50 reconnect) |
| `bun run test:db*` | DB 마이그레이션·역할 분리·동시성 하니스 (Docker) |
| `bun run test:retrieval` | WP7 검색·추천 파이프라인 |
| `bun run test:security` / `test:release-security` | 보안 계열 |
| `bun run test:wp8*` | WP8 발행 안전 게이트·동시성·라이브 발행 |
| `bun run test:wp9` | WP9 제품 검증 |
| `bun run test:aggregate` / `test:aggregate:10` | WP10 릴리스 게이트 (1회 / 10회 반복) |
| `bun run test:stt-bakeoff` | STT 모델 bakeoff |
| `bun run test:audio-lifecycle` | 오디오 캡처 수명주기·보안 |

테스트를 새로 작성할 때는 기존 스타일을 따른다: 시간 기반 폴링 대신 이벤트 신호 + 명시적 데드라인, 측정 대상(SLA)과 러너 예산을 분리한 타임아웃.

## 워크팩 진행 상황

| WP | 내용 | 상태 |
|---|---|---|
| WP0 | 저장소·정책·도구 기반 | ✅ (verifier 확인) |
| WP1 | 계약·스키마·프로토콜 (role-scoped, capability, epoch) | ✅ |
| WP2 | DB(3-way 분리)·프론트 2종·ingestion·model-router·서버 | ✅ |
| WP3 | 준비된 증거(prepared evidence) E2E | ✅ |
| WP4 | 스테이지 인과·투스크린 토폴로지 E2E | ✅ |
| WP5 | 실시간 제어·리스·reconnect + soak | ✅ |
| WP6 | 오디오 캡처·STT 수명주기·보안 | ✅ |
| WP7 | 검색·벡터·추천 파이프라인 | ✅ |
| WP8 | 발행 CAS·tombstone·안전 게이트 | ✅ |
| WP9 | 제품 검증 (데모 범위·접근성·매뉴얼 QA) | ✅ |
| WP10 | 릴리스 보안 게이트·매뉴얼 QA | ✅ (plan-complete) |
| 이후 | render 파이프라인: PPTX → SVG → 슬라이드 타임라인 → 브라우저 재생, 발행 연동 | 🔄 진행 중 |

## .omo 디렉토리 (에이전트 작업 맥락)

omo/senpi로 작업을 이어갈 때 필요한 맥락이 전부 들어 있다.

```text
.omo/
  plans/impromptu-r2-hyperplan.md   # 승인된 구현 계획 (biding plan)
  boulder.json                      # 활성 작업 포인터 (start-work 상태)
  start-work/ledger.jsonl           # WP별 실행·검증·커밋 증거 원장
  hyperplan/pwa-presentation-debate.md   # 계획 수립 디베이트
  ulw-research/                     # 연구 세션 산출물
    20260814-040838/                # PWA 구현 최적화 연구 (SYNTHESIS, claim-graph, sources-ledger…)
    20260815-150744/                # WebTransport/PWA 연구 (report.md, verify-*.md, wave digests)
  application-text.txt              # 신청서 텍스트 추출본
  scratch/                          # QA 산출물 (golden-oracle, render-qa) — 참고용
```

`.omo/senpi-task/`는 실행 중 세션의 런타임 상태(트랜스크립트·팀 메일박스)로 gitignore 처리되어 있다. 과거 스냅샷은 커밋 히스토리에 보존되어 있다.

## 작업 방식

- **브랜치:** `main`이 canonical 통합 브랜치. 과거 WP topic 브랜치(`feat/wp*`, `fix/*`)는 통합·대체 완료된 잔여 브랜치이며, 새 작업은 `main`에서 topic 브랜치를 만들어 진행한다.
- **커밋:** 하나의 검증된 인크리먼트를 원자적 커밋으로 남긴다. 검증 게이트(`bun run check`) 통과가 원칙. `CONTRIBUTING.md` 참고.
- **AI 경계:** 모든 비자명 AI 연산은 서버 전용. 브라우저에는 금지 의존성 목록이 적용된다(`docs/AI-BOUNDARY.md`).
- **운영 문서:** `docs/runbooks/` — vendor-prewarm, venue-failure-recovery.

## 문서 목록

- `docs/신청서.pdf` — 제품 요구사항(원본)
- `docs/PWA-구현-최적화-연구보고서.md/.html` — 연구 보고서
- `docs/AI-BOUNDARY.md` — 서버 전용 AI 경계
- `docs/DEMO-SCOPE.md` — 데모 범위
- `docs/accessibility-matrix.md` — 접근성
- `docs/final-manual-qa.md` — 최종 매뉴얼 QA
- `docs/runbooks/*` — 운영 런북
