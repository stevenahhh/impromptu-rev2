import { describe, expect, test } from "bun:test";
import { runCustomDeckUploadE2e } from "./custom-deck-upload.harness.ts";

describe("custom deck upload real-browser QA", () => {
  test("uploads representative PPTX and PDF fixtures through Console and proves them on Stage", async () => {
    const evidence = await runCustomDeckUploadE2e();

    expect(evidence.environment).toMatchObject({
      consoleOrigin: "http://localhost:4173",
      sofficePath: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      libreOfficeVersion: expect.stringContaining("LibreOffice 26.2.5.2"),
      fontVersion: "DejaVu 2.37 (Homebrew font-dejavu cask)",
      fontSha256: "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
      fixtureSha256: {
        pptx: "fd7b193c0d02756b737035caa653cd905d09c2b10b9e283ca96107e8667d8727",
        pdf: "36fb24675895a886008a1320b2c5c84355314ed02bd24c71ebeb9fc00ed3e1fc",
      },
    });
    expect(evidence.httpResponses.signIn201.csrfToken).toBe("[REDACTED]");
    expect(evidence.httpResponses.pptxUpload201.publicDeck).toBeDefined();
    expect(evidence.httpResponses.pdfUpload201.publicDeck).toBeDefined();
    expect(evidence.signIn201).toEqual({
      status: 201,
      account: { accountId: "account_custom_deck_e2e", actorId: "actor_custom_deck_e2e" },
    });
    expect(evidence.pptxUpload201.status).toBe(201);
    expect(evidence.pdfUpload201.status).toBe(201);
    expect(evidence.presentationReady).toHaveLength(2);
    expect(evidence.presentationReady.every((id) => id.startsWith("ps_"))).toBe(true);

    expect(evidence.pptx).toMatchObject({
      slideCount: 1,
      dimensions: { width: 1280, height: 720 },
      svgViewBox: { width: 33867, height: 19050 },
      effectClasses: ["entrance", "emphasis", "exit"],
      clickGroups: 3,
      transition: "fade",
      transitionComplete: true,
      computedOpacity: 1,
      font: {
        family: "DejaVu Sans",
        httpStatus: 200,
        readiness: "loaded",
        faceStatus: "loaded",
        check: true,
        byteSize: 757076,
        sha256: "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
      },
      runtimeGroupsAdvanced: 3,
    });
    expect(evidence.pptx.stageBoundingBox.width).toBeGreaterThan(0);
    expect(evidence.pptx.stageBoundingBox.height).toBeGreaterThan(0);
    expect(evidence.pptx.renderedLabels.join(" ")).toContain("Entrance target");
    expect(evidence.pptx.font.computedFamily).toContain("DejaVu Sans");
    expect(evidence.pptx.clickGroupEvidence).toHaveLength(3);
    expect(evidence.pptx.clickGroupEvidence[0]).toMatchObject({
      before: 0,
      after: 1,
      effectClass: "entrance",
      beforeStyle: { visibility: "hidden" },
      afterStyle: { visibility: "visible", opacity: "1" },
      screenshot: "artifacts/custom-deck-upload-e2e/stage-pptx-after-entrance.png",
    });
    expect(evidence.pptx.clickGroupEvidence[1]).toMatchObject({
      before: 1,
      after: 2,
      effectClass: "emphasis",
      beforeStyle: { paintedFill: "rgb(122, 61, 184)" },
      afterStyle: { paintedFill: "rgb(241, 90, 36)" },
      screenshot: "artifacts/custom-deck-upload-e2e/stage-pptx-after-emphasis.png",
    });
    expect(evidence.pptx.clickGroupEvidence[2]).toMatchObject({
      before: 2,
      after: 3,
      effectClass: "exit",
      beforeStyle: { opacity: "1" },
      afterStyle: { opacity: "0" },
      screenshot: "artifacts/custom-deck-upload-e2e/stage-pptx-after-exit.png",
    });
    expect(evidence.pdf).toEqual({
      pageCount: 3,
      dimensions: [
        { width: 1280, height: 720 },
        { width: 556, height: 720 },
        { width: 960, height: 720 },
      ],
      staticRuntimeCount: 0,
      computedOpacity: 1,
      firstPageVisible: true,
      secondPageVisible: true,
      navigation: {
        fromPublicSlideKey: expect.stringMatching(/^slide_[a-f0-9]{64}$/),
        toPublicSlideKey: expect.stringMatching(/^slide_[a-f0-9]{64}$/),
      },
    });
    expect(evidence.screenshots).toHaveLength(8);
    expect(evidence.actions).toContain("Stage advanced PPTX click group 2 -> 3");
    expect(evidence.cleanup).toEqual([
      "browser closed",
      "browser origins stopped",
      "backend and gateway stopped",
      "temporary staging, snapshots, and promoted assets removed",
    ]);
  }, 120_000);
});
