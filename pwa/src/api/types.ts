export type Citation = {
  path: string;
  commit?: string;
  snippet?: string;
};

export type AgentChange = {
  path: string;
  kind: "create" | "edit";
};

export type AgentResult = {
  schema: "dome.ask/v1";
  status: "ok";
  answer: string;
  citations: Citation[];
  steps: number;
  stopReason: "final" | "budget";
  changes?: AgentChange[];
};

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; citations: Citation[]; stopReason: "final" | "budget"; changes?: AgentChange[] }
  | { type: "error"; message: string };

export type CaptureResult = {
  schema: "dome.capture/v1";
  status: "captured" | "duplicate" | "error";
  path?: string;
  commit?: string;
  title?: string;
  error?: string;
};

export type TodayItem = {
  text: string;
  path: string;
  line: number | null;
  dueDate: string | null;
  origin?: string;
  entities?: string[];
  priority?: "highest" | "high" | "medium" | "low" | "lowest" | null;
  /** Stamped ^block-anchor id (dome.daily.today/v1's optional widening) —
   * present only when the task line is settle-able; absent tasks stay
   * decorative-only (never a synthesized id). */
  blockId?: string;
};

export type TodayQuestion = {
  id: number;
  question: string;
  resolveCommand: string;
  options: string[];
};

export type Today = {
  schema: "dome.daily.today/v1";
  date: string;
  openTasks: TodayItem[];
  followups: TodayItem[];
  questions: TodayQuestion[];
  brief: { text: string; sourceRef: { path: string } } | null;
  calendar:
    | {
        events: { time: string; title: string; meta: string }[];
        sourceRef: { path: string };
      }
    | null;
  hero: { kind: "task" | "question"; item: TodayItem | TodayQuestion } | null;
  counts: { openTasks: number; followups: number; questions: number };
};

export type RecentEntry = {
  path: string;
  title: string;
  lastChangedAt: string;
  changedBy: "human" | "engine";
  subject: string;
};

export type Recents = {
  schema: "dome.recents/v1";
  count: number;
  entries: RecentEntry[];
};

export type ResolveResult = {
  schema: "dome.answer/v1";
  status: "answered" | "already-answered" | "invalid-option" | "error";
  options?: string[];
  question?: { id: number; status: string; question: string; answer: string | null };
  message?: string;
};

export type SettleDisposition = "close" | "defer" | "keep";

// Wire shape of POST /settle's response (dome.settle/v1). `block_id` is
// snake_case on the wire — src/surface/settle.ts's settleResultJson mirrors
// the same shape shared by the CLI/MCP/HTTP settle adapters; the PWA client
// does not re-key it.
export type SettleResult = {
  schema: "dome.settle/v1";
  status: "settled" | "not-found" | "invalid";
  block_id?: string;
  disposition?: SettleDisposition;
  commit?: string | null;
  message?: string;
};

export type Transcript = {
  schema: "dome.transcribe/v1";
  text: string;
};

export type ApiError = {
  status: "error";
  error: string;
  message?: string;
};
