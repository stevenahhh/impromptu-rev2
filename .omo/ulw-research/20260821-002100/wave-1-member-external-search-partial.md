# wave-1 / external-search (진행 중)

## 검색 API 후보 (전부 공식 원문 직접 fetch 로 확인)
| 후보 | 가격 | 원문 본문 반환 | 비고 |
|---|---|---|---|
| Brave | $5/1,000 req, 50 rps | ✗ (snippet/LLM context, 최대 5 snippets/page) | ZDR 은 엔터프라이즈만 |
| Tavily | $0.008/credit, 월 1,000 무료. basic 1 / advanced 2 credit | ✓ `include_raw_content` → cleaned+parsed markdown/text | production 1,000 RPM |
| Exa | Search $7/1k + Contents $1/1k pages | ✓ full page text/highlights/summaries | 검색 호출에서 contents 옵션 |
| SerpAPI | Free 250, $25/1k ~ $150/15k | ✗ 구조화 SERP | hl/gl/lr/cr 로 한국어·한국 제어. 1h 캐시, cached 무료 |
| Google CSE | — | — | **신규 가입 불가**, 2027-01-01 종료 |
| Bing Search API | — | — | **2025-08-11 완전 retired**, 신규 불가 |
| Perplexity `/search` | 추출 중 | ✓ web page contents, low/medium/high 토큰 제어 | |
| Kagi | 확인 중 | ? | Public Beta 제약 확인 중 |

## claim
- (high) 신규 제품의 웹 검색 후보 생성기로 **Google CSE 와 Bing Search API 는 사용 불가**.
  PRIMARY: developers.google.com/custom-search/v1/overview, learn.microsoft.com/lifecycle/announcements/bing-search-api-retirement
- (normal) Tavily 와 Exa 는 검색 + 원문 본문 반환을 한 API 계열에서 제공.

## 이 축의 핵심 설계 분기 (멤버가 제기)
Brave 처럼 **URL 후보만 구매하고 원문은 자체 SafeExternalEvidenceFetcher 로 fetch** 할 것인가,
아니면 Tavily/Exa 의 원문 반환을 쓸 것인가. 후자는 SSRF·redirect 재검증·원문 무결성 경계를
외부 사업자에게 위임하는 것 — 현재 자체 fetcher 가 더 강한 보안 불변식을 보유.
