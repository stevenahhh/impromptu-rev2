import { Badge, Button, Panel } from "@impromptu/ui";
import { useState } from "react";
import type { AudienceScreenController, AudienceScreenStatus } from "./audience-screen";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import type { DisplayJoinView } from "./session-client";
import { stageUrl } from "./stage-origin";

function decodeDisplayJoin(value: string): DisplayJoinView | null {
  try {
    const decoded = JSON.parse(atob(value.trim())) as Record<string, unknown>;
    return typeof decoded.displayJoinId === "string" &&
      typeof decoded.displayId === "string" &&
      typeof decoded.displayFingerprint === "string" &&
      typeof decoded.deckVersion === "string" &&
      typeof decoded.expiresAtMs === "number"
      ? (decoded as unknown as DisplayJoinView)
      : null;
  } catch {
    return null;
  }
}

/** Plain-language recovery copy for the pairing states a presenter can actually land on. */
export function audienceRecovery(
  status: AudienceScreenStatus,
  text: ReturnType<typeof messages>,
): { readonly message: string; readonly retry: string } | null {
  switch (status) {
    case "POPUP_BLOCKED":
      return { message: text.audiencePopupBlocked, retry: text.audienceRetry };
    case "JOIN_TIMEOUT":
      return { message: text.audienceJoinTimeout, retry: text.audienceReopen };
    case "BIND_FAILED":
      return { message: text.audienceBindFailed, retry: text.audienceRetry };
    case "DISCONNECTED":
      return { message: text.audienceDisconnected, retry: text.audienceReopen };
    default:
      return null;
  }
}

/**
 * The rarely-needed connection paths. A screen the Console itself opened binds through the
 * primary action, because opening it was already the presenter's gesture and its handshake is
 * matched on source as well as origin. Everything in here serves the cases that gesture cannot
 * cover: a second device, a blocked popup, or a join reported by a window this Console did not
 * open - which never binds without the explicit approval below.
 */
export function AudienceScreenPanel({
  audience,
  presenting,
}: {
  readonly audience: AudienceScreenController;
  readonly presenting: boolean;
}) {
  const { activePresentation, displayBindingEpoch, locale } = useAuth();
  const text = messages(locale);
  const [connectionCode, setConnectionCode] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  if (activePresentation === null) return null;

  // Mid-talk with a live binding the pre-talk pairing paths are dead weight and misread as
  // required: the only honest surface is the connected badge and a way to hand the link to
  // someone else. Unbound mid-talk keeps everything - that state IS the recovery path.
  const collapsedToLink = presenting && displayBindingEpoch !== null;
  const copyStageLink = () =>
    void navigator.clipboard?.writeText(stageUrl(activePresentation.deckVersion));

  // A join this Console did not open has nowhere else to surface, so it opens the disclosure
  // rather than waiting silently behind it.
  const expanded = advancedOpen || audience.pendingJoin !== null;

  return (
    <Panel
      className="console-stage-setup"
      title={text.stageTitle}
      tone="inset"
      data-audience-screen-panel={displayBindingEpoch === null ? "PENDING" : "CONNECTED"}
    >
      {displayBindingEpoch === null ? null : <Badge tone="success">{text.audienceConnected}</Badge>}
      {collapsedToLink ? (
        <div className="console-stage-actions">
          <Button variant="quiet" data-copy-stage onClick={copyStageLink}>
            {text.copyStage}
          </Button>
        </div>
      ) : (
        <details
          className="console-advanced-connect"
          open={expanded}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>{text.advancedConnect}</summary>
          <div className="console-stage-actions">
            <Button data-stage-open onClick={() => void audience.openAndBind()}>
              {text.openStagePreview}
            </Button>
            <Button variant="quiet" onClick={copyStageLink}>
              {text.copyStage}
            </Button>
          </div>
          <div
            className="console-stage-pairing"
            data-stage-pairing={audience.pendingJoin === null ? "WAITING" : "DETECTED"}
            data-join-display-id={audience.pendingJoin?.displayId}
          >
            {audience.pendingJoin === null ? (
              <p className="console-caption">{text.stageHandshakeWaiting}</p>
            ) : (
              <>
                <p>{text.stagePairPending}</p>
                <Button
                  data-display-approve
                  onClick={() => void audience.approve(audience.pendingJoin)}
                >
                  {text.approveHandshake}
                </Button>
              </>
            )}
          </div>
          <p className="console-caption">{text.connectLead}</p>
          <label className="console-field">
            <span>{text.connectionCode}</span>
            <input
              value={connectionCode}
              onChange={(event) => setConnectionCode(event.currentTarget.value)}
            />
          </label>
          <Button
            disabled={connectionCode.length === 0}
            onClick={() => void audience.approve(decodeDisplayJoin(connectionCode))}
          >
            {text.approveDisplay}
          </Button>
        </details>
      )}
    </Panel>
  );
}
