import type { ModelError, ModelErrorCode } from "./schemas.ts";

export class ModelRouterError extends Error {
  readonly modelError: ModelError;

  constructor(code: ModelErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ModelRouterError";
    this.modelError = { code, message, retryable };
  }
}
