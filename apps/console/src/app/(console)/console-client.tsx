"use client";

import { useEffect } from "react";
import { BrowserRouter } from "react-router-dom";

import { AuthProvider, ConsoleRoutes } from "../../App";
import type { PresentationTemplate } from "../../presentation-templates";
import { registerConsoleServiceWorker } from "../../registerServiceWorker";

export function ConsoleClient({
  templates,
}: {
  readonly templates: readonly PresentationTemplate[];
}) {
  useEffect(() => {
    registerConsoleServiceWorker();
  }, []);

  return (
    <BrowserRouter>
      <AuthProvider>
        <ConsoleRoutes
          coResident={process.env.NEXT_PUBLIC_CO_RESIDENT_CONSOLE === "true"}
          templates={templates}
        />
      </AuthProvider>
    </BrowserRouter>
  );
}
