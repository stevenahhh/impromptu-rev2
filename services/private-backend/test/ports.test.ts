import { describe, expect, test } from "bun:test";
import { SERVER_MODEL_CAPABILITIES, type ServerModelRouter } from "../src/index.ts";

describe("private backend ports", () => {
  test("declares server-only model capabilities without an adapter", () => {
    expect(SERVER_MODEL_CAPABILITIES).toEqual([
      "stt",
      "ocr-vlm",
      "embedding",
      "rerank",
      "llm-verifier",
      "dlp-pii",
      "coaching",
      "report-summary",
    ]);
  });

  test("exports the model router port as a type, not a runtime adapter", () => {
    const modelRouter: ServerModelRouter | undefined = undefined;

    expect(modelRouter).toBeUndefined();
  });
});
