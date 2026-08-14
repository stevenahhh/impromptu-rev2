import { parsePrivateBackendConfig } from "../../../../../private-backend/src/config.ts";

export function loadPrivateConfig() {
  return parsePrivateBackendConfig({
    PRIVATE_BACKEND_PORT: "4102",
    CONSOLE_ORIGIN: "https://console.example.test",
  });
}
