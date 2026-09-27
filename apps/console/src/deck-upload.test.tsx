import { afterEach, describe, expect, test } from "bun:test";
import { registerDom } from "@impromptu/test-harness";

registerDom();

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");
const { getDebugLogger } = await import("./debug-log");
const { messages } = await import("./i18n");
const { DeckUploadError } = await import("./session-client");

import type { ConsoleDeckUploadClient, DeckUploadView } from "./session-client";

afterEach(cleanup);

function createUploadClient(options: { readonly failWith?: Error } = {}) {
  const uploads: Array<{ csrfToken: string; file: File }> = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settled: Promise<DeckUploadView> = gate.then(() => {
    if (options.failWith !== undefined) throw options.failWith;
    return {
      presentationSessionId: "ps_deck-upload-1",
      presentationSessionEpoch: "pse_1",
      deckVersion: "deck-v1",
    };
  });
  const client: ConsoleDeckUploadClient = {
    async signUp() {
      throw new Error("not used");
    },
    async signIn() {
      throw new Error("not used");
    },
    async readSession() {
      return null;
    },
    async signOut() {},
    async createPresentation() {
      throw new Error("not used");
    },
    async recommend() {
      throw new Error("not used");
    },
    async readLiveCandidates() {
      throw new Error("not used");
    },
    async approveLiveCandidate() {
      throw new Error("not used");
    },
    async uploadDeck(csrfToken: string, file: File): Promise<DeckUploadView> {
      uploads.push({ csrfToken, file });
      return settled;
    },
  };
  return { client, uploads, release: () => release?.(), settled };
}

function renderSession(client: ConsoleDeckUploadClient) {
  return render(
    <MemoryRouter initialEntries={["/session"]}>
      <AuthProvider initialAuthenticated client={client}>
        <ConsoleRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function selectDeckFile(name = "rehearsal.pptx") {
  const input = document.querySelector("[data-deck-file-input]") as HTMLInputElement | null;
  if (input === null) throw new Error("deck file input missing");
  expect(input.type).toBe("file");
  expect(input.accept).toBe(".pptx,.pdf");
  const deck = new File([`fake ${name} bytes`], name, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  Object.defineProperty(input, "files", { configurable: true, value: [deck] });
  fireEvent.change(input);
  const uploadButton = document.querySelector("[data-deck-upload-submit]");
  if (uploadButton === null) throw new Error("deck upload button missing");
  fireEvent.click(uploadButton);
  return { deck };
}

describe("deck upload from the authenticated Session page", () => {
  test("asks for the deck exactly once on the first screen", () => {
    renderSession(createUploadClient().client);

    const dropzone = document.querySelector("[data-upload-dropzone]");
    expect(dropzone).not.toBeNull();
    // The page h1 owns the upload ask; the dropzone must not repeat it as a second heading.
    expect(dropzone?.querySelectorAll("h1, h2, h3, h4").length).toBe(0);

    const ask = messages("ko").uploadTitle;
    const askHeadings = [...document.querySelectorAll("h1, h2, h3")].filter(
      (heading) => heading.textContent?.trim() === ask,
    );
    expect(askHeadings.length).toBe(1);
    expect(askHeadings[0]?.tagName).toBe("H1");

    // Screen readers still receive the ask through the dropzone's own label.
    expect(dropzone?.getAttribute("aria-label")).toBe(ask);
  });
  test("accepts .pptx/.pdf, shows progress, and confirms the ready presentation and stage link", async () => {
    const harness = createUploadClient();
    renderSession(harness.client);

    // Choosing a deck is the whole action now, so the control the harnesses click is the
    // picker itself and the input is what closes while an upload is in flight.
    const uploadControl = document.querySelector("[data-deck-upload-submit]");
    expect(uploadControl).not.toBeNull();
    expect((document.querySelector("[data-deck-file-input]") as HTMLInputElement).disabled).toBe(
      false,
    );

    const { deck } = selectDeckFile();

    expect(document.querySelector("[data-upload-status='UPLOADING']")).not.toBeNull();
    expect((document.querySelector("[data-deck-file-input]") as HTMLInputElement).disabled).toBe(
      true,
    );
    // selectDeckFile already clicked the picker after setting files, the way the Playwright
    // harnesses drive it; that click must never re-send the same deck.
    fireEvent.click(uploadControl as HTMLElement);
    expect(harness.uploads).toHaveLength(1);
    expect(harness.uploads[0]?.csrfToken).toBe("preview-csrf");
    expect(harness.uploads[0]?.file).toBe(deck);
    expect(harness.uploads[0]?.file.name).toBe("rehearsal.pptx");
    expect(harness.uploads[0]?.file.type).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    await act(async () => {
      harness.release();
      await harness.settled;
    });

    expect(document.querySelector("[data-upload-status='UPLOADING']")).toBeNull();
    expect(document.querySelector("[data-upload-dropzone]")).toBeNull();
    expect(document.querySelector("[data-stage-open]")).not.toBeNull();
  });

  test("surfaces a localized upload error without exposing the server reason", async () => {
    const harness = createUploadClient({ failWith: new Error("deck_upload_rejected") });
    renderSession(harness.client);
    selectDeckFile("rehearsal.pdf");

    expect(document.querySelector("[data-upload-status='UPLOADING']")).not.toBeNull();

    await act(async () => {
      harness.release();
      await harness.settled.catch(() => undefined);
    });

    expect(document.querySelector("[data-upload-status='UPLOADING']")).toBeNull();
    const errorText = document.querySelector("[data-upload-status='ERROR']");
    expect(errorText?.textContent).not.toContain("deck_upload_rejected");
    expect(errorText?.textContent?.length).toBeGreaterThan(0);
    if (!(errorText instanceof HTMLElement)) throw new Error("deck upload error missing");
    expect(errorText.className).toContain("console-status-line--attention");
    expect(document.querySelector("[data-upload-status='SUCCESS']")).toBeNull();
    expect(document.querySelector("[data-stage-open]")).toBeNull();
  });

  test("records every deck upload in the debug overlay under the upload source", async () => {
    const harness = createUploadClient();
    const log = getDebugLogger();
    log.clear();
    renderSession(harness.client);
    selectDeckFile();

    expect(
      log
        .entries()
        .some((entry) => entry.source === "upload" && entry.message === "deck.upload.start"),
    ).toBe(true);

    await act(async () => {
      harness.release();
      await harness.settled;
    });

    const uploadEntries = log.entries().filter((entry) => entry.source === "upload");
    expect(uploadEntries.map((entry) => entry.message)).toEqual([
      "deck.upload.start",
      "deck.upload.ok",
    ]);
    const startedEntry = uploadEntries[0];
    expect(startedEntry?.detail?.filename).toBe("rehearsal.pptx");
  });

  test("tells the presenter when a deck exceeds the upload size limit", async () => {
    const harness = createUploadClient({
      failWith: new DeckUploadError("input_too_large", { status: 413 }),
    });
    renderSession(harness.client);
    selectDeckFile("too-large.pptx");

    await act(async () => {
      harness.release();
      await harness.settled.catch(() => undefined);
    });

    const errorText = document.querySelector("[data-upload-status='ERROR']");
    expect(errorText?.textContent).toContain(messages("ko").uploadTooLarge);
    // The typed rejection must stay localized: no raw codes leak to the presenter.
    expect(errorText?.textContent).not.toContain("input_too_large");
  });

  test("clears the picker so the same deck can be chosen again after a failed upload", async () => {
    // After an ERROR the panel stays mounted; a real browser only fires change when the
    // selection differs, so the stale fake-path value must be reset after each pick.
    const harness = createUploadClient({
      failWith: new DeckUploadError("unsafe_filename", { status: 400 }),
    });
    renderSession(harness.client);

    const input = document.querySelector("[data-deck-file-input]") as HTMLInputElement;
    let recordedReset = false;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "C:\\fakepath\\rehearsal.pptx",
      set: (assigned) => {
        if (assigned === "") recordedReset = true;
      },
    });
    const deck = new File(["fake bytes"], "rehearsal.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    Object.defineProperty(input, "files", { configurable: true, value: [deck] });
    await act(async () => {
      fireEvent.change(input);
      harness.release();
      await harness.settled.catch(() => undefined);
    });

    expect(harness.uploads).toHaveLength(1);
    expect(recordedReset).toBe(true);
  });
});
