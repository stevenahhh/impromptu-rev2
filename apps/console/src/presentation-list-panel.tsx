import { Button, Panel } from "@impromptu/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import type {
  ActivePresentationView,
  PresentationDetailView,
  PresentationSummaryView,
} from "./session-client";

/**
 * Owner-scoped "My presentations" surface (GAP-10). The rows come from the private backend's
 * persisted library, never from localStorage; selecting an ACTIVE deck re-enters it (taking
 * over the playback lease when the new account session carries a different actor) and an
 * ENDED deck goes straight to its report. A failed read is an honest error, never an empty
 * list masquerading as "nothing uploaded".
 */
export function PresentationListPanel({
  /** Renders the empty-state copy when true (the dedicated /presentations page). */
  showEmptyState = false,
}: {
  readonly showEmptyState?: boolean;
}) {
  const {
    activePresentation,
    client,
    locale,
    session,
    setActivePresentation,
    setDisplayBindingEpoch,
  } = useAuth();
  const text = messages(locale);
  const navigate = useNavigate();
  const accountId = session?.account.accountId;
  const [phase, setPhase] = useState<"LOADING" | "READY" | "ERROR">("LOADING");
  const [items, setItems] = useState<readonly PresentationSummaryView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameErrorId, setRenameErrorId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);
  // Generation counter: a response that lands after an account switch or a newer request must
  // never repopulate this panel with the previous account's rows.
  const requestRef = useRef(0);

  const load = useCallback(
    async (cursor?: string) => {
      if (client.listPresentations === undefined || accountId === undefined) return;
      const request = ++requestRef.current;
      if (cursor === undefined) setPhase("LOADING");
      try {
        const page = await client.listPresentations(cursor === undefined ? {} : { cursor });
        if (request !== requestRef.current) return;
        setItems((current) =>
          cursor === undefined ? page.presentations : [...current, ...page.presentations],
        );
        setNextCursor(page.nextCursor);
        setPhase("READY");
      } catch {
        if (request !== requestRef.current) return;
        setPhase("ERROR");
      }
    },
    [accountId, client],
  );

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setResumeError(false);
    void load();
  }, [load]);

  if (client.listPresentations === undefined || session === null) return null;

  const resumePresentation = async (summary: PresentationSummaryView) => {
    if (client.readPresentation === undefined || resumingId !== null) return;
    setResumingId(summary.presentationSessionId);
    setResumeError(false);
    try {
      const detail = await client.readPresentation(summary.presentationSessionId);
      if (detail.status === "ENDED") {
        // An ended deck has nothing to re-enter in the cockpit; its report is the destination.
        navigate(`/reports/${encodeURIComponent(detail.presentationSessionId)}`);
        return;
      }
      // Re-entry needs a controller lease owned by THIS session's actor. The server mints a
      // fresh actor per sign-in, so the persisted lease usually belongs to an old actor and
      // is taken over against the exact binding epoch the resume read reported.
      if (
        detail.playback.activeLease.actorId !== session.account.actorId &&
        client.takeoverPlaybackLease !== undefined
      ) {
        await client.takeoverPlaybackLease(
          session.csrfToken,
          detail.presentationSessionId,
          detail.playback.displayBindingEpoch,
        );
      }
      setActivePresentation(activePresentationFromDetail(detail));
      // A reopened Console must re-open and re-approve the screen itself: the previous
      // window's binding is server state, not proof this window still has a screen up.
      setDisplayBindingEpoch(null);
      navigate("/");
    } catch {
      setResumeError(true);
    } finally {
      setResumingId(null);
    }
  };

  const deleteItem = async (summary: PresentationSummaryView) => {
    if (client.deletePresentation === undefined || session === null) return;
    if (deletingId !== null) return;
    setDeletingId(summary.presentationSessionId);
    try {
      await client.deletePresentation(session.csrfToken, summary.presentationSessionId);
      setItems((current) =>
        current.filter((row) => row.presentationSessionId !== summary.presentationSessionId),
      );
      // A deleted deck can never be re-entered: if it is the loaded cockpit, drop it so the
      // workspace returns to the upload surface instead of steering a dead session.
      if (activePresentation?.presentationSessionId === summary.presentationSessionId) {
        setActivePresentation(null);
      }
      setConfirmingDeleteId(null);
      setDeleteErrorId(null);
    } catch {
      setDeleteErrorId(summary.presentationSessionId);
    } finally {
      setDeletingId(null);
    }
  };

  const saveRename = async (summary: PresentationSummaryView) => {
    if (client.renamePresentation === undefined || session === null) return;
    const title = renameDraft.trim();
    if (title.length === 0) return;
    try {
      const renamed = await client.renamePresentation(
        session.csrfToken,
        summary.presentationSessionId,
        title,
      );
      setItems((current) =>
        current.map((row) =>
          row.presentationSessionId === renamed.presentationSessionId
            ? { ...row, title: renamed.title, updatedAtMs: renamed.updatedAtMs }
            : row,
        ),
      );
      setRenamingId(null);
      setRenameErrorId(null);
    } catch {
      setRenameErrorId(summary.presentationSessionId);
    }
  };

  return (
    <Panel
      className="console-presentations"
      title={text.myPresentations}
      tone="inset"
      data-presentation-library={phase}
    >
      {phase === "ERROR" ? (
        <p className="console-status-line console-status-line--attention" role="alert">
          {text.presentationsFailed}{" "}
          <Button variant="quiet" onClick={() => void load()}>
            {text.presentationsRetry}
          </Button>
        </p>
      ) : items.length === 0 && phase === "READY" && showEmptyState ? (
        <p className="console-caption">{text.presentationsEmpty}</p>
      ) : items.length === 0 ? null : (
        <ul className="console-presentation-list">
          {items.map((item) => (
            <li
              key={item.presentationSessionId}
              className="console-presentation-row"
              data-presentation-row
              data-presentation-status={item.status}
            >
              {renamingId === item.presentationSessionId ? (
                <form
                  className="console-presentation-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveRename(item);
                  }}
                >
                  <label className="console-field">
                    <span className="ui-sr-only">{text.presentationRenameLabel}</span>
                    <input
                      aria-label={text.presentationRenameLabel}
                      data-presentation-rename-input
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.currentTarget.value)}
                    />
                  </label>
                  <Button type="submit" variant="quiet">
                    {text.presentationRenameSave}
                  </Button>
                  <Button variant="quiet" onClick={() => setRenamingId(null)}>
                    {text.presentationRenameCancel}
                  </Button>
                </form>
              ) : (
                <>
                  <span className="console-presentation-row__title" data-presentation-title>
                    {item.title}
                  </span>
                  <span className="console-presentation-row__meta">
                    {text.presentationSlideCount.replace("{count}", String(item.slideCount))}
                    {" · "}
                    {text.presentationUpdatedAt}{" "}
                    {new Date(item.updatedAtMs).toLocaleString(locale === "ko" ? "ko-KR" : "en-US")}
                    {" · "}
                    {item.status === "ENDED"
                      ? text.presentationEndedStatus
                      : text.presentationActiveStatus}
                  </span>
                </>
              )}
              <span className="console-presentation-row__actions">
                {item.status === "ENDED" ? (
                  <Link
                    className="ui-button ui-button--quiet"
                    to={`/reports/${encodeURIComponent(item.presentationSessionId)}`}
                  >
                    {text.presentationViewReport}
                  </Link>
                ) : (
                  <Button
                    disabled={resumingId !== null}
                    onClick={() => void resumePresentation(item)}
                  >
                    {text.presentationResume}
                  </Button>
                )}
                {renamingId === item.presentationSessionId ? null : (
                  <>
                    <Button
                      variant="quiet"
                      onClick={() => {
                        setRenamingId(item.presentationSessionId);
                        setRenameDraft(item.title);
                        setRenameErrorId(null);
                      }}
                    >
                      {text.presentationRename}
                    </Button>
                    {client.deletePresentation === undefined ? null : confirmingDeleteId ===
                      item.presentationSessionId ? (
                      <>
                        <Button
                          variant="quiet"
                          disabled={deletingId !== null}
                          onClick={() => void deleteItem(item)}
                        >
                          {text.presentationDeleteConfirm}
                        </Button>
                        <Button
                          variant="quiet"
                          onClick={() => {
                            setConfirmingDeleteId(null);
                            setDeleteErrorId(null);
                          }}
                        >
                          {text.presentationRenameCancel}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="quiet"
                        onClick={() => {
                          setConfirmingDeleteId(item.presentationSessionId);
                          setDeleteErrorId(null);
                        }}
                      >
                        {text.presentationDelete}
                      </Button>
                    )}
                  </>
                )}
              </span>
              {renameErrorId === item.presentationSessionId ? (
                <p className="console-status-line console-status-line--attention" role="alert">
                  {text.presentationRenameFailed}
                </p>
              ) : null}
              {deleteErrorId === item.presentationSessionId ? (
                <p
                  className="console-status-line console-status-line--attention"
                  role="alert"
                  data-presentation-delete="FAILED"
                >
                  {text.presentationDeleteFailed}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {resumeError ? (
        <p
          className="console-status-line console-status-line--attention"
          role="alert"
          data-presentation-library-resume="FAILED"
        >
          {text.presentationResumeFailed}
        </p>
      ) : null}
      {nextCursor === null ? null : (
        <Button variant="quiet" onClick={() => void load(nextCursor)}>
          {text.presentationsLoadMore}
        </Button>
      )}
    </Panel>
  );
}

/**
 * Maps the owner-scoped resume detail onto the cockpit's active presentation. The public
 * deck's slides and CAS fields arrive verbatim; the control revision seeds the command chain
 * and the current slide keeps a returned presenter where the room actually is.
 */
export function activePresentationFromDetail(
  detail: PresentationDetailView,
): ActivePresentationView {
  return {
    presentationSessionId: detail.presentationSessionId,
    presentationSessionEpoch: detail.presentationSessionEpoch,
    deckVersion: detail.deckVersion,
    manifestHash: detail.publicDeck.manifestHash,
    title: detail.title,
    status: detail.status,
    displayBindingEpoch: detail.playback.displayBindingEpoch,
    controlRevision: detail.playback.controlRevision,
    currentSlideKey: detail.playback.occurrence.publicSlideKey,
    slides: detail.publicDeck.slides,
  };
}
