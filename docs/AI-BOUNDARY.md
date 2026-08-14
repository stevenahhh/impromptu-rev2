# Server-only AI boundary

## Decision

All model execution that is more than deterministic UI logic runs on the server.

## Server-only capabilities

- streaming STT decoding and endpoint finalization
- OCR and visual-language analysis
- embeddings and vector queries
- reranking
- LLM structured output
- evidence verification
- model-assisted DLP and PII detection
- coaching inference
- generated report summaries

These capabilities are exposed through a typed `ServerModelRouter` inside the private backend. Provider credentials are loaded from the server secret manager, never from a browser-visible environment variable.

## Browser allowlist

The Console and Stage may:

- capture microphone frames and stream them over an authenticated channel
- observe slide, display, and connectivity events
- validate received DTO schemas
- render server-approved public projections
- apply deterministic leases, expiry, tombstones, and revisions
- navigate a signed, cached public deck
- calculate local timers and presentation-only UI state

## Browser denylist

Browser bundles may not contain or invoke:

- WebGPU, ONNX Runtime Web, TensorFlow.js, or a WASM model runtime
- OCR, STT, embedding, reranking, LLM, or VLM inference
- model weights, tokenizers, vector corpora, or private prompts
- AI provider SDKs, endpoints, API keys, or service credentials
- client-generated evidence verdicts, ACL decisions, or public card payloads

When a capability is ambiguous, it defaults to server execution.

## Enforcement

CI must:

1. scan Console and Stage import graphs for forbidden packages;
2. scan browser bundles for model extensions, tokenizer signatures, provider key names, and provider SDKs;
3. ensure browser CSP blocks direct provider connections;
4. test that only the private backend can access provider egress;
5. test that the Projection Gateway has no provider secret or private data path.

## Result metadata

Every model result records:

- capability
- provider and model version
- policy version
- request and trace identifiers
- start, end, and latency
- cache status
- terminal result or typed failure

Content that is not needed for the audit must not be copied into telemetry.
