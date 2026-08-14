import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const defaultManifestPath = "config/browser-forbidden-dependencies.json";
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export interface BrowserDependencyManifest {
  readonly browserRoots: readonly string[];
  readonly forbiddenPackagePrefixes: readonly string[];
  readonly forbiddenPathFragments: readonly string[];
}

export interface BrowserDependencyViolation {
  readonly file: string;
  readonly kind: "forbidden-import" | "forbidden-manifest-dependency";
  readonly specifier: string;
  readonly rule: string;
}

export function loadBrowserDependencyManifest(
  path = defaultManifestPath,
): BrowserDependencyManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new TypeError("Browser dependency manifest must be an object");
  return Object.freeze({
    browserRoots: readStringArray(parsed, "browserRoots"),
    forbiddenPackagePrefixes: readStringArray(parsed, "forbiddenPackagePrefixes"),
    forbiddenPathFragments: readStringArray(parsed, "forbiddenPathFragments"),
  });
}

export function scanBrowserDependencies(
  manifest: BrowserDependencyManifest,
  roots: readonly string[] = manifest.browserRoots,
  cwd = process.cwd(),
): BrowserDependencyViolation[] {
  const violations: BrowserDependencyViolation[] = [];
  for (const file of collectFiles(roots, cwd)) {
    const relativeFile = toPosix(relative(cwd, file));
    const specifiers = file.endsWith("package.json")
      ? readManifestDependencies(file)
      : extractModuleSpecifiers(readFileSync(file, "utf8"));
    const kind = file.endsWith("package.json")
      ? "forbidden-manifest-dependency"
      : "forbidden-import";
    violations.push(...findForbiddenDependencyViolations(manifest, relativeFile, specifiers, kind));
  }
  return violations.sort((left, right) =>
    `${left.file}\u0000${left.specifier}`.localeCompare(`${right.file}\u0000${right.specifier}`),
  );
}

export function findForbiddenDependencyViolations(
  manifest: BrowserDependencyManifest,
  file: string,
  specifiers: readonly string[],
  kind: BrowserDependencyViolation["kind"] = "forbidden-import",
): BrowserDependencyViolation[] {
  const violations: BrowserDependencyViolation[] = [];
  for (const specifier of new Set(specifiers)) {
    const packageRule = manifest.forbiddenPackagePrefixes.find(
      (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
    );
    const pathRule = manifest.forbiddenPathFragments.find((fragment) =>
      toPosix(specifier).includes(fragment),
    );
    const rule = packageRule ?? pathRule;
    if (rule !== undefined) violations.push({ file, kind, specifier, rule });
  }
  return violations;
}

function collectFiles(roots: readonly string[], cwd: string): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const absoluteRoot = resolve(cwd, root);
    if (!existsSync(absoluteRoot)) continue;
    if (!statSync(absoluteRoot).isDirectory()) {
      files.push(absoluteRoot);
      continue;
    }
    walk(absoluteRoot, files);
  }
  return files.sort();
}

function walk(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (entry.isFile() && isScannableFile(entry.name)) {
      files.push(path);
    }
  }
}

function isScannableFile(name: string): boolean {
  if (name === "package.json") return true;
  const extensionStart = name.lastIndexOf(".");
  return extensionStart >= 0 && sourceExtensions.has(name.slice(extensionStart));
}

function extractModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamicImport = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function readManifestDependencies(path: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) return [];
  const dependencies: string[] = [];
  for (const section of dependencySections) {
    const value = parsed[section];
    if (isRecord(value)) dependencies.push(...Object.keys(value));
  }
  return dependencies;
}

function readStringArray(
  value: Readonly<Record<string, unknown>>,
  property: string,
): readonly string[] {
  const candidate = value[property];
  if (
    !Array.isArray(candidate) ||
    !candidate.every((entry): entry is string => typeof entry === "string" && entry.length > 0)
  ) {
    throw new TypeError(`Browser dependency manifest ${property} must be a non-empty string array`);
  }
  return Object.freeze([...candidate]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

if (import.meta.main) {
  const manifest = loadBrowserDependencyManifest();
  const requestedRoots = process.argv.slice(2);
  const violations = scanBrowserDependencies(
    manifest,
    requestedRoots.length === 0 ? manifest.browserRoots : requestedRoots,
  );
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `${violation.file}: ${violation.kind} '${violation.specifier}' matches '${violation.rule}'`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log("Browser dependency boundary verified.");
  }
}
