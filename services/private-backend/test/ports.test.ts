import { describe, expect, test } from "bun:test";
import {
  type PublicProjectionWriter,
  SERVER_MODEL_CAPABILITIES,
  type ServerModelRouter,
} from "../src/index.ts";

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

  test("exports ports as types, not runtime adapters", () => {
    const modelRouter: ServerModelRouter | undefined = undefined;
    const projectionWriter: PublicProjectionWriter | undefined = undefined;

    expect(modelRouter).toBeUndefined();
    expect(projectionWriter).toBeUndefined();
  });
});
