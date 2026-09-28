import { Button, Panel } from "@impromptu/ui";
import { useState } from "react";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";

const DISMISSED_KEY = "impromptu.quick-start.dismissed";

/**
 * One-time quick start on the upload surface (rendered while no deck is loaded). Dismissal
 * persists in localStorage — the same first-run-only contract Dibs uses for its walkthroughs.
 */
export function QuickStartPanel() {
  const { locale } = useAuth();
  const text = messages(locale);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;
  return (
    <Panel
      className="console-quick-start"
      title={text.quickStartTitle}
      tone="inset"
      data-quick-start
    >
      <p className="console-caption">{text.quickStartLead}</p>
      <ol className="console-quick-start__steps">
        <li>{text.quickStartStepContinue}</li>
        <li>{text.quickStartStepInvite}</li>
        <li>{text.quickStartStepPresent}</li>
        <li>{text.quickStartStepReport}</li>
      </ol>
      <Button
        variant="quiet"
        data-quick-start-dismiss
        onClick={() => {
          try {
            localStorage.setItem(DISMISSED_KEY, "1");
          } catch {
            // Storage-denied contexts still hide the panel for this session.
          }
          setDismissed(true);
        }}
      >
        {text.quickStartDismiss}
      </Button>
    </Panel>
  );
}
