import { expect, test } from "bun:test";
import type { ActivePresentationView } from "./session-client";
import {
  createConsoleSessionClient,
  DisplayApprovalRejectedError,
  DisplayInvitationError,
} from "./session-client";

const TOKEN = `dinv_${"ab".repeat(32)}`;
const INVITATION_ID = `dinvite_${"cd".repeat(16)}`;
const presentation: ActivePresentationView = {
  presentationSessionId: "ps_active",
  presentationSessionEpoch: "pse_1",
  deckVersion: "deck_v7",
  slides: [],
};

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): Array<{ url: string; init: RequestInit | undefined }> {
  const received: Array<{ url: string; init: RequestInit | undefined }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      received.push({ url: String(input), init });
      return handler(String(input), init);
    },
  });
  return received;
}

function restoreFetch(original: typeof fetch): void {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: original });
}

const invitationResponse = {
  invitationId: INVITATION_ID,
  token: TOKEN,
  deckVersion: "deck_v7",
  expiresAtMs: 1_000_090,
  stagePath: `/?deck=deck_v7#invite=${TOKEN}`,
};

test("issueDisplayInvitation mints through the owner route and keeps the token inside the fragment", async () => {
  const originalFetch = globalThis.fetch;
  const received = stubFetch(
    () =>
      new Response(JSON.stringify(invitationResponse), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    if (client.issueDisplayInvitation === undefined) {
      throw new Error("client lacks display-invitation issuance");
    }
    const issued = await client.issueDisplayInvitation("csrf_invite", "ps_active");

    const call = received[0];
    if (call === undefined) throw new Error("invitation request was not sent");
    expect(call.url).toBe("https://private.example.test/v1/display-invitations");
    expect(call.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": "csrf_invite" },
    });
    if (typeof call.init?.body !== "string") throw new Error("request body was not JSON");
    expect(JSON.parse(call.init.body)).toEqual({ presentationSessionId: "ps_active" });

    // The minted URL material arrives as a path+fragment only; the token must never be
    // echo'd back as a separate field the console could accidentally ship in a query string.
    expect(issued.stagePath).toBe(`/?deck=deck_v7#invite=${TOKEN}`);
    expect("token" in issued).toBe(false);
    expect(issued.invitationId).toBe(INVITATION_ID);
    expect(issued.deckVersion).toBe("deck_v7");
    expect(issued.expiresAtMs).toBe(1_000_090);
    const url = new URL(`https://stage.example.test${issued.stagePath}`);
    expect(url.searchParams.get("invite")).toBeNull();
    expect(url.hash).toBe(`#invite=${TOKEN}`);
  } finally {
    restoreFetch(originalFetch);
  }
});

test("issueDisplayInvitation rejects a malformed stagePath instead of leaking a bad link", async () => {
  const originalFetch = globalThis.fetch;
  const malformed = [
    { ...invitationResponse, stagePath: "/?deck=deck_v7" },
    { ...invitationResponse, stagePath: `/?invite=${TOKEN}&deck=deck_v7` },
    { ...invitationResponse, stagePath: `https://evil.example/?deck=deck_v7#invite=${TOKEN}` },
    { ...invitationResponse, stagePath: `/?deck=deck_v7#invite=not-a-token` },
  ];
  for (const body of malformed) {
    stubFetch(
      () =>
        new Response(JSON.stringify(body), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createConsoleSessionClient("https://private.example.test");
    if (client.issueDisplayInvitation === undefined) {
      throw new Error("client lacks display-invitation issuance");
    }
    await expect(client.issueDisplayInvitation("csrf_invite", "ps_active")).rejects.toBeInstanceOf(
      DisplayInvitationError,
    );
  }
  restoreFetch(originalFetch);
});

test("issueDisplayInvitation surfaces the backend rejection code as a typed error", async () => {
  const originalFetch = globalThis.fetch;
  stubFetch(
    () =>
      new Response(JSON.stringify({ error: "presentation_ended" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    if (client.issueDisplayInvitation === undefined) {
      throw new Error("client lacks display-invitation issuance");
    }
    await expect(client.issueDisplayInvitation("csrf_invite", "ps_active")).rejects.toMatchObject({
      name: "DisplayInvitationError",
      status: 409,
      code: "presentation_ended",
    });
  } finally {
    restoreFetch(originalFetch);
  }
});

test("readDisplayInvitationPending returns the pending identity and the CAS epoch", async () => {
  const originalFetch = globalThis.fetch;
  const received = stubFetch(
    () =>
      new Response(
        JSON.stringify({
          invitationId: INVITATION_ID,
          presentationSessionId: "ps_active",
          deckVersion: "deck_v7",
          expiresAtMs: 1_000_090,
          status: "JOINED",
          displayBindingEpoch: "dbe_3",
          join: {
            displayJoinId: `join_${"ef".repeat(16)}`,
            displayId: "display_room",
            deckVersion: "deck_v7",
            displayFingerprint: "stage-browser-fp",
            expiresAtMs: 1_000_050,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    if (client.readDisplayInvitationPending === undefined) {
      throw new Error("client lacks the pending-invitation read");
    }
    const view = await client.readDisplayInvitationPending(INVITATION_ID);

    const call = received[0];
    if (call === undefined) throw new Error("pending read was not sent");
    expect(call.url).toBe(
      `https://private.example.test/v1/display-invitations/${INVITATION_ID}/pending`,
    );
    expect(call.init?.method ?? "GET").toBe("GET");
    expect(call.init?.credentials).toBe("include");

    expect(view).toEqual({
      invitationId: INVITATION_ID,
      presentationSessionId: "ps_active",
      deckVersion: "deck_v7",
      expiresAtMs: 1_000_090,
      status: "JOINED",
      displayBindingEpoch: "dbe_3",
      join: {
        displayJoinId: `join_${"ef".repeat(16)}`,
        displayId: "display_room",
        deckVersion: "deck_v7",
        displayFingerprint: "stage-browser-fp",
        expiresAtMs: 1_000_050,
      },
    });
  } finally {
    restoreFetch(originalFetch);
  }
});

test("readDisplayInvitationPending maps expired and unknown invitations to typed rejections", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    { status: 410, error: "INVITATION_EXPIRED" },
    { status: 404, error: "invitation_not_found" },
  ];
  try {
    for (const { status, error } of cases) {
      stubFetch(
        () =>
          new Response(JSON.stringify({ error }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = createConsoleSessionClient("https://private.example.test");
      if (client.readDisplayInvitationPending === undefined) {
        throw new Error("client lacks the pending-invitation read");
      }
      await expect(client.readDisplayInvitationPending(INVITATION_ID)).rejects.toMatchObject({
        name: "DisplayInvitationError",
        status,
        code: error,
      });
    }
  } finally {
    restoreFetch(originalFetch);
  }
});

test("readDisplayInvitationPending fails closed on a malformed view", async () => {
  const originalFetch = globalThis.fetch;
  stubFetch(
    () =>
      new Response(JSON.stringify({ invitationId: INVITATION_ID, status: "JOINED", join: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    if (client.readDisplayInvitationPending === undefined) {
      throw new Error("client lacks the pending-invitation read");
    }
    await expect(client.readDisplayInvitationPending(INVITATION_ID)).rejects.toBeInstanceOf(
      DisplayInvitationError,
    );
  } finally {
    restoreFetch(originalFetch);
  }
});

test("approveDisplay sends the presenter-read CAS epoch, never a constant", async () => {
  const originalFetch = globalThis.fetch;
  const received = stubFetch(
    () =>
      new Response(JSON.stringify({ binding: { displayBindingEpoch: "dbe_4" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    if (client.approveDisplay === undefined) throw new Error("client lacks display approval");
    const join = {
      displayJoinId: `join_${"ef".repeat(16)}`,
      displayId: "display_room",
      displayFingerprint: "stage-browser-fp",
      deckVersion: "deck_v7",
      expiresAtMs: 1_000_050,
    };
    const binding = await client.approveDisplay("csrf_approve", presentation, join, "dbe_3");

    const call = received[0];
    if (call === undefined || typeof call.init?.body !== "string") {
      throw new Error("approval request was not sent");
    }
    const body = JSON.parse(call.init.body) as Record<string, unknown>;
    expect(body.expectedDisplayBindingEpoch).toBe("dbe_3");
    expect(body).toMatchObject({
      presentationSessionId: "ps_active",
      displayJoinId: join.displayJoinId,
      expectedDeckVersion: "deck_v7",
      approvedDisplayId: "display_room",
      approvedDisplayFingerprint: "stage-browser-fp",
    });
    expect(binding).toEqual({ displayBindingEpoch: "dbe_4" });
  } finally {
    restoreFetch(originalFetch);
  }
});

test("approveDisplay exposes a stale CAS as a typed rejection the UI can recover from", async () => {
  const originalFetch = globalThis.fetch;
  stubFetch(
    () =>
      new Response(JSON.stringify({ error: "STALE_DISPLAY_BINDING" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
  );
  try {
    const client = createConsoleSessionClient("https://private.example.test");
    if (client.approveDisplay === undefined) throw new Error("client lacks display approval");
    const join = {
      displayJoinId: `join_${"ef".repeat(16)}`,
      displayId: "display_room",
      displayFingerprint: "stage-browser-fp",
      deckVersion: "deck_v7",
      expiresAtMs: 1_000_050,
    };
    const approval = client.approveDisplay("csrf_approve", presentation, join, "dbe_1");
    await expect(approval).rejects.toBeInstanceOf(DisplayApprovalRejectedError);
    await expect(approval).rejects.toMatchObject({ reason: "STALE_DISPLAY_BINDING" });
  } finally {
    restoreFetch(originalFetch);
  }
});
