import { type DisplayInvitationToken, DisplayInvitationTokenSchema } from "@impromptu/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DisplayJoinError, type DisplayJoinView, type StageSessionClient } from "./stage-client";
import { publishStageEvent } from "./stage-events";
import { useStageCopy } from "./stage-i18n";

type InvitationFragment =
  | Readonly<{ kind: "token"; token: DisplayInvitationToken }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "none" }>;

/**
 * Reads the one-use invitation from the URL fragment exactly once, in memory. The fragment is
 * validated against the public contract here — at the browser boundary — so a malformed invite
 * never reaches the gateway, and the token itself never touches storage or the DOM.
 */
function readInvitationFragment(): InvitationFragment {
  const hash = window.location.hash;
  if (hash.length === 0) return { kind: "none" };
  if (!hash.startsWith("#invite=")) return { kind: "none" };
  const parsed = DisplayInvitationTokenSchema.safeParse(hash.slice("#invite=".length));
  return parsed.success ? { kind: "token", token: parsed.data } : { kind: "invalid" };
}

type JoinFailure = "expired" | "invalid" | "retryable";

function invitationFailure(error: unknown): JoinFailure {
  if (error instanceof DisplayJoinError) {
    if (error.status === 410) return "expired";
    // A structured rejection means the gateway answered: this link is dead, retrying the same
    // token can only replay the refusal. Only an unanswered request (status undefined) is
    // worth retrying; an error without a body (HTTP layer, no fields) is treated the same.
    if (error.reason !== undefined) return "invalid";
  }
  return "retryable";
}

function LandingPage({ client }: { readonly client: StageSessionClient }) {
  const copy = useStageCopy();
  const navigate = useNavigate();
  const identity = useMemo(
    () => ({
      displayId: `display_${crypto.randomUUID().replaceAll("-", "")}`,
      displayFingerprint: `stage-browser-${crypto.randomUUID()}`,
    }),
    [],
  );
  const deckVersion = new URL(window.location.href).searchParams.get("deck") ?? "deck_alpha";
  // The fragment is read exactly once, during the initial render, and lives only in component
  // state from then on. The effect below removes it from the address bar and history.
  const [invitation] = useState<InvitationFragment>(readInvitationFragment);
  // When the Console opened this window, the join is handed straight back to it and approval
  // happens over there. Without an opener (second device, blocked popup) only an invitation
  // token can start pairing — the bare URL stays inert.
  const consoleOrigin = useMemo(() => {
    try {
      const origin = new URL(document.referrer, window.location.href).origin;
      return origin === window.location.origin ? null : origin;
    } catch {
      return null;
    }
  }, []);
  const openedByConsole =
    consoleOrigin !== null && window.opener !== null && window.opener !== undefined;
  const [join, setJoin] = useState<DisplayJoinView | null>(null);
  const [joinFailed, setJoinFailed] = useState<JoinFailure | null>(null);
  const [joinExpired, setJoinExpired] = useState(false);
  // Retried joins re-run the join effect; the token itself stays only in component state.
  const [joinRetryToken, setJoinRetryToken] = useState(0);
  const [message, setMessage] = useState(copy.waitingApproval);
  // StrictMode remounts effects in development; the one-use token would already be consumed by
  // the first attempt, so the in-flight request is shared instead of being started twice.
  const joinRequest = useRef<Promise<DisplayJoinView> | null>(null);

  useEffect(() => {
    // Consume the fragment immediately after the first paint decision: replaceState removes the
    // token from the address bar and keeps it out of browser history, so the one-use secret
    // survives only in memory. Any other fragment is dropped the same way — this page has no
    // legitimate fragment use.
    if (window.location.hash.length === 0) return;
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  const invitationToken = invitation.kind === "token" && !openedByConsole ? invitation.token : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: joinRetryToken is the explicit retry trigger — bumping it re-runs this effect
  useEffect(() => {
    // Product decision: a Stage window the Console did not open must stay completely inert —
    // no join creation, no codes, no claim affordance — unless it carries a valid one-use
    // invitation fragment, because otherwise anyone holding the bare URL could put a screen
    // into the pairing flow. Binding only ever starts console-led or invitation-led.
    const joinRequested = openedByConsole || invitationToken !== null;
    if (!joinRequested) return;
    joinRequest.current ??= client.createJoin(identity, deckVersion, invitationToken ?? undefined);
    let active = true;
    void joinRequest.current
      .then((created) => {
        if (active) {
          setJoin(created);
          publishStageEvent("impromptu:display-join", created);
          if (openedByConsole) {
            (window.opener as Window)?.postMessage(
              { kind: "impromptu:display-join", join: created },
              consoleOrigin,
            );
          }
          setMessage(copy.waitingApproval);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (invitationToken !== null) {
          const failure = invitationFailure(error);
          setJoinFailed(failure);
          setMessage(
            failure === "expired"
              ? copy.invitationExpired
              : failure === "invalid"
                ? copy.invitationInvalid
                : copy.invitationRetryable,
          );
          publishStageEvent("impromptu:invitation-failed", {
            reason:
              error instanceof DisplayJoinError
                ? (error.reason ?? "JOIN_UNAVAILABLE")
                : "JOIN_UNAVAILABLE",
          });
        } else {
          setMessage(error instanceof Error ? error.message : copy.joinFailed);
          setJoinFailed("retryable");
        }
      });
    return () => {
      active = false;
    };
  }, [
    client,
    consoleOrigin,
    copy,
    deckVersion,
    identity,
    invitationToken,
    openedByConsole,
    joinRetryToken,
  ]);

  // The console tells the window it opened the moment approval lands, so this display claims at
  // once instead of waiting out the interval below. It is only a nudge: the claim is still what
  // the gateway authorises, and it only succeeds for a join the presenter actually approved. The
  // interval stays armed on this path too, because the console tab can be closed, reloaded, or
  // frozen by a phone before it ever gets to send this.
  useEffect(() => {
    if (join === null || consoleOrigin === null) return;
    let active = true;
    const onMessage = (event: MessageEvent) => {
      if (!active || event.origin !== consoleOrigin || event.source !== window.opener) return;
      const data = event.data as { readonly kind?: unknown; readonly displayJoinId?: unknown };
      if (
        typeof data !== "object" ||
        data === null ||
        data.kind !== "impromptu:display-bound" ||
        data.displayJoinId !== join.displayJoinId
      ) {
        return;
      }
      void client
        .claim(join)
        .then(() => {
          if (active) navigate(`/display/${identity.displayId}`);
        })
        .catch(() => {
          // Not yet claimable; the interval below keeps trying.
        });
    };
    window.addEventListener("message", onMessage);
    return () => {
      active = false;
      window.removeEventListener("message", onMessage);
    };
  }, [client, consoleOrigin, identity.displayId, join, navigate]);

  useEffect(() => {
    if (join === null || joinExpired) return;
    let active = true;
    // The pending join expires on the gateway's clock; once it does, no claim can ever succeed,
    // so the wait ends honestly instead of polling a dead locator forever.
    const attemptClaim = () => {
      if (!active) return;
      if (Date.now() >= join.expiresAtMs) {
        active = false;
        setJoinExpired(true);
        if (invitationToken !== null) {
          publishStageEvent("impromptu:invitation-expired", {
            reason: "JOIN_EXPIRED",
          });
        }
        return;
      }
      void client
        .claim(join)
        .then(() => {
          if (active) navigate(`/display/${identity.displayId}`);
        })
        .catch(() => {});
    };
    attemptClaim();
    const retry = globalThis.setInterval(attemptClaim, 1_500);
    return () => {
      active = false;
      globalThis.clearInterval(retry);
    };
  }, [client, identity.displayId, invitationToken, join, joinExpired, navigate]);

  // A window the console opened is already facing the room, so this page's setup scaffolding is
  // something an audience should never be shown. Stay blank until the validated snapshot paints,
  // and break that silence only when the handshake actually failed — from the back of a room a
  // blank screen that is never coming back looks exactly like one that is.
  if (openedByConsole) {
    return (
      <div className="stage-display" data-audience-readiness="PAIRING" data-blackout="false">
        <main className="stage-display__content">
          {joinFailed !== null ? (
            <section className="stage-claim ui-reveal">
              <h1>{message}</h1>
            </section>
          ) : null}
        </main>
        <p className="stage-note ui-sr-only" aria-live="polite">
          {message}
        </p>
      </div>
    );
  }

  if (invitation.kind === "token") {
    // An invited second screen is operated on by the person holding the link, not watched by a
    // room — so unlike the opener path it may speak while it waits. It shows the identity the
    // presenter will be asked to approve, and nothing more: the pending join is a locator, not
    // authority, and no slide can appear before the claim succeeds.
    if (joinFailed !== null || joinExpired) {
      return (
        <main className="stage-console-only">
          <section className="stage-invitation ui-reveal" data-join-state="failed">
            <output className="stage-invitation-status">
              {joinExpired ? copy.invitationExpired : message}
            </output>
            {joinFailed === "retryable" && !joinExpired ? (
              <button
                type="button"
                data-invitation-retry
                onClick={() => {
                  joinRequest.current = null;
                  setJoinFailed(null);
                  setMessage(copy.waitingApproval);
                  setJoinRetryToken((token) => token + 1);
                }}
              >
                {copy.invitationRetry}
              </button>
            ) : null}
          </section>
        </main>
      );
    }
    return (
      <main className="stage-console-only">
        <section
          className="stage-invitation ui-reveal"
          data-join-state={join === null ? "joining" : "pending-approval"}
        >
          <output className="stage-invitation-status">{message}</output>
          <dl className="stage-invitation-identity">
            <div>
              <dt>{copy.displayIdLabel}</dt>
              <dd data-display-id>{identity.displayId}</dd>
            </div>
            <div>
              <dt>{copy.displayFingerprintLabel}</dt>
              <dd data-display-fingerprint>{identity.displayFingerprint}</dd>
            </div>
          </dl>
        </section>
      </main>
    );
  }

  if (invitation.kind === "invalid") {
    return (
      <main className="stage-console-only">
        <section className="stage-invitation ui-reveal" data-join-state="failed">
          <output className="stage-invitation-status">{copy.invitationInvalid}</output>
        </section>
      </main>
    );
  }

  // Product decision: without a Console opener or a valid invitation this window must not
  // self-serve pairing — no join, no codes, no claim button. One neutral line is all it shows.
  return (
    <main className="stage-console-only">
      <p>{copy.consoleOnlyNotice}</p>
    </main>
  );
}

export default LandingPage;
