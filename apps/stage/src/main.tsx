import "@impromptu/ui/styles.css";
import "./stage.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { StageRoutes } from "./App";
import { registerStageServiceWorker } from "./registerServiceWorker";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Stage root element is missing");
}

document.documentElement.dataset.surface = "stage";

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <StageRoutes />
    </BrowserRouter>
  </StrictMode>,
);

registerStageServiceWorker();
