import { resolve } from "node:path";
import { scanProjectionArchitecture } from "./support/architecture-scanner.ts";

const serviceRoot = resolve(import.meta.dir, "..");
const violations = scanProjectionArchitecture(serviceRoot);

if (violations.length > 0) {
  console.error(JSON.stringify(violations));
  process.exit(1);
}

console.log(JSON.stringify({ service: "projection-gateway", architecture: "valid" }));
