import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const defaultManifestPath = "config/browser-forbidden-dependencies.json";
const sourceExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".map",
  ".mjs",
  ".ts",
  ".tsx",
]);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const manifestProperties = new Set([
  "browserRoots",
  "forbiddenPackagePrefixes",
  "forbiddenPathFragments",
  "forbiddenArtifactExtensions",
  "forbiddenContentSignatures",
  "forbiddenProviderOrigins",
]);

export interface BrowserDependencyManifest {
  readonly browserRoots: readonly string[];
  readonly forbiddenPackagePrefixes: readonly string[];
  readonly forbiddenPathFragments: readonly string[];
  readonly forbiddenArtifactExtensions: readonly string[];
  readonly forbiddenContentSignatures: readonly string[];
  readonly forbiddenProviderOrigins: readonly string[];
}

export interface BrowserDependencyViolation {
  readonly file: string;
  readonly kind:
    | "empty-root"
    | "forbidden-artifact"
    | "forbidden-content-signature"
    | "forbidden-csp-origin"
    | "forbidden-import"
    | "forbidden-manifest-dependency"
    | "missing-csp"
    | "missing-root";
  readonly specifier: string;
  readonly rule: string;
}

export function loadBrowserDependencyManifest(
  path = defaultManifestPath,
): BrowserDependencyManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new TypeError("Browser dependency manifest must be an object");
  const unknownProperties = Object.keys(parsed).filter(
    (property) => !manifestProperties.has(property),
  );
  if (unknownProperties.length > 0) {
    throw new TypeError(
      `Unknown browser dependency manifest properties: ${unknownProperties.join(", ")}`,
    );
  }
  return Object.freeze({
    browserRoots: readStringArray(parsed, "browserRoots"),
    forbiddenPackagePrefixes: readStringArray(parsed, "forbiddenPackagePrefixes"),
    forbiddenPathFragments: readStringArray(parsed, "forbiddenPathFragments"),
    forbiddenArtifactExtensions: readStringArray(parsed, "forbiddenArtifactExtensions"),
    forbiddenContentSignatures: readStringArray(parsed, "forbiddenContentSignatures"),
    forbiddenProviderOrigins: readStringArray(parsed, "forbiddenProviderOrigins"),
  });
}

export function scanBrowserDependencies(
  manifest: BrowserDependencyManifest,
  roots: readonly string[] = manifest.browserRoots,
  cwd = process.cwd(),
): BrowserDependencyViolation[] {
  if (roots.length === 0) {
    return [violation(".", "empty-root", ".", "at least one browser root is required")];
  }
  const violations: BrowserDependencyViolation[] = [];
  for (const root of roots) scanRoot(manifest, root, cwd, violations);
  return violations.sort((left, right) =>
    `${left.file}\u0000${left.kind}\u0000${left.specifier}`.localeCompare(
      `${right.file}\u0000${right.kind}\u0000${right.specifier}`,
    ),
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

function scanRoot(
  manifest: BrowserDependencyManifest,
  root: string,
  cwd: string,
  violations: BrowserDependencyViolation[],
): void {
  const absoluteRoot = resolve(cwd, root);
  const relativeRoot = toPosix(relative(cwd, absoluteRoot));
  if (!existsSync(absoluteRoot)) {
    violations.push(
      violation(relativeRoot, "missing-root", relativeRoot, "browser root must exist"),
    );
    return;
  }

  const rootIsDirectory = statSync(absoluteRoot).isDirectory();
  const files = rootIsDirectory ? collectDirectoryFiles(absoluteRoot, manifest) : [absoluteRoot];
  if (files.length === 0) {
    violations.push(
      violation(
        relativeRoot,
        "empty-root",
        relativeRoot,
        "browser root must contain scannable files",
      ),
    );
    return;
  }

  let cspFound = false;
  for (const file of files) {
    const relativeFile = toPosix(relative(cwd, file));
    const extension = extensionOf(file);
    if (manifest.forbiddenArtifactExtensions.includes(extension)) {
      violations.push(
        violation(relativeFile, "forbidden-artifact", extension, "forbidden model artifact"),
      );
      continue;
    }

    if (file.endsWith("package.json")) {
      violations.push(
        ...findForbiddenDependencyViolations(
          manifest,
          relativeFile,
          readManifestDependencies(file),
          "forbidden-manifest-dependency",
        ),
      );
    }

    const source = readFileSync(file, "utf8");
    violations.push(
      ...findForbiddenDependencyViolations(manifest, relativeFile, extractModuleSpecifiers(source)),
    );
    violations.push(...findForbiddenContentViolations(manifest, relativeFile, source));
    if (containsCsp(source)) {
      cspFound = true;
      violations.push(...findForbiddenCspViolations(manifest, relativeFile, source));
    }
  }

  if (rootIsDirectory && !cspFound) {
    violations.push(
      violation(relativeRoot, "missing-csp", relativeRoot, "browser root must define a CSP"),
    );
  }
}

function collectDirectoryFiles(directory: string, manifest: BrowserDependencyManifest): string[] {
  const files: string[] = [];
  walk(directory, files, manifest);
  return files.sort();
}

function walk(directory: string, files: string[], manifest: BrowserDependencyManifest): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, files, manifest);
    } else if (entry.isFile() && isScannableFile(entry.name, manifest)) {
      files.push(path);
    }
  }
}

function isScannableFile(name: string, manifest: BrowserDependencyManifest): boolean {
  if (name === "package.json") return true;
  const extension = extensionOf(name);
  return (
    sourceExtensions.has(extension) || manifest.forbiddenArtifactExtensions.includes(extension)
  );
}

function findForbiddenContentViolations(
  manifest: BrowserDependencyManifest,
  file: string,
  source: string,
): BrowserDependencyViolation[] {
  const normalizedSource = source.toLowerCase();
  return manifest.forbiddenContentSignatures
    .filter((signature) => normalizedSource.includes(signature.toLowerCase()))
    .map((signature) =>
      violation(file, "forbidden-content-signature", signature, "forbidden bundle signature"),
    );
}

function findForbiddenCspViolations(
  manifest: BrowserDependencyManifest,
  file: string,
  source: string,
): BrowserDependencyViolation[] {
  const normalizedSource = source.toLowerCase();
  return manifest.forbiddenProviderOrigins
    .filter((origin) => normalizedSource.includes(origin.toLowerCase()))
    .map((origin) =>
      violation(file, "forbidden-csp-origin", origin, "CSP permits a provider origin"),
    );
}

function containsCsp(source: string): boolean {
  return /content-security-policy/i.test(source);
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
  if (!isRecord(parsed)) throw new TypeError(`${path} package manifest must be an object`);
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
    candidate.length === 0 ||
    !candidate.every((entry): entry is string => typeof entry === "string" && entry.length > 0)
  ) {
    throw new TypeError(`Browser dependency manifest ${property} must be a non-empty string array`);
  }
  return Object.freeze([...candidate]);
}

function violation(
  file: string,
  kind: BrowserDependencyViolation["kind"],
  specifier: string,
  rule: string,
): BrowserDependencyViolation {
  return { file, kind, specifier, rule };
}

function extensionOf(path: string): string {
  const extensionStart = path.lastIndexOf(".");
  return extensionStart >= 0 ? path.slice(extensionStart).toLowerCase() : "";
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
    for (const entry of violations) {
      console.error(`${entry.file}: ${entry.kind} '${entry.specifier}' (${entry.rule})`);
    }
    process.exitCode = 1;
  } else {
    console.log("Browser dependency boundary verified.");
  }
}
