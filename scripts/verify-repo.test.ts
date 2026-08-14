import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyRepository } from "./verify-repo.ts";

const fixtureRoots: string[] = [];
const fixtureFiles = [
  ".gitignore",
  "package.json",
  "README.md",
  "CONTRIBUTING.md",
  "docs/AI-BOUNDARY.md",
  "docs/DEMO-SCOPE.md",
  "docs/PWA-구현-최적화-연구보고서.md",
  "docs/PWA-구현-최적화-연구보고서.html",
  "docs/신청서.pdf",
  "docs/wp0/staffing-owners.json",
  "docs/runbooks/vendor-prewarm.md",
  "tests/corpus/holdout-manifest.json",
  "tests/corpus/korean-claims.manifest.json",
  "tests/fixtures/deck-registry.json",
  ".omo/hyperplan/pwa-presentation-debate.md",
  ".omo/plans/impromptu-r2-hyperplan.md",
  ".omo/ulw-research/20260814-040838/sources-ledger.md",
] as const;

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function makeRepositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "impromptu-r2-policy-"));
  fixtureRoots.push(root);

  for (const path of fixtureFiles) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(path, destination);
  }

  const init = Bun.spawnSync(["git", "init", "--quiet"], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error(init.stderr.toString());
  }

  return root;
}

describe("repository policy", () => {
  test("verifies the checked-in repository through recognizable content", () => {
    expect(() => verifyRepository(".")).not.toThrow();
  });

  test("uses the impromptu-r2 private workspace identity", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      name?: unknown;
      private?: unknown;
    };

    expect(manifest).toMatchObject({
      name: "impromptu-r2",
      private: true,
    });
  });

  test("ships the application, approved plan, research, and server-only AI boundary", () => {
    expect(existsSync("docs/신청서.pdf")).toBe(true);
    expect(existsSync("docs/PWA-구현-최적화-연구보고서.md")).toBe(true);
    expect(existsSync("docs/PWA-구현-최적화-연구보고서.html")).toBe(true);
    expect(existsSync(".omo/plans/impromptu-r2-hyperplan.md")).toBe(true);
    expect(existsSync(".omo/ulw-research/20260814-040838/sources-ledger.md")).toBe(true);

    const boundary = readFileSync("docs/AI-BOUNDARY.md", "utf8");
    expect(boundary).toContain("All model execution");
    expect(boundary).toContain("Browser bundles may not contain or invoke");
  });

  test("rejects empty required text artifacts", () => {
    const root = makeRepositoryFixture();

    for (const path of [
      ".omo/plans/impromptu-r2-hyperplan.md",
      ".omo/ulw-research/20260814-040838/sources-ledger.md",
      "docs/PWA-구현-최적화-연구보고서.md",
    ]) {
      const original = readFileSync(join(root, path));
      writeFileSync(join(root, path), "");
      expect(() => verifyRepository(root)).toThrow(`${path} is empty`);
      writeFileSync(join(root, path), original);
    }
  });

  test("rejects nonempty artifacts with an unrecognized plan, ledger, or report", () => {
    const root = makeRepositoryFixture();
    const cases = [
      [
        ".omo/plans/impromptu-r2-hyperplan.md",
        `---\nplan_id: another-plan\napproval_state: PENDING\n---\n${"x".repeat(12_000)}`,
      ],
      [
        ".omo/ulw-research/20260814-040838/sources-ledger.md",
        `# Unrelated notes\n${"x".repeat(12_000)}`,
      ],
      ["docs/PWA-구현-최적화-연구보고서.md", `# Unrelated report\n${"x".repeat(12_000)}`],
    ] as const;

    for (const [path, corruptContent] of cases) {
      const original = readFileSync(join(root, path));
      writeFileSync(join(root, path), corruptContent);
      expect(() => verifyRepository(root)).toThrow(`${path} is missing required content`);
      writeFileSync(join(root, path), original);
    }
  });

  test("rejects a corrupt application PDF even when it is large", () => {
    const root = makeRepositoryFixture();
    writeFileSync(join(root, "docs/신청서.pdf"), Buffer.alloc(4_096, 0x41));

    expect(() => verifyRepository(root)).toThrow("docs/신청서.pdf is not a recognizable PDF");
  });

  test("rejects a fabricated Phase-0 collection state or incomplete contract", () => {
    const root = makeRepositoryFixture();
    const path = join(root, "tests/corpus/holdout-manifest.json");
    const holdout = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

    holdout.corpusState = "COLLECTED";
    writeFileSync(path, JSON.stringify(holdout));
    expect(() => verifyRepository(root)).toThrow(
      "tests/corpus/holdout-manifest.json is missing required state",
    );

    holdout.corpusState = "NOT_COLLECTED";
    delete holdout.samplingContract;
    writeFileSync(path, JSON.stringify(holdout));
    expect(() => verifyRepository(root)).toThrow(
      "tests/corpus/holdout-manifest.json has an incomplete collection or approval contract",
    );
  });

  test("rejects comment-only ignore entries that do not ignore policy probes", () => {
    const root = makeRepositoryFixture();
    writeFileSync(
      join(root, ".gitignore"),
      [
        "# .env",
        "# .senpi/",
        "# .omo/senpi-task/",
        "# .omo/boulder.json",
        "# uploads/",
        "# models/",
      ].join("\n"),
    );

    expect(() => verifyRepository(root)).toThrow("Required paths are not ignored by .gitignore");
  });
});
