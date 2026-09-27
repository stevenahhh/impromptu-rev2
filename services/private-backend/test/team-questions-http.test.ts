import { describe, expect, test } from "bun:test";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { createAccountDirectory, createInMemoryAccountStore } from "../src/account-directory.ts";
import { createSessionReportRead } from "../src/bootstrap/session-reports.ts";
import { createTeamQuestions } from "../src/bootstrap/team-questions.ts";
import { type PrivateBackendConfig, parsePrivateBackendConfig } from "../src/config.ts";
import { createPrivateBackendHandler } from "../src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
} from "../src/prepared-evidence.ts";
import { SessionReportFinalizer } from "../src/report/session-report-finalizer.ts";
import { createInMemoryTeamQuestionStore } from "../src/team-question-grants.ts";
import { MemorySessionReportRepository } from "./support/memory-session-report-repository.ts";

/**
 * Plan-8 boundary tests: a session-scoped, revocable question-only capability for an
 * independently signed-in teammate B, issued and revoked by owner A through the real
 * authenticated handler (exact Origin + Referer + cookie + CSRF). B never gains deck,
 * playback, report, or other-question reads; unrelated C gains nothing at all.
 */

const config: PrivateBackendConfig = parsePrivateBackendConfig({
  CONSOLE_ORIGIN: "https://console.example.test",
});
const internalAuthToken = "team-questions-test-token";
const TEAM_QUESTION_GRANT_TTL_MS = 4 * 60 * 60 * 1_000;

const manifestHash = "b".repeat(64);

function deckArtifacts(ownerAccountId: string) {
  return {
    privateDeck: {
      deckId: "private_deck_team",
      deckVersion: "deck_team_e2e",
      manifestHash,
      title: "Team deck",
      ownerAccountId,
      aclPolicyVersion: "acl-1",
      privateObjectPrefix: `private-decks/${ownerAccountId}/team`,
      slides: [
        {
          privateSlideId: "private_slide_team_one",
          publicSlideKey: "slide_team_one",
          ordinal: 1,
          speakerNotes: "private note",
          extractedText: "Slide one",
          sourceAssetIds: ["asset_team_one"],
        },
      ],
    },
    publicDeck: {
      deckVersion: "deck_team_e2e",
      manifestHash,
      title: "Team deck",
      slides: [
        {
          publicSlideKey: "slide_team_one",
          ordinal: 1,
          image: {
            url: "https://public.example.test/one.png",
            contentHash: "c".repeat(64),
            width: 1920,
            height: 1080,
          },
          accessibilityLabel: "Slide one",
        },
      ],
    },
  } as const;
}

interface Harness {
  readonly handler: (request: Request) => Response | Promise<Response>;
  readonly coordinator: PreparedEvidenceCoordinator;
  readonly clock: { value: number };
}

function harness(options?: { readonly omitTeamQuestions?: boolean }): Harness {
  const clock = { value: 1_000 };
  const accountStore = createInMemoryAccountStore();
  const directory = createAccountDirectory(accountStore);
  const store = createPreparedEvidenceStore();
  const coordinator = new PreparedEvidenceCoordinator(
    new PreparedEvidenceProjectionGateway(),
    store,
  );
  const sessionReportRead = createSessionReportRead({
    store,
    sessionReportFinalizer: new SessionReportFinalizer(new MemorySessionReportRepository()),
    coordinator,
    now: () => clock.value,
  });
  const handler = createPrivateBackendHandler(config, {
    coordinator,
    identityVerifier: directory,
    accountRegistrar: directory,
    internalAuthToken,
    now: () => clock.value,
    sessionReportRead,
    ...(options?.omitTeamQuestions === true
      ? {}
      : {
          teamQuestions: createTeamQuestions({
            store,
            coordinator,
            questionStore: createInMemoryTeamQuestionStore(),
            resolveAccount: async (username) => await accountStore.readByUsername(username),
            now: () => clock.value,
          }),
        }),
  });
  return { handler, coordinator, clock };
}

interface User {
  readonly accountId: string;
  readonly cookie: string;
  readonly csrf: string;
}

function request(
  path: string,
  init: { method?: string; cookie?: string; csrf?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {
    Origin: config.allowedOrigin,
    Referer: `${config.allowedOrigin}/`,
    "content-type": "application/json",
  };
  if (init.cookie !== undefined) headers.Cookie = init.cookie;
  if (init.csrf !== undefined) headers["x-csrf-token"] = init.csrf;
  return new Request(`https://private.example.test${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function register(h: Harness, username: string, password: string): Promise<User> {
  const registered = await h.handler(
    request("/v1/accounts", { method: "POST", body: { username, password } }),
  );
  expect(registered.status).toBe(201);
  const signedIn = await h.handler(
    request("/v1/account-sessions", { method: "POST", body: { username, password } }),
  );
  expect(signedIn.status).toBe(201);
  const body = (await signedIn.json()) as {
    account: { accountId: string };
    csrfToken: string;
  };
  return {
    accountId: body.account.accountId,
    cookie: signedIn.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
    csrf: body.csrfToken,
  };
}

async function createPresentation(h: Harness, owner: User): Promise<string> {
  const created = await h.handler(
    request("/v1/presentation-sessions", {
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: deckArtifacts(owner.accountId),
    }),
  );
  expect(created.status).toBe(201);
  const body = (await created.json()) as {
    lifecycle: { presentationSessionId: string };
  };
  return body.lifecycle.presentationSessionId;
}

interface IssuedGrant {
  readonly grantId: string;
  readonly invitationToken: string;
  readonly [key: string]: unknown;
}

async function issueGrant(
  h: Harness,
  owner: User,
  presentationSessionId: string,
  teammateUsername: string,
  idempotencyKey = `issue-${teammateUsername}`,
): Promise<Response> {
  return await h.handler(
    request("/v1/team-question-grants", {
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { presentationSessionId, teammateUsername, idempotencyKey },
    }),
  );
}

async function issuedGrant(
  h: Harness,
  owner: User,
  presentationSessionId: string,
  teammateUsername: string,
  idempotencyKey?: string,
): Promise<IssuedGrant> {
  const response = await issueGrant(
    h,
    owner,
    presentationSessionId,
    teammateUsername,
    idempotencyKey,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as IssuedGrant;
}

async function accept(h: Harness, user: User, invitationToken: unknown): Promise<Response> {
  return await h.handler(
    request("/v1/team-question-grants/accept", {
      cookie: user.cookie,
      csrf: user.csrf,
      body: { invitationToken },
    }),
  );
}

async function submit(h: Harness, user: User, body: Record<string, unknown>): Promise<Response> {
  return await h.handler(
    request("/v1/team-questions", { cookie: user.cookie, csrf: user.csrf, body }),
  );
}

async function inbox(h: Harness, user: User, presentationSessionId: string): Promise<Response> {
  return await h.handler(
    request(`/v1/team-questions?presentationSessionId=${presentationSessionId}`, {
      cookie: user.cookie,
    }),
  );
}

/**
 * Registers owner A, teammate B and stranger C; A owns one ACTIVE presentation. The
 * deterministic clock starts at 1_000 so grant expiry is exercised by advancing a number,
 * never by sleeping.
 */
async function threeUsers(h: Harness): Promise<{
  readonly owner: User;
  readonly teammate: User;
  readonly stranger: User;
  readonly presentationSessionId: string;
}> {
  const owner = await register(h, "owner-a", "owner-a-password");
  const teammate = await register(h, "teammate-b", "teammate-b-password");
  const stranger = await register(h, "stranger-c", "stranger-c-password");
  const presentationSessionId = await createPresentation(h, owner);
  return { owner, teammate, stranger, presentationSessionId };
}

describe("team question grants: issuance", () => {
  test("the owner issues a PENDING grant with a one-use opaque invitation, shown once", async () => {
    const h = harness();
    const { owner, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    expect(grant.grantId).toMatch(/^tqg_[0-9a-f]{32}$/);
    expect(grant.invitationToken).toMatch(/^tginv_[0-9a-f]{64}$/);
    expect(grant.status).toBe("PENDING");
    expect(grant.revocationRevision).toBe(1);
    expect(grant.expiresAtMs).toBe(h.clock.value + TEAM_QUESTION_GRANT_TTL_MS);
    // The grant list never carries token or digest material.
    const listed = await h.handler(
      request(`/v1/team-question-grants?presentationSessionId=${presentationSessionId}`, {
        cookie: owner.cookie,
      }),
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { grants: Record<string, unknown>[] };
    expect(listedBody.grants).toHaveLength(1);
    const raw = JSON.stringify(listedBody);
    expect(raw).not.toContain(grant.invitationToken);
    expect(raw).not.toContain("invitationToken");
    expect(raw).not.toContain("Digest");
  });

  test("issuance idempotency replays the same grant without revealing a new token", async () => {
    const h = harness();
    const { owner, presentationSessionId } = await threeUsers(h);
    const first = await issuedGrant(h, owner, presentationSessionId, "teammate-b", "k-1");
    const replay = await issueGrant(h, owner, presentationSessionId, "teammate-b", "k-1");
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody.grantId).toBe(first.grantId);
    expect(replayBody.duplicate).toBe(true);
    expect(replayBody.invitationToken).toBeUndefined();
    // A different target under the same key is a typed conflict, not a silent replay.
    const conflict = await issueGrant(h, owner, presentationSessionId, "stranger-c", "k-1");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "team_question_idempotency_conflict",
    });
  });

  test("an unknown teammate, a self-grant and a foreign session are all typed rejections", async () => {
    const h = harness();
    const { owner, stranger } = await threeUsers(h);
    const ownSession = await createPresentation(h, owner);
    const strangerSession = await createPresentation(h, stranger);

    expect((await issueGrant(h, owner, ownSession, "nobody-here")).status).toBe(404);
    const unknown = await issueGrant(h, owner, ownSession, "nobody-here");
    expect(await unknown.json()).toEqual({ error: "teammate_not_found" });

    const self = await issueGrant(h, owner, ownSession, "owner-a");
    expect(self.status).toBe(409);
    expect(await self.json()).toEqual({ error: "team_grant_self" });

    const foreign = await issueGrant(h, owner, strangerSession, "teammate-b");
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "unauthorized" });

    const missing = await issueGrant(h, owner, "ps_missing_session_01", "teammate-b");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "presentation_not_found" });
  });

  test("issuance demands the exact origin, the session cookie and CSRF", async () => {
    const h = harness();
    const { owner, presentationSessionId } = await threeUsers(h);
    const body = {
      presentationSessionId,
      teammateUsername: "teammate-b",
      idempotencyKey: "csrf-probe",
    };

    const noCsrf = await h.handler(
      request("/v1/team-question-grants", { cookie: owner.cookie, body }),
    );
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toEqual({ error: "csrf_rejected" });

    const noCookie = await h.handler(
      request("/v1/team-question-grants", { csrf: owner.csrf, body }),
    );
    expect(noCookie.status).toBe(401);
    expect(await noCookie.json()).toEqual({ error: "account_session_required" });

    const wrongOrigin = await h.handler(
      new Request("https://private.example.test/v1/team-question-grants", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example.test",
          Referer: "https://attacker.example.test/",
          "content-type": "application/json",
          Cookie: owner.cookie,
          "x-csrf-token": owner.csrf,
        },
        body: JSON.stringify(body),
      }),
    );
    expect(wrongOrigin.status).toBe(403);
  });
});

describe("team question grants: one-use acceptance", () => {
  test("the targeted teammate accepts once and holds the capability handle", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    const accepted = await accept(h, teammate, grant.invitationToken);
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as Record<string, unknown>;
    expect(body).toEqual({
      grantId: grant.grantId,
      presentationSessionId,
      expiresAtMs: h.clock.value + TEAM_QUESTION_GRANT_TTL_MS,
    });
    // The accept receipt carries no owner data beyond the capability handle.
    expect(Object.keys(body).sort()).toEqual(["expiresAtMs", "grantId", "presentationSessionId"]);
  });

  test("a replayed invitation, a stranger's redemption and a malformed token all fail", async () => {
    const h = harness();
    const { owner, teammate, stranger, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");

    // Stranger C cannot redeem a token targeted at B, even holding the exact token.
    const strangersTry = await accept(h, stranger, grant.invitationToken);
    expect(strangersTry.status).toBe(404);
    expect(await strangersTry.json()).toEqual({ error: "invitation_not_found" });

    // The owner cannot redeem a grant aimed at someone else either.
    const ownersTry = await accept(h, owner, grant.invitationToken);
    expect(ownersTry.status).toBe(404);

    expect((await accept(h, teammate, grant.invitationToken)).status).toBe(200);
    const replayed = await accept(h, teammate, grant.invitationToken);
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({ error: "team_grant_already_accepted" });

    const malformed = await accept(h, teammate, "tginv_nothex");
    expect(malformed.status).toBe(400);
    const unknown = await accept(h, teammate, `tginv_${"f".repeat(64)}`);
    expect(unknown.status).toBe(404);
  });

  test("concurrent duplicate redemptions of one invitation yield exactly one acceptance", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    const [first, second] = await Promise.all([
      accept(h, teammate, grant.invitationToken),
      accept(h, teammate, grant.invitationToken),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("team questions: submission and the owner inbox", () => {
  test("B's bounded text lands in A's private inbox; B sees only the receipt", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);

    const submitted = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "  슬라이드 3의 매출 수치 출처가 무엇인가요?  ",
      idempotencyKey: "q-1",
    });
    expect(submitted.status).toBe(202);
    const receipt = (await submitted.json()) as Record<string, unknown>;
    expect(receipt).toEqual({
      questionId: expect.stringMatching(/^tqq_[0-9a-f]{32}$/),
      grantId: grant.grantId,
      submittedAtMs: h.clock.value,
      duplicate: false,
    });

    const ownerInbox = await inbox(h, owner, presentationSessionId);
    expect(ownerInbox.status).toBe(200);
    const inboxBody = (await ownerInbox.json()) as {
      presentationSessionId: string;
      questions: Record<string, unknown>[];
    };
    expect(inboxBody.presentationSessionId).toBe(presentationSessionId);
    expect(inboxBody.questions).toHaveLength(1);
    expect(inboxBody.questions[0]).toMatchObject({
      grantId: grant.grantId,
      teammateAccountId: teammate.accountId,
      teammateUsername: "teammate-b",
      questionText: "슬라이드 3의 매출 수치 출처가 무엇인가요?",
      questionSeq: 1,
    });
  });

  test("an identical idempotent retry dedupes; a reused key with different text conflicts", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);

    const first = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "same question",
      idempotencyKey: "q-dup",
    });
    const retry = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "same question",
      idempotencyKey: "q-dup",
    });
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    const firstBody = (await first.json()) as { questionId: string; duplicate: boolean };
    const retryBody = (await retry.json()) as { questionId: string; duplicate: boolean };
    expect(retryBody.questionId).toBe(firstBody.questionId);
    expect(retryBody.duplicate).toBe(true);

    const conflict = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "different text under a reused key",
      idempotencyKey: "q-dup",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "team_question_idempotency_conflict",
    });

    const ownerInbox = await inbox(h, owner, presentationSessionId);
    const inboxBody = (await ownerInbox.json()) as { questions: unknown[] };
    expect(inboxBody.questions).toHaveLength(1);
  });

  test("malformed, oversized and untargeted submissions are typed rejections", async () => {
    const h = harness();
    const { owner, teammate, stranger, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);

    for (const body of [
      { grantId: grant.grantId, questionText: "   ", idempotencyKey: "x-1" },
      { grantId: grant.grantId, questionText: "x".repeat(2001), idempotencyKey: "x-2" },
      { grantId: grant.grantId, questionText: "missing key" },
      { grantId: grant.grantId, idempotencyKey: "x-4" },
      { grantId: "not-a-grant", questionText: "hi", idempotencyKey: "x-5" },
    ]) {
      const rejected = await submit(h, teammate, body);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "invalid_request" });
    }

    // A well-formed but unknown grant id, and C aiming at B's grant, both answer 404.
    for (const [user, grantId] of [
      [teammate, "tqg_00000000000000000000000000000000"],
      [stranger, grant.grantId],
    ] as const) {
      const denied = await submit(h, user, {
        grantId,
        questionText: "probe",
        idempotencyKey: "probe-1",
      });
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: "team_grant_not_found" });
    }

    const pendingGrant = await issuedGrant(h, owner, presentationSessionId, "stranger-c");
    const notAccepted = await submit(h, stranger, {
      grantId: pendingGrant.grantId,
      questionText: "before accept",
      idempotencyKey: "q-early",
    });
    expect(notAccepted.status).toBe(409);
    expect(await notAccepted.json()).toEqual({ error: "team_grant_not_accepted" });
  });

  test("the inbox is owner-only: B and C cannot read it, and no inbox crosses tenants", async () => {
    const h = harness();
    const { owner, teammate, stranger, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);
    await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "owner-only question",
      idempotencyKey: "q-inbox",
    });

    for (const reader of [teammate, stranger]) {
      const denied = await inbox(h, reader, presentationSessionId);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "unauthorized" });
      const deniedList = await h.handler(
        request(`/v1/team-question-grants?presentationSessionId=${presentationSessionId}`, {
          cookie: reader.cookie,
        }),
      );
      expect(deniedList.status).toBe(403);
    }

    // A second owner's separate presentation receives its own grant and question; A's
    // inbox stays untouched — zero cross-tenant rows.
    const secondOwner = await register(h, "owner-d", "owner-d-password");
    const secondSession = await createPresentation(h, secondOwner);
    const secondGrant = await issuedGrant(h, secondOwner, secondSession, "teammate-b");
    await accept(h, teammate, secondGrant.invitationToken);
    await submit(h, teammate, {
      grantId: secondGrant.grantId,
      questionText: "second owner's question",
      idempotencyKey: "q-other",
    });

    const firstInbox = (await (await inbox(h, owner, presentationSessionId)).json()) as {
      questions: { questionText: string }[];
    };
    expect(firstInbox.questions.map((q) => q.questionText)).toEqual(["owner-only question"]);
    const secondInbox = (await (await inbox(h, secondOwner, secondSession)).json()) as {
      questions: { questionText: string }[];
    };
    expect(secondInbox.questions.map((q) => q.questionText)).toEqual(["second owner's question"]);
  });
});

describe("team questions: revocation, session end and expiry", () => {
  test("revocation bumps the revision and blocks B immediately", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);
    await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "pre-revocation question",
      idempotencyKey: "q-pre",
    });

    const revoked = await h.handler(
      request(`/v1/team-question-grants/${grant.grantId}`, {
        method: "DELETE",
        cookie: owner.cookie,
        csrf: owner.csrf,
      }),
    );
    expect(revoked.status).toBe(200);
    const revokedBody = (await revoked.json()) as Record<string, unknown>;
    expect(revokedBody.status).toBe("REVOKED");
    expect(revokedBody.revocationRevision).toBe(2);
    expect(revokedBody.revokedAtMs).toBe(h.clock.value);

    // The next write is refused adjacent to it; the recorded question stays in the inbox.
    const denied = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "post-revocation question",
      idempotencyKey: "q-post",
    });
    expect(denied.status).toBe(410);
    expect(await denied.json()).toEqual({ error: "team_grant_revoked" });

    const ownerInbox = (await (await inbox(h, owner, presentationSessionId)).json()) as {
      questions: unknown[];
    };
    expect(ownerInbox.questions).toHaveLength(1);

    // A fresh invitation aimed at B stays blocked too: its grant is revoked before B
    // could even try to redeem it.
    const second = await issuedGrant(h, owner, presentationSessionId, "teammate-b", "k-2");
    await h.handler(
      request(`/v1/team-question-grants/${second.grantId}`, {
        method: "DELETE",
        cookie: owner.cookie,
        csrf: owner.csrf,
      }),
    );
    const acceptRevoked = await accept(h, teammate, second.invitationToken);
    expect(acceptRevoked.status).toBe(410);
    expect(await acceptRevoked.json()).toEqual({ error: "team_grant_revoked" });
  });

  test("a stranger cannot revoke, and a missing grant answers a typed 404", async () => {
    const h = harness();
    const { owner, teammate, stranger, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");

    const strangersTry = await h.handler(
      request(`/v1/team-question-grants/${grant.grantId}`, {
        method: "DELETE",
        cookie: stranger.cookie,
        csrf: stranger.csrf,
      }),
    );
    expect(strangersTry.status).toBe(404);
    expect(await strangersTry.json()).toEqual({ error: "team_grant_not_found" });

    // The grant survives the failed foreign revocation: B can still accept.
    expect((await accept(h, teammate, grant.invitationToken)).status).toBe(200);

    const missing = await h.handler(
      request("/v1/team-question-grants/tqg_00000000000000000000000000000000", {
        method: "DELETE",
        cookie: owner.cookie,
        csrf: owner.csrf,
      }),
    );
    expect(missing.status).toBe(404);
  });

  test("session end blocks submissions and new accepts immediately", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);

    // The real end route: owner cookie + CSRF, finalization lane included.
    const ended = await h.handler(
      request(`/v1/presentation-sessions/${presentationSessionId}/end`, {
        method: "POST",
        cookie: owner.cookie,
        csrf: owner.csrf,
        body: {},
      }),
    );
    expect(ended.status).toBe(202);

    const denied = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "post-end question",
      idempotencyKey: "q-late",
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "presentation_ended" });

    // No NEW capability can be minted or redeemed on an ended session.
    const lateIssue = await issueGrant(h, owner, presentationSessionId, "teammate-b", "k-end");
    expect(lateIssue.status).toBe(409);
    expect(await lateIssue.json()).toEqual({ error: "presentation_ended" });

    // Accepting a grant issued before its session ended is also refused immediately.
    const endedOwner = await register(h, "owner-e", "owner-e-password");
    const endedSession = await createPresentation(h, endedOwner);
    const endedGrant = await issuedGrant(h, endedOwner, endedSession, "teammate-b");
    await h.handler(
      request(`/v1/presentation-sessions/${endedSession}/end`, {
        method: "POST",
        cookie: endedOwner.cookie,
        csrf: endedOwner.csrf,
        body: {},
      }),
    );
    const acceptLate = await accept(h, teammate, endedGrant.invitationToken);
    expect(acceptLate.status).toBe(409);
    expect(await acceptLate.json()).toEqual({ error: "presentation_ended" });
  });

  test("an expired grant rejects acceptance and submission at exactly expiresAtMs", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    h.clock.value += TEAM_QUESTION_GRANT_TTL_MS;

    const expiredAccept = await accept(h, teammate, grant.invitationToken);
    expect(expiredAccept.status).toBe(410);
    expect(await expiredAccept.json()).toEqual({ error: "team_grant_expired" });
    // An expired invitation never produced a capability: submitting is still refused.
    const denied = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "expired grant question",
      idempotencyKey: "q-exp",
    });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "team_grant_not_accepted" });
  });

  test("an accepted grant that expires mid-session rejects the next submission", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);
    h.clock.value += TEAM_QUESTION_GRANT_TTL_MS;
    const denied = await submit(h, teammate, {
      grantId: grant.grantId,
      questionText: "too late",
      idempotencyKey: "q-expired",
    });
    expect(denied.status).toBe(410);
    expect(await denied.json()).toEqual({ error: "team_grant_expired" });
  });
});

describe("team questions: least-authority boundaries", () => {
  test("B's grant opens no report, playback, deck or Q&A authority", async () => {
    const h = harness();
    const { owner, teammate, presentationSessionId } = await threeUsers(h);
    const grant = await issuedGrant(h, owner, presentationSessionId, "teammate-b");
    await accept(h, teammate, grant.invitationToken);

    const report = await h.handler(
      request(`/v1/presentation-sessions/${presentationSessionId}/report`, {
        cookie: teammate.cookie,
      }),
    );
    expect(report.status).toBe(403);

    const candidates = await h.handler(
      request(`/v1/publications/live-candidates?presentationSessionId=${presentationSessionId}`, {
        cookie: teammate.cookie,
      }),
    );
    expect(candidates.status).toBe(403);

    const slideSet = await h.handler(
      request("/v1/playback/slide-set", {
        cookie: teammate.cookie,
        csrf: teammate.csrf,
        body: {
          presentationSessionId,
          commandId: "cmd_teammate",
          publicSlideKey: "slide_team_one",
          displayBindingEpoch: "dbe_0",
          baseRevision: "cr_0",
        },
      }),
    );
    expect(slideSet.status).not.toBe(202);

    const ownerQa = await h.handler(
      request("/v1/qa-defense", {
        cookie: teammate.cookie,
        csrf: teammate.csrf,
        body: {
          presentationSessionId,
          questionText: "teammate reaching for owner Q&A",
          origin: "TYPED",
        },
      }),
    );
    // The backend without Q&A wiring answers 503; the teammate is never authorized
    // for the owner route either way.
    expect([403, 404, 503]).toContain(ownerQa.status);

    const displayInvite = await h.handler(
      request("/v1/display-invitations", {
        cookie: teammate.cookie,
        csrf: teammate.csrf,
        body: { presentationSessionId },
      }),
    );
    expect(displayInvite.status).toBe(403);
  });

  test("a handler without the team-question dependency answers the typed 503", async () => {
    const h = harness({ omitTeamQuestions: true });
    const owner = await register(h, "owner-f", "owner-f-password");
    const unavailable = await h.handler(
      request("/v1/team-question-grants", {
        cookie: owner.cookie,
        csrf: owner.csrf,
        body: {
          presentationSessionId: "ps_anyid000000001",
          teammateUsername: "x",
          idempotencyKey: "k",
        },
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "team_questions_unavailable" });
  });
});
