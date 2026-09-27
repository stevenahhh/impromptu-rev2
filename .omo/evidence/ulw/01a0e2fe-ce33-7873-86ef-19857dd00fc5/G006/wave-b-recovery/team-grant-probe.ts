/**
 * Live HTTP probe for the task-8 teammate grant surface: a real Bun.serve instance on
 * 127.0.0.1, real cookies + CSRF + exact Origin/Referer, in-memory stores (the dev-topology
 * equivalent), three independently signed-in accounts (owner A, teammate B, stranger C).
 * Prints one redacted status line per call; the token is shown only in the owner issuance
 * log line and is never logged afterwards.
 */
import { createAccountDirectory, createInMemoryAccountStore } from "../../../../../../services/private-backend/src/account-directory.ts";
import { createTeamQuestions } from "../../../../../../services/private-backend/src/bootstrap/team-questions.ts";
import { parsePrivateBackendConfig } from "../../../../../../services/private-backend/src/config.ts";
import { createPrivateBackendHandler } from "../../../../../../services/private-backend/src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
} from "../../../../../../services/private-backend/src/prepared-evidence.ts";
import { createInMemoryTeamQuestionStore } from "../../../../../../services/private-backend/src/team-question-grants.ts";

const ORIGIN = "http://localhost:3417";
const BASE = "http://127.0.0.1:3499";
const AUTH = "probe-internal-token";

const clock = { value: 1_000 };
const accountStore = createInMemoryAccountStore();
const directory = createAccountDirectory(accountStore);
const store = createPreparedEvidenceStore();
const projectionStub = {
  bindDisplay: () => ({ outcome: "REJECTED" as const, reason: "unused" }),
  projectPlayback: () => false,
  recordPlaybackApplied: () => false,
  issueDisplayInvitation: () => ({ outcome: "REJECTED" as const, reason: "unused" }),
  readDisplayInvitation: () => ({ outcome: "REJECTED" as const, reason: "unused" }),
};
const coordinator = new PreparedEvidenceCoordinator(projectionStub, store);
const handler = createPrivateBackendHandler(
  parsePrivateBackendConfig({ CONSOLE_ORIGIN: ORIGIN }),
  {
    coordinator,
    identityVerifier: directory,
    accountRegistrar: directory,
    internalAuthToken: AUTH,
    now: () => clock.value,
    teamQuestions: createTeamQuestions({
      store,
      coordinator,
      questionStore: createInMemoryTeamQuestionStore(),
      resolveAccount: async (username) => await accountStore.readByUsername(username),
      now: () => clock.value,
    }),
  },
);

const server = Bun.serve({ hostname: "127.0.0.1", port: 3499, fetch: handler });
const lines: string[] = [];

async function call(
  label: string,
  init: { method?: string; path: string; cookie?: string; csrf?: string; body?: unknown; origin?: string },
): Promise<{ status: number; body: string; cookie: string | null }> {
  const headers: Record<string, string> = {
    Origin: init.origin ?? ORIGIN,
    Referer: `${init.origin ?? ORIGIN}/`,
    "content-type": "application/json",
  };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.csrf) headers["x-csrf-token"] = init.csrf;
  const response = await fetch(`${BASE}${init.path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? null;
  const redacted = body.replaceAll(/tginv_[0-9a-f]{64}/g, "tginv_<redacted>");
  lines.push(`${label} -> ${response.status} ${redacted.slice(0, 200)}`);
  return { status: response.status, body, cookie };
}

try {
  const ownerReg = await call("POST /v1/accounts owner", {
    path: "/v1/accounts",
    body: { username: "probe-owner", password: "probe-owner-password" },
  });
  const ownerSession = await call("POST /v1/account-sessions owner", {
    path: "/v1/account-sessions",
    body: { username: "probe-owner", password: "probe-owner-password" },
  });
  const owner = {
    cookie: ownerSession.cookie ?? "",
    csrf: (JSON.parse(ownerSession.body) as { csrfToken: string }).csrfToken,
    accountId: (JSON.parse(ownerSession.body) as { account: { accountId: string } }).account
      .accountId,
  };
  const mateSession = await call("POST /v1/accounts+session teammate", {
    path: "/v1/accounts",
    body: { username: "probe-mate", password: "probe-mate-password" },
  });
  void mateSession;
  const mateSignIn = await call("POST /v1/account-sessions teammate", {
    path: "/v1/account-sessions",
    body: { username: "probe-mate", password: "probe-mate-password" },
  });
  const mate = {
    cookie: mateSignIn.cookie ?? "",
    csrf: (JSON.parse(mateSignIn.body) as { csrfToken: string }).csrfToken,
    accountId: (JSON.parse(mateSignIn.body) as { account: { accountId: string } }).account
      .accountId,
  };
  const strangerSignIn = await call("POST /v1/account-sessions stranger", {
    path: "/v1/account-sessions",
    body: { username: "probe-stranger", password: "probe-stranger-password" },
  });
  if (strangerSignIn.status !== 201) {
    await call("POST /v1/accounts stranger", {
      path: "/v1/accounts",
      body: { username: "probe-stranger", password: "probe-stranger-password" },
    });
  }
  const strangerSession = await call("POST /v1/account-sessions stranger-2", {
    path: "/v1/account-sessions",
    body: { username: "probe-stranger", password: "probe-stranger-password" },
  });
  const stranger = {
    cookie: strangerSession.cookie ?? "",
    csrf: (JSON.parse(strangerSession.body) as { csrfToken: string }).csrfToken,
    accountId: (JSON.parse(strangerSession.body) as { account: { accountId: string } }).account
      .accountId,
  };
  void ownerReg;

  const manifestHash = "c".repeat(64);
  const created = await call("POST /v1/presentation-sessions owner", {
    path: "/v1/presentation-sessions",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: {
      privateDeck: {
        deckId: "private_deck_probe",
        deckVersion: "deck_probe",
        manifestHash,
        title: "Probe",
        ownerAccountId: owner.accountId,
        aclPolicyVersion: "acl-1",
        privateObjectPrefix: `private-decks/${owner.accountId}/probe`,
        slides: [
          {
            privateSlideId: "private_slide_probe",
            publicSlideKey: "slide_probe",
            ordinal: 1,
            speakerNotes: "private",
            extractedText: "text",
            sourceAssetIds: ["asset_probe"],
          },
        ],
      },
      publicDeck: {
        deckVersion: "deck_probe",
        manifestHash,
        title: "Probe",
        slides: [
          {
            publicSlideKey: "slide_probe",
            ordinal: 1,
            image: {
              url: "https://public.example.test/one.png",
              contentHash: "d".repeat(64),
              width: 1920,
              height: 1080,
            },
            accessibilityLabel: "Slide",
          },
        ],
      },
    },
  });
  const presentationSessionId = (
    JSON.parse(created.body) as { lifecycle: { presentationSessionId: string } }
  ).lifecycle.presentationSessionId;

  const issued = await call("POST /v1/team-question-grants owner->B", {
    path: "/v1/team-question-grants",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: {
      presentationSessionId,
      teammateUsername: "probe-mate",
      idempotencyKey: "issue-1",
    },
  });
  const invitationToken = (JSON.parse(issued.body) as { invitationToken: string })
    .invitationToken;
  const grantId = (JSON.parse(issued.body) as { grantId: string }).grantId;

  await call("POST /v1/team-question-grants no-CSRF", {
    path: "/v1/team-question-grants",
    cookie: owner.cookie,
    body: {
      presentationSessionId,
      teammateUsername: "probe-mate",
      idempotencyKey: "issue-x",
    },
  });
  await call("POST /v1/team-question-grants wrong-origin", {
    path: "/v1/team-question-grants",
    cookie: owner.cookie,
    csrf: owner.csrf,
    origin: "http://evil.example.test",
    body: {
      presentationSessionId,
      teammateUsername: "probe-mate",
      idempotencyKey: "issue-y",
    },
  });
  await call("POST /v1/team-question-grants C targets B grant flow", {
    path: "/v1/team-question-grants",
    cookie: stranger.cookie,
    csrf: stranger.csrf,
    body: {
      presentationSessionId,
      teammateUsername: "probe-mate",
      idempotencyKey: "issue-c",
    },
  });

  await call("POST /v1/team-question-grants/accept C with B token", {
    path: "/v1/team-question-grants/accept",
    cookie: stranger.cookie,
    csrf: stranger.csrf,
    body: { invitationToken },
  });
  await call("POST /v1/team-question-grants/accept B", {
    path: "/v1/team-question-grants/accept",
    cookie: mate.cookie,
    csrf: mate.csrf,
    body: { invitationToken },
  });
  await call("POST /v1/team-question-grants/accept B replay", {
    path: "/v1/team-question-grants/accept",
    cookie: mate.cookie,
    csrf: mate.csrf,
    body: { invitationToken },
  });

  await call("POST /v1/team-questions B", {
    path: "/v1/team-questions",
    cookie: mate.cookie,
    csrf: mate.csrf,
    body: { grantId, questionText: "슬라이드 3의 수치 출처는?", idempotencyKey: "q-1" },
  });
  await call("POST /v1/team-questions B idempotent retry", {
    path: "/v1/team-questions",
    cookie: mate.cookie,
    csrf: mate.csrf,
    body: { grantId, questionText: "슬라이드 3의 수치 출처는?", idempotencyKey: "q-1" },
  });
  await call("POST /v1/team-questions C via B grant", {
    path: "/v1/team-questions",
    cookie: stranger.cookie,
    csrf: stranger.csrf,
    body: { grantId, questionText: "intrusion", idempotencyKey: "q-c" },
  });
  await call("GET /v1/team-questions B (denied)", {
    path: `/v1/team-questions?presentationSessionId=${presentationSessionId}`,
    cookie: mate.cookie,
  });
  await call("GET /v1/team-questions owner inbox", {
    path: `/v1/team-questions?presentationSessionId=${presentationSessionId}`,
    cookie: owner.cookie,
  });
  await call("GET /v1/presentation-sessions/:id/report B (denied)", {
    path: `/v1/presentation-sessions/${presentationSessionId}/report`,
    cookie: mate.cookie,
  });

  await call(`DELETE /v1/team-question-grants/${grantId} by C`, {
    method: "DELETE",
    path: `/v1/team-question-grants/${grantId}`,
    cookie: stranger.cookie,
    csrf: stranger.csrf,
  });
  await call(`DELETE /v1/team-question-grants/${grantId} owner`, {
    method: "DELETE",
    path: `/v1/team-question-grants/${grantId}`,
    cookie: owner.cookie,
    csrf: owner.csrf,
  });
  await call("POST /v1/team-questions B after revoke", {
    path: "/v1/team-questions",
    cookie: mate.cookie,
    csrf: mate.csrf,
    body: { grantId, questionText: "too late", idempotencyKey: "q-2" },
  });
  await call("POST /v1/presentation-sessions/:id/end owner", {
    path: `/v1/presentation-sessions/${presentationSessionId}/end`,
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: {},
  });
} finally {
  server.stop(true);
  console.log(lines.join("\n"));
}
