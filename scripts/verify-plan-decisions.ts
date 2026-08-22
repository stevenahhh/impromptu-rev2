const DECISION_SOURCE = "30으로 가고, q5는 include-hardening";
const HARDENING_IMPLICATION =
  "48시간 완료를 선언하지 않는다. 9월 hardening을 완료 경계 안에 포함한다.";

type JsonObject = Record<string, unknown>;

function assertClosedObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  const actualKeys = Object.keys(value).sort();
  const schemaKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== schemaKeys.length ||
    actualKeys.some((key, index) => key !== schemaKeys[index])
  ) {
    throw new Error(`${label} must contain exactly these keys: ${schemaKeys.join(", ")}`);
  }
}

function assertUserDecision(value: JsonObject, label: string): void {
  if (value.decidedBy !== "user") {
    throw new Error(`${label}.decidedBy must equal "user"`);
  }
  if (
    typeof value.decidedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.decidedAt) ||
    Number.isNaN(Date.parse(value.decidedAt))
  ) {
    throw new Error(`${label}.decidedAt must be an ISO 8601 UTC timestamp`);
  }
  if (value.source !== DECISION_SOURCE) {
    throw new Error(`${label}.source does not match the confirmed user quote`);
  }
}

export function validateCoachingDecision(value: unknown): void {
  assertClosedObject(
    value,
    ["windowSeconds", "decidedBy", "decidedAt", "source"],
    "coaching decision",
  );
  assertUserDecision(value, "coaching decision");
  if (value.windowSeconds !== 30) {
    throw new Error("coaching decision.windowSeconds must equal 30");
  }
}

export function validateCompletionDecision(value: unknown): void {
  assertClosedObject(
    value,
    ["boundary", "decidedBy", "decidedAt", "source", "implication"],
    "completion decision",
  );
  assertUserDecision(value, "completion decision");
  if (value.boundary !== "include-hardening") {
    throw new Error('completion decision.boundary must equal "include-hardening"');
  }
  if (value.implication !== HARDENING_IMPLICATION) {
    throw new Error("completion decision.implication does not match the decision");
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text()) as unknown;
}

function parseArgs(args: string[]): { coaching: string; completion: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--coaching" && flag !== "--completion") || !value) {
      throw new Error(
        "usage: bun run scripts/verify-plan-decisions.ts --coaching <path> --completion <path>",
      );
    }
    values.set(flag, value);
  }

  const coaching = values.get("--coaching");
  const completion = values.get("--completion");
  if (!coaching || !completion || values.size !== 2) {
    throw new Error("both --coaching and --completion are required");
  }
  return { coaching, completion };
}

export async function verifyDecisionFiles(
  coachingPath: string,
  completionPath: string,
): Promise<void> {
  validateCoachingDecision(await readJson(coachingPath));
  validateCompletionDecision(await readJson(completionPath));
}

if (import.meta.main) {
  try {
    const paths = parseArgs(Bun.argv.slice(2));
    await verifyDecisionFiles(paths.coaching, paths.completion);
    console.log("Plan decisions are valid and explicitly user-approved.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
