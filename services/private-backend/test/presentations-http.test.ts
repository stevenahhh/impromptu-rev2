import { describe, expect, test } from "bun:test";
import { PreparedEvidenceProjectionGateway } from "@impromptu/projection-gateway";
import { parsePrivateBackendConfig } from "../src/config.ts";
import { deckTitleFromFilename } from "../src/deck-upload-service.ts";
import { createPrivateBackendHandler, type PrivateBackendHandler } from "../src/http.ts";
import {
  createPreparedEvidenceStore,
  PreparedEvidenceCoordinator,
  restorePreparedEvidenceStore,
  snapshotPreparedEvidenceStore,
} from "../src/prepared-evidence.ts";

const origin = "https://console.example.test";
const config = parsePrivateBackendConfig({ CONSOLE_ORIGIN: origin });

const manifestHash = "a".repeat(64);
const imageHash = "c".repeat(64);

function deckPair(ownerAccountId: string, deckVersion: string, title: string, slideCount = 2) {
  const slides = Array.from({ length: slideCount }, (_unused, index) => index + 1);
  return {
    privateDeck: {
      deckId: `private_deck_${deckVersion}`,
      deckVersion,
      manifestHash,
      title,
      ownerAccountId,
      aclPolicyVersion: "acl-1",
      privateObjectPrefix: `private-decks/${ownerAccountId}/${deckVersion}`,
      slides: slides.map((ordinal) => ({
        privateSlideId: `private_slide_${deckVersion}_${ordinal}`,
        publicSlideKey: `slide_${deckVersion}_${ordinal}`,
        ordinal,
        speakerNotes: `PRIVATE_NOTE_SENTINEL_${deckVersion}_${ordinal}`,
        extractedText: `Slide ${ordinal}`,
        sourceAssetIds: [`asset_${deckVersion}_${ordinal}`],
      })),
    },
    publicDeck: {
      deckVersion,
      manifestHash,
      title,
      slides: slides.map((ordinal) => ({
        publicSlideKey: `slide_${deckVersion}_${ordinal}`,
        ordinal,
        image: {
          url: `https://public.example.test/${deckVersion}/${ordinal}.png`,
          contentHash: imageHash,
          width: 1920,
          height: 1080,
        },
        accessibilityLabel: `Slide ${ordinal}`,
      })),
    },
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://private.example.test${path}`, {
    ...init,
    headers: {
      Origin: origin,
      Referer: `${origin}/presentations`,
      ...init.headers,
    },
  });
}

/**
 * Mirrors the real directory contract (account-directory.ts): every sign-in mints a fresh
 * actorId, so a sign-out/sign-in round trip must not reuse the first session's lease actor.
 */
function presentationHarness(options: { persist?: () => Promise<void> } = {}) {
  const store = createPreparedEvidenceStore();
  const coordinator = new PreparedEvidenceCoordinator(
    new PreparedEvidenceProjectionGateway(),
    store,
  );
  const signInCountByUsername = new Map<string, number>();
  const handler = createPrivateBackendHandler(config, {
    coordinator,
    identityVerifier: {
      async verifyCredentials(username, password) {
        const credentials: Record<string, string> = {
          "alpha@example.test": "alpha-password",
          "beta@example.test": "beta-password",
        };
        if (credentials[username] !== password) return null;
        const accountId = `account_${username.split("@", 1)[0]}`;
        const signInCount = (signInCountByUsername.get(username) ?? 0) + 1;
        signInCountByUsername.set(username, signInCount);
        return { accountId, actorId: `actor_${accountId}_${signInCount}` };
      },
    },
    internalAuthToken: "internal-test-token-library",
    now: () => 1_000,
    ...(options.persist === undefined ? {} : { persist: options.persist }),
  });
  return { coordinator, handler, store };
}

async function signIn(handler: PrivateBackendHandler, username: string, password: string) {
  const response = await handler(
    request("/v1/account-sessions", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  );
  expect(response.status).toBe(201);
  const payload = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const accountSessionId = /=(account_session_[A-Za-z0-9]+)/.exec(cookie)?.[1];
  if (accountSessionId === undefined) throw new Error(`no session cookie: ${cookie}`);
  return {
    accountSessionId,
    actorId: String(payload.account.actorId),
    cookie,
    csrfToken: String(payload.csrfToken),
  };
}

async function createPresentation(
  coordinator: PreparedEvidenceCoordinator,
  accountSessionId: string,
  deckVersion: string,
  title: string,
  options: {
    readonly slideCount?: number;
    readonly ownerAccountId?: string;
    readonly nowMs?: number;
  } = {},
): Promise<string> {
  const ownerAccountId = options.ownerAccountId ?? "account_alpha";
  const pair = deckPair(ownerAccountId, deckVersion, title, options.slideCount ?? 2);
  const created = await coordinator.createPresentation(
    accountSessionId,
    pair,
    options.nowMs ?? 1_000,
  );
  if (created.outcome === "REJECTED") {
    throw new Error(`fixture presentation rejected: ${created.reason}`);
  }
  return created.value.lifecycle.presentationSessionId;
}

const listGet = (handler: PrivateBackendHandler, auth: { cookie: string }, query = "") =>
  handler(request(`/v1/presentations${query}`, { headers: { Cookie: auth.cookie } }));

describe("owner-scoped presentation library", () => {
  test("lists only the caller's decks, resume returns the deck, and foreign accounts see zero rows", async () => {
    const { coordinator, handler } = presentationHarness();
    const alpha = await signIn(handler, "alpha@example.test", "alpha-password");
    const beta = await signIn(handler, "beta@example.test", "beta-password");
    const firstId = await createPresentation(
      coordinator,
      alpha.accountSessionId,
      "deck_first",
      "Quarterly review",
    );
    const sampleId = await createPresentation(
      coordinator,
      alpha.accountSessionId,
      "deck_sample",
      deckTitleFromFilename("impromptu-sample-deck.pdf"),
      { slideCount: 7, nowMs: 2_000 },
    );
    await createPresentation(coordinator, beta.accountSessionId, "deck_beta", "Beta private", {
      ownerAccountId: "account_beta",
    });

    const alphaList = await listGet(handler, alpha);
    expect(alphaList.status).toBe(200);
    const alphaBody = await alphaList.json();
    expect(alphaBody.presentations.map((row: { title: string }) => row.title)).toEqual([
      "Impromptu sample deck",
      "Quarterly review",
    ]);
    expect(alphaBody.nextCursor).toBeNull();
    const sampleRow = alphaBody.presentations.find(
      (row: { presentationSessionId: string }) => row.presentationSessionId === sampleId,
    );
    expect(sampleRow.slideCount).toBe(7);
    expect(sampleRow.status).toBe("ACTIVE");

    // A foreign account's list contains zero of the owner's rows.
    const betaList = await listGet(handler, beta);
    expect(betaList.status).toBe(200);
    const betaBody = await betaList.json();
    expect(betaBody.presentations.map((row: { title: string }) => row.title)).toEqual([
      "Beta private",
    ]);

    // The owner re-enters its deck without re-uploading: the detail carries the public deck.
    const detail = await handler(
      request(`/v1/presentations/${sampleId}`, { headers: { Cookie: alpha.cookie } }),
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.presentation.presentationSessionId).toBe(sampleId);
    expect(detailBody.presentation.title).toBe("Impromptu sample deck");
    expect(detailBody.publicDeck.slides).toHaveLength(7);
    expect(detailBody.publicDeck.slides[0].publicSlideKey).toBe("slide_deck_sample_1");
    expect(detailBody.playback.controlRevision).toBe("cr_0");
    expect(detailBody.playback.displayBindingEpoch).toBe("dbe_0");
    expect(detailBody.playback.activeLease.actorId).toBe(alpha.actorId);

    // No private deck bytes or fields ever leave the owner-scoped read.
    const serialized = JSON.stringify(detailBody);
    expect(serialized).not.toContain("PRIVATE_NOTE_SENTINEL");
    expect(serialized).not.toContain("privateObjectPrefix");
    expect(serialized).not.toContain("privateDeck");
    expect(serialized).not.toContain("speakerNotes");
    expect(serialized).not.toContain("sourceAssetIds");

    // A foreign account cannot read or even discover the owner's presentation.
    const foreignDetail = await handler(
      request(`/v1/presentations/${firstId}`, { headers: { Cookie: beta.cookie } }),
    );
    expect(foreignDetail.status).toBe(403);
    const unknownDetail = await handler(
      request("/v1/presentations/ps_missingid000001", { headers: { Cookie: beta.cookie } }),
    );
    expect(unknownDetail.status).toBe(404);
  });

  test("survives sign-out and re-login: the same deck resumes without reupload", async () => {
    const { coordinator, handler } = presentationHarness();
    const firstSession = await signIn(handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await createPresentation(
      coordinator,
      firstSession.accountSessionId,
      "deck_resume",
      "Launch rehearsal",
    );

    const signOut = await handler(
      request("/v1/account-session", {
        method: "DELETE",
        headers: { Cookie: firstSession.cookie, "X-CSRF-Token": firstSession.csrfToken },
      }),
    );
    expect(signOut.status).toBe(200);
    const revoked = await listGet(handler, firstSession);
    expect(revoked.status).toBe(401);

    // The second sign-in mints a fresh actorId, exactly like the real directory.
    const secondSession = await signIn(handler, "alpha@example.test", "alpha-password");
    expect(secondSession.actorId).not.toBe(firstSession.actorId);

    const list = await listGet(handler, secondSession);
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.presentations).toHaveLength(1);
    expect(body.presentations[0].presentationSessionId).toBe(presentationSessionId);
    expect(body.presentations[0].title).toBe("Launch rehearsal");

    const detail = await handler(
      request(`/v1/presentations/${presentationSessionId}`, {
        headers: { Cookie: secondSession.cookie },
      }),
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    // The detail reports the stale first-session lease so the Console knows a takeover is due.
    expect(detailBody.playback.activeLease.actorId).toBe(firstSession.actorId);
    expect(detailBody.publicDeck.deckVersion).toBe("deck_resume");
  });

  test("restores a legacy snapshot whose lifecycle predates title and updatedAtMs fields", async () => {
    const { coordinator, handler, store } = presentationHarness();
    const alpha = await signIn(handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await createPresentation(
      coordinator,
      alpha.accountSessionId,
      "deck_legacy",
      "Legacy upload",
    );

    // Strip the additive fields the way a pre-GAP-10 snapshot was persisted. The account
    // session survives inside the same snapshot, so the restored coordinator still knows it.
    const snapshot = JSON.parse(JSON.stringify(snapshotPreparedEvidenceStore(store))) as {
      presentations: Array<{
        lifecycle: Record<string, unknown>;
      }>;
    };
    delete snapshot.presentations[0]?.lifecycle.presentationTitle;
    delete snapshot.presentations[0]?.lifecycle.updatedAtMs;
    const restored = restorePreparedEvidenceStore(snapshot);
    expect(restored.outcome).toBe("RESTORED");
    if (restored.outcome !== "RESTORED") throw new Error("restore failed");

    const restoredCoordinator = new PreparedEvidenceCoordinator(
      new PreparedEvidenceProjectionGateway(),
      restored.store,
    );
    const restoredHandler = createPrivateBackendHandler(config, {
      coordinator: restoredCoordinator,
      identityVerifier: {
        async verifyCredentials(username, password) {
          return username === "alpha@example.test" && password === "alpha-password"
            ? { accountId: "account_alpha", actorId: "actor_alpha_relogin" }
            : null;
        },
      },
      internalAuthToken: "internal-test-token-library",
      now: () => 1_000,
    });
    const relogin = await signIn(restoredHandler, "alpha@example.test", "alpha-password");
    const detail = await restoredHandler(
      request(`/v1/presentations/${presentationSessionId}`, {
        headers: { Cookie: relogin.cookie },
      }),
    );
    expect(detail.status).toBe(200);
    const body = await detail.json();
    // Backfill rule: an absent presentation title falls back to the deck title.
    expect(body.presentation.title).toBe("Legacy upload");
    expect(body.presentation.updatedAtMs).toBe(body.presentation.createdAtMs);
  });

  test("renames only the owner's presentation and never another account's", async () => {
    const { coordinator, handler } = presentationHarness();
    const alpha = await signIn(handler, "alpha@example.test", "alpha-password");
    const beta = await signIn(handler, "beta@example.test", "beta-password");
    const presentationSessionId = await createPresentation(
      coordinator,
      alpha.accountSessionId,
      "deck_rename",
      "Draft title",
    );

    const renamed = await handler(
      request(`/v1/presentations/${presentationSessionId}`, {
        method: "POST",
        headers: { Cookie: alpha.cookie, "X-CSRF-Token": alpha.csrfToken },
        body: JSON.stringify({ title: "Final title" }),
      }),
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).presentation.title).toBe("Final title");

    const list = await listGet(handler, alpha);
    expect((await list.json()).presentations[0].title).toBe("Final title");

    const foreignRename = await handler(
      request(`/v1/presentations/${presentationSessionId}`, {
        method: "POST",
        headers: { Cookie: beta.cookie, "X-CSRF-Token": beta.csrfToken },
        body: JSON.stringify({ title: "Stolen title" }),
      }),
    );
    expect(foreignRename.status).toBe(403);
    const after = await handler(
      request(`/v1/presentations/${presentationSessionId}`, {
        headers: { Cookie: alpha.cookie },
      }),
    );
    expect((await after.json()).presentation.title).toBe("Final title");

    // Closed DTO: empty titles and unknown keys are rejected outright.
    const emptyTitle = await handler(
      request(`/v1/presentations/${presentationSessionId}`, {
        method: "POST",
        headers: { Cookie: alpha.cookie, "X-CSRF-Token": alpha.csrfToken },
        body: JSON.stringify({ title: "" }),
      }),
    );
    expect(emptyTitle.status).toBe(400);
    const extraKey = await handler(
      request(`/v1/presentations/${presentationSessionId}`, {
        method: "POST",
        headers: { Cookie: alpha.cookie, "X-CSRF-Token": alpha.csrfToken },
        body: JSON.stringify({ title: "Fine", ownerAccountId: "account_beta" }),
      }),
    );
    expect(extraKey.status).toBe(400);
  });

  test("deletes only the owner's presentation and revokes every read of it", async () => {
    const { coordinator, handler } = presentationHarness();
    const alpha = await signIn(handler, "alpha@example.test", "alpha-password");
    const beta = await signIn(handler, "beta@example.test", "beta-password");
    const keepId = await createPresentation(
      coordinator,
      alpha.accountSessionId,
      "deck_keep",
      "Keep me",
    );
    const dropId = await createPresentation(
      coordinator,
      alpha.accountSessionId,
      "deck_drop",
      "Delete me",
    );

    // A foreign account cannot delete or even discover the owner's presentation.
    const foreignDelete = await handler(
      request(`/v1/presentations/${dropId}`, {
        method: "DELETE",
        headers: { Cookie: beta.cookie, "X-CSRF-Token": beta.csrfToken },
      }),
    );
    expect(foreignDelete.status).toBe(403);
    const missingDelete = await handler(
      request("/v1/presentations/ps_missingid000001", {
        method: "DELETE",
        headers: { Cookie: alpha.cookie, "X-CSRF-Token": alpha.csrfToken },
      }),
    );
    expect(missingDelete.status).toBe(404);

    const deleted = await handler(
      request(`/v1/presentations/${dropId}`, {
        method: "DELETE",
        headers: { Cookie: alpha.cookie, "X-CSRF-Token": alpha.csrfToken },
      }),
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });

    // The row is gone from the owner's list while the sibling deck survives.
    const list = await listGet(handler, alpha);
    const body = await list.json();
    expect(
      body.presentations.map((row: { presentationSessionId: string }) => row.presentationSessionId),
    ).toEqual([keepId]);

    // Every read of the deleted id now answers not-found, and a second delete fails too.
    const detail = await handler(
      request(`/v1/presentations/${dropId}`, { headers: { Cookie: alpha.cookie } }),
    );
    expect(detail.status).toBe(404);
    const again = await handler(
      request(`/v1/presentations/${dropId}`, {
        method: "DELETE",
        headers: { Cookie: alpha.cookie, "X-CSRF-Token": alpha.csrfToken },
      }),
    );
    expect(again.status).toBe(404);
  });

  test("paginates the owner's list and rejects an opaque cursor that was not issued", async () => {
    const { coordinator, handler } = presentationHarness();
    const alpha = await signIn(handler, "alpha@example.test", "alpha-password");
    await createPresentation(coordinator, alpha.accountSessionId, "deck_one", "One", {
      slideCount: 1,
      nowMs: 1_000,
    });
    await createPresentation(coordinator, alpha.accountSessionId, "deck_two", "Two", {
      slideCount: 1,
      nowMs: 2_000,
    });
    await createPresentation(coordinator, alpha.accountSessionId, "deck_three", "Three", {
      slideCount: 1,
      nowMs: 3_000,
    });

    const firstPage = await listGet(handler, alpha, "?limit=2");
    expect(firstPage.status).toBe(200);
    const firstBody = await firstPage.json();
    expect(firstBody.presentations).toHaveLength(2);
    expect(firstBody.presentations[0].title).toBe("Three");
    expect(typeof firstBody.nextCursor).toBe("string");

    const secondPage = await listGet(
      handler,
      alpha,
      `?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    expect(secondPage.status).toBe(200);
    const secondBody = await secondPage.json();
    expect(secondBody.presentations.map((row: { title: string }) => row.title)).toEqual(["One"]);
    expect(secondBody.nextCursor).toBeNull();

    const forged = await listGet(handler, alpha, "?cursor=not-an-issued-cursor");
    expect(forged.status).toBe(400);
    const badLimit = await listGet(handler, alpha, "?limit=0");
    expect(badLimit.status).toBe(400);
  });

  test("guards the owner routes with session cookie, exact origin, and CSRF", async () => {
    const { coordinator, handler } = presentationHarness();
    const alpha = await signIn(handler, "alpha@example.test", "alpha-password");
    const presentationSessionId = await createPresentation(
      coordinator,
      alpha.accountSessionId,
      "deck_guard",
      "Guarded deck",
    );

    const anonymousList = await listGet(handler, { cookie: "" });
    expect(anonymousList.status).toBe(401);
    const anonymousDetail = await handler(request(`/v1/presentations/${presentationSessionId}`));
    expect(anonymousDetail.status).toBe(401);

    const withoutCsrf = await handler(
      request(`/v1/presentations/${presentationSessionId}`, {
        method: "POST",
        headers: { Cookie: alpha.cookie },
        body: JSON.stringify({ title: "New title" }),
      }),
    );
    expect(withoutCsrf.status).toBe(403);

    const crossOrigin = await handler(
      new Request(`https://private.example.test/v1/presentations/${presentationSessionId}`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example.test",
          Referer: "https://attacker.example.test/x",
          Cookie: alpha.cookie,
          "X-CSRF-Token": alpha.csrfToken,
        },
        body: JSON.stringify({ title: "New title" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const missingReferer = await handler(
      new Request(`https://private.example.test/v1/presentations/${presentationSessionId}`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: alpha.cookie,
          "X-CSRF-Token": alpha.csrfToken,
        },
        body: JSON.stringify({ title: "New title" }),
      }),
    );
    expect(missingReferer.status).toBe(403);
  });
});
