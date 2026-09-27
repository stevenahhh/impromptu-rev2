#!/usr/bin/env bun
// Task-2 supplementary probe: invitation exchange battery with schema-valid bodies.
// Same redaction contract as run.mjs: no token/cookie/csrf values in artifacts.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EVID = new URL("..", import.meta.url).pathname;
const HTTP = join(EVID, "pairing.http");
const LOG = join(EVID, "browser-actions.log");

const CONSOLE_ORIGIN = "https://impromptu-rev2-console.vercel.app";
const STAGE_ORIGIN = "https://impromptu-rev2-stage.vercel.app";

const envFile = readFileSync("/Users/gahn/projects/impromptu-rev2/.env", "utf8");
const env = (key) => envFile.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
const USERNAME = env("CONTROLLER_USERNAME");
const PASSWORD = env("CONTROLLER_PASSWORD");
// presentation is minted fresh below (previous probe session was ENDED)
let PRESENTATION = process.env.TASK2_PS_ID ?? "";
let DECK = process.env.TASK2_DECK ?? "deck_16d089f58618c3e943c230fd51978a4c4e660bc9794c27a65c2371990101a660";

const out = [];
function rec(label, status, body) {
  const rendered = JSON.stringify(body)
    .replace(/dinv_[0-9a-f]+/gi, "dinv_<redacted>")
    .replace(/account_session_[A-Za-z0-9]+/g, "<cookie>")
    .replace(/"csrfToken":"[^"]+"/g, '"csrfToken":"<redacted>"')
    .replace(/"token":"[^"]+"/g, '"token":"<redacted>"')
    .replace(/join_[0-9a-f]{32}/g, "join_<id>")
    .replace(/display_[0-9a-f]{32}/g, "display_<id>")
    .replace(/stage-browser-[0-9a-f-]{36}/g, "stage-browser-<uuid>")
    .replace(/audience_[0-9a-f]+/g, "audience_<session>");
  const line = `### ${label}\nHTTP ${status}\n${rendered}\n`;
  out.push(line);
  console.log(`${label} -> ${status} ${rendered.slice(0, 200)}`);
}
async function probe(label, url, init) {
  const res = await fetch(url, init);
  rec(label, res.status, await res.json().catch(() => null));
  return res;
}
const stageHeaders = {
  "content-type": "application/json",
  origin: STAGE_ORIGIN,
  referer: `${STAGE_ORIGIN}/`,
};

// sign in (session cookie + csrf live in memory only)
const login = await fetch(`${CONSOLE_ORIGIN}/v1/account-sessions`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: CONSOLE_ORIGIN,
    referer: `${CONSOLE_ORIGIN}/`,
  },
  body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
});
const loginBody = await login.json();
const csrf = loginBody.csrfToken;
const cookie = (login.headers.getSetCookie?.() ?? [])
  .map((sc) => sc.split(";")[0])
  .join("; ");
rec("supp-login", login.status, { accountId: loginBody?.account?.accountId });

const auth = {
  "content-type": "application/json",
  origin: CONSOLE_ORIGIN,
  referer: `${CONSOLE_ORIGIN}/`,
  "x-csrf-token": csrf,
  cookie,
};

// fresh ACTIVE presentation for the invite battery (reuses the verified gateway artifact)
if (PRESENTATION === "") {
  const artifact = "464229827b429e149e84f1336ab51ec2b7839c48b85db86352f3b636b28cc36a";
  const slides = [
    ["slide_f7c0b54e0a890365fefb587d212173b64f92c50f7b43f5c187a4429866ecba56", 1, "slides/slide-1.svg", "76f7d1146714dfd7b48cff3706a6ee7c0b6ba5f965759ac4b1abe68a4dfcf2ad"],
    ["slide_7aa0fd59bb199dc41c0bcc17eab1567bf98ef810e5c6cdd1275133979859b26f", 2, "slides/slide-2.svg", "a163ebe229636bae69a2599c5991953c3dffa7f01d704befdb150ced9a44e58b"],
    ["slide_000803621852a74b3520da0a28b1e8ff1f1e3976274517934e15b4ffac843104", 3, "slides/slide-3.svg", "f1b9f3bdec04fcd0f27c299fc2c1f82c95525833026eb53ad5cb13f348741e2c"],
  ].map(([slide_key, source_index, relative_path, content_sha256]) => ({
    slide_key, source_index, relative_path, content_sha256, width_points: 1280, height_points: 720,
  }));
  const artRes = await fetch(`${CONSOLE_ORIGIN}/v1/deck-artifacts`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      title: "task2 invite battery",
      renderManifest: {
        deck_id: `deck_${"b2".repeat(32)}`,
        slides,
        fonts: [],
        timelines: [],
        animation_eligible: false,
        ineligible_reason: "baseline reproduction deck",
      },
      publicBaseUrl: `http://projection-gateway:3002/v1/deck-assets/${artifact}`,
    }),
  });
  const arts = await artRes.json().catch(() => null);
  rec("supp-deck-artifacts", artRes.status, {
    deckVersion: arts?.publicDeck?.deckVersion,
    error: arts?.error,
  });
  const presRes = await fetch(`${CONSOLE_ORIGIN}/v1/presentation-sessions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ privateDeck: arts.privateDeck, publicDeck: arts.publicDeck }),
  });
  const pres = await presRes.json().catch(() => null);
  rec("supp-presentation-create", presRes.status, pres?.lifecycle ?? pres);
  PRESENTATION = pres?.lifecycle?.presentationSessionId ?? "";
  DECK = arts?.publicDeck?.deckVersion ?? DECK;
}
if (PRESENTATION === "") {
  console.log("FATAL: no presentation");
  process.exit(2);
}

// mint a real invitation for the task-2 presentation
const mint = await fetch(`${CONSOLE_ORIGIN}/v1/display-invitations`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ presentationSessionId: PRESENTATION }),
});
const invite = await mint.json().catch(() => null);
rec("supp-mint", mint.status, invite ? { ...invite, token: "<redacted>", stagePath: "<redacted>" } : null);
const token = invite?.token;

if (token) {
  const fp = "fp_task2invited_validshape";
  const base = {
    displayId: "display_task2invitedA1",
    displayFingerprint: fp,
    deckVersion: invite.deckVersion ?? DECK,
    invitationToken: token,
  };
  // 1) first exchange — one-use consume
  const ex1 = await fetch(`${STAGE_ORIGIN}/v1/display-joins`, {
    method: "POST",
    headers: stageHeaders,
    body: JSON.stringify(base),
  });
  const ex1Body = await ex1.json().catch(() => null);
  rec("invitation-exchange-first", ex1.status, ex1Body);

  // 2) replay — consumed token must deny, different display identity
  await probe("invitation-exchange-replay", `${STAGE_ORIGIN}/v1/display-joins`, {
    method: "POST",
    headers: stageHeaders,
    body: JSON.stringify({ ...base, displayId: "display_task2invitedB2" }),
  });

  // 3) claim the minted join without presenter approval -> deny
  if (ex1.status === 201) {
    await probe("invited-join-claim-unapproved", `${STAGE_ORIGIN}/v1/display-session`, {
      method: "POST",
      headers: stageHeaders,
      body: JSON.stringify(ex1Body),
    });
  }

  // 4) forged well-formed token -> INVITATION_UNKNOWN
  await probe("invitation-exchange-forged", `${STAGE_ORIGIN}/v1/display-joins`, {
    method: "POST",
    headers: stageHeaders,
    body: JSON.stringify({ ...base, invitationToken: `dinv_${"ab".repeat(32)}` }),
  });

  // 5) well-formed token on the wrong deck -> INVITATION_DECK_MISMATCH (fresh mint)
  const mint2 = await fetch(`${CONSOLE_ORIGIN}/v1/display-invitations`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ presentationSessionId: PRESENTATION }),
  });
  const invite2 = await mint2.json().catch(() => null);
  rec("supp-mint-2", mint2.status, invite2 ? { ...invite2, token: "<redacted>", stagePath: "<redacted>" } : null);
  if (invite2?.token) {
    await probe("invitation-exchange-wrong-deck", `${STAGE_ORIGIN}/v1/display-joins`, {
      method: "POST",
      headers: stageHeaders,
      body: JSON.stringify({
        ...base,
        displayId: "display_task2invitedC3",
        deckVersion: `deck_${"0".repeat(64)}`,
        invitationToken: invite2.token,
      }),
    });
    // 6) expired-but-unused tokens stay minted; revoke the second token by letting it die —
    //    TTL is <=90s, recorded as residue.
  }
}

// sign out
const out2 = await fetch(`${CONSOLE_ORIGIN}/v1/account-session`, {
  method: "DELETE",
  headers: auth,
});
rec("supp-revoke-session", out2.status, await out2.json().catch(() => null));

appendFileSync(HTTP, `\n# supplementary invitation battery (schema-valid bodies)\n${out.join("\n")}`);
appendFileSync(LOG, `${new Date().toISOString()} supplementary invitation battery complete\n`);
console.log("DONE");
