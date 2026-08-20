# wave-1 / rag-hybrid (진행 중)

## 실측 (멤버가 로컬에서 직접 측정 — MEASURED)
인메모리 코사인 768차원: p50 **0.57ms(50 chunk) / 4.78ms(500) / 47.6ms(5000)**
→ 멤버 판단: **현 규모에서 ANN(pgvector HNSW/IVFFlat)은 과설계.**

## 한국어 lexical 선택지
- **Kiwi 외부 토크나이징 + tsvector**: 현 `postgres:17-alpine` 제약상 품질/운영 균형 우세 (권장)
- **pg_bigm**: 가장 단순한 DB 확장 대안
- **PGroonga**: 강력하나 이미지 복잡도 큼

## 융합 (근거 확정)
- Bruch et al. 2023 (TOIS / arXiv 2210.11934): **정규화 가중합(CC)이 in/out-of-domain 에서 RRF 를 능가**,
  RRF 도 파라미터 민감.
- Elastic 재현: 약 40개 annotated query 로 RRF 를 이길 수 있었다고 보고.
→ 결론: **라벨 0인 현재는 RRF 로 시작**, 한국어 발표 질의셋 40~100개 확보 후 정규화 가중합 튜닝,
  learned fusion 은 그 이후.
