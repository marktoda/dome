import { useEffect, useRef, useState } from "react";
import type { DomeClient } from "../api/client";
import type { Citation } from "../api/types";
import type { SourceDocumentResult } from "../../../contracts/source-document";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly result: SourceDocumentResult }
  | { readonly kind: "error"; readonly message: string };

export function SourceViewer({
  citation,
  client,
  onClose,
  returnFocus,
}: {
  readonly citation: Citation;
  readonly client: DomeClient;
  readonly onClose: () => void;
  readonly returnFocus: HTMLElement | null;
}): React.ReactElement {
  const [state, setState] = useState<State>({ kind: "loading" });
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const shortCommit = citation.commit?.slice(0, 8) ?? "revision unavailable";

  useEffect(() => {
    const controller = new AbortController();
    client.source(citation, controller.signal).then(
      (result) => setState({ kind: "loaded", result }),
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

  useEffect(() => {
    closeRef.current?.focus();
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ) ?? [])];
        if (focusable.length === 0) {
          event.preventDefault();
          dialogRef.current?.focus();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (
          focusable.length === 1 ||
          (!event.shiftKey && document.activeElement === last) ||
          (event.shiftKey && document.activeElement === first)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      returnFocus?.focus();
    };
  }, [onClose, returnFocus]);

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
            <p id="source-revision">Revision {shortCommit}</p>
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
        <div className="source-body">
          {state.kind === "loading" ? <p className="source-state">Loading source…</p> : null}
          {state.kind === "error" ? <p className="source-state source-error">{state.message}</p> : null}
          {state.kind === "loaded" && state.result.status !== "ok"
            ? <p className="source-state source-error">{state.result.message}</p>
            : null}
          {state.kind === "loaded" && state.result.status === "ok"
            ? <pre>{state.result.content}</pre>
            : null}
        </div>
      </section>
    </div>
  );
}
