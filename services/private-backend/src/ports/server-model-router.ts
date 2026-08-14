export const SERVER_MODEL_CAPABILITIES = [
  "stt",
  "ocr-vlm",
  "embedding",
  "rerank",
  "llm-verifier",
  "dlp-pii",
  "coaching",
  "report-summary",
] as const;

export type ServerModelCapability = (typeof SERVER_MODEL_CAPABILITIES)[number];

export interface ModelOperation<Input, Output> {
  readonly capability: ServerModelCapability;
  readonly input: Input;
  readonly decodeOutput: (value: unknown) => Output;
}

export interface ModelExecution<Output> {
  readonly output: Output;
  readonly provider: string;
  readonly modelVersion: string;
  readonly policyVersion: string;
  readonly traceId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly latencyMs: number;
}

export interface ServerModelRouter {
  execute<Input, Output>(operation: ModelOperation<Input, Output>): Promise<ModelExecution<Output>>;
}
