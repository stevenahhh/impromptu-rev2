import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayJoinView } from "./session-client";

export type AudienceScreenStatus =
  | "IDLE"
  | "OPENING"
  | "WAITING_JOIN"
  | "BINDING"
  | "CONNECTED"
  | "POPUP_BLOCKED"
  | "JOIN_TIMEOUT"
  | "BIND_FAILED"
  | "DISCONNECTED";

export type AudienceScreenOutcome =
  | { readonly kind: "CONNECTED"; readonly displayBindingEpoch: string }
  | { readonly kind: "POPUP_BLOCKED" }
  | { readonly kind: "JOIN_TIMEOUT" }
  | { readonly kind: "BIND_FAILED" };

export interface UseAudienceScreenInput {
  readonly stageOrigin: string;
  readonly stageUrl: string;
  readonly deckVersion: string;
  readonly approveJoin: (join: DisplayJoinView) => Promise<{ displayBindingEpoch: string }>;
  readonly onBound: (displayBindingEpoch: string) => void;
  /** Interval for noticing a closed screen handle; tests may shorten it. */
  readonly disconnectPollMs?: number;
  readonly joinTimeoutMs?: number;
}

export interface AudienceScreenController {
  readonly status: AudienceScreenStatus;
  /** A join from a window this Console did NOT open. Never auto-approved. */
  readonly pendingJoin: DisplayJoinView | null;
  /** MUST be called synchronously inside a user gesture: it calls window.open first thing. */
  readonly openAndBind: () => Promise<AudienceScreenOutcome>;
  /** Approve a pendingJoin or a manually decoded join. */
  readonly approve: (join: DisplayJoinView | null) => Promise<AudienceScreenOutcome>;
}

const DEFAULT_JOIN_TIMEOUT_MS = 8000;
/**
 * Cross-origin windows expose no close event, so a vanished screen is detected through
 * window.closed. A slow recurrence is enough - focus/blur shifts between the two windows give
 * an immediate check anyway, and this timer only covers the quiet-while-idle case.
 */
const DEFAULT_DISCONNECT_POLL_MS = 2500;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Closed shape for the join an audience screen reports back over postMessage. */
function displayJoinFromMessage(value: unknown): DisplayJoinView | null {
  const envelope = record(value);
  const join = record(envelope?.join);
  if (envelope?.kind !== "impromptu:display-join" || join === null) return null;
  const { displayJoinId, displayId, displayFingerprint, deckVersion, expiresAtMs } = join;
  return typeof displayJoinId === "string" &&
    typeof displayId === "string" &&
    typeof displayFingerprint === "string" &&
    typeof deckVersion === "string" &&
    typeof expiresAtMs === "number"
    ? { displayJoinId, displayId, displayFingerprint, deckVersion, expiresAtMs }
    : null;
}

/**
 * Drives audience-screen pairing as an explicit state machine. A window this Console opened
 * binds without a second confirmation because opening it was already the presenter's gesture;
 * its handshake is matched on event.source as well as origin, which is stricter than origin
 * alone. Any other join lands in pendingJoin behind an explicit approve().
 */
export function useAudienceScreen(input: UseAudienceScreenInput): AudienceScreenController {
  const [status, setStatus] = useState<AudienceScreenStatus>("IDLE");
  const [pendingJoin, setPendingJoin] = useState<DisplayJoinView | null>(null);
  // Latest-input ref so the long-lived message listener judges joins against the presentation
  // that is current, without re-subscribing on every input change.
  const inputRef = useRef(input);
  inputRef.current = input;
  const openedScreenRef = useRef<Window | null>(null);
  const screenSurveyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joinWaiterRef = useRef<((join: DisplayJoinView) => void) | null>(null);
  const joinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards a stale attempt's timer from settling (or cancelling) a newer attempt after a
  // quick reopen.
  const attemptRef = useRef(0);
  const mountedRef = useRef(false);

  const clearJoinWait = useCallback(() => {
    if (joinTimerRef.current !== null) {
      clearTimeout(joinTimerRef.current);
      joinTimerRef.current = null;
    }
    joinWaiterRef.current = null;
  }, []);

  const stopScreenSurvey = useCallback(() => {
    if (screenSurveyRef.current !== null) {
      clearTimeout(screenSurveyRef.current);
      screenSurveyRef.current = null;
    }
  }, []);

  const disconnectClosedHandle = useCallback(
    (handle: Window | null): boolean => {
      if (mountedRef.current === false || handle?.closed !== true) return false;
      stopScreenSurvey();
      setStatus("DISCONNECTED");
      return true;
    },
    [stopScreenSurvey],
  );

  // Focus and blur pass between the console and its screen while both stay open, so every such
  // shift re-checks the handle immediately; closing one usually fires it without waiting for
  // the slow survey.
  const reportDisconnectedIfClosed = useCallback(() => {
    disconnectClosedHandle(openedScreenRef.current);
  }, [disconnectClosedHandle]);

  const watchOpenedScreen = useCallback(
    (child: Window) => {
      stopScreenSurvey();
      const surveyDelay = inputRef.current.disconnectPollMs ?? DEFAULT_DISCONNECT_POLL_MS;
      screenSurveyRef.current = setTimeout(function survey() {
        screenSurveyRef.current = null;
        if (mountedRef.current === false) return;
        if (disconnectClosedHandle(child)) return;
        screenSurveyRef.current = setTimeout(survey, surveyDelay);
      }, surveyDelay);
    },
    [disconnectClosedHandle, stopScreenSurvey],
  );

  const bind = useCallback(
    (join: DisplayJoinView, settle: (outcome: AudienceScreenOutcome) => void): void => {
      setStatus("BINDING");
      void (async () => {
        try {
          const binding = await inputRef.current.approveJoin(join);
          // A screen this Console opened has no other way to learn the approval landed, so it
          // would otherwise sit out its retry interval while the deck is already projectable.
          // This is only a prompt to retry: the screen still has to claim, and the gateway still
          // only honours a claim for a join this Console actually approved. The binding already
          // exists server-side at this point, so a screen that has since been closed must not be
          // able to turn a successful approval into a failed one.
          try {
            openedScreenRef.current?.postMessage(
              { kind: "impromptu:display-bound", displayJoinId: join.displayJoinId },
              inputRef.current.stageOrigin,
            );
          } catch {
            // The screen converges through its own retry instead.
          }
          if (!mountedRef.current) {
            // The panel went away mid-handshake; the binding exists server-side but this
            // surface must no longer touch its own state or the parent's callbacks.
            settle({ kind: "CONNECTED", displayBindingEpoch: binding.displayBindingEpoch });
            return;
          }
          setPendingJoin(null);
          inputRef.current.onBound(binding.displayBindingEpoch);
          setStatus("CONNECTED");
          settle({ kind: "CONNECTED", displayBindingEpoch: binding.displayBindingEpoch });
        } catch {
          if (mountedRef.current) setStatus("BIND_FAILED");
          settle({ kind: "BIND_FAILED" });
        }
      })();
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    const onMessage = (event: MessageEvent) => {
      const current = inputRef.current;
      // Anything from another origin is noise, whoever claims to have sent it.
      if (event.origin !== current.stageOrigin) return;
      const join = displayJoinFromMessage(event.data);
      if (join === null || join.deckVersion !== current.deckVersion) return;
      if (
        event.source !== null &&
        openedScreenRef.current !== null &&
        event.source === openedScreenRef.current
      ) {
        // The join comes from the very window a presenter gesture opened: opening it was
        // the approval, so no second confirmation is asked for.
        const waiter = joinWaiterRef.current;
        clearJoinWait();
        waiter?.(join);
        return;
      }
      // A screen this Console did not open must never attach on its own.
      setPendingJoin(join);
    };
    window.addEventListener("message", onMessage);
    const onWindowActivity = () => reportDisconnectedIfClosed();
    window.addEventListener("focus", onWindowActivity);
    window.addEventListener("blur", onWindowActivity);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onWindowActivity);
      window.removeEventListener("blur", onWindowActivity);
      clearJoinWait();
      // The controller is gone; its closed-screen check must never fire again.
      stopScreenSurvey();
    };
  }, [clearJoinWait, reportDisconnectedIfClosed, stopScreenSurvey]);

  const openAndBind = useCallback((): Promise<AudienceScreenOutcome> => {
    // Browsers only honour window.open inside the user gesture, so this must stay the very
    // first statement, ahead of any state work or await.
    const child = window.open(inputRef.current.stageUrl, "impromptu-stage", "popup");
    openedScreenRef.current = child;
    if (child === null) {
      setStatus("POPUP_BLOCKED");
      return Promise.resolve({ kind: "POPUP_BLOCKED" });
    }
    const attempt = ++attemptRef.current;
    clearJoinWait();
    setStatus("OPENING");
    setStatus("WAITING_JOIN");
    watchOpenedScreen(child);
    return new Promise<AudienceScreenOutcome>((resolve) => {
      joinWaiterRef.current = (join) => {
        if (attemptRef.current !== attempt) return;
        bind(join, resolve);
      };
      joinTimerRef.current = setTimeout(() => {
        if (attemptRef.current !== attempt) return;
        clearJoinWait();
        setStatus("JOIN_TIMEOUT");
        resolve({ kind: "JOIN_TIMEOUT" });
      }, inputRef.current.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS);
    });
  }, [bind, clearJoinWait, watchOpenedScreen]);

  const approve = useCallback(
    async (join: DisplayJoinView | null): Promise<AudienceScreenOutcome> => {
      // A null decode or a join for another deck version fails closed with no API call.
      if (join === null || join.deckVersion !== inputRef.current.deckVersion) {
        setStatus("BIND_FAILED");
        return { kind: "BIND_FAILED" };
      }
      return await new Promise<AudienceScreenOutcome>((resolve) => {
        bind(join, resolve);
      });
    },
    [bind],
  );

  return { status, pendingJoin, openAndBind, approve };
}
