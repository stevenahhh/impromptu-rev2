import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

function compileFixture(path: string): readonly ts.Diagnostic[] {
  const fixturePath = resolve(path).replaceAll("\\", "/");
  const virtualPath = fixturePath.slice(0, -".txt".length);
  const fixtureSource = readFileSync(fixturePath, "utf8");
  const host = ts.createCompilerHost(compilerOptions);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => fileName === virtualPath || ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    fileName === virtualPath ? fixtureSource : ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === virtualPath
      ? ts.createSourceFile(fileName, fixtureSource, languageVersion, true)
      : defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([virtualPath], compilerOptions, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === virtualPath);
}

describe("nominal card-state boundaries", () => {
  for (const fixture of [
    "tests/contract/fixtures/authoritative-as-compact.ts.txt",
    "tests/contract/fixtures/compact-as-authoritative.ts.txt",
    "tests/contract/fixtures/forged-compact-brand.ts.txt",
  ]) {
    test(`rejects ${fixture}`, () => {
      const diagnostics = compileFixture(fixture);
      expect(diagnostics.map(({ code }) => code)).toEqual([2322]);
    });
  }
});
