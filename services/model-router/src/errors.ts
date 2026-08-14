import { type ModelError, type ModelErrorCode, modelErrorSchema } from "./schemas.ts";

export class ModelRouterError extends Error {
  readonly modelError: ModelError;

  constructor(code: ModelErrorCode, message: string, retryable: boolean) {
    const modelError = modelErrorSchema.parse({ code, message, retryable });
    super(modelError.message);
    this.name = "ModelRouterError";
    this.modelError = Object.freeze(modelError);
  }
}

export function normalizedModelError(
  code: ModelErrorCode,
  message: string,
  retryable: boolean,
): ModelError {
  return Object.freeze(modelErrorSchema.parse({ code, message, retryable }));
}
