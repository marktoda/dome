export type Citation = {
  path: string;
  commit?: string;
  snippet?: string;
};

export type AskResult = {
  schema: "dome.ask/v1";
  status: "ok";
  answer: string;
  citations: Citation[];
  steps: number;
  stopReason: "final" | "budget";
};

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; citations: Citation[]; stopReason: "final" | "budget" }
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

export type Transcript = {
  schema: "dome.transcribe/v1";
  text: string;
};

export type ApiError = {
  status: "error";
  error: string;
  message?: string;
};
