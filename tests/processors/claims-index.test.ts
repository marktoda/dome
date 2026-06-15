import { describe, expect, test } from "bun:test";

import { claimFactValue } from "../../assets/extensions/dome.claims/processors/claim-fact";

describe("claimFactValue", () => {
  test("encodes key, value, and asOf as canonical JSON", () => {
    const encoded = claimFactValue({
      line: 3,
      key: "Pod managed",
      value: "[[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      asOf: "2026-05-22",
      anchor: "c1a2b3c4d",
    });
    expect(JSON.parse(encoded)).toEqual({
      key: "Pod managed",
      value: "[[wiki/entities/protocol-growth-pod]] *(as of 2026-05-22)*",
      asOf: "2026-05-22",
    });
  });

  test("omits asOf when absent", () => {
    const encoded = claimFactValue({
      line: 1,
      key: "Level",
      value: "UNI-4",
      asOf: null,
      anchor: null,
    });
    expect(JSON.parse(encoded)).toEqual({ key: "Level", value: "UNI-4" });
  });
});
