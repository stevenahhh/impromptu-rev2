import { describe, expect, test } from "bun:test";
import { type ExactOrigin, parseProjectionGatewayConfig } from "../src/config.ts";
import { createProjectionGatewayHandler } from "../src/http.ts";
import { createMetricsRegistry } from "../src/observability.ts";
import { PreparedEvidenceProjectionGateway } from "../src/prepared-evidence.ts";
import { createTokenBucketRateLimiter } from "../src/rate-limit.ts";
import { createProjectionRealtimeProtocol } from "../src/realtime.ts";

const origin = "https://stage.example.test" as ExactOrigin;
const config = parseProjectionGatewayConfig({ STAGE_ORIGIN: origin });

describe("projection gateway operational controls", () => {
  test("keeps metrics internal and rate limits public requests by IP", async () => {
    const now = () => 1_000;
    const metrics = createMetricsRegistry("projection_gateway");
    const dependencies = {
      gateway: new PreparedEvidenceProjectionGateway(),
      internalAuthToken: "service-token-secret",
      now,
      stageReceiptWriter: {
        async recordApplied() {
          return null;
        },
      },
      metrics,
      publicRateLimiter: createTokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.1, now }),
      readiness: {
        async check() {
          return { outcome: "READY" as const };
        },
      },
    };
    const handler = createProjectionGatewayHandler(config, dependencies);
    expect((await handler(new Request("https://projection.test/metrics"))).status).toBe(401);
    expect((await handler(new Request("https://projection.test/readyz"))).status).toBe(200);
    const first = await handler(
      new Request("https://projection.test/v1/snapshot", {
        headers: { "x-forwarded-for": "192.0.2.20" },
      }),
    );
    expect(first.status).toBe(401);
    const rejected = await handler(
      new Request("https://projection.test/v1/snapshot", {
        headers: { "x-forwarded-for": "192.0.2.20" },
      }),
    );
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({
      outcome: "REJECTED",
      reason: "IP_RATE_LIMITED",
      retryAfterMs: 10_000,
    });
    const metricResponse = await handler(
      new Request("https://projection.test/metrics", {
        headers: { authorization: "Bearer service-token-secret" },
      }),
    );
    expect(await metricResponse.text()).toContain("projection_gateway_http_requests_total");
  });

  test("rate limits realtime authentication and tracks live connections", () => {
    const now = () => 1_000;
    const metrics = createMetricsRegistry("projection_gateway");
    const gateway = new PreparedEvidenceProjectionGateway();
    const limiter = createTokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0.1, now });
    const protocol = createProjectionRealtimeProtocol({
      gateway,
      allowedOrigin: origin,
      now,
      async recordApplied() {
        return null;
      },
      connectionRateLimiter: limiter,
      metrics,
    });
    const request = new Request("https://projection.test/v1/realtime", {
      headers: { origin, cookie: "__Host-display=missing", "x-forwarded-for": "192.0.2.30" },
    });
    expect(protocol.authenticate(request).outcome).toBe("ACCEPTED");
    expect(protocol.authenticate(request)).toEqual({
      outcome: "REJECTED",
      reason: "RATE_LIMITED",
      retryAfterMs: 10_000,
    });
    expect(metrics.render()).toContain("projection_gateway_realtime_connections 0");
  });
});
