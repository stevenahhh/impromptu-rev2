import { Badge, Panel } from "@impromptu/ui";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth-session";
import { createCorrelationId, getDebugLogger } from "./debug-log";
import { messages } from "./i18n";
import type { ReferenceDocumentSummaryView } from "./session-client";

/**
 * Presenter-uploaded reference documents: a project folder's worth of context attached to the
 * live session. Their text is indexed into the same retrieval store the deck uses, which is
 * what lets prepared evidence cite something other than the slides themselves.
 */
export function ReferenceDocumentPanel({ onIndexed }: { readonly onIndexed: () => void }) {
  const { activePresentation, client, locale, session } = useAuth();
  const text = messages(locale);
  const [documents, setDocuments] = useState<readonly ReferenceDocumentSummaryView[]>([]);
  const [phase, setPhase] = useState<"IDLE" | "UPLOADING" | "ERROR">("IDLE");
  const [message, setMessage] = useState("");
  const folderInput = useRef<HTMLInputElement | null>(null);

  const presentationSessionId = activePresentation?.presentationSessionId;

  useEffect(() => {
    if (presentationSessionId === undefined || client.listReferenceDocuments === undefined) return;
    let active = true;
    void client
      .listReferenceDocuments(presentationSessionId)
      .then((current) => {
        if (active) setDocuments(current);
      })
      .catch(() => {
        // An unreadable listing leaves the panel empty; uploading still reports its own outcome.
      });
    return () => {
      active = false;
    };
  }, [client, presentationSessionId]);

  const upload = async (selected: readonly File[]) => {
    if (
      selected.length === 0 ||
      session === null ||
      presentationSessionId === undefined ||
      client.uploadReferenceDocuments === undefined
    ) {
      return;
    }
    const log = getDebugLogger();
    const correlationId = createCorrelationId();
    setPhase("UPLOADING");
    setMessage(text.referenceUploading);
    try {
      const outcome = await log.timed(
        "upload",
        "reference-documents.upload",
        () =>
          // biome-ignore lint/style/noNonNullAssertion: guarded by the capability check above.
          client.uploadReferenceDocuments!(session.csrfToken, presentationSessionId, selected),
        { correlationId, detail: { fileCount: selected.length } },
      );
      if (outcome.outcome === "REJECTED") {
        log.warn("upload", "reference-documents.rejected", {
          correlationId,
          detail: { reason: outcome.reason },
        });
        setPhase("ERROR");
        setMessage(text.referenceRejected.replace("{reason}", outcome.reason));
        return;
      }
      setDocuments(outcome.documents);
      setPhase("IDLE");
      setMessage(text.referenceIndexed.replace("{count}", String(outcome.documents.length)));
      onIndexed();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("upload", "reference-documents.failed", { correlationId, detail: { reason } });
      setPhase("ERROR");
      setMessage(text.referenceRejected.replace("{reason}", reason));
    }
  };

  if (activePresentation === null) return null;
  return (
    <Panel className="console-reference-documents" title={text.referenceTitle} tone="inset">
      <div data-reference-documents-status={phase}>
        <p className="console-evidence-caption">{text.referenceLead}</p>
        <label className="ui-button ui-button--quiet console-file-button" data-reference-pick-files>
          <span>{phase === "UPLOADING" ? text.referenceUploading : text.referenceChooseFiles}</span>
          <input
            accept=".pdf,.pptx,.md,.txt,.docx"
            multiple
            type="file"
            onChange={(event) => {
              const selected = [...(event.target.files ?? [])];
              event.target.value = "";
              void upload(selected);
            }}
          />
        </label>
        <button
          className="ui-button ui-button--quiet"
          data-reference-pick-folder
          type="button"
          onClick={() => folderInput.current?.click()}
        >
          {text.referenceChooseFolder}
        </button>
        <input
          hidden
          multiple
          ref={(node) => {
            folderInput.current = node;
            // A folder picker is an attribute React does not model, so it is set directly.
            if (node !== null) node.setAttribute("webkitdirectory", "");
          }}
          type="file"
          onChange={(event) => {
            const selected = [...(event.target.files ?? [])];
            event.target.value = "";
            void upload(selected);
          }}
        />
        {documents.length === 0 ? null : (
          <ul className="console-evidence-list" data-reference-document-list>
            {documents.map((document) => (
              <li key={document.documentId}>
                <article
                  className="console-evidence-card"
                  data-reference-document={document.filename}
                >
                  <h3>{document.filename}</h3>
                  <Badge tone="neutral">
                    {document.status === "INDEXED"
                      ? text.referenceChunks.replace("{count}", String(document.chunkCount))
                      : text.referenceEmptyDocument}
                  </Badge>
                </article>
              </li>
            ))}
          </ul>
        )}
        <p className="console-evidence-caption" data-reference-documents-message>
          {message || text.referenceNone}
        </p>
      </div>
    </Panel>
  );
}
