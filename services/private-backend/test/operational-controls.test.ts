import { describe, expect, test } from "bun:test";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import { createJsonLogger, createMetricsRegistry } from "../src/observability.ts";
import { PreparedEvidenceCoordinator } from "../src/prepared-evidence.ts";
import { createTokenBucketRateLimiter } from "../src/rate-limit.ts";

const origin = "https://console.example.test";
const config = parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin });

function login(ip: string) {
  return new Request("https://private.test/v1/account-sessions", {
    method: "POST",
    headers: { origin, referer: `${origin}/login`, "x-forwarded-for": ip },
    body: JSON.stringify({ username: "secret@example.test", password: "never-log-this" }),
  });
}

describe("private backend operational controls", () => {
  test("token buckets use an injected clock and report a bounded retry", () => {
    let now = 0;
    const limiter = createTokenBucketRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: () => now,
    });
    expect(limiter.consume("key").outcome).toBe("ALLOWED");
    expect(limiter.consume("key").outcome).toBe("ALLOWED");
    expect(limiter.consume("key")).toEqual({ outcome: "REJECTED", retryAfterMs: 1_000 });
    now = 1_000;
    expect(limiter.consume("key").outcome).toBe("ALLOWED");
  });

  test("rate limits login by account and IP without logging credentials", async () => {
    const lines: string[] = [];
    const now = () => 1_000;
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return null;
        },
      },
      internalAuthToken: "service-token-secret",
      now,
      logger: createJsonLogger({ write: (line) => lines.push(line), now }),
      loginRateLimiters: {
        account: createTokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.1, now }),
        ip: createTokenBucketRateLimiter({ capacity: 10, refillPerSecond: 1, now }),
      },
    });

    expect((await handler(login("192.0.2.10"))).status).toBe(401);
    const rejected = await handler(login("192.0.2.11"));
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({
      outcome: "REJECTED",
      reason: "ACCOUNT_RATE_LIMITED",
      retryAfterMs: 10_000,
    });
    expect(lines.join("\n")).not.toContain("secret@example.test");
    expect(lines.join("\n")).not.toContain("never-log-this");
  });

  test("logs and measures the recommendation domain outcome without changing HTTP 200", async () => {
    const lines: string[] = [];
    const metrics = createMetricsRegistry("private_backend");
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_observability", actorId: "actor_observability" };
        },
      },
      internalAuthToken: "service-token-secret",
      now: () => 1_000,
      logger: createJsonLogger({ write: (line) => lines.push(line), now: () => 1_000 }),
      metrics,
      recommendations: {
        async recommend() {
          return {
            outcome: "ABSTAIN",
            reason: "INSUFFICIENT_EVIDENCE",
            completedAtMs: 1_000,
            latencyMs: 0,
          };
        },
      },
    });
    const signIn = await handler(login("192.0.2.20"));
    const session = await signIn.json();
    const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0];
    if (typeof session.csrfToken !== "string" || cookie === undefined) {
      throw new Error("test sign-in failed");
    }
    const recommendation = await handler(
      new Request("https://private.test/v1/recommendations", {
        method: "POST",
        headers: {
          origin,
          referer: `${origin}/present`,
          cookie,
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify({}),
      }),
    );

    expect(recommendation.status).toBe(200);
    expect(await recommendation.json()).toMatchObject({
      outcome: "ABSTAIN",
      reason: "INSUFFICIENT_EVIDENCE",
    });
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        path: "/v1/recommendations",
        status: 200,
        outcome: "ABSTAIN:INSUFFICIENT_EVIDENCE",
      }),
    );
    expect(metrics.render()).toContain('outcome="ABSTAIN:INSUFFICIENT_EVIDENCE"');
  });

  test("protects metrics and reports readiness and request observations", async () => {
    const metrics = createMetricsRegistry("private_backend");
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return null;
        },
      },
      internalAuthToken: "service-token-secret",
      now: () => 1_000,
      metrics,
      readiness: {
        async check() {
          return { outcome: "READY" };
        },
      },
    });
    expect((await handler(new Request("https://private.test/metrics"))).status).toBe(401);
    const ready = await handler(new Request("https://private.test/readyz"));
    expect(ready.status).toBe(200);
    const response = await handler(
      new Request("https://private.test/metrics", {
        headers: { authorization: "Bearer service-token-secret" },
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("private_backend_http_requests_total");
    expect(text).toContain('path="/readyz"');
  });
});
