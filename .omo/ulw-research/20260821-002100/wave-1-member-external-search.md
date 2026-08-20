# wave-1 / external-search (축 완주)

## 가격/기능 (공식 원문)
| 후보 | 가격 | 원문 반환 | 비고 |
|---|---|---|---|
| Brave | $5/1k, 50 rps | ✗ snippet/LLM context | 후보 생성만 필요하면 **최저 직접비용** |
| Tavily | basic $8/1k, advanced $16/1k | ✓ `include_raw_content` markdown/text | production 1,000 RPM |
| Exa | search $7/1k + pages $1/1k | ✓ full text/highlights | |
| SerpAPI | $25/1k~ | ✗ SERP only | hl/gl/lr/cr 한국어 제어 |
| Perplexity | $5/1k | ✓ page content, 토큰량 제어 | |
| Kagi | search $12/1k + extract $4/1k | ✓ full markdown extraction | |
| Google CSE | — | — | 신규 불가 / 2027-01-01 종료 |
| Bing | — | — | 2025-08-11 완전 종료 |
| DDG Instant Answer | — | — | 일반 SERP API 아님 |

## 약관 위험 (이 축의 가장 중요한 산출)
- **Exa ToS §4.2(a)**: Services 에서 얻은 정보를 download/copy/distribute 금지, 표시 목적 브라우저 임시 캐시만 예외.
  **§1.2(c)**: Exa 가 User Input/Output 을 제품 제공·개선 목적으로 host/cache/store 할 **영구 라이선스**.
  → 엔터프라이즈 별도 계약 없이는 **'근거 quote 영구 저장' 과 충돌 가능성이 큰 법무 위험.**
  https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf
- **Tavily ToS §6.5/§9.2**: AI Functionality 의 Input/Output 을 훈련·개선에 사용·보관 가능,
  Customer Input 에 광범위한 perpetual license. 단순 Search API 가 AI Functionality 에 항상 해당하는지 **문언상 불명확** → 계약 확인 필요.
- **Perplexity API ToS §2.3.1~2.3.3**: Customer 가 Input 권리 유지, **Output 소유**, Customer Content 를 **모델 훈련에 사용하지 않음** 명시.
  앱 내 Output 사용/표시 허용. (Cloudflare 를 TLS impersonation 으로 live 원문 확인)
- **Google API 공통약관 §5(e)**: permanent copy/database 금지, cache header 초과 캐시 금지. 저장 정책도 부적합.
- **Kagi**: 검색 query 를 계정과 연결하지 않음. 디버깅 로그 7일(LB/VM), Sentry 오류 90일, 공개 웹페이지 summary cache <=1일.

## claim
- (high) 공개 기본약관만 보면 **Exa 가 근거 원문/quote 영구저장에 가장 큰 계약 리스크**,
  **Perplexity API 약관이 고객 Output 소유·비훈련을 명시해 상대적으로 명확**.
  COUNTER: enterprise MSA 가능성 때문에 일반 약관만으로 최종 법률판단 금지.
- (high) 현 MEASURED p95 4,506ms 추천 경로에 외부 검색 + 다중 원문 fetch 를 넣어 5초 SLA 를 지키는 것은 **구조적으로 여유 없음.**

## 설계 결론 (멤버)
외부 검색을 **확정 발화 이전/직후 비동기 prepared-evidence 잡으로 분리**.
즉시 후보 enqueue, 준비 완료 이벤트만 Console 에 반영. 동기 5초 경로에는 헤드룸 없음.
DEAD END: 외부 검색 + 원문 검증을 기존 동기 추천 p95 5초 안에 **항상** 완료.
