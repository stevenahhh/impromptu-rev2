# Task 32 — DETERMINISTIC_MISMATCH 제거 + 5,000ms 예산 동시 만족 구성 판정

**판정: NO.** provider 카탈로그 전수 확인 결과, 아직 시험하지 않은 모델을 포함한 어떤 모델
구성도 (a) deterministic gate 위반 없이 RECOMMEND 에 도달하면서 (b) p95 ≤ 5,000ms 를
동시에 만족하지 못한다. 기본값(deepseek-v4-flash / deepseek-v4-flash / qwen3.6-plus)이
여전히 최선 근접 구성이므로 `.env.example`, `compose.production.yaml`,
`recommendation-pipeline.ts` 변경 없음.

## (a) 카탈로그 조회

`GET https://opencode.ai/zen/go/v1/models` (private-backend `main.ts` 와 동일 base URL,
`OPENCODE_ZEN_API_KEY`) → 29종:

minimax-m3, minimax-m2.7, minimax-m2.5, kimi-k3, kimi-k2.7-code, kimi-k2.6, kimi-k2.5,
glm-5.2, glm-5.3, glm-5.1, glm-5, ox-alpha-free, deepseek-v4-pro, deepseek-v4-flash,
deepseek-v4-flash-vision-exp, qwen3.7-max, qwen3.8-max, qwen3.7-plus, qwen3.6-plus,
qwen3.5-plus, mimo-v2-pro, mimo-v2-omni, mimo-v2.5-pro, mimo-v2.5, hy3, hy3-preview,
gpt-5.6-luna, grok-4.5, muse-spark-1.2-contributor

task-29 에서 이미 시험된 4종 제외 후보 25종 (`screening.json`):

| 후보 | 결과 | 사유 |
|---|---|---|
| qwen3.6-plus | **생존** | 3/3 PASS, 직접호출 p50 1,811ms |
| qwen3.5-plus | **생존** | 3/3 PASS, p50 2,142ms |
| qwen3.8-max | 생존(보더라인) | 2/3 PASS, p50 2,665ms |
| muse-spark-1.2-contributor | 탈락 | grounding 3/3 이나 p50 6,505ms — 단독으로 예산 초과 |
| glm-5.2 / qwen3.7-max | 탈락 | FABRICATED_FACTS 2/3 |
| kimi-k2.6, glm-5.1, glm-5, mimo-v2.5, mimo-v2.5-pro, hy3, gpt-5.6-luna, minimax-m3/m2.7 | 탈락 | 매번 facts 날조 또는 p50 > 4.5s |
| minimax-m2.5, hy3-preview | 배제 | "Reasoning is mandatory" — 어댑터가 reasoning_effort:none 하드코딩(main.ts, 범위 밖) |
| kimi-k3 | 배제 | temperature 0.6 만 허용 — 어댑터 temperature:0 고정 |
| deepseek-v4-pro, ox-alpha-free, glm-5.3, vision-exp, mimo-v2×2( deprecated), grok-4.5(불가), hy3-preview | 배제 | response_format json_schema 미지원 / deprecated / endpoint unavailable |

## (b) 슬롯 스크리닝 (`slot-screening.json`, `chain-explain.ts` 출력)

- verifier 슬롯(정상 근거 입력, 5회): qwen3.5-plus 5/5 SUPPORTED(1.54–1.91s),
  qwen3.8-max 5/5 SUPPORTED(1.33–1.74s), deepseek 5/5(0.82–2.05s).
- rerank 슬롯(5회): qwen3.5-plus 1.13–1.47s 로 안정. deepseek 은 재차 7.0s 테일 관측.
- **체인 실험(결정적)**: 실제 llm 출력을 verifier 에 그대로 투입 시
  qwen3.8-max 는 얇은 fixture 의 정상 근거를 `INSUFFICIENT /
  evidence-lacks-verifiable-content`·`untrusted-evidence-only` 로 거부(5/6 회).
  deepseek verifier 도 파이프라인 내 완주 3회 모두 INSUFFICIENT. 얇은 근거를 지지하는
  빠른 verifier 는 **qwen3.6-plus 가 유일**(chain-explain: 6/6 SUPPORTED).

## (c) 정식 10회 측정표 (현재 HEAD = rerank‖llm 동시 교차 구조, fixture 불변)

| 구성 (rerank / llm / verifier) | RECOMMEND | p50 | p95 | abstain 사유 분포 |
|---|---|---|---|---|
| cfgA deepseek / **qwen3.6** / **qwen3.8-max** | 0/10 | 5,000 | 5,000 | DEADLINE 8, INSUFFICIENT(verifier 거부) 2 |
| cfgB deepseek / **qwen3.6** / deepseek | 0/10 | 4,684 | 5,000 | DEADLINE 5, MISMATCH 2, INSUFFICIENT 3 |
| cfgC qwen3.5 / **qwen3.6** / **qwen3.8-max** | 0/10 | 5,000 | 5,000 | DEADLINE 6, MISMATCH 2, INSUFFICIENT 2 |
| cfgD deepseek / **qwen3.5** / qwen3.6 | 0/10 | 5,000 | 5,000 | DEADLINE 8, CONFLICTING 2 |
| (참고) task-29 deepseek/deepseek/qwen3.6 | 7/10* | 3,648 | 4,221 | CONFLICTING 3 (*구조 변경 전 sequential 측정) |
| (참고) task-29 동일 조합, interleaved | 2/10 | 4,188 | 5,000 | DEADLINE 4, MISMATCH 4 |

원본: `cfgA…cfgD*.json` + `cfg?.stderr.log`(단계별 stage latency 포함).

## (d) 불가능 근거 (구간별 실측)

임계경로 = embedding + retrieval gap + max(rerank, llm) + verifier ≤ 4,500ms(guard 500ms)
- embedding: 158–182ms (cold 707ms). gap: 383–1,132ms (task-29, 현재도 유효).
- **llm 하한**: 근거를 지키는(qwen 계열) 모델의 파이프라인 내 llm 은 최소 1,872ms,
  중앙값 2,100–2,500ms, 테일 3,168–3,679ms. deepseek(976ms)은 부하 하에서 40–60% 확률로
  facts 를 날조해 gate 가 정확히 거부(MISMATCH 4–6/10).
- **verifier 하한**: 얇은 fixture 를 SUPPORT 하는 모델은 qwen3.6-plus(911–1,781ms)뿐.
  더 빠른 deepseek(~1,000ms)와 동급 속도의 qwen3.8-max는 정상 근거를 INSUFFICIENT 로 거부.
- 최상의 관측 성분을 조합해도 158+400+max(819, 1,872)+911 ≈ 3,341ms 로 중앙값은 들어오지만,
  llm 테일(≥2.5s 빈발) 때문에 모든 qwen-llm 구성에서 DEADLINE ≥ 50%. p95 ≤ 5,000 요건과
  충돌. 반대로 빠른 llm(deepseek)은 gate 위반으로 RECOMMEND 자체가 무너짐.

즉 "근거 절제 × 속도" 트레이드오프가 provider 카탈로그 전체에서 동시 만족점을 갖지 않으며,
gate 약화·예산 연장 없이는 해소되지 않는다. 향후 여지는 (1) 신규 모델 등록 시 본 스크리닝
재실행, (2) 얇은 단일 청크 fixture 가 아닌 실제 데크에서의 재판정 뿐이다.

## (e) VERIFY exit code

| 검사 | exit |
|---|---|
| bun run lint | 0 |
| bun run typecheck | 0 |
| bun run build | 0 |
| bun test services/private-backend | 0 (158 pass) |
| bun run test:retrieval | 0 (24 pass) |
| bun run test:security | 0 (15 pass) |

측정 환경: 임시 포트(개발 스택 4173/4174/3001/3002 미사용), DB 역할 impromptu_bootstrap,
fixture `tests/fixtures/format-neutral-decks/korean-text-layer.pdf` 및 acceptance 쿼리 동일,
예산 5,000ms/guard 500ms/gate 미변경.
