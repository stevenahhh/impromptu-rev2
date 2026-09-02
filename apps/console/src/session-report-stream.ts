// Report finalization: subscribing to the private controller event stream before
// ending the presentation, awaiting the exact REPORT_READY signal, and reading an
// already-finalized report on reload.

import {
  mutationHeaders,
  type PrivateClientContext,
  responseBody,
  stringField,
} from "./private-transport";
import {
  type SessionReportReadView,
  type SessionReportView,
  sessionReport,
} from "./session-report-view";

export class SessionReportClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "SessionReportClientError";
  }
}

export async function endPresentationAndAwaitReport(
  context: PrivateClientContext,
  csrfToken: string,
  presentationSessionId: string,
): Promise<SessionReportView> {
  const { baseUrl, createReportEventSource, reportReadyTimeoutMs } = context;
  const source = createReportEventSource(
    `${baseUrl}/v1/playback/controller-events?presentationSessionId=${encodeURIComponent(presentationSessionId)}`,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveOpened: () => void = () => {};
  let rejectOpened: (error: Error) => void = () => {};
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  let resolveReport: (report: SessionReportView) => void = () => {};
  const ready = new Promise<SessionReportView>((resolve) => {
    resolveReport = resolve;
  });
  const onOpen: EventListener = () => resolveOpened();
  const onError: EventListener = () => rejectOpened(new Error("Private report stream failed."));
  const onReportReady: EventListener = (event) => {
    const data = "data" in event ? event.data : undefined;
    if (typeof data !== "string") return;
    let body: unknown;
    try {
      body = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    const envelope = body as Record<string, unknown>;
    const parsed = sessionReport(envelope.report);
    if (
      envelope.kind !== "REPORT_READY" ||
      envelope.presentationSessionId !== presentationSessionId ||
      parsed?.presentationSessionId !== presentationSessionId
    ) {
      return;
    }
    resolveReport(parsed);
  };
  source.addEventListener("open", onOpen);
  source.addEventListener("error", onError);
  source.addEventListener("REPORT_READY", onReportReady);
  const bounded = <Value>(promise: Promise<Value>, message: string) =>
    Promise.race([
      promise,
      new Promise<Value>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), reportReadyTimeoutMs);
      }),
    ]);
  try {
    await bounded(opened, "Private report stream did not open in time.");
    if (timeout !== undefined) clearTimeout(timeout);
    const response = await fetch(
      `${baseUrl}/v1/presentation-sessions/${encodeURIComponent(presentationSessionId)}/end`,
      {
        method: "POST",
        credentials: "include",
        headers: mutationHeaders(csrfToken),
      },
    );
    const body = await responseBody(response);
    if (response.status !== 202) {
      const code = stringField(body, "error") ?? "presentation_end_failed";
      throw new SessionReportClientError(response.status, code);
    }
    const report = await bounded(ready, "Finalized report signal did not arrive in time.");
    if (timeout !== undefined) clearTimeout(timeout);
    return report;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    source.removeEventListener("open", onOpen);
    source.removeEventListener("error", onError);
    source.removeEventListener("REPORT_READY", onReportReady);
    source.close();
  }
}

export async function readFinalizedReport(
  context: PrivateClientContext,
  presentationSessionId: string,
): Promise<SessionReportReadView> {
  const response = await fetch(
    `${context.baseUrl}/v1/presentation-sessions/${encodeURIComponent(presentationSessionId)}/report`,
    { credentials: "include" },
  );
  const body = await responseBody(response);
  if (response.status === 202) return { status: "PENDING" };
  const parsed =
    typeof body === "object" && body !== null ? sessionReport(Reflect.get(body, "report")) : null;
  if (response.ok && parsed?.presentationSessionId === presentationSessionId) {
    return { status: "FINALIZED", report: parsed };
  }
  const code = stringField(body, "error") ?? "report_read_failed";
  throw new SessionReportClientError(response.status, code);
}
