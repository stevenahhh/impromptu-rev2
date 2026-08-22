import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const { MemoryRouter } = await import("react-router-dom");

const { AuthProvider, ConsoleRoutes } = await import("./App");

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
  expect(input).not.toBeNull();
  if (input === null) throw new Error("deck file input missing");
  expect(input.type).toBe("file");
  expect(input.accept).toBe(".pptx,.pdf");
  const deck = new File([`fake ${name} bytes`], name, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  Object.defineProperty(input, "files", { configurable: true, value: [deck] });
  fireEvent.change(input);
  const uploadButton = document.querySelector("[data-deck-upload-submit]");
  expect(uploadButton).not.toBeNull();
  if (uploadButton === null) throw new Error("deck upload button missing");
  fireEvent.click(uploadButton);
  return { deck };
}

describe("deck upload from the authenticated Session page", () => {
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
});
