import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

export type ArchitectureViolationCode =
  | "ALIAS_ESCAPE"
  | "BOUNDARY_ESCAPE"
  | "COMMONJS_REQUIRE"
  | "EXTERNAL_IMPORT"
  | "FORBIDDEN_PRIVATE_DEPENDENCY"
  | "IMPORT_EQUALS"
  | "INVALID_TSCONFIG"
  | "MALFORMED_DEPENDENCY_GROUP"
  | "MALFORMED_PACKAGE_MANIFEST"
  | "NON_LITERAL_DYNAMIC_IMPORT"
  | "NON_LITERAL_IMPORT_TYPE";

export interface ArchitectureViolation {
  readonly code: ArchitectureViolationCode;
  readonly file: string;
  readonly specifier?: string;
  readonly group?: string;
  readonly dependency?: string;
}

export interface PathAlias {
  readonly pattern: string;
  readonly targets: readonly string[];
}

export interface SourceBoundaryPolicy {
  readonly sourceRoot: string;
  readonly aliases: readonly PathAlias[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function aliasTargets(specifier: string, aliases: readonly PathAlias[]): readonly string[] | null {
  for (const alias of aliases) {
    const wildcard = alias.pattern.indexOf("*");
    if (wildcard === -1) {
      if (specifier === alias.pattern) {
        return alias.targets;
      }
      continue;
    }

    const prefix = alias.pattern.slice(0, wildcard);
    const suffix = alias.pattern.slice(wildcard + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
      continue;
    }

    const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    return alias.targets.map((target) => target.replace("*", matched));
  }

  return null;
}

function checkSpecifier(
  file: string,
  specifier: string,
  policy: SourceBoundaryPolicy,
): readonly ArchitectureViolation[] {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(file), specifier);
    return isInside(policy.sourceRoot, target)
      ? []
      : [{ code: "BOUNDARY_ESCAPE", file, specifier }];
  }

  const targets = aliasTargets(specifier, policy.aliases);
  if (targets === null) {
    return [{ code: "EXTERNAL_IMPORT", file, specifier }];
  }

  return targets
    .filter((target) => !isInside(policy.sourceRoot, resolve(target)))
    .map(() => ({ code: "ALIAS_ESCAPE" as const, file, specifier }));
}

function isRequireCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) {
    return node.expression.text === "require";
  }

  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require";
}

export function scanSourceText(
  file: string,
  text: string,
  policy: SourceBoundaryPolicy,
): readonly ArchitectureViolation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const violations: ArchitectureViolation[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      violations.push(...checkSpecifier(file, node.moduleSpecifier.text, policy));
    } else if (ts.isImportEqualsDeclaration(node)) {
      violations.push({ code: "IMPORT_EQUALS", file });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        violations.push(...checkSpecifier(file, argument.literal.text, policy));
      } else {
        violations.push({ code: "NON_LITERAL_IMPORT_TYPE", file });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (node.arguments.length === 1 && argument !== undefined && ts.isStringLiteral(argument)) {
        violations.push(...checkSpecifier(file, argument.text, policy));
      } else {
        violations.push({ code: "NON_LITERAL_DYNAMIC_IMPORT", file });
      }
    } else if (ts.isCallExpression(node) && isRequireCall(node)) {
      violations.push({ code: "COMMONJS_REQUIRE", file });
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

function filesNamed(directory: string, name: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") {
      return [];
    }

    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return filesNamed(path, name);
    }
    return entry.name === name ? [path] : [];
  });
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function isForbiddenPrivateDependency(name: string, specifier?: string): boolean {
  if (name === "@impromptu/private-backend") {
    return true;
  }

  return specifier?.includes("@impromptu/private-backend") === true;
}

export function scanPackageManifest(file: string, text: string): readonly ArchitectureViolation[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [{ code: "MALFORMED_PACKAGE_MANIFEST", file }];
  }

  if (!isRecord(manifest)) {
    return [{ code: "MALFORMED_PACKAGE_MANIFEST", file }];
  }

  const violations: ArchitectureViolation[] = [];
  for (const [group, value] of Object.entries(manifest)) {
    if (group !== "dependencies" && !group.endsWith("Dependencies")) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const dependency of value) {
        if (typeof dependency === "string" && isForbiddenPrivateDependency(dependency)) {
          violations.push({ code: "FORBIDDEN_PRIVATE_DEPENDENCY", file, group, dependency });
        }
      }
      continue;
    }

    if (!isRecord(value)) {
      violations.push({ code: "MALFORMED_DEPENDENCY_GROUP", file, group });
      continue;
    }

    for (const [dependency, specifier] of Object.entries(value)) {
      if (
        isForbiddenPrivateDependency(
          dependency,
          typeof specifier === "string" ? specifier : undefined,
        )
      ) {
        violations.push({ code: "FORBIDDEN_PRIVATE_DEPENDENCY", file, group, dependency });
      }
    }
  }

  return violations;
}

function loadAliases(configPath: string): {
  readonly aliases: readonly PathAlias[];
  readonly violations: readonly ArchitectureViolation[];
} {
  const diagnostics: ts.Diagnostic[] = [];
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (parsed === undefined) {
    return {
      aliases: [],
      violations: [{ code: "INVALID_TSCONFIG", file: configPath }],
    };
  }

  diagnostics.push(...parsed.errors);
  const baseUrl = parsed.options.baseUrl ?? dirname(configPath);
  const aliases = Object.entries(parsed.options.paths ?? {}).map(([pattern, targets]) => ({
    pattern,
    targets: targets.map((target) => resolve(baseUrl, target)),
  }));

  return {
    aliases,
    violations: diagnostics.map(() => ({ code: "INVALID_TSCONFIG", file: configPath })),
  };
}

export function scanProjectionArchitecture(serviceRoot: string): readonly ArchitectureViolation[] {
  const sourceRoot = resolve(serviceRoot, "src");
  const configPath = resolve(serviceRoot, "tsconfig.json");
  const aliasResult = loadAliases(configPath);
  const policy: SourceBoundaryPolicy = {
    sourceRoot,
    aliases: aliasResult.aliases,
  };
  const sourceViolations = sourceFiles(sourceRoot).flatMap((file) =>
    scanSourceText(file, readFileSync(file, "utf8"), policy),
  );
  const manifestViolations = filesNamed(serviceRoot, "package.json").flatMap((file) =>
    scanPackageManifest(file, readFileSync(file, "utf8")),
  );

  return [...aliasResult.violations, ...sourceViolations, ...manifestViolations];
}
