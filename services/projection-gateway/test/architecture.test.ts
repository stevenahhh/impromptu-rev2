import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const serviceRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(serviceRoot, "src");

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

function importsFrom(path: string): readonly string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const imports: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        imports.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return imports;
}

describe("projection gateway architecture", () => {
  test("production imports stay inside the projection gateway", () => {
    const violations: string[] = [];

    for (const path of sourceFiles(sourceRoot)) {
      for (const specifier of importsFrom(path)) {
        if (!specifier.startsWith(".")) {
          violations.push(`${relative(serviceRoot, path)} imports external module ${specifier}`);
          continue;
        }

        const target = resolve(dirname(path), specifier);
        if (relative(sourceRoot, target).startsWith("..")) {
          violations.push(
            `${relative(serviceRoot, path)} escapes service boundary via ${specifier}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("publishes one root entrypoint and no private subpath", () => {
    const manifest = JSON.parse(readFileSync(resolve(serviceRoot, "package.json"), "utf8")) as {
      exports?: unknown;
      dependencies?: Record<string, string>;
    };

    expect(manifest.exports).toEqual({ ".": "./src/index.ts" });
    expect(manifest.dependencies?.["@impromptu/private-backend"]).toBeUndefined();
  });
});
