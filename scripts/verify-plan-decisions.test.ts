import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCoachingDecision } from "./verify-plan-decisions";

const source = "30으로 가고, q5는 include-hardening";
const decidedAt = "2026-08-21T02:09:16.441Z";
const temporaryDirectories: string[] = [];

async function fixturePath(name: string, value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "plan-decisions-"));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value)}\n`);
  return path;
}

async function runValidator(
  coaching: string,
  completion: string,
): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "verify-plan-decisions.ts"),
      "--coaching",
      coaching,
      "--completion",
      completion,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { exitCode, stderr };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("plan decision validator", () => {
  test("accepts valid coaching and completion fixtures", async () => {
    const coaching = await fixturePath("coaching.json", {
      windowSeconds: 30,
      decidedBy: "user",
      decidedAt,
      source,
    });
    const completion = await fixturePath("completion.json", {
      boundary: "include-hardening",
      decidedBy: "user",
      decidedAt,
      source,
      implication: "48시간 완료를 선언하지 않는다. 9월 hardening을 완료 경계 안에 포함한다.",
    });

    expect(await runValidator(coaching, completion)).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  test.each([
    ["missing", undefined],
    ["different", "executor"],
  ])("rejects a fixture with %s decidedBy", (_, decidedBy) => {
    const fixture: Record<string, unknown> = {
      windowSeconds: 30,
      decidedAt,
      source,
    };
    if (decidedBy !== undefined) fixture.decidedBy = decidedBy;

    expect(() => validateCoachingDecision(fixture)).toThrow(/decidedBy/);
  });

  test("returns nonzero for an invalid fixture", async () => {
    const coaching = await fixturePath("invalid-coaching.json", {
      windowSeconds: 30,
      decidedBy: "executor",
      decidedAt,
      source,
    });
    const completion = await fixturePath("completion.json", {
      boundary: "include-hardening",
      decidedBy: "user",
      decidedAt,
      source,
      implication: "48시간 완료를 선언하지 않는다. 9월 hardening을 완료 경계 안에 포함한다.",
    });

    const result = await runValidator(coaching, completion);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('coaching decision.decidedBy must equal "user"');
  });
});
