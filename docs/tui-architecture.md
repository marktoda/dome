---

# **Design Document – Dome Chat TUI (TypeScript Edition)**

| **Doc rev** | **Date**     | **Author** |
| ----------- | ------------ | ---------- |
|  v1.0 draft |  14 Jul 2025 |  —         |

---

## 1. Purpose & Scope

This document describes the architecture, major modules, third‑party libraries, and coding conventions for **Dome Chat TUI**—a terminal application that lets a user converse with an AI assistant while creating, searching, and managing Markdown notes in a local vault. It is written in **TypeScript (Node ≥ 20)** and targets macOS/Linux/Windows terminals with true‑color support.

---

## 2. High‑level Requirements recap

| Area        | Requirement                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat UX     | • Token‑streaming with blinking cyan cursor ▊ • Rich Markdown rendering • Color‑coded msg tags • Collapsing/expanding long messages • Optional relative/absolute timestamps |
| Layout      | Sticky header, scrollable chat, left help panel, right activity monitor, bottom status bar                                                                                  |
| Commands    | All `/`‑prefixed (plus `:timestamps`); Ctrl shortcuts                                                                                                                       |
| Activity    | Real‑time log of tool calls & doc fetches, capped at 100 lines                                                                                                              |
| Performance | Background vault indexing, keep last 50 visible msgs, resize‑safe                                                                                                           |
| Note ops    | Semantic search, list/browse, create/append, delete, organize YAML                                                                                                          |

---

## 3. Technology & Library Choices

| Concern         | Selected Library                                                               | Rationale                                              |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| TUI rendering   | **[`ink`](https://github.com/vadimdemedes/ink)** (React for CLIs)              | Declarative, hooks, flex‑box layout, <Static> for perf |
| Markdown → ANSI | `ink-markdown` (or fallback to `marked` + `marked-terminal`)                   | Handles headings, code blocks, lists, etc.             |
| Colors & styles | `chalk` v5                                                                     | Fine‑grained ANSI styling, 16M‑color                   |
| Key handling    | `ink` `useInput()`                                                             | Native inside Ink app                                  |
| State mgmt      | React Context + `useReducer`                                                   | Lightweight, serialisable                              |
| FS & glob       | `fs/promises`, `fast-glob`                                                     | Vault traversal                                        |
| Background work | Node `worker_threads`                                                          | Non‑blocking indexing, semantic scoring                |
| Embeddings      | Pluggable provider (OpenAI, local ONNX, etc.) via `@dome/embeddings` interface | Keeps core decoupled                                   |
| Streaming AI    | Fetch EventStream (OpenAI Chat, Anthropic, etc.) via `@dome/llm-client`        | Unified wrapper supports SSE & chunked                 |
| Configuration   | `conf` or dotfile in `~/.config/dome`                                          | Persist user prefs (timestamps mode, last vault path…) |
| Testing         | `vitest` + `ink-testing-library`                                               | Unit & interaction tests                               |
| Build           | `tsx` for dev, `esbuild` single‑file bundle for release                        | Fast & no transpile overhead                           |

---

## 4. Directory Structure

```
dome-chat-tui/
 ├─ src/
 │  ├─ cli.ts            // entry – parses flags, sets vault path
 │  ├─ app.tsx           // <App/> root rendered by ink
 │  ├─ components/
 │  │    ├─ Header.tsx
 │  │    ├─ ChatArea.tsx
 │  │    ├─ Message.tsx
 │  │    ├─ HelpPanel.tsx
 │  │    ├─ ActivityMonitor.tsx
 │  │    ├─ StatusBar.tsx
 │  │    └─ InputBar.tsx
 │  ├─ hooks/
 │  │    ├─ useStream.ts           // char‑by‑char streaming
 │  │    └─ useVaultIndexer.ts     // subscribe to worker progress
 │  ├─ state/
 │  │    ├─ chatReducer.ts
 │  │    ├─ activityReducer.ts
 │  │    └─ types.ts
 │  ├─ commands/
 │  │    ├─ index.ts               // registry + dispatcher
 │  │    └─ handlers/*.ts          // /help, /list, ...
 │  ├─ services/
 │  │    ├─ LlmClient.ts
 │  │    ├─ Vault.ts               // note CRUD
 │  │    ├─ IndexWorker.ts         // worker thread helper
 │  │    └─ Search.ts              // semantic + keyword
 │  ├─ utils/
 │  │    ├─ markdown.ts
 │  │    ├─ ansi.ts
 │  │    └─ formatDate.ts
 │  └─ constants.ts
 ├─ worker/
 │  └─ indexer.ts                  // executed in worker thread
 ├─ test/
 ├─ tsconfig.json
 └─ package.json
```

---

## 5. Component & Data‑flow Details

### 5.1 State shape (simplified)

```ts
interface RootState {
  cfg: { timestamps: 'off' | 'relative' | 'absolute'; verbose: boolean };
  header: { vaultPath: string; noteCount: number };
  chat: {
    messages: ChatMessage[]; // kept ≤ 50
    selectedIdx: number | null;
    streaming: boolean;
  };
  activity: ActivityEvent[]; // kept ≤ 100
  index: { progress: number; running: boolean };
}
```

### 5.2 Message Streaming (`useStream`)

1. `LlmClient.stream(prompt)` returns **AsyncIterable<string>** chunks.
2. Inside `useStream`, characters are en‑queued into state at 30‑60 fps using `setTimeout` to achieve smooth flow; last char replaced with cyan ▊ every 500 ms for blink.
3. On `stream.done`, cursor removed and final message length saved for collapsible logic.

### 5.3 ChatArea virtualisation

- Renders only the last N visible msgs (defaults 15) based on terminal height.
- Up/Down arrows move `selectedIdx`; `s` toggles `collapsed` flag on message object.
- Collapsed messages show `▶` / `▼` indicator and char count.

### 5.4 Layout composition

```
<Box flexDirection="column" height={...}>
  <Header />
  <Box flexGrow={1}>
    <HelpPanel />       // width: 25%, hidden via context
    <ChatArea flexGrow={1} />
    <ActivityMonitor /> // width: 25%, hide w/ Ctrl+A
  </Box>
  <StatusBar />
  <InputBar />          // TextInput always focussed
</Box>
```

`ink` flex‑box keeps header and status bars sticky while center panel scrolls.

### 5.5 Keyboard shortcuts

Handled globally in `<App>` via `useInput`:

```ts
useInput((input, key) => {
  if (key.ctrl && input === 'c') exit();
  else if (key.ctrl && input === 'h') toggleHelp();
  else if (key.ctrl && input === 'a') toggleActivity();
  else if (key.upArrow) selectPrev();
  else if (key.downArrow) selectNext();
  else if (input === 's') toggleCollapse();
});
```

### 5.6 Command execution pipeline

```
User input >>> detect '/' prefix
            >>> commands/registry.dispatch(cmd, args, context)
            >>> handler mutates state OR returns promise
```

Errors thrown by handlers are caught in `dispatcher` and pushed into chat as `[Error]` messages.

### 5.7 Activity monitor updates

Service modules (`Vault`, `LlmClient`, `Search`) emit events via a lightweight `EventEmitter`. `ActivityMonitor` subscribes and rerenders a `<Static>` list to avoid reflow. Each event row:

- Cyan ▸ for tool calls
- Green ◆ for file accesses
- Grey timestamp (configurable relative)

List capped to 100 by pruning in reducer.

---

## 6. Background Indexing & Search

- **Worker thread** (`worker/indexer.ts`) walks the vault with `fast-glob`, computes embeddings (pluggable provider), builds approximate‑nearest‑neighbor index (e.g., HNSW via `@vdk/hnswlib-node`), and posts incremental progress.
- Main thread tracks progress in `index` slice; `StatusBar` shows animated progress bar.
- Semantic search: on query, embed prompt, knn search, merge with keyword matches, return top K note IDs.

Indexer persists serialized graph to `.dome/index.bin` for fast startup; re‑indexes when file mtime changes.

---

## 7. Error Handling & Resilience

| Class              | Mitigation                                                        |
| ------------------ | ----------------------------------------------------------------- |
| LLM/network errors | Retry w/ exponential backoff (max 2), then push `[Error]` msg     |
| Vault FS errors    | Log to activity monitor red ♦, keep CLI alive                    |
| Worker crash       | Auto‑restart once; bubble fatal to chat on repeated failure       |
| Terminal resize    | `ink` onResize event recalculates page size; scroll index clamped |

---

## 8. Performance & Memory Budget

- Message & activity arrays clipped (50/100).
- `React.memo` on `Message`, `ActivityRow`.
- Markdown rendering memoised per message ID.
- Worker offloads heavy embedding math.
- Stream write batching (16 ms) prevents flicker.

---

## 9. Testing Strategy

| Layer     | Tool                                           | Example                         |
| --------- | ---------------------------------------------- | ------------------------------- |
| Unit      | `vitest`                                       | utils, reducers                 |
| Component | `ink-testing-library`                          | Message collapse, input parsing |
| Worker    | spawn worker, feed mock vault                  |                                 |
| E2E       | `expect` + pty (`node-pty`) snapshot of stdout |                                 |

Continuous integration via GitHub Actions matrix (ubuntu, macOS, windows).

---

## 10. Build, Distribution, Ops

1. `pnpm build` → single `dist/cli.js` (ESM) via **esbuild**.
2. `npm pkg set bin.dome-chat="dist/cli.js"` for global install (`npm i -g`).
3. Releases packed with `pkg` (optional) for standalone binary.
4. Vault path determined by flag `--vault` or `$DOME_VAULT`; defaults to `./vault`.

---

## 11. Future Enhancements (non‑goals for v1)

- Multi‑vault switching during session
- Mouse‑based selection & scroll
- Inline code block syntax highlighting (via `shiki`)
- Live‑share TUI over SSH for pair note‑taking
- Hot‑reloading of config without restart

---

## 12. Appendix – Color Palette (24‑bit)

| Tag       | Color (RGB)       |
| --------- | ----------------- |
| \[You]    | #00d7d7 (cyan)    |
| \[Dome]   | #ff00ff (magenta) |
| \[System] | #5f87ff (blue)    |
| \[Error]  | #ff5f5f (red)     |
| Tool ▸    | same cyan         |
| Doc ◆     | #5fff87 (green)   |

---

With the above blueprint an engineer can `pnpm i` and start implementing modules independently while preserving a clean, maintainable architecture that meets the UX and performance goals of Dome Chat TUI.
