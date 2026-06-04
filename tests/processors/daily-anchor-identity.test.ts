import { describe, expect, test } from "bun:test";

import { actionItemsFromMarkdown } from "../../assets/extensions/dome.daily/processors/daily-shared";

describe("actionItemsFromMarkdown is anchor-aware", () => {
  test("strips a trailing ^anchor from a checkbox body and exposes the anchor", () => {
    const [item] = actionItemsFromMarkdown("- [ ] ship it ^t1a2b3c4\n");
    expect(item?.body).toBe("ship it");
    expect(item?.anchor).toBe("t1a2b3c4");
  });

  test("strips a trailing ^anchor from a directive body and exposes the anchor", () => {
    const [item] = actionItemsFromMarkdown("TODO: wire the broker ^tabc12345\n");
    expect(item?.body).toBe("wire the broker");
    expect(item?.anchor).toBe("tabc12345");
  });

  test("leaves body unchanged and anchor undefined when unstamped", () => {
    const [item] = actionItemsFromMarkdown("- [ ] ship it\n");
    expect(item?.body).toBe("ship it");
    expect(item?.anchor).toBeUndefined();
  });

  test("the anchored and unanchored forms of the same task share a body", () => {
    const [anchored] = actionItemsFromMarkdown("- [ ] ship it ^t1a2b3c4\n");
    const [plain] = actionItemsFromMarkdown("- [ ] ship it\n");
    expect(anchored?.body).toBe(plain?.body);
  });
});
