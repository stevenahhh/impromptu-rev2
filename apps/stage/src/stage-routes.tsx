import { useEffect, useMemo } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import DisplayPage from "./display-page";
import LandingPage from "./landing-page";
import { STAGE_PUBLIC_API_ORIGIN } from "./slide-view";
import { createStageSessionClient, type StageSessionClient } from "./stage-client";
import {
  resolveStageLocale,
  StageCopyProvider,
  StageLocaleContext,
  stageMessages,
} from "./stage-i18n";

export function StageRoutes({ client }: { readonly client?: StageSessionClient }) {
  const sessionClient = useMemo(
    () => client ?? createStageSessionClient(STAGE_PUBLIC_API_ORIGIN),
    [client],
  );
  // Resolved once at app mount: the audience device language, or the presenter-chosen ?lang=
  // the Console appends when it opens the window. The audience entry point is the real window
  // URL (which may carry ?deck=…&lang=…#invite=…); the router's own location only sees the SPA
  // entry, so window.location.search is the authoritative source for the mount-time choice. The
  // dep list is intentionally empty — the entry URL does not change through SPA navigation.
  const locale = useMemo(
    () =>
      resolveStageLocale(window.location.search, [
        ...(navigator.languages ?? []),
        navigator.language,
      ]),
    [],
  );
  const copy = stageMessages(locale);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = copy.pageTitle;
  }, [locale, copy]);

  return (
    <StageLocaleContext.Provider value={locale}>
      <StageCopyProvider value={copy}>
        <Routes>
          <Route index element={<LandingPage client={sessionClient} />} />
          <Route path="/display/:displayId" element={<DisplayPage client={sessionClient} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </StageCopyProvider>
    </StageLocaleContext.Provider>
  );
}
