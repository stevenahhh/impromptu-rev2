import { Badge } from "@impromptu/ui";
import type { PrivateEvidenceCardView } from "./session-client";

export type EvidenceCardText = Readonly<{
  summary: string;
  sourceUrl: string;
  sourceDate: string;
  internalApproved: string;
  externalUnknown: string;
}>;

export interface EvidenceCardProps {
  readonly card: PrivateEvidenceCardView & Readonly<{ id: string; summary: string }>;
  readonly text: EvidenceCardText;
}

function displayDate(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

export function EvidenceCard({ card, text }: EvidenceCardProps) {
  const rightsLabel = card.kind === "EXTERNAL" ? text.externalUnknown : text.internalApproved;
  const sourceDate = displayDate(card.sourceDate);
  return (
    <article
      className="console-evidence-card"
      data-evidence-card={card.id}
      data-evidence-kind={card.kind}
    >
      <h3>{card.title}</h3>
      <Badge data-evidence-badge tone={card.kind === "INTERNAL" ? "success" : "neutral"}>
        {rightsLabel}
      </Badge>
      <dl>
        <div>
          <dt>{text.summary}</dt>
          <dd>{card.summary}</dd>
        </div>
        {card.sourceUrl === null ? null : (
          <div>
            <dt>{text.sourceUrl}</dt>
            <dd>
              <a href={card.sourceUrl} rel="noreferrer" target="_blank">
                {card.sourceUrl}
              </a>
            </dd>
          </div>
        )}
        {sourceDate === null ? null : (
          <div>
            <dt>{text.sourceDate}</dt>
            <dd>{sourceDate}</dd>
          </div>
        )}
      </dl>
    </article>
  );
}
