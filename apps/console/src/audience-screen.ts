import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DisplayInvitationPendingView,
  DisplayJoinView,
  IssuedStageInvitationView,
} from "./session-client";
import { DisplayApprovalRejectedError, DisplayInvitationError } from "./session-client";

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

/**
 * The <=90s one-use Stage invitation lifecycle, owned by this controller. Minting itself
 * carries no authority: the link only lets another device's Stage ask once; binding still
 * needs the explicit presenter approval below.
 */
export type AudienceInvitationState =
  | { readonly kind: "NONE" }
  | { readonly kind: "ISSUING" }
  | {
      readonly kind: "OPEN";
      readonly invitationId: string;
      readonly url: string;
      readonly expiresAtMs: number;
      readonly checking: boolean;
      readonly checkFailed: boolean;
    }
  | {
      readonly kind: "JOINED";
      readonly invitationId: string;
      readonly url: string;
      readonly expiresAtMs: number;
      readonly checking: boolean;
      readonly checkFailed: boolean;
    }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "OUTDATED" }
  | { readonly kind: "ISSUE_FAILED" };

export type AudienceScreenOutcome =
  | { readonly kind: "CONNECTED"; readonly displayBindingEpoch: string }
  | { readonly kind: "POPUP_BLOCKED" }
  | { readonly kind: "JOIN_TIMEOUT" }
  | { readonly kind: "BIND_FAILED"; readonly reason: string | null };

export interface UseAudienceScreenInput {
  readonly stageOrigin: string;
  readonly stageUrl: string;
  readonly deckVersion: string;
  /**
   * The binding epoch this console currently believes in, or null when nothing is bound
   * (fresh session, reload, cleared dead binding). It is only ever a CAS guess: the
   * backend decides, and a stale guess is refreshed through a fresh pending read.
   */
  readonly displayBindingEpoch: string | null;
  readonly approveJoin: (
    join: DisplayJoinView,
    expectedDisplayBindingEpoch: string,
  ) => Promise<{ displayBindingEpoch: string }>;
  readonly onBound: (displayBindingEpoch: string) => void;
  /**
   * Mints the <=90s one-use invitation for the current presentation; the returned
   * stagePath carries the token in its fragment only.
   */
  readonly issueInvitation?: () => Promise<IssuedStageInvitationView>;
  /** Owner-scoped pending read: pending join identity + the authoritative CAS epoch. */
  readonly readInvitation?: (invitationId: string) => Promise<DisplayInvitationPendingView>;
  /** Interval for noticing a closed screen handle; tests may shorten it. */
  readonly disconnectPollMs?: number;
  readonly joinTimeoutMs?: number;
}

export interface AudienceScreenController {
  readonly status: AudienceScreenStatus;
  /**
   * The rejection reason for the last failed bind — the backend's verbatim code
   * (STALE_DISPLAY_BINDING, WRONG_DECK, ...) or EPOCH_UNAVAILABLE when no CAS could be
   * read at all; null for a transport/unknown failure. Read it with status.
   */
  readonly failureReason: string | null;
  /** A join awaiting the presenter's explicit decision. Never auto-approved. */
  readonly pendingJoin: DisplayJoinView | null;
  /**
   * The CAS epoch currently displayed beside the pending join — the value the pending
   * read returned, so the presenter sees the real epoch, not a remembered one.
   */
  readonly pendingEpoch: string | null;
  readonly invitation: AudienceInvitationState;
  /** MUST be called synchronously inside a user gesture: it calls window.open first thing. */
  readonly openAndBind: () => Promise<AudienceScreenOutcome>;
  /** Approve a pendingJoin or a manually decoded join. */
  readonly approve: (join: DisplayJoinView | null) => Promise<AudienceScreenOutcome>;
  /**
   * Mint a fresh one-use invitation and return its Stage URL (token in the fragment).
   * Returns null and lands in ISSUE_FAILED when minting is unavailable or rejected.
   */
  readonly copyInvitationLink: () => Promise<string | null>;
  /** Re-read the current invitation's pending view: the "check connection request" control. */
  readonly checkInvitation: () => Promise<void>;
}

const DEFAULT_JOIN_TIMEOUT_MS = 8000;
/**
 * Cross-origin windows expose no close event, so a vanished screen is detected through
 * window.closed. A slow recurrence is enough - focus/blur shifts between the two windows give
 * an immediate check anyway, and this timer only covers the quiet-while-idle case.
 */
const DEFAULT_DISCONNECT_POLL_MS = 2500;

interface PendingJoinRecord {
  readonly join: DisplayJoinView;
  /** The epoch the pending read returned; null when the join arrived over postMessage. */
  readonly epoch: string | null;
  /** Which invitation produced this join, when it came through the pending read. */
  readonly invitationId: string | null;
}

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
 * alone. Any other join — postMessage from an unopened window or an invitation redemption
 * surfacing on the owner-scoped pending read — waits behind an explicit approve(), and every
 * approval carries the freshest binding-epoch CAS the console can read: the pending view's
 * own epoch first, the context's held epoch otherwise, and a fresh mint-and-read whenever
 * nothing is held or the CAS comes back stale. The literal dbe_0 is never guessed.
 */
export function useAudienceScreen(input: UseAudienceScreenInput): AudienceScreenController {
  const [status, setStatus] = useState<AudienceScreenStatus>("IDLE");
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [pendingRecord, setPendingRecord] = useState<PendingJoinRecord | null>(null);
  const [invitation, setInvitation] = useState<AudienceInvitationState>({ kind: "NONE" });
  // Latest-input ref so the long-lived message listener judges joins against the presentation
  // that is current, without re-subscribing on every input change.
  const inputRef = useRef(input);
  inputRef.current = input;
  // Mirrors of the pending state for callbacks that must not go stale (bind is captured
  // inside the join waiter and runs after newer renders).
  const invitationRef = useRef(invitation);
  invitationRef.current = invitation;
  const pendingRecordRef = useRef<PendingJoinRecord | null>(null);
  pendingRecordRef.current = pendingRecord;
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

  // A fresh CAS read. When the pending join came through an invitation, re-reading that same
  // invitation is cheapest; otherwise mint an internal, never-shared invitation and read its
  // pending view — it is the only owner-scoped read that returns the live binding epoch.
  const resolveBindingEpoch = useCallback(
    async (record: PendingJoinRecord | null): Promise<string | null> => {
      const { readInvitation, issueInvitation } = inputRef.current;
      if (record !== null && record.invitationId !== null && readInvitation !== undefined) {
        try {
          return (await readInvitation(record.invitationId)).displayBindingEpoch;
        } catch {
          return null;
        }
      }
      if (issueInvitation === undefined || readInvitation === undefined) return null;
      try {
        const issued = await issueInvitation();
        return (await readInvitation(issued.invitationId)).displayBindingEpoch;
      } catch {
        return null;
      }
    },
    [],
  );

  const bind = useCallback(
    (
      join: DisplayJoinView,
      settle: (outcome: AudienceScreenOutcome) => void,
      epochHint: string | null,
    ): void => {
      setStatus("BINDING");
      setFailureReason(null);
      void (async () => {
        // The CAS guess: the pending read's epoch for an invitation join, the held binding
        // epoch otherwise. Null means nothing is held (fresh session or reload), so the
        // authoritative value has to be read before the approval goes out — never guessed.
        const held = epochHint ?? inputRef.current.displayBindingEpoch;
        const approveWith = async (epoch: string | null) => {
          const resolved = epoch ?? (await resolveBindingEpoch(pendingRecordRef.current));
          if (resolved === null) throw new DisplayApprovalRejectedError("EPOCH_UNAVAILABLE");
          return await inputRef.current.approveJoin(join, resolved);
        };
        try {
          let binding: { displayBindingEpoch: string };
          try {
            binding = await approveWith(held);
          } catch (cause) {
            // A stale CAS is recoverable exactly once: read the live epoch and retry. Any
            // other rejection, or a refresh that returns the same epoch, lands honestly.
            if (!(cause instanceof DisplayApprovalRejectedError)) throw cause;
            if (cause.reason !== "STALE_DISPLAY_BINDING") throw cause;
            const fresh = await resolveBindingEpoch(pendingRecordRef.current);
            if (fresh === null || fresh === held) throw cause;
            binding = await approveWith(fresh);
          }
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
          const boundRecord = pendingRecordRef.current;
          setPendingRecord(null);
          // The link is spent the moment its join binds; an open invitation for another
          // pending join survives on its own merits.
          setInvitation((current) =>
            current.kind === "JOINED" &&
            boundRecord !== null &&
            current.invitationId === boundRecord.invitationId
              ? { kind: "NONE" }
              : current,
          );
          inputRef.current.onBound(binding.displayBindingEpoch);
          setStatus("CONNECTED");
          settle({ kind: "CONNECTED", displayBindingEpoch: binding.displayBindingEpoch });
        } catch (cause) {
          const reason = cause instanceof DisplayApprovalRejectedError ? cause.reason : null;
          if (mountedRef.current) {
            setFailureReason(reason);
            setStatus("BIND_FAILED");
          }
          settle({ kind: "BIND_FAILED", reason });
        }
      })();
    },
    [resolveBindingEpoch],
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
      setPendingRecord({ join, epoch: null, invitationId: null });
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

  // A deck change retires every pending decision: an invitation minted for the old deck can
  // only produce joins the approval would reject, and a stale pending record must not bind
  // into the new presentation.
  const deckVersion = input.deckVersion;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the body intentionally uses only setters; deckVersion is the trigger signal, not a read.
  useEffect(() => {
    setPendingRecord(null);
    setInvitation({ kind: "NONE" });
  }, [deckVersion]);

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
        bind(join, resolve, null);
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
        setFailureReason(null);
        return { kind: "BIND_FAILED", reason: null };
      }
      // The deliberate approval uses the epoch the presenter is looking at right now when the
      // join surfaced through the pending read; postMessage joins fall back to the held epoch.
      const record = pendingRecordRef.current;
      const hint = record !== null && record.join === join ? record.epoch : null;
      return await new Promise<AudienceScreenOutcome>((resolve) => {
        bind(join, resolve, hint);
      });
    },
    [bind],
  );

  const copyInvitationLink = useCallback(async (): Promise<string | null> => {
    const issue = inputRef.current.issueInvitation;
    if (issue === undefined) {
      setInvitation({ kind: "ISSUE_FAILED" });
      return null;
    }
    setInvitation({ kind: "ISSUING" });
    try {
      const issued = await issue();
      if (issued.deckVersion !== inputRef.current.deckVersion) {
        // The minted link belongs to a different deck than the one being presented: handing
        // it out could only produce joins this session would reject.
        setInvitation({ kind: "OUTDATED" });
        return null;
      }
      const url = `${inputRef.current.stageOrigin}${issued.stagePath}`;
      setInvitation({
        kind: "OPEN",
        invitationId: issued.invitationId,
        url,
        expiresAtMs: issued.expiresAtMs,
        checking: false,
        checkFailed: false,
      });
      return url;
    } catch {
      if (mountedRef.current) setInvitation({ kind: "ISSUE_FAILED" });
      return null;
    }
  }, []);

  const checkInvitation = useCallback(async (): Promise<void> => {
    const current = invitationRef.current;
    const read = inputRef.current.readInvitation;
    if ((current.kind !== "OPEN" && current.kind !== "JOINED") || read === undefined) return;
    const invitationId = current.invitationId;
    setInvitation({ ...current, checking: true, checkFailed: false });
    try {
      const view = await read(invitationId);
      const latest = invitationRef.current;
      // A newer invitation replaced this one mid-read; leave the fresh state untouched.
      if (
        (latest.kind !== "OPEN" && latest.kind !== "JOINED") ||
        latest.invitationId !== invitationId
      ) {
        return;
      }
      if (view.deckVersion !== inputRef.current.deckVersion) {
        setInvitation({ kind: "OUTDATED" });
        return;
      }
      if (view.status === "EXPIRED") {
        setInvitation({ kind: "EXPIRED" });
        return;
      }
      if (view.status === "JOINED" && view.join !== null) {
        setPendingRecord({ join: view.join, epoch: view.displayBindingEpoch, invitationId });
        setInvitation({
          kind: "JOINED",
          invitationId,
          url: latest.url,
          expiresAtMs: latest.expiresAtMs,
          checking: false,
          checkFailed: false,
        });
        return;
      }
      setInvitation({ ...latest, checking: false, checkFailed: false });
    } catch (cause) {
      const latest = invitationRef.current;
      if (
        (latest.kind !== "OPEN" && latest.kind !== "JOINED") ||
        latest.invitationId !== invitationId
      ) {
        return;
      }
      // Gone is terminal for this link; a transient failure keeps the invitation open and
      // flags the check so the presenter knows to try again.
      if (
        cause instanceof DisplayInvitationError &&
        (cause.status === 404 || cause.status === 410)
      ) {
        setInvitation({ kind: "EXPIRED" });
        return;
      }
      setInvitation({ ...latest, checking: false, checkFailed: true });
    }
  }, []);

  return {
    status,
    failureReason,
    pendingJoin: pendingRecord?.join ?? null,
    pendingEpoch: pendingRecord?.epoch ?? null,
    invitation,
    openAndBind,
    approve,
    copyInvitationLink,
    checkInvitation,
  };
}
