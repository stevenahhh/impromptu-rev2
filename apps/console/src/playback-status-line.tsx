export type PlaybackStatusKind = "NEUTRAL" | "PROBLEM";

/**
 * The playback panel's live status hierarchy. Both slots stay mounted for the panel's whole
 * life because a live region only announces reliably when it exists before its content does;
 * only the problem slot sits inside a live region, so routine receipts never announce
 * themselves over the talk.
 */
export function PlaybackStatusLine({
  idle,
  status,
}: {
  readonly idle: string;
  readonly status: { readonly kind: PlaybackStatusKind; readonly text: string };
}) {
  return (
    <div className="console-present__status" data-playback-status={status.kind}>
      <p className="console-caption" data-slot="neutral" hidden={status.kind === "PROBLEM"}>
        {status.kind === "NEUTRAL" ? status.text || idle : ""}
      </p>
      <p
        className="console-caption console-caption--error"
        data-slot="problem"
        aria-live="polite"
        hidden={status.kind !== "PROBLEM"}
      >
        {status.kind === "PROBLEM" ? status.text : ""}
      </p>
    </div>
  );
}
