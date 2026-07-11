import { describe, expect, test } from "bun:test";
import { parseCaptureReceipt } from "../../contracts/capture";

describe("capture wire contract", () => {
  test("accepts an explicit committed receipt", () => {
    const receipt = parseCaptureReceipt({
      schema: "dome.capture/v1",
      status: "captured",
      vault: "/vault",
      path: "inbox/raw/a.md",
      commit: "abc",
      title: "A",
      captured_at: "2026-07-11T12:00:00.000Z",
      source: "pwa",
      branch: "main",
      serve_status: "running",
      adopted_initialized: true,
      compile_pending: false,
      commit_status: "committed",
      adoption_status: "pending",
    });
    expect(receipt.status).toBe("captured");
  });

  test("rejects ambiguous legacy success documents at the product boundary", () => {
    expect(() => parseCaptureReceipt({
      schema: "dome.capture/v1",
      status: "captured",
      path: "inbox/raw/a.md",
      commit: "abc",
    })).toThrow("invalid capture receipt");
  });
});
