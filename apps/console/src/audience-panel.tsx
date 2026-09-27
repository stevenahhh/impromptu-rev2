import { Badge, Button, Panel } from "@impromptu/ui";
import { useState } from "react";
import type { AudienceScreenController, AudienceScreenStatus } from "./audience-screen";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import type { DisplayJoinView } from "./session-client";

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
 *
 * The second-device path is a one-use <=90s invitation link: minting it grants nothing, it
 * only lets another Stage ask. The asker lands on the owner-scoped pending read, and this
 * panel shows its exact display id, fingerprint, deck and binding CAS next to the only
 * control that can bind it.
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
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkCopyFailed, setLinkCopyFailed] = useState(false);
  if (activePresentation === null) return null;

  // A failed or absent bind must never keep the "connected" badge warm: the badge only shows
  // while the held epoch is both present and not known to be dead.
  const bound = displayBindingEpoch !== null && audience.status !== "BIND_FAILED";

  // Mid-talk with a live binding the pre-talk pairing paths are dead weight and misread as
  // required - but the moment an invitation exists or a pending join needs a decision the
  // full surface must come back, because the second device is exactly this panel's job.
  const collapsedToLink =
    presenting && bound && audience.invitation.kind === "NONE" && audience.pendingJoin === null;

  // Minting is async, so the clipboard write happens after the promise resolves; browsers
  // still accept it inside the click's gesture. When copying is impossible the link is
  // printed in the readonly field below so the presenter can carry it by hand.
  const copyStageLink = () => {
    setLinkCopied(false);
    setLinkCopyFailed(false);
    void (async () => {
      const url = await audience.copyInvitationLink();
      if (url === null) return;
      try {
        if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(url);
        setLinkCopied(true);
      } catch {
        setLinkCopyFailed(true);
      }
    })();
  };

  // A join this Console did not open has nowhere else to surface, so it opens the disclosure
  // rather than waiting silently behind it.
  const expanded = advancedOpen || audience.pendingJoin !== null;
  const invitation = audience.invitation;
  const invitationOpen = invitation.kind === "OPEN" || invitation.kind === "JOINED";

  const expiryText = (expiresAtMs: number) =>
    text.stageInviteExpiry.replace(
      "{time}",
      new Date(expiresAtMs).toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US"),
    );

  return (
    <Panel
      className="console-stage-setup"
      title={text.stageTitle}
      tone="inset"
      data-audience-screen-panel={bound ? "CONNECTED" : "PENDING"}
    >
      {bound ? <Badge tone="success">{text.audienceConnected}</Badge> : null}
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
            <Button
              variant="quiet"
              data-copy-stage
              disabled={invitation.kind === "ISSUING"}
              onClick={copyStageLink}
            >
              {text.copyStage}
            </Button>
          </div>
          {invitation.kind === "NONE" ? null : (
            <div className="console-stage-invitation" data-stage-invitation={invitation.kind}>
              {invitation.kind === "ISSUING" ? (
                <p className="console-caption">{text.stageInviteIssuing}</p>
              ) : null}
              {invitationOpen ? (
                <>
                  <p className="console-caption">{expiryText(invitation.expiresAtMs)}</p>
                  <label className="console-field">
                    <span>{text.stageInviteLink}</span>
                    <input readOnly value={invitation.url} />
                  </label>
                  {linkCopied ? <p className="console-caption">{text.stageInviteCopied}</p> : null}
                  {linkCopyFailed ? (
                    <p className="console-caption">{text.stageInviteCopyFailed}</p>
                  ) : null}
                  {invitation.checkFailed ? (
                    <p className="console-caption">{text.stageInviteCheckFailed}</p>
                  ) : null}
                  <Button
                    variant="quiet"
                    data-invitation-check
                    disabled={invitation.checking}
                    onClick={() => void audience.checkInvitation()}
                  >
                    {invitation.checking ? text.stageInviteChecking : text.stageInviteCheck}
                  </Button>
                  {invitation.kind === "JOINED" ? null : (
                    <p className="console-caption">{text.stageInviteWaiting}</p>
                  )}
                </>
              ) : null}
              {invitation.kind === "EXPIRED" ? <p>{text.stageInviteExpired}</p> : null}
              {invitation.kind === "OUTDATED" ? <p>{text.stageInviteOutdated}</p> : null}
              {invitation.kind === "ISSUE_FAILED" ? <p>{text.stageInviteIssueFailed}</p> : null}
            </div>
          )}
          <div
            className="console-stage-pairing"
            data-stage-pairing={audience.pendingJoin === null ? "WAITING" : "DETECTED"}
            data-join-display-id={audience.pendingJoin?.displayId}
          >
            {audience.pendingJoin === null ? (
              <p className="console-caption">{text.stageHandshakeWaiting}</p>
            ) : (
              <>
                <p>
                  {audience.pendingEpoch === null ? text.stagePairPending : text.stageInviteJoined}
                </p>
                <dl className="console-stage-identity" data-pending-identity>
                  <div>
                    <dt>{text.stageDisplayId}</dt>
                    <dd data-identity-display-id>{audience.pendingJoin.displayId}</dd>
                  </div>
                  <div>
                    <dt>{text.stageDisplayFingerprint}</dt>
                    <dd data-identity-fingerprint>{audience.pendingJoin.displayFingerprint}</dd>
                  </div>
                  <div>
                    <dt>{text.stageDisplayDeck}</dt>
                    <dd data-identity-deck>{audience.pendingJoin.deckVersion}</dd>
                  </div>
                  {audience.pendingEpoch === null ? null : (
                    <div>
                      <dt>{text.stageBindingEpoch}</dt>
                      <dd data-identity-epoch>{audience.pendingEpoch}</dd>
                    </div>
                  )}
                </dl>
                {audience.status === "BIND_FAILED" &&
                audience.failureReason === "STALE_DISPLAY_BINDING" ? (
                  <p className="console-caption">{text.stageApprovalStale}</p>
                ) : null}
                <Button
                  data-display-approve
                  disabled={audience.status === "BINDING"}
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
