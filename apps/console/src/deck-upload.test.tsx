import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
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
    return { presentationSessionId: "ps_deck-upload-1", deckVersion: "deck-v1" };
  });
  const client: ConsoleDeckUploadClient = {
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
  const input = within(document.body).getByLabelText(/Deck file/) as HTMLInputElement;
  expect(input.type).toBe("file");
  expect(input.accept).toBe(".pptx,.pdf");
  const deck = new File([`fake ${name} bytes`], name, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  Object.defineProperty(input, "files", { configurable: true, value: [deck] });
  fireEvent.change(input);
  fireEvent.click(within(document.body).getByRole("button", { name: "Upload deck" }));
  return { deck };
}

describe("deck upload from the authenticated Session page", () => {
  test("accepts .pptx/.pdf, shows progress, and confirms the ready presentation and stage link", async () => {
    const harness = createUploadClient();
    renderSession(harness.client);

    const uploadButton = within(document.body).getByRole("button", { name: "Upload deck" });
    expect(uploadButton.hasAttribute("disabled")).toBe(true);

    const { deck } = selectDeckFile();

    expect(within(document.body).getByText("Uploading deck...")).toBeTruthy();
    expect(uploadButton.hasAttribute("disabled")).toBe(true);
    expect((within(document.body).getByLabelText(/Deck file/) as HTMLInputElement).disabled).toBe(
      true,
    );
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

    expect(within(document.body).queryByText("Uploading deck...")).toBeNull();
    expect(within(document.body).getByText("Presentation ready")).toBeTruthy();
    expect(within(document.body).getByText("Session ps_deck-upload-1")).toBeTruthy();
    expect(uploadButton.hasAttribute("disabled")).toBe(false);
    const stageLink = within(document.body).getByRole("link", { name: "Open the public Stage" });
    expect(stageLink.getAttribute("href")).toBe("http://localhost:4174/?deck=deck-v1");
  });

  test("surfaces the typed upload error message", async () => {
    const harness = createUploadClient({ failWith: new Error("deck_upload_rejected") });
    renderSession(harness.client);
    selectDeckFile("rehearsal.pdf");

    expect(within(document.body).getByText("Uploading deck...")).toBeTruthy();

    await act(async () => {
      harness.release();
      await harness.settled.catch(() => undefined);
    });

    expect(within(document.body).queryByText("Uploading deck...")).toBeNull();
    const errorText = within(document.body).getByText("deck_upload_rejected");
    expect(errorText.className).toContain("console-caption--error");
    expect(within(document.body).queryByText("Presentation ready")).toBeNull();
    expect(within(document.body).queryByRole("link", { name: "Open the public Stage" })).toBeNull();
  });
});
