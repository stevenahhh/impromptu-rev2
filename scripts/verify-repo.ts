import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "docs/AI-BOUNDARY.md",
  "docs/DEMO-SCOPE.md",
  ".omo/plans/impromptu-r2-hyperplan.md",
] as const;

const missingFiles = requiredFiles.filter((path) => !existsSync(path));

if (missingFiles.length > 0) {
  throw new Error(`Missing required repository files: ${missingFiles.join(", ")}`);
}

const packageManifest = JSON.parse(readFileSync("package.json", "utf8")) as {
  name?: unknown;
  private?: unknown;
};

if (packageManifest.name !== "impromptu-r2" || packageManifest.private !== true) {
  throw new Error("package.json must identify the private impromptu-r2 workspace");
}

const gitignore = readFileSync(".gitignore", "utf8");
const requiredIgnoreEntries = [
  ".env",
  ".omo/senpi-task/",
  ".senpi/",
  "models/",
  "uploads/",
] as const;
const missingIgnoreEntries = requiredIgnoreEntries.filter((entry) => !gitignore.includes(entry));

if (missingIgnoreEntries.length > 0) {
  throw new Error(`Missing required .gitignore entries: ${missingIgnoreEntries.join(", ")}`);
}

console.log(`Repository policy verified (${requiredFiles.length} required files).`);
