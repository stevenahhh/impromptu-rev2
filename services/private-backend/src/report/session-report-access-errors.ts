/** Error taxonomy for the session report tables; thrown only at repository boundaries. */

export class SessionReportStateConflictError extends Error {
  readonly code = "SESSION_REPORT_STATE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "SessionReportStateConflictError";
  }
}

export class SessionReportFinalizedError extends Error {
  readonly code = "SESSION_REPORT_FINALIZED";

  constructor(message: string) {
    super(message);
    this.name = "SessionReportFinalizedError";
  }
}

export class SessionReportAccessDeniedError extends Error {
  readonly code = "SESSION_REPORT_ACCESS_DENIED";

  constructor(message: string) {
    super(message);
    this.name = "SessionReportAccessDeniedError";
  }
}
