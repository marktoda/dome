import type {
  AgentStreamChange,
  AgentStreamCitation,
  AgentStreamEvent,
} from "../../../contracts/agent-stream";
import type { TaskBacklogListOk } from "../../../src/surface/task-backlog";

export type Citation = AgentStreamCitation;

export type AgentChange = AgentStreamChange;

export type AgentSession = {
  schema: "dome.agent-session/v1";
  status: "created";
  sessionId: string;
};

export type PairingStatus = {
  schema: "dome.pairing/v1" | "dome.device.pairing/v1";
  available: boolean;
  paired: boolean;
};

export type PairingResult = {
  schema: "dome.pairing/v1" | "dome.device.pairing/v1";
  status: "paired";
  expires_at?: string;
  credentialExpiresAt?: string;
  csrfToken?: string;
};

export type StreamEvent = AgentStreamEvent;

export type AgentStreamOutcome =
  | { kind: "done" }
  | { kind: "cancelled"; source: "local-abort" | "server" }
  | { kind: "failed"; code: string; message: string; retryable: boolean; retryAfterSeconds?: number }
  | { kind: "session-missing" }
  | { kind: "session-expired" };

export type AgentStopOutcome =
  | { kind: "cancelled" | "idle" }
  | { kind: "failed"; code: string; message: string; retryable: boolean; retryAfterSeconds?: number }
  | { kind: "session-missing" }
  | { kind: "session-expired" };

export type { CaptureReceipt as CaptureResult } from "../../../contracts/capture";

export type TodayItem = {
  text: string;
  path: string;
  line: number | null;
  source?: "daily" | "backlog";
  /** Follow-up is a facet of this logical task, not a second task. */
  followup?: boolean;
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

export type TodayReview = {
  id: number;
  reason: string;
  processorId: string;
  paths: string[];
  reviewCommand: string;
};

export type Today = {
  schema: "dome.daily.today/v1";
  date: string;
  openTasks: TodayItem[];
  followups: TodayItem[];
  questions: TodayQuestion[];
  reviews?: TodayReview[];
  attentionBacklog?: number;
  brief: { text: string; sourceRef: { path: string } } | null;
  calendar:
    | {
        events: { time: string; title: string; meta: string }[];
        sourceRef: { path: string };
      }
    | null;
  hero: { kind: "task" | "question"; item: TodayItem | TodayQuestion } | null;
  counts: { openTasks: number; followups: number; questions: number; reviews?: number };
};

export type TaskBacklog = TaskBacklogListOk;

export type RecentEntry = {
  path: string;
  title: string;
  lastChangedAt: string;
  changedBy: "human" | "engine";
  subject: string;
  commit: string;
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
