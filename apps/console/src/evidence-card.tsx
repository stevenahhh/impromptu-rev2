import { Badge } from "@impromptu/ui";
import type { PrivateEvidenceCardView } from "./session-client";

export type EvidenceCardText = Readonly<{
  summary: string;
  sourceUrl: string;
  sourceDate: string;
  rights: string;
  sourceUnavailable: string;
  dateUnavailable: string;
  internalApproved: string;
  externalUnknown: string;
}>;

export interface EvidenceCardProps {
  readonly card: PrivateEvidenceCardView & Readonly<{ id: string; summary: string }>;
  readonly text: EvidenceCardText;
}

function displayDate(value: string | null, unavailable: string): string {
  if (value === null) return unavailable;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : unavailable;
}

export function EvidenceCard({ card, text }: EvidenceCardProps) {
  const rightsLabel = card.kind === "EXTERNAL" ? text.externalUnknown : text.internalApproved;
  return (
    <article
      className="console-evidence-card"
      data-evidence-card={card.id}
      data-evidence-kind={card.kind}
    >
      <h3>{card.title}</h3>
      <Badge tone={card.kind === "INTERNAL" ? "success" : "neutral"}>{rightsLabel}</Badge>
      <dl>
        <div>
          <dt>{text.summary}</dt>
          <dd>{card.summary}</dd>
        </div>
        <div>
          <dt>{text.sourceUrl}</dt>
          <dd>
            {card.sourceUrl === null ? (
              text.sourceUnavailable
            ) : (
              <a href={card.sourceUrl} rel="noreferrer" target="_blank">
                {card.sourceUrl}
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt>{text.sourceDate}</dt>
          <dd>{displayDate(card.sourceDate, text.dateUnavailable)}</dd>
        </div>
        <div>
          <dt>{text.rights}</dt>
          <dd>{rightsLabel}</dd>
        </div>
      </dl>
    </article>
  );
}
