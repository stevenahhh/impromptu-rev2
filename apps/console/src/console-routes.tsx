import { useId } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { SignInPage, SignUpPage } from "./auth-pages";
import { PublicOnly, RequireAuth, useAuth } from "./auth-session";
import { messages } from "./i18n";
import { PrivateLayout } from "./private-shell";
import { PresentationReportPage } from "./report-page";
import { PresentationWorkspacePage } from "./workspace-page";

function CockpitWorkspace() {
  // The page itself owns the debug overlay and shows it only once a deck is loaded.
  return <PresentationWorkspacePage />;
}

/**
 * Compatibility surface for the retired /live-publication route (plan task 28). A silent
 * redirect dropped a presenter mid-bookmark with no explanation; the route keeps serving a
 * guide-and-return step so the retired public-approval flow is explained, not just dead. The
 * locale files are owned elsewhere, so the notice carries its own bilingual literals rather
 * than reaching into another lane's catalog.
 */
function LivePublicationInterstitial() {
  const titleId = useId();
  const { locale } = useAuth();
  const text = messages(locale);
  return (
    <section
      className="console-stack ui-reveal"
      aria-labelledby={titleId}
      data-live-publication-interstitial
    >
      <div>
        <h1 id={titleId}>{text.liveApproval}</h1>
        <p className="console-lead">
          {locale === "ko"
            ? "청중에게 바로 공개하던 승인 화면은 이제 제공되지 않습니다. 발표 준비와 발표 진행은 워크스페이스에서 계속할 수 있습니다."
            : "The live approval page for publishing straight to the audience is retired. Preparing and presenting continue in the workspace."}
        </p>
      </div>
      <Link className="ui-button ui-button--primary" to="/">
        {text.workspace}
      </Link>
    </section>
  );
}

export function ConsoleRoutes({ coResident = false }: { readonly coResident?: boolean }) {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/sign-up" element={<SignUpPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<PrivateLayout coResident={coResident} />}>
          <Route index element={<CockpitWorkspace />} />
          <Route path="/session" element={<CockpitWorkspace />} />
          <Route path="/live-publication" element={<LivePublicationInterstitial />} />
          <Route path="/reports/:presentationSessionId" element={<PresentationReportPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/sign-in" replace />} />
    </Routes>
  );
}
