import { describe, expect, test } from "bun:test";

interface VerifierEvidence {
  readonly flow: readonly string[];
  readonly acceptedCommandPrefix: readonly string[];
  readonly appliedCommandPrefix: readonly string[];
  readonly cardEventCount: number;
  readonly connectedTombstoneP95Ms: number;
  readonly reconnectActiveCardCount: number;
  readonly reconnectTombstoneStatuses: readonly string[];
  readonly browserStorageEntries: number;
  readonly samples: number;
  readonly publicCorrelationMatches: number;
  readonly surface: string;
}

function isEvidence(value: unknown): value is VerifierEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.flow) &&
    Array.isArray(candidate.acceptedCommandPrefix) &&
    Array.isArray(candidate.appliedCommandPrefix) &&
    typeof candidate.cardEventCount === "number" &&
    typeof candidate.connectedTombstoneP95Ms === "number" &&
    typeof candidate.reconnectActiveCardCount === "number" &&
    Array.isArray(candidate.reconnectTombstoneStatuses) &&
    typeof candidate.browserStorageEntries === "number" &&
    typeof candidate.samples === "number" &&
    typeof candidate.publicCorrelationMatches === "number" &&
    typeof candidate.surface === "string"
  );
}

describe("WP3 prepared evidence real-browser E2E", () => {
  test("runs the service mains and a clean Chrome Stage through reconnect", async () => {
    const verifier = Bun.spawn({
      cmd: ["node", "--experimental-strip-types", "scripts/verify-wp3-e2e.ts"],
      env: Bun.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      verifier.exited,
      new Response(verifier.stdout).text(),
      new Response(verifier.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isEvidence(parsed)) throw new Error("WP3 verifier emitted invalid evidence");

    expect(parsed.flow).toEqual([
      "upload",
      "deck-artifacts",
      "authenticated-controller",
      "presentation-session",
      "display-join",
      "display-bound",
      "network-channel-subscribed",
      "slide-set-accepted",
      "stage-applied",
      "candidate-approved",
      "published-card-visible",
      "ordered-retract-tombstone",
      "ordered-expiry-tombstone",
      "both-mains-restarted",
      "restart-tombstones-restored",
      "restart-prefix-applied",
      "controller-takeover",
      "old-controller-superseded",
      "takeover-prefix-applied",
      "reconnect-snapshot",
    ]);
    expect(parsed.acceptedCommandPrefix).toEqual([
      "cmd_e2e_absolute",
      "cmd_after_restart",
      "cmd_after_takeover",
    ]);
    expect(parsed.appliedCommandPrefix).toEqual(parsed.acceptedCommandPrefix);
    expect(parsed.cardEventCount).toBe(40);
    expect(parsed.reconnectActiveCardCount).toBe(0);
    expect(parsed.reconnectTombstoneStatuses).toHaveLength(20);
    expect(
      parsed.reconnectTombstoneStatuses.filter((status) => status === "RETRACTED"),
    ).toHaveLength(19);
    expect(parsed.reconnectTombstoneStatuses.filter((status) => status === "EXPIRED")).toHaveLength(
      1,
    );
    expect(parsed.browserStorageEntries).toBe(0);
    expect(parsed.samples).toBe(20);
    expect(parsed.publicCorrelationMatches).toBe(0);
    expect(parsed.connectedTombstoneP95Ms).toBeLessThanOrEqual(500);
    expect(parsed.surface).toBe("real-service-mains+clean-chrome-stage");
  }, 60_000);
});
