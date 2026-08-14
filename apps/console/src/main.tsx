import "@impromptu/ui/styles.css";
import "./console.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { AuthProvider, ConsoleRoutes } from "./App";
import { registerConsoleServiceWorker } from "./registerServiceWorker";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Console root element is missing");
}

document.documentElement.dataset.surface = "console";

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ConsoleRoutes coResident={import.meta.env.VITE_CO_RESIDENT_CONSOLE === "true"} />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

registerConsoleServiceWorker();
