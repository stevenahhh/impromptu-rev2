import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  evaluateWp9ApprovalLoad,
  evaluateWp9AudienceExperiment,
  type Wp9ApprovalLoadFixture,
  type Wp9ApprovalLoadThresholds,
  type Wp9AudienceFixture,
  type Wp9AudienceThresholds,
  type Wp9PublicationArm,
} from "../packages/test-harness/src/wp9-product-validation.ts";

interface Artifact {
  readonly path: string;
  readonly sha256: string;
}
interface Registration {
  readonly registrationId: string;
  readonly claimBoundary: {
    readonly wp0CollectionStatus: "NOT_COLLECTED";
    readonly wp0GateStatus: "BLOCKED";
    readonly productAcceptanceEligible: false;
    readonly superiorityClaimPermitted: false;
  };
  readonly audienceValue: {
    readonly fixture: Artifact;
    readonly wp8GateManifest: Artifact;
    readonly thresholds: Readonly<Record<Wp9PublicationArm, Wp9AudienceThresholds>>;
  };
  readonly presenterApprovalLoad: {
    readonly fixture: Artifact;
    readonly thresholds: Wp9ApprovalLoadThresholds;
  };
}

const registrationPath = "tests/corpus/wp9-product-validation-registration.json";
const evidencePath = "tests/evidence/wp9-product-validation.json";
const checksumPath = `${evidencePath}.sha256`;
const bytes = (path: string) => readFileSync(path);
const sha256 = (path: string) => createHash("sha256").update(bytes(path)).digest("hex");
const json = <Value>(path: string) => JSON.parse(bytes(path).toString("utf8")) as Value;

if (process.env.LIVE_PUBLICATION_GATE_STATE !== undefined) {
  throw new Error("WP9 offline validation requires LIVE_PUBLICATION_GATE_STATE to remain unset");
}
const registration = json<Registration>(registrationPath);
for (const artifact of [
  registration.audienceValue.fixture,
  registration.audienceValue.wp8GateManifest,
  registration.presenterApprovalLoad.fixture,
]) {
  if (sha256(artifact.path) !== artifact.sha256)
    throw new Error(`fixture checksum mismatch: ${artifact.path}`);
}
const audience = evaluateWp9AudienceExperiment(
  json<Wp9AudienceFixture>(registration.audienceValue.fixture.path),
  registration.audienceValue.thresholds,
);
const approvalLoad = evaluateWp9ApprovalLoad(
  json<Wp9ApprovalLoadFixture>(registration.presenterApprovalLoad.fixture.path),
  registration.presenterApprovalLoad.thresholds,
);
if (!audience.machineThresholdsPassed || !approvalLoad.passed) {
  throw new Error("WP9 deterministic machine thresholds failed");
}
const evidence = {
  schemaVersion: 1,
  registrationId: registration.registrationId,
  evidenceKind: "OFFLINE_FIXED_FIXTURE_SIMULATION",
  claimBoundary: registration.claimBoundary,
  runtimeGateState: "UNSET_DEFAULT_OFF",
  inputs: {
    registration: { path: registrationPath, sha256: sha256(registrationPath) },
    audienceFixture: registration.audienceValue.fixture,
    wp8GateManifest: registration.audienceValue.wp8GateManifest,
    approvalLoadFixture: registration.presenterApprovalLoad.fixture,
  },
  audience,
  approvalLoad,
};
const serializedEvidence = JSON.stringify(evidence, null, 2).replace(
  /"latenciesMs": \[([\d,\s]+)\]/,
  (_match, values: string) =>
    `"latenciesMs": [${values
      .split(",")
      .map((value) => value.trim())
      .join(", ")}]`,
);
writeFileSync(evidencePath, `${serializedEvidence}\n`, "utf8");
const evidenceChecksum = sha256(evidencePath);
writeFileSync(checksumPath, `${evidenceChecksum}  wp9-product-validation.json\n`, "utf8");
console.log(
  JSON.stringify({ evidencePath, evidenceChecksum, audience: audience.arms, approvalLoad }),
);
