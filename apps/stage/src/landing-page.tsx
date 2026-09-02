import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import copy from "./locales/ko.json";
import type { DisplayJoinView, StageSessionClient } from "./stage-client";
import { publishStageEvent } from "./stage-events";

function LandingPage({ client }: { readonly client: StageSessionClient }) {
  const navigate = useNavigate();
  const identity = useMemo(
    () => ({
      displayId: `display_${crypto.randomUUID().replaceAll("-", "")}`,
      displayFingerprint: `stage-browser-${crypto.randomUUID()}`,
    }),
    [],
  );
  const deckVersion = new URL(window.location.href).searchParams.get("deck") ?? "deck_alpha";
  // When the Console opened this window, the join is handed straight back to it and approval
  // happens over there. Without an opener (second device, blocked popup) the manual connection
  // code below remains the path.
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
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState(copy.waitingApproval);

  useEffect(() => {
    // Product decision: a Stage window the Console did not open must stay completely inert — no
    // join creation, no codes, no claim affordance — because otherwise anyone holding the bare
    // URL could put a screen into the pairing flow. Binding only ever starts console-led.
    if (!openedByConsole) return;
    let active = true;
    void client
      .createJoin(identity, deckVersion)
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
        setMessage(error instanceof Error ? error.message : copy.joinFailed);
        setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, consoleOrigin, deckVersion, identity, openedByConsole]);

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
    if (join === null) return;
    let active = true;
    const retry = globalThis.setInterval(() => {
      if (!active || Date.now() >= join.expiresAtMs) return;
      void client
        .claim(join)
        .then(() => {
          if (active) navigate(`/display/${identity.displayId}`);
        })
        .catch(() => {});
    }, 1_500);
    return () => {
      active = false;
      globalThis.clearInterval(retry);
    };
  }, [client, identity.displayId, join, navigate]);

  // A window the console opened is already facing the room, so this page's setup scaffolding is
  // something an audience should never be shown. Stay blank until the validated snapshot paints,
  // and break that silence only when the handshake actually failed — from the back of a room a
  // blank screen that is never coming back looks exactly like one that is.
  if (openedByConsole) {
    return (
      <div className="stage-display" data-audience-readiness="PAIRING" data-blackout="false">
        <main className="stage-display__content">
          {failed ? (
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

  // Product decision: without a Console opener this window must not self-serve pairing — no join,
  // no codes, no claim button. One neutral line is all it shows.
  return (
    <main className="stage-console-only">
      <p>{copy.consoleOnlyNotice}</p>
    </main>
  );
}

export default LandingPage;
