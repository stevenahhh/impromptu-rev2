import { Navigate, Route, Routes } from "react-router-dom";
import { SignInPage, SignUpPage } from "./auth-pages";
import { PublicOnly, RequireAuth } from "./auth-session";
import { LivePublicationPage } from "./live-publication-page";
import { PrivateLayout } from "./private-shell";
import { PresentationReportPage } from "./report-page";
import { PresentationWorkspacePage } from "./workspace-page";

function CockpitWorkspace() {
  // The page itself owns the debug overlay and shows it only once a deck is loaded.
  return <PresentationWorkspacePage />;
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
          <Route path="/live-publication" element={<LivePublicationPage />} />
          <Route path="/reports/:presentationSessionId" element={<PresentationReportPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/sign-in" replace />} />
    </Routes>
  );
}
