"use client";

import { useEffect } from "react";
import { BrowserRouter } from "react-router-dom";

import { AuthProvider, ConsoleRoutes } from "../../App";
import { registerConsoleServiceWorker } from "../../registerServiceWorker";

export function ConsoleClient() {
  useEffect(() => {
    registerConsoleServiceWorker();
  }, []);

  return (
    <BrowserRouter>
      {/* Session hydration restores the signed-in workspace after a reload; the server list,
          not storage, decides what the presenter sees. */}
      <AuthProvider hydrateSession>
        <ConsoleRoutes coResident={process.env.NEXT_PUBLIC_CO_RESIDENT_CONSOLE === "true"} />
      </AuthProvider>
    </BrowserRouter>
  );
}
