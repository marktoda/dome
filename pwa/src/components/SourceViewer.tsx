import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { DomeClient } from "../api/client";
import type { Citation } from "../api/types";
import type { SourceDocumentResult } from "../../../contracts/source-document";
import { useModalFocus } from "../accessibility/modalFocus";

const VaultMarkdown = lazy(async () => {
  const module = await import("./VaultMarkdown");
  return { default: module.VaultMarkdown };
});

export const MARKDOWN_RENDER_BUDGET_BYTES = 128 * 1024;

type MarkdownRenderer = ComponentType<{ readonly content: string }>;

type MarkdownRenderBoundaryProps = {
  readonly children: ReactNode;
};

class MarkdownRenderBoundary extends Component<MarkdownRenderBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="source-state source-error" role="alert">
          The rendered view failed. Switch to Raw to read the exact source.
        </p>
      );
    }
    return this.props.children;
  }
}

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly result: SourceDocumentResult }
  | { readonly kind: "error"; readonly message: string };

export function SourceViewer({
  citation,
  client,
  onClose,
  returnFocus,
  editedLabel,
  MarkdownRenderer = VaultMarkdown,
}: {
  readonly citation: Citation;
  readonly client: DomeClient;
  readonly onClose: () => void;
  readonly returnFocus: HTMLElement | null;
  /** Optional "edited 2d ago" provenance — only when the opener knows it
   * (Activity carries a timestamp; a chat citation does not). */
  readonly editedLabel?: string;
  /** A narrow renderer seam used by failure-containment tests. */
  readonly MarkdownRenderer?: MarkdownRenderer;
}): React.ReactElement {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const shortCommit = citation.commit?.slice(0, 8) ?? "revision unavailable";

  useModalFocus({
    active: true,
    focusKey: "source",
    containerRef: dialogRef,
    initialFocus: () => closeRef.current,
    onEscape: onClose,
    restoreFocus: () => returnFocus,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    setView("rendered");
    client.source(citation, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.status === "ok" && exceedsMarkdownRenderBudget(result.content)) setView("raw");
        setState({ kind: "loaded", result });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "The source could not be loaded.",
          });
        }
      },
    );
    return () => controller.abort();
  }, [citation, client]);

  const overRenderBudget = state.kind === "loaded" && state.result.status === "ok" &&
    exceedsMarkdownRenderBudget(state.result.content);

  return (
    <div className="source-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className="source-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="source-title"
        aria-describedby="source-revision"
      >
        <header className="source-head">
          <div>
            <h2 id="source-title">{citation.path}</h2>
            <p id="source-revision">rev {shortCommit}{editedLabel !== undefined ? ` · ${editedLabel}` : ""}</p>
          </div>
          <button ref={closeRef} type="button" className="source-close" onClick={onClose} aria-label="Close source">×</button>
        </header>
        <p className="source-a11y-status" aria-live="polite">
          {state.kind === "loading"
            ? "Loading source"
            : state.kind === "error" || state.result.status !== "ok"
              ? "Source failed to load"
              : "Source loaded"}
        </p>
        {state.kind === "loaded" && state.result.status === "ok"
          ? <>
              <div className="source-view-toggle" role="group" aria-label="Source display">
                <button
                  type="button"
                  aria-pressed={view === "rendered"}
                  disabled={overRenderBudget}
                  onClick={() => setView("rendered")}
                >Rendered</button>
                <button type="button" aria-pressed={view === "raw"} onClick={() => setView("raw")}>Raw</button>
              </div>
              {overRenderBudget
                ? <p className="source-render-notice" role="status">
                    This source is too large to render safely, so it opened in Raw. The exact content is unchanged.
                  </p>
                : null}
            </>
          : null}
        <div className="source-body">
          {state.kind === "loading" ? <p className="source-state">Loading source…</p> : null}
          {state.kind === "error" ? <p className="source-state source-error">{state.message}</p> : null}
          {state.kind === "loaded" && state.result.status !== "ok"
            ? <p className="source-state source-error">{state.result.message}</p>
            : null}
          {state.kind === "loaded" && state.result.status === "ok"
            ? view === "rendered"
              ? <MarkdownRenderBoundary key={`${state.result.path}\u0000${state.result.commit}`}>
                  <Suspense fallback={<p className="source-state">Rendering source…</p>}>
                    <MarkdownRenderer content={state.result.content} />
                  </Suspense>
                </MarkdownRenderBoundary>
              : <pre className="source-raw">{state.result.content}</pre>
            : null}
        </div>
      </section>
    </div>
  );
}

function exceedsMarkdownRenderBudget(content: string): boolean {
  return new TextEncoder().encode(content).byteLength > MARKDOWN_RENDER_BUDGET_BYTES;
}
