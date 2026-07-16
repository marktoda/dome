import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { VaultMarkdown } from "../src/components/VaultMarkdown";

afterEach(cleanup);

describe("VaultMarkdown", () => {
  test("renders CommonMark, GFM, and inert Obsidian syntax through one safe seam", () => {
    render(<VaultMarkdown content={`---
type: project
---
# Project **Alpha**

A paragraph with *emphasis*, \`inline code\`, [[projects/alpha.md#Launch|Project #Alpha]], and [[plans/Roadmap#Now]].

- ordinary item
- [ ] open task
- [x] completed task

1. first
2. second

> A useful quote.

\`\`\`ts
const x = 1;
\`\`\`

| Name | State |
| --- | --- |
| Dome | Ready |

[safe](https://example.com) [unsafe](javascript:alert(1))

![beacon](https://tracker.invalid/pixel.png)

<script>globalThis.pwned = true</script>
<img src=x onerror="globalThis.pwned = true">

\`[[literal-code]]\`
`} />);

    expect(screen.getByText("type: project").tagName).toBe("CODE");
    expect(screen.getByRole("heading", { name: "Project Alpha", level: 1 })).toBeDefined();
    expect(screen.getByText("emphasis").tagName).toBe("EM");
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    expect(screen.getByText("Project #Alpha").classList.contains("source-wikilink")).toBeTrue();
    expect(screen.getByText("Roadmap").classList.contains("source-wikilink")).toBeTrue();
    expect(document.querySelectorAll(".source-wikilink")).toHaveLength(2);
    expect(screen.getByText("[[literal-code]]").tagName).toBe("CODE");

    const tasks = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.disabled)).toBeTrue();
    expect(tasks.map((task) => task.checked)).toEqual([false, true]);
    expect(screen.getByText("A useful quote.").closest("blockquote")).not.toBeNull();
    expect(screen.getByText("const x = 1;").tagName).toBe("CODE");
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByRole("cell", { name: "Ready" })).toBeDefined();

    const safe = screen.getByRole("link", { name: "safe" });
    expect(safe.getAttribute("href")).toBe("https://example.com");
    expect(safe.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
    expect(screen.getByText("unsafe").classList.contains("source-link-label")).toBeTrue();
    expect(screen.getByText("Image: beacon")).toBeDefined();
    expect(document.querySelector(".source-markdown img")).toBeNull();
    expect(document.querySelector(".source-markdown script")).toBeNull();
    expect(document.querySelector("[onerror]")).toBeNull();
  });
});
