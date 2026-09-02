import { Panel } from "@impromptu/ui";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import { PresentationReport } from "./presentation-report";
import { presentationReportText } from "./presentation-report-text";
import { QaDefensePanel } from "./qa-defense-panel";
import { record } from "./server-payload";
import type { SessionReportView } from "./session-client";
import { sessionReport } from "./session-report-view";

function navigationReport(value: unknown, presentationSessionId: string): SessionReportView | null {
  // The closed parser decides — not a version equality shortcut. It accepts both shipped report
  // versions (v2 adds the qaDefense section), so ending the talk still navigates to its report.
  const parsed = sessionReport(record(value)?.report);
  return parsed !== null && parsed.presentationSessionId === presentationSessionId ? parsed : null;
}

export function PresentationReportPage() {
  const { client, locale, activePresentation } = useAuth();
  const text = messages(locale);
  const location = useLocation();
  const { presentationSessionId = "" } = useParams();
  const fromFinalization = navigationReport(location.state, presentationSessionId);
  const [report, setReport] = useState<SessionReportView | null>(fromFinalization);
  const [status, setStatus] = useState<"LOADING" | "PENDING" | "FORBIDDEN">(
    fromFinalization === null ? "LOADING" : "PENDING",
  );

  // The presenter reads slide visits by deck label or ordinal, never by raw key; the deck only
  // exists while its session is live, so the map empties once activePresentation is cleared.
  const slides = useMemo(
    () =>
      new Map(
        (activePresentation?.slides ?? []).map((slide) => [
          slide.publicSlideKey,
          { ordinal: slide.ordinal, label: slide.accessibilityLabel },
        ]),
      ),
    [activePresentation],
  );

  useEffect(() => {
    if (fromFinalization !== null) return;
    if (presentationSessionId.length === 0 || client.readFinalizedReport === undefined) {
      setStatus("FORBIDDEN");
      return;
    }
    let active = true;
    void client
      .readFinalizedReport(presentationSessionId)
      .then((result) => {
        if (!active) return;
        if (result.status === "FINALIZED") setReport(result.report);
        else setStatus("PENDING");
      })
      .catch(() => {
        if (active) setStatus("FORBIDDEN");
      });
    return () => {
      active = false;
    };
  }, [client, fromFinalization, presentationSessionId]);

  if (report === null) {
    return (
      <section className="console-stack ui-reveal" data-report-status={status}>
        <h1>{text.reportTitle}</h1>
        <Panel tone="inset">
          <p className="console-caption" aria-live="polite">
            {status === "LOADING"
              ? text.reportLoading
              : status === "PENDING"
                ? text.reportPending
                : text.reportUnavailable}
          </p>
        </Panel>
      </section>
    );
  }

  return (
    <>
      <PresentationReport report={report} text={presentationReportText(text)} slides={slides} />

      {/* The end action lands here immediately, so this is where a finished presenter can reach
          Q&A in one click — before leaving for anywhere else. */}
      <QaDefensePanel presentationSessionId={presentationSessionId} />
    </>
  );
}
