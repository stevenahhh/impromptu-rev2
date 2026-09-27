import { useId } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./auth-session";
import { messages } from "./i18n";
import { PresentationListPanel } from "./presentation-list-panel";

/**
 * The "My presentations" destination: the persisted owner list with an explicit path into
 * deck upload for a new presentation. Rows never come from localStorage; the panel reads the
 * private backend each mount.
 */
export function PresentationsPage() {
  const titleId = useId();
  const { locale } = useAuth();
  const text = messages(locale);
  return (
    <section className="console-stack ui-reveal" aria-labelledby={titleId}>
      <div>
        <h1 id={titleId}>{text.myPresentations}</h1>
        <p className="console-lead">{text.presentationsLead}</p>
        <Link className="ui-button ui-button--primary" to="/">
          {text.newDeck}
        </Link>
      </div>
      <PresentationListPanel showEmptyState />
    </section>
  );
}
