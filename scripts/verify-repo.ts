import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface TextArtifact {
  path: string;
  minimumBytes: number;
  requiredContent: readonly string[];
}

const textArtifacts: readonly TextArtifact[] = [
  {
    path: "README.md",
    minimumBytes: 500,
    requiredContent: ["# impromptu-rev2", "## 제품 계약"],
  },
  {
    path: "CONTRIBUTING.md",
    minimumBytes: 500,
    requiredContent: ["# Contributing to impromptu-r2", "## Atomic increment loop"],
  },
  {
    path: "docs/AI-BOUNDARY.md",
    minimumBytes: 500,
    requiredContent: ["All model execution", "Browser bundles may not contain or invoke"],
  },
  {
    path: "docs/DEMO-SCOPE.md",
    minimumBytes: 500,
    requiredContent: ["# Demo and acceptance scope", "## Preregistered evaluation"],
  },
  {
    path: "docs/PWA-구현-최적화-연구보고서.md",
    minimumBytes: 5_000,
    requiredContent: ["# AI 발표 에이전트 PWA 구현 최적화 연구보고서", "## 1. 결론 요약"],
  },
  {
    path: "docs/PWA-구현-최적화-연구보고서.html",
    minimumBytes: 5_000,
    requiredContent: ["<!doctype html>", '<html lang="ko">', "<title>AI 발표 에이전트"],
  },
  {
    path: ".omo/hyperplan/pwa-presentation-debate.md",
    minimumBytes: 1_000,
    requiredContent: ["#", "PWA"],
  },
  {
    path: ".omo/plans/impromptu-r2-hyperplan.md",
    minimumBytes: 10_000,
    requiredContent: [
      "plan_id: impromptu-r2-hyperplan",
      "approval_state: APPROVED",
      "execution_state: IN_PROGRESS",
      "repository_state: INITIALIZED",
      "# impromptu-r2 구현 Hyperplan",
      "### WP0 — 결정·평가 사전등록",
    ],
  },
  {
    path: ".omo/ulw-research/20260814-040838/sources-ledger.md",
    minimumBytes: 3_000,
    requiredContent: ["# Sources Ledger", "| id | source | kind | used for |", "| S-01 |"],
  },
  {
    path: "docs/runbooks/vendor-prewarm.md",
    minimumBytes: 1_000,
    requiredContent: [
      "# Vendor account and prewarm runbook",
      "Status: `BLOCKED`",
      "Owner: `UNASSIGNED`",
      "Prewarm evidence: `NOT_COLLECTED`",
      "## Blocking gate",
    ],
  },
] as const;

const requiredJsonArtifacts = [
  "docs/wp0/staffing-owners.json",
  "tests/corpus/holdout-manifest.json",
  "tests/corpus/korean-claims.manifest.json",
  "tests/fixtures/deck-registry.json",
] as const;

const ignoreProbes = [
  ".env",
  ".senpi/verify-repo-probe",
  ".omo/senpi-task/verify-repo-probe",
  ".omo/boulder.json",
  "uploads/verify-repo-probe",
  "models/verify-repo-probe",
] as const;

function readTextArtifact(root: string, artifact: TextArtifact): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(root, artifact.path));
  } catch {
    throw new Error(`Missing required repository file: ${artifact.path}`);
  }

  if (bytes.length === 0) {
    throw new Error(`${artifact.path} is empty`);
  }
  if (bytes.length < artifact.minimumBytes) {
    throw new Error(
      `${artifact.path} is too small to be recognizable (${bytes.length} < ${artifact.minimumBytes} bytes)`,
    );
  }

  const content = bytes.toString("utf8");
  const missingContent = artifact.requiredContent.filter((marker) => !content.includes(marker));
  if (missingContent.length > 0) {
    throw new Error(
      `${artifact.path} is missing required content: ${missingContent.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
  return content;
}

function readJsonObject(root: string, path: string): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(resolve(root, path), "utf8");
  } catch {
    throw new Error(`Missing required repository file: ${path}`);
  }
  if (content.length === 0) {
    throw new Error(`${path} is empty`);
  }

  try {
    const value: unknown = JSON.parse(content);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${reason}`);
  }
}

function requireExactState(
  artifact: Record<string, unknown>,
  path: string,
  expected: Record<string, unknown>,
): void {
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => artifact[key] !== value)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  if (mismatches.length > 0) {
    throw new Error(`${path} is missing required state: ${mismatches.join(", ")}`);
  }
}

function objectField(
  artifact: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = artifact[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} has an incomplete collection or approval contract: ${key}`);
  }
  return value as Record<string, unknown>;
}

function requireStringMembers(
  artifact: Record<string, unknown>,
  key: string,
  required: readonly string[],
  path: string,
): void {
  const value = artifact[key];
  if (!Array.isArray(value) || required.some((item) => !value.includes(item))) {
    throw new Error(`${path} has an incomplete collection or approval contract: ${key}`);
  }
}

function requireUnassignedApprovers(
  artifact: Record<string, unknown>,
  requiredRoles: readonly string[],
  path: string,
): void {
  const approvers = objectField(artifact, "approvers", path);
  if (requiredRoles.some((role) => approvers[role] !== "UNASSIGNED")) {
    throw new Error(`${path} must retain explicit UNASSIGNED approvers`);
  }
}

function verifyPhaseZeroRecords(root: string): void {
  const staffingPath = requiredJsonArtifacts[0];
  const staffing = readJsonObject(root, staffingPath);
  requireExactState(staffing, staffingPath, { schemaVersion: 1, status: "BLOCKED" });
  const requiredStaffingRoles = [
    "product_owner",
    "engineering_owner",
    "evaluation_owner",
    "privacy_reviewer",
    "operations_owner",
    "corpus_custodian",
  ] as const;
  const roles = staffing.roles;
  if (
    !Array.isArray(roles) ||
    roles.length !== requiredStaffingRoles.length ||
    requiredStaffingRoles.some(
      (requiredRole) =>
        !roles.some(
          (role) =>
            role !== null &&
            typeof role === "object" &&
            (role as Record<string, unknown>).role === requiredRole &&
            (role as Record<string, unknown>).assignee === "UNASSIGNED" &&
            typeof (role as Record<string, unknown>).requiredBefore === "string",
        ),
    )
  ) {
    throw new Error(`${staffingPath} must retain explicit UNASSIGNED staffing owners`);
  }
  const staffingGate = objectField(staffing, "gate", staffingPath);
  requireExactState(staffingGate, staffingPath, { state: "BLOCKED" });
  requireStringMembers(
    staffingGate,
    "unblockWhen",
    [
      "Each required role has a named human assignee and recorded acceptance.",
      "Product owner separately approves the provisional thresholds before evaluation.",
    ],
    staffingPath,
  );

  const holdoutPath = requiredJsonArtifacts[1];
  const holdout = readJsonObject(root, holdoutPath);
  requireExactState(holdout, holdoutPath, {
    schemaVersion: 1,
    corpusState: "NOT_COLLECTED",
    gateState: "BLOCKED",
    frozen: false,
    artifactPath: null,
    sha256: null,
  });
  const sampling = objectField(holdout, "samplingContract", holdoutPath);
  requireExactState(sampling, holdoutPath, {
    minimumRepresentativeNonSupportable: 299,
    requiredCriticalErrors: 0,
  });
  requireStringMembers(
    sampling,
    "requiredRecordFields",
    [
      "claim_id",
      "paraphrase_family_id",
      "source_revision",
      "deck_instance_id",
      "speaker_recording_id",
      "semantic_endpoint_labels",
    ],
    holdoutPath,
  );
  const disjointness = objectField(holdout, "disjointnessContract", holdoutPath);
  requireStringMembers(
    disjointness,
    "separateFrom",
    ["development", "provider_bakeoff", "adversarial_security"],
    holdoutPath,
  );
  requireStringMembers(
    disjointness,
    "disjointBy",
    [
      "claim_id",
      "paraphrase_family_id",
      "source_id_and_revision",
      "deck_instance_id",
      "speaker_recording_id",
    ],
    holdoutPath,
  );
  const freeze = objectField(holdout, "freezeContract", holdoutPath);
  requireExactState(freeze, holdoutPath, { hashAlgorithm: "sha256", approvalEvidence: null });
  requireStringMembers(
    freeze,
    "requiredApprovals",
    ["product_owner", "evaluation_owner", "corpus_custodian"],
    holdoutPath,
  );
  requireUnassignedApprovers(
    freeze,
    ["product_owner", "evaluation_owner", "corpus_custodian"],
    holdoutPath,
  );
  const exposure = objectField(holdout, "exposureProtocol", holdoutPath);
  requireStringMembers(
    exposure,
    "onExposureOrFailedAcceptance",
    [
      "mark the corpus EXPOSED and preserve the failed result",
      "remove it permanently from acceptance use",
      "collect a new corpus disjoint under every disjointness key",
    ],
    holdoutPath,
  );

  const claimsPath = requiredJsonArtifacts[2];
  const claims = readJsonObject(root, claimsPath);
  requireExactState(claims, claimsPath, {
    schemaVersion: 1,
    collectionState: "NOT_COLLECTED",
    gateState: "BLOCKED",
    artifactPath: null,
    sha256: null,
  });
  const claimCollection = objectField(claims, "collectionContract", claimsPath);
  requireStringMembers(
    claimCollection,
    "requiredRecordFields",
    [
      "claim_id",
      "claim_text_ko",
      "paraphrase_family_id",
      "source_revision",
      "deck_fixture_id",
      "speaker_id",
      "recording_id",
      "rights_record_id",
      "expert_label",
    ],
    claimsPath,
  );
  const claimApproval = objectField(claims, "approvalContract", claimsPath);
  requireStringMembers(
    claimApproval,
    "requiredRoles",
    ["evaluation_owner", "privacy_reviewer", "corpus_custodian"],
    claimsPath,
  );
  requireUnassignedApprovers(
    claimApproval,
    ["evaluation_owner", "privacy_reviewer", "corpus_custodian"],
    claimsPath,
  );

  const decksPath = requiredJsonArtifacts[3];
  const decks = readJsonObject(root, decksPath);
  requireExactState(decks, decksPath, {
    schemaVersion: 1,
    collectionState: "NOT_COLLECTED",
    gateState: "BLOCKED",
  });
  const requiredDecks = new Map([
    ["ko-font-layout", "korean_font_and_layout"],
    ["ko-chart-table", "chart_and_table"],
    ["ko-image-scanned", "image_and_scanned"],
  ]);
  const fixtures = decks.fixtures;
  if (
    !Array.isArray(fixtures) ||
    fixtures.length !== requiredDecks.size ||
    [...requiredDecks].some(
      ([id, kind]) =>
        !fixtures.some(
          (fixture) =>
            fixture !== null &&
            typeof fixture === "object" &&
            (fixture as Record<string, unknown>).id === id &&
            (fixture as Record<string, unknown>).kind === kind &&
            (fixture as Record<string, unknown>).state === "NOT_COLLECTED" &&
            (fixture as Record<string, unknown>).path === null &&
            (fixture as Record<string, unknown>).sha256 === null &&
            (fixture as Record<string, unknown>).rightsState === "NOT_APPROVED",
        ),
    )
  ) {
    throw new Error(`${decksPath} must describe exactly three NOT_COLLECTED deck fixtures`);
  }
  const deckCollection = objectField(decks, "collectionContract", decksPath);
  requireStringMembers(
    deckCollection,
    "requiredPerFixture",
    [
      "source provenance",
      "rights approval",
      "SHA-256",
      "canonical filename",
      "approved render-reference hash",
      "private-note expectation",
    ],
    decksPath,
  );
  const deckApproval = objectField(decks, "approvalContract", decksPath);
  requireUnassignedApprovers(
    deckApproval,
    ["product_owner", "evaluation_owner", "privacy_reviewer"],
    decksPath,
  );
}

function verifyPdf(root: string): void {
  const path = "docs/신청서.pdf";
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolve(root, path));
  } catch {
    throw new Error(`Missing required repository file: ${path}`);
  }

  const header = bytes.subarray(0, 8).toString("ascii");
  const trailer = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("ascii");
  if (bytes.length < 1_024 || !/^%PDF-1\.[0-9]/.test(header) || !trailer.includes("%%EOF")) {
    throw new Error(`${path} is not a recognizable PDF`);
  }
}

function verifyPackageManifest(root: string): void {
  const path = "package.json";
  const manifest = readJsonObject(root, path);
  if (manifest.name !== "impromptu-r2" || manifest.private !== true) {
    throw new Error("package.json must identify the private impromptu-r2 workspace");
  }
}

function verifyEffectiveIgnores(root: string): void {
  const missing: string[] = [];

  for (const probe of ignoreProbes) {
    const result = Bun.spawnSync(["git", "check-ignore", "--verbose", "--no-index", "--", probe], {
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    const details = result.stdout.toString().replaceAll("\\", "/").trim();
    if (result.exitCode !== 0 || !details.startsWith(".gitignore:")) {
      missing.push(probe);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Required paths are not ignored by .gitignore: ${missing.join(", ")}`);
  }
}

export function verifyRepository(rootPath: string): number {
  const root = resolve(rootPath);
  verifyPackageManifest(root);
  for (const artifact of textArtifacts) {
    readTextArtifact(root, artifact);
  }
  verifyPdf(root);
  verifyPhaseZeroRecords(root);
  verifyEffectiveIgnores(root);
  return textArtifacts.length + requiredJsonArtifacts.length + 2;
}

function cliRoot(args: readonly string[]): string {
  if (args.length === 0) {
    return process.cwd();
  }
  if (args.length === 2 && args[0] === "--root" && args[1] !== undefined) {
    return args[1];
  }
  throw new Error("Usage: bun run scripts/verify-repo.ts [--root <repository>] ");
}

if (import.meta.main) {
  try {
    const count = verifyRepository(cliRoot(process.argv.slice(2)));
    console.log(`Repository policy verified (${count} recognizable artifacts and policy gates).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Repository policy verification failed: ${message}`);
    process.exit(1);
  }
}
