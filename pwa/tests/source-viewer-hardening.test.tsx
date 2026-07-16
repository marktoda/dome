import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DomeClient } from "../src/api/client";
import {
  MARKDOWN_RENDER_BUDGET_BYTES,
  SourceViewer,
} from "../src/components/SourceViewer";
import type { SourceDocumentResult } from "../../contracts/source-document";

afterEach(cleanup);

const CITATION = {
  path: "wiki/source.md",
  commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function clientReturning(result: SourceDocumentResult): DomeClient {
  return {
    source: async () => result,
  } as unknown as DomeClient;
}

function documentWith(content: string): SourceDocumentResult {
  return {
    schema: "dome.source-document/v1",
    status: "ok",
    path: CITATION.path,
    commit: CITATION.commit,
    content,
  };
}

describe("SourceViewer rendering limits", () => {
  test("opens over-budget UTF-8 content as exact Raw without mounting the renderer", async () => {
    let rendererMounts = 0;
    const CountingRenderer = (): React.ReactElement => {
      rendererMounts += 1;
      return <p>rendered</p>;
    };
    // Each character is four UTF-8 bytes: the byte budget, not JS string length, is authoritative.
    const content = "🙂".repeat(Math.floor(MARKDOWN_RENDER_BUDGET_BYTES / 4) + 1);

    render(<SourceViewer
      citation={CITATION}
      client={clientReturning(documentWith(content))}
      onClose={() => {}}
      returnFocus={null}
      MarkdownRenderer={CountingRenderer}
    />);

    await waitFor(() => expect(screen.getByText(/too large to render safely/i)).toBeDefined());
    expect(screen.getByRole("status").textContent).toContain("exact content is unchanged");
    expect(screen.getByRole("button", { name: "Raw" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Rendered" }) as HTMLButtonElement).disabled).toBeTrue();
    expect(rendererMounts).toBe(0);
    expect(document.querySelector(".source-raw")?.textContent).toBe(content);
  });

  test("contains renderer failures and keeps Raw usable", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const ThrowingRenderer = (): React.ReactElement => {
      throw new Error("renderer failed");
    };
    const content = "# Exact source";

    try {
      render(<SourceViewer
        citation={CITATION}
        client={clientReturning(documentWith(content))}
        onClose={() => {}}
        returnFocus={null}
        MarkdownRenderer={ThrowingRenderer}
      />);

      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("rendered view failed"));
      const raw = screen.getByRole("button", { name: "Raw" });
      fireEvent.click(raw);
      expect(raw.getAttribute("aria-pressed")).toBe("true");
      expect(document.querySelector(".source-raw")?.textContent).toBe(content);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("normal documents still default to the rendered view", async () => {
    const Renderer = ({ content }: { readonly content: string }): React.ReactElement => <h1>{content}</h1>;

    render(<SourceViewer
      citation={CITATION}
      client={clientReturning(documentWith("Normal source"))}
      onClose={() => {}}
      returnFocus={null}
      MarkdownRenderer={Renderer}
    />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Normal source" })).toBeDefined());
    expect(screen.getByRole("button", { name: "Rendered" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
