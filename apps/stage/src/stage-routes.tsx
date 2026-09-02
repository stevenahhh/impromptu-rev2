import { useMemo } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import DisplayPage from "./display-page";
import LandingPage from "./landing-page";
import { STAGE_PUBLIC_API_ORIGIN } from "./slide-view";
import { createStageSessionClient, type StageSessionClient } from "./stage-client";

export function StageRoutes({ client }: { readonly client?: StageSessionClient }) {
  const sessionClient = useMemo(
    () => client ?? createStageSessionClient(STAGE_PUBLIC_API_ORIGIN),
    [client],
  );
  return (
    <Routes>
      <Route index element={<LandingPage client={sessionClient} />} />
      <Route path="/display/:displayId" element={<DisplayPage client={sessionClient} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
