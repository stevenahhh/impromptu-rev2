import { describe, expect, test } from "bun:test";
import { PublishedDeckArtifactSchema } from "@impromptu/contracts/public";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { createSessionReportRead } from "../src/bootstrap/session-reports.ts";
import { parsePrivateBackendConfig } from "../src/config.ts";
import type { PrivateBackendHandler } from "../src/http/types.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
} from "../src/prepared-evidence.ts";
import { PreparedEvidenceStateConflictError } from "../src/prepared-evidence-store-postgres.ts";
import type { QaExchangeItem } from "../src/qa/qa-exchange-ledger.ts";
import type { SessionReportReadRouteHandler } from "../src/report/http.ts";
import { createSessionReportRouteHandler } from "../src/report/http.ts";
import type {
  AppendSlideVisitInput,
  CompareAndSetSessionReportStateInput,
  SessionReportRepository,
  SessionReportState,
} from "../src/report/postgres-session-report-repository.ts";
import { createProvisionedSessionReportRepository } from "../src/report/provisioned-session-report-repository.ts";
import { SessionReportFinalizer } from "../src/report/session-report-finalizer.ts";
import {
  fakeProvisioningSql,
  OwnershipCheckedReportRepository,
} from "./support/provisioning-harness.ts";

const origin = "https://console.example.test";
const config = parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin });

// Returns null through a call so the assertions below still see `string | null`: a bare `null`
// initializer lets control-flow analysis narrow the variable to `null`, because the assignment
// happens inside a callback TypeScript cannot track, and `expect(x).toBe("...")` then rejects.
function emptyCredential(): string | null {
  return null;
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://private.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/sign-in`,
      ...init.headers,
    },
  });
}

describe("account session HTTP boundary", () => {
  test("exchanges a one-time code server-side into an HttpOnly host cookie", async () => {
    let receivedUsername: string | null = emptyCredential();
    let receivedPassword: string | null = emptyCredential();
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials(username, password) {
          receivedUsername = username;
          receivedPassword = password;
          if (username !== "alpha@example.test" || password !== "alpha-password") return null;
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
    });
    const response = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(receivedUsername).toBe("alpha@example.test");
    expect(receivedPassword).toBe("alpha-password");
    expect(response.headers.get("set-cookie")).toContain("__Host-account=account_session_");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict");
    expect(JSON.stringify(payload)).not.toContain("one-time-code");
    expect(payload.csrfToken).toMatch(/^[0-9a-f]{48}$/);
  });

  test("uses an HttpOnly development cookie when the Console runs over HTTP", async () => {
    const developmentOrigin = "http://localhost:4173";
    const handler = createPrivateBackendHandler(
      parsePrivateBackendConfig({ CONSOLE_ORIGIN: developmentOrigin }),
      {
        coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
        identityVerifier: {
          async verifyCredentials() {
            return { accountId: "account_local", actorId: "actor_local" };
          },
        },
        internalAuthToken: "internal-test-token-local",
        now: () => 1_000,
      },
    );
    const response = await handler(
      new Request("http://localhost:3001/v1/account-sessions", {
        method: "POST",
        headers: {
          Origin: developmentOrigin,
          Referer: `${developmentOrigin}/sign-in`,
        },
        body: JSON.stringify({ username: "local@example.test", password: "local-password" }),
      }),
    );
    const cookie = response.headers.get("set-cookie");

    expect(response.status).toBe(201);
    expect(cookie).toContain("account=account_session_");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("__Host-account");
    expect(cookie).not.toContain(" Secure");
  });

  test("requires exact navigation origin and synchronizer CSRF for mutations", async () => {
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
    });
    const missingReferer = await handler(
      new Request("https://private.example.test/v1/account-sessions", {
        method: "POST",
        headers: { Origin: origin },
        body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
      }),
    );
    expect(missingReferer.status).toBe(403);

    const signedIn = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
      }),
    );
    const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0];
    const withoutCsrf = await handler(
      request("/v1/account-session", {
        method: "DELETE",
        headers: { Cookie: cookie ?? "" },
      }),
    );
    expect(withoutCsrf.status).toBe(403);
  });

  test("accepts a renderer manifest and returns its slides as a public deck", async () => {
    const handler = createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_render", actorId: "actor_render" };
        },
      },
      internalAuthToken: "internal-test-token-render",
      now: () => 1_000,
    });
    const signedIn = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username: "render@example.test", password: "render-password" }),
      }),
    );
    const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const session = await signedIn.json();

    const response = await handler(
      request("/v1/deck-artifacts", {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": String(session.csrfToken),
        },
        body: JSON.stringify({
          title: "Rendered deck",
          publicBaseUrl: "https://public.example.test/rendered/deck",
          renderManifest: {
            deck_id: `deck_${"a".repeat(64)}`,
            animation_eligible: true,
            ineligible_reason: null,
            slides: [
              {
                slide_key: `slide_${"b".repeat(64)}`,
                source_index: 1,
                relative_path: "slides/slide-1.svg",
                content_sha256: "c".repeat(64),
                width_points: 960,
                height_points: 540,
              },
            ],
          },
        }),
      }),
    );
    const payload = await response.json();
    const deck = PublishedDeckArtifactSchema.parse(payload.publicDeck);

    expect(response.status).toBe(201);
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0]?.image.url).toBe(
      "https://public.example.test/rendered/deck/slides/slide-1.svg",
    );
  });
});

describe("sign-in under prepared-evidence state conflict", () => {
  // Two devices signing in at the same moment both touch the prepared-evidence snapshot; when
  // the compare-and-swap loses, the loser used to surface as an unhandled 500 on the login
  // path. A conflict must be surfaced deliberately (503, retryable) - never as an internal
  // error - and the other concurrent sign-in must still succeed.
  function conflictingHandler(persist: () => Promise<void>) {
    return createPrivateBackendHandler(config, {
      coordinator: new PreparedEvidenceCoordinator(new PreparedEvidenceProjectionGateway()),
      identityVerifier: {
        async verifyCredentials() {
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
      persist,
    });
  }

  test("two concurrent sign-ins survive one losing the state compare-and-swap", async () => {
    let persistCalls = 0;
    const handler = conflictingHandler(async () => {
      persistCalls += 1;
      if (persistCalls === 1) throw new PreparedEvidenceStateConflictError("test conflict");
    });
    const signIn = () =>
      handler(
        request("/v1/account-sessions", {
          method: "POST",
          body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
        }),
      );
    const [first, second] = await Promise.all([signIn(), signIn()]);
    const statuses = [first.status, second.status].sort((left, right) => left - right);

    expect(persistCalls).toBe(2);
    expect(statuses).toEqual([201, 503]);
    const conflicted = first.status === 503 ? first : second;
    expect(await conflicted.json()).toEqual({ error: "state_write_conflict" });
  });

  test("both concurrent sign-ins surface a deliberate conflict when every write loses", async () => {
    const handler = conflictingHandler(async () => {
      throw new PreparedEvidenceStateConflictError("test conflict");
    });
    const signIn = () =>
      handler(
        request("/v1/account-sessions", {
          method: "POST",
          body: JSON.stringify({ username: "alpha@example.test", password: "alpha-password" }),
        }),
      );
    const responses = await Promise.all([signIn(), signIn()]);

    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "state_write_conflict" });
    }
  });
});

describe("presentation end lifecycle wiring", () => {
  const manifestHash = "a".repeat(64);
  const imageHash = "c".repeat(64);
  const privateDeckFixture = {
    deckId: "private_deck_alpha",
    deckVersion: "deck_alpha",
    manifestHash,
    title: "Prepared deck",
    ownerAccountId: "account_alpha",
    aclPolicyVersion: "acl-1",
    privateObjectPrefix: "private-decks/account-alpha/deck-alpha",
    slides: [
      {
        privateSlideId: "private_slide_one",
        publicSlideKey: "slide_one",
        ordinal: 1,
        speakerNotes: "private note",
        extractedText: "Slide one",
        sourceAssetIds: ["asset_one"],
      },
    ],
  };
  const publicDeckFixture = {
    deckVersion: "deck_alpha",
    manifestHash,
    title: "Prepared deck",
    slides: [
      {
        publicSlideKey: "slide_one",
        ordinal: 1,
        image: {
          url: "https://public.example.test/one.png",
          contentHash: imageHash,
          width: 1920,
          height: 1080,
        },
        accessibilityLabel: "Slide one",
      },
    ],
  };

  class MemoryReportRepository implements SessionReportRepository {
    private nextRevision = 0;

    // Only the end path touches this repository in these tests; no visit ever lands.
    async appendSlideVisit(_input: AppendSlideVisitInput): Promise<never> {
      throw new Error("appendSlideVisit is not exercised by the end-wiring tests");
    }

    async compareAndSetState(
      input: CompareAndSetSessionReportStateInput,
    ): Promise<SessionReportState> {
      this.nextRevision += 1;
      return {
        ownerSubject: input.ownerSubject,
        revision: this.nextRevision,
        speechSummary: input.speechSummary,
        wordCount: input.wordCount,
        speakingDurationMs: input.speakingDurationMs,
        coachingAggregate: structuredClone(input.coachingAggregate),
        finalizedAtMs: input.finalizedAtMs,
        reportVersion: 2,
      };
    }

    async readSlideVisits() {
      return [];
    }

    async appendQaExchange() {
      // These end-wiring tests never append an exchange; the post-rule store only appends.
      return {
        outcome: "APPENDED" as const,
        exchange: {
          exchangeId: "qa-unexercised",
          askedAtMs: 0,
          question: "unexercised",
          origin: "TYPED" as const,
          defense: { outcome: "ABSTAINED" as const, abstainReason: "unused", retryable: false },
        },
      };
    }

    async readQaExchanges(): Promise<readonly QaExchangeItem[]> {
      return [];
    }

    async readForOwner() {
      return null;
    }
  }

  function wiredEndFlow(withCoordinator: boolean, reports?: SessionReportRepository) {
    const store = createPreparedEvidenceStore();
    const coordinator = new PreparedEvidenceCoordinator(
      new PreparedEvidenceProjectionGateway(),
      store,
    );
    const finalizer = new SessionReportFinalizer(reports ?? new MemoryReportRepository());
    const sessionReportRead = withCoordinator
      ? createSessionReportRead({
          store,
          sessionReportFinalizer: finalizer,
          coordinator,
          now: () => 1_000,
        })
      : createSessionReportRead({ store, sessionReportFinalizer: finalizer, now: () => 1_000 });
    const handler = createPrivateBackendHandler(config, {
      coordinator,
      identityVerifier: {
        async verifyCredentials(username, password) {
          if (username === "beta@example.test" && password === "beta-password") {
            return { accountId: "account_beta", actorId: "actor_beta" };
          }
          if (username !== "alpha@example.test" || password !== "alpha-password") return null;
          return { accountId: "account_alpha", actorId: "actor_alpha" };
        },
      },
      internalAuthToken: "internal-test-token-alpha",
      now: () => 1_000,
      sessionReportRead,
    });
    return { coordinator, finalizer, handler, store };
  }

  async function signIn(
    handler: PrivateBackendHandler,
    username: string,
    password: string,
  ): Promise<{ accountSessionId: string; cookie: string; csrfToken: string }> {
    const signedIn = await handler(
      request("/v1/account-sessions", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    );
    expect(signedIn.status).toBe(201);
    const cookie = signedIn.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const payload = await signedIn.json();
    const accountSessionId = /=(account_session_[A-Za-z0-9]+)/.exec(cookie)?.[1];
    if (accountSessionId === undefined) throw new Error(`no session cookie: ${cookie}`);
    return { accountSessionId, cookie, csrfToken: String(payload.csrfToken) };
  }

  async function activePresentation(coordinator: PreparedEvidenceCoordinator, who: string) {
    const created = await coordinator.createPresentation(
      who,
      { privateDeck: privateDeckFixture, publicDeck: publicDeckFixture },
      1_000,
    );
    if (created.outcome === "REJECTED") throw new Error(`fixture rejected: ${created.reason}`);
    return created.value.lifecycle.presentationSessionId;
  }

  const endPost = (
    handler: PrivateBackendHandler,
    presentationSessionId: string,
    auth: { cookie: string; csrfToken: string },
  ) =>
    handler(
      request(`/v1/presentation-sessions/${presentationSessionId}/end`, {
        method: "POST",
        headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken },
      }),
    );

  test("marks the coordinator lifecycle ENDED after the owner ends over HTTP", async () => {
    const flow = wiredEndFlow(true);
    const auth = await signIn(flow.handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await activePresentation(flow.coordinator, auth.accountSessionId);

    const response = await endPost(flow.handler, presentationSessionId, auth);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(flow.store.presentations.get(presentationSessionId)?.lifecycle.status).toBe("ENDED");
  });

  test("keeps ending twice idempotent: 202 both times and the first end record survives", async () => {
    const flow = wiredEndFlow(true);
    const auth = await signIn(flow.handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await activePresentation(flow.coordinator, auth.accountSessionId);

    const first = await endPost(flow.handler, presentationSessionId, auth);
    expect(first.status).toBe(202);
    const lifecycleAfterFirst = flow.store.presentations.get(presentationSessionId)?.lifecycle;
    if (lifecycleAfterFirst === undefined) {
      throw new Error("presentation record vanished between the two end calls");
    }
    const second = await endPost(flow.handler, presentationSessionId, auth);

    expect(second.status).toBe(202);
    // The retried end rewrote nothing: the original end record survives untouched.
    expect(flow.store.presentations.get(presentationSessionId)?.lifecycle).toEqual(
      lifecycleAfterFirst,
    );
    const report = await flow.handler(
      request(`/v1/presentation-sessions/${presentationSessionId}/report`, {
        headers: { Cookie: auth.cookie },
      }),
    );
    expect(report.status).toBe(202);
    expect(await report.json()).toEqual({ status: "pending" });
  });

  test("non-owner end stays 403 and never moves the lifecycle", async () => {
    const flow = wiredEndFlow(true);
    const owner = await signIn(flow.handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await activePresentation(
      flow.coordinator,
      owner.accountSessionId,
    );
    const intruder = await signIn(flow.handler, "beta@example.test", "beta-password");

    const response = await endPost(flow.handler, presentationSessionId, intruder);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "report_forbidden" });
    expect(flow.store.presentations.get(presentationSessionId)?.lifecycle.status).toBe("ACTIVE");
  });

  test("unknown presentation id answers the existing rejection, never a 500", async () => {
    const flow = wiredEndFlow(true);
    const auth = await signIn(flow.handler, "alpha@example.test", "alpha-password");

    const response = await endPost(flow.handler, "ps_does_not_exist", auth);

    expect([403, 409]).toContain(response.status);
    const payload = await response.json();
    expect(
      payload.error === "report_forbidden" || payload.error === "presentation_end_conflict",
    ).toBe(true);
  });

  test("maps only the owner-retry ended marker onward; other coordinator rejections stay 409", async () => {
    const finalizer = new SessionReportFinalizer(new MemoryReportRepository());
    const ownerResolver = {
      async resolve(input: { accountId: string; presentationSessionId: string }) {
        return input.accountId === "account-owner" &&
          input.presentationSessionId === "presentation-live"
          ? {
              tenantId: "tenant-owner",
              presentationSessionId: "presentation-live",
              ownerSubject: "account-owner",
            }
          : null;
      },
    };
    let lifecycleCalls = 0;
    const route = (endLifecycle?: Parameters<typeof createSessionReportRouteHandler>[4]) =>
      createSessionReportRouteHandler(
        finalizer,
        ownerResolver,
        {
          async resolve() {
            return { label: "준비된 근거", items: [] };
          },
        },
        {
          async resolve() {
            return {
              endedOffsetMs: 100,
              finalizedAtMs: 200,
              preparedEvidence: { label: "준비된 근거", items: [] },
            };
          },
        },
        endLifecycle,
      );
    const post = (route: SessionReportReadRouteHandler) =>
      route(
        new Request("https://private.test/v1/presentation-sessions/presentation-live/end", {
          method: "POST",
        }),
        "account-owner",
        "account_session_owner",
      );

    const applied = await post(
      route(async () => {
        lifecycleCalls += 1;
        return { outcome: "APPLIED" as const, value: {} as never };
      }),
    );
    expect(applied?.status).toBe(202);
    expect(lifecycleCalls).toBe(1);

    const ownerRetry = await post(
      route(async () => ({
        outcome: "REJECTED" as const,
        reason: "PRESENTATION_ENDED" as const,
        endedBySameOwner: true as const,
      })),
    );
    expect(ownerRetry?.status).toBe(202);

    for (const reason of ["PRESENTATION_NOT_FOUND", "UNAUTHORIZED", "ACCOUNT_SESSION_EXPIRED"]) {
      const rejected = await post(
        route(async () => ({
          outcome: "REJECTED" as const,
          reason,
        })),
      );
      expect(rejected?.status).toBe(409);
      expect(await rejected?.json()).toEqual({ error: "presentation_end_conflict" });
    }
  });

  // Live-baseline F2: ending a session that never recorded a slide visit or Q&A exchange
  // died with an unhandled SessionReportAccessDeniedError (HTTP 500) because the owning
  // presentation_sessions row only existed after a write. Through the real provisioning
  // adapter, the owner must get 202 on /end and a durable finalized report on /report.
  test("zero-activity end and report stay owner-successful through the provisioning adapter", async () => {
    const rows = {
      tenants: new Map<string, string>(),
      sessions: new Map<string, { readonly ownerSubject: string; readonly epoch: number }>(),
    };
    const { sql } = fakeProvisioningSql(rows);
    const reports = createProvisionedSessionReportRepository(
      sql,
      new OwnershipCheckedReportRepository(rows.sessions),
    );
    const flow = wiredEndFlow(true, reports);
    const auth = await signIn(flow.handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await activePresentation(flow.coordinator, auth.accountSessionId);

    const ended = await endPost(flow.handler, presentationSessionId, auth);
    expect(ended.status).toBe(202);
    expect(flow.store.presentations.get(presentationSessionId)?.lifecycle.status).toBe("ENDED");

    const report = await flow.handler(
      request(`/v1/presentation-sessions/${presentationSessionId}/report`, {
        headers: { Cookie: auth.cookie },
      }),
    );
    expect(report.status).toBe(200);
    const payload = await report.json();
    expect(payload.report.presentationSessionId).toBe(presentationSessionId);
    expect(payload.report.ownerAccountId).toBe("account_alpha");
    expect(payload.report.slideVisits).toEqual([]);
    expect(payload.report.qaDefense?.exchanges).toEqual([]);
    expect(payload.report.finalizedAtMs).toBeGreaterThan(0);

    // The report is durable state, not a one-shot render: a second read returns the same body.
    const reread = await flow.handler(
      request(`/v1/presentation-sessions/${presentationSessionId}/report`, {
        headers: { Cookie: auth.cookie },
      }),
    );
    expect(reread.status).toBe(200);
    expect(await reread.json()).toEqual(payload);
  });

  test("without an injected coordinator the end route behaves exactly as before", async () => {
    const flow = wiredEndFlow(false);
    const auth = await signIn(flow.handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await activePresentation(flow.coordinator, auth.accountSessionId);

    const response = await endPost(flow.handler, presentationSessionId, auth);

    expect(response.status).toBe(202);
    expect(flow.store.presentations.get(presentationSessionId)?.lifecycle.status).toBe("ACTIVE");
  });
});
