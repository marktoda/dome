// daily-shared.ts — compatibility barrel for the dome.daily helper modules.
// New code should import from the specific module; existing importers and
// the cross-bundle consumers (dome.search, dome.agent) resolve through here
// unchanged. No logic lives in this file.
export {
  EDITION_YESTERDAY_BLOCK,
  CARRIED_FORWARD_START,
  CARRIED_FORWARD_END,
  START_CONTEXT_START,
  START_CONTEXT_END,
  OPEN_LOOPS_START,
  OPEN_LOOPS_END,
  CAPTURED_START,
  CAPTURED_END,
  CAPTURED_HEADING,
  CLOSE_START,
  CLOSE_END,
  DAILY_GENERATED_BLOCKS,
} from "./daily-types";
export type {
  DailyDate,
  DailyPathSettings,
  OpenTask,
  MarkdownActionItem,
  AmbiguousFollowup,
  DailyOpenLoopSource,
  DailyOpenLoopCandidate,
  DailySettledOpenLoopSource,
  PreviousDailyDigest,
  DailyCloseDigest,
  DailyCloseDoneCandidate,
  SettledActionItem,
  DailyOpenLoopSettlementStatus,
} from "./daily-types";
export {
  localDateParts,
  previousLocalDate,
  dailyPathSettings,
  dailyPath,
  dailyLink,
  parseDailyPath,
  formatDate,
  isValidDailyDate,
} from "./daily-paths";
export {
  openTasksFromMarkdown,
  actionItemsFromMarkdown,
  isObsidianTasksDashboard,
  stampTaskAnchors,
  normalizeTaskSyntax,
  taskAnchorId,
  ambiguousFollowupsFromMarkdown,
  settledActionItemsFromMarkdown,
} from "./action-extraction";
export {
  openLoopSurfaceSources,
  openLoopSurfaceSection,
  settledSourceBackedOpenLoopsFromMarkdown,
  openSourceBackedOpenLoopsFromMarkdown,
  reconcileSettledOpenLoops,
  completedSourceBackedOpenLoopsFromMarkdown,
  openLoopIdentity,
  openLoopSurfaceKey,
  taskStableId,
  openLoopStableId,
  rankDailyOpenLoopSurfaceItems,
  openLoopFreshnessKey,
  replaceOpenLoopSurfaceSection,
} from "./open-loop-surface";
export {
  renderDailySkeleton,
  carriedForwardSection,
  previousDailyDigest,
  yesterdayFallbackSection,
  ensureYesterdayFallbackSection,
  removeLegacyStartContextSection,
  closeScaffoldSection,
  ensureCloseScaffoldSection,
  closeDigestFromDailyContent,
  replaceCarriedForwardSection,
} from "./daily-scaffold";
export {
  CAPTURED_LINE_MAX_CHARS,
  CAPTURED_APPEND_MAX_LINES,
  isCapturedTaskLine,
  appendCapturedTaskLines,
  isValidCapturedTasksWrite,
  repairCapturedTodayHeadings,
} from "./captured-block";
