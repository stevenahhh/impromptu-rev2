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
      <AuthProvider>
        <ConsoleRoutes coResident={process.env.NEXT_PUBLIC_CO_RESIDENT_CONSOLE === "true"} />
      </AuthProvider>
    </BrowserRouter>
  );
}
