#!/usr/bin/env bun

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

type SmokeOptions = {
  readonly keep: boolean;
  readonly model: string | null;
  readonly vaultPath: string | null;
};

type StatusPayload = {
  readonly sync_needed: boolean;
  readonly attention_required: boolean;
  readonly attention: ReadonlyArray<string>;
  readonly dirty_modified: number;
  readonly dirty_untracked: number;
  readonly diagnostics: number;
  readonly questions: number;
  readonly pending_runs: number;
  readonly failed_runs: number;
  readonly outbox_failed: number;
  readonly quarantined: number;
};

type QueryPayload = {
  readonly schema: string;
  readonly matches: ReadonlyArray<{
    readonly path?: string;
    readonly title?: string;
  }>;
};

type QuestionRow = {
  readonly id: number;
  readonly status: string;
  readonly metadata?: {
    readonly automationPolicy?: string;
    readonly risk?: string;
  };
};

const repoRoot = resolve(import.meta.dir, "..");
const domeBin = resolve(repoRoot, "bin", "dome");
const capturePath = "inbox/raw/v1-llm-smoke.md";
const captureBody = [
  "# V1 LLM smoke capture",
  "",
  "After the Nova kickoff, send Ada the calibration checklist.",
  "Decision: keep the beta rollout gated on support readiness.",
  "Follow up with Ben about the support staffing owner.",
  "The phrase `Nova kickoff` should stay searchable.",
  "",
].join("\n");

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  if ((Bun.env.ANTHROPIC_API_KEY ?? "").trim().length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is required; load it in the environment or .env",
    );
  }

  const vaultPath = opts.vaultPath ?? await tempVaultPath();
  let shouldCleanup = opts.vaultPath === null && !opts.keep;
  try {
    await runDome(["init", vaultPath, "--with-model-provider", "anthropic"]);
    await enableIntake(vaultPath);
    await writeFile(join(vaultPath, capturePath), captureBody);
    await git(vaultPath, ["add", ".dome/config.yaml", capturePath]);
    await git(vaultPath, ["commit", "-m", "v1 llm smoke capture"]);

    const syncHeads = await runUntilSettled(vaultPath, opts);
    const generated = await singleMarkdownPath(
      join(vaultPath, "wiki", "generated", "intake"),
      "generated intake page",
    );
    const archive = await singleMarkdownPath(
      join(vaultPath, "inbox", "processed"),
      "processed capture archive",
    );

    await assertCaptureOutputs({ vaultPath, generated, archive });
    await assertQuerySeesCapture(vaultPath, opts);
    const status = await statusJson(vaultPath, opts);
    assertSettledStatus(status);
    await assertQuestionsAreAgentSafe({ vaultPath, status, opts });

    console.log(
      [
        "v1-llm-smoke: ok",
        `vault ${vaultPath}`,
        `generated ${relativeToVault(vaultPath, generated)}`,
        `archive ${relativeToVault(vaultPath, archive)}`,
        `sync_heads ${syncHeads.join(" -> ")}`,
        `diagnostics ${status.diagnostics}`,
        `questions ${status.questions}`,
      ].join(" | "),
    );
  } catch (error) {
    shouldCleanup = false;
    throw error;
  } finally {
    if (shouldCleanup) {
      await rm(vaultPath, { recursive: true, force: true });
    } else {
      console.log(`v1-llm-smoke: kept vault at ${vaultPath}`);
    }
  }
}

async function tempVaultPath(): Promise<string> {
  const parent = join(tmpdir(), `dome-v1-llm-smoke-${Date.now()}`);
  return resolve(parent);
}

async function enableIntake(vaultPath: string): Promise<void> {
  const configPath = join(vaultPath, ".dome", "config.yaml");
  const parsed = parseYaml(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const extensions = ensureRecord(parsed, "extensions");
  const intake = ensureRecord(extensions, "dome.intake");
  intake.enabled = true;
  await writeFile(configPath, stringifyYaml(parsed));
}

function ensureRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  record[key] = next;
  return next;
}

async function runUntilSettled(
  vaultPath: string,
  opts: SmokeOptions,
): Promise<ReadonlyArray<string>> {
  const heads: string[] = [];
  let previousHead = await gitStdout(vaultPath, ["rev-parse", "--short", "HEAD"]);
  for (let i = 0; i < 5; i += 1) {
    await runDome(["sync", "--vault", vaultPath, "--json"], opts);
    const nextHead = await gitStdout(vaultPath, [
      "rev-parse",
      "--short",
      "HEAD",
    ]);
    heads.push(nextHead);
    const status = await statusJson(vaultPath, opts);
    if (nextHead === previousHead && !status.sync_needed) {
      return Object.freeze(heads);
    }
    previousHead = nextHead;
  }
  throw new Error("Dome did not settle after 5 sync passes");
}

async function singleMarkdownPath(
  dir: string,
  label: string,
): Promise<string> {
  if (!existsSync(dir)) {
    throw new Error(`expected ${label} directory at ${dir}`);
  }
  const entries = (await readdir(dir))
    .filter((entry) => entry.endsWith(".md"))
    .sort();
  if (entries.length !== 1) {
    throw new Error(`expected exactly one ${label}, found ${entries.length}`);
  }
  return join(dir, entries[0] as string);
}

async function assertCaptureOutputs(input: {
  readonly vaultPath: string;
  readonly generated: string;
  readonly archive: string;
}): Promise<void> {
  const generated = await readFile(input.generated, "utf8");
  const archive = await readFile(input.archive, "utf8");
  assertIncludes(generated, "type: capture", "generated capture type");
  assertIncludes(generated, "disposition: digested", "generated disposition");
  assertIncludes(generated, "processed_from: inbox/raw/v1-llm-smoke.md", "source path");
  assertIncludes(generated, "source_hash:", "source hash");
  assertIncludes(generated, "Nova kickoff", "searchable source phrase");
  assertIncludes(archive, "disposition: archived", "archive disposition");
  assertIncludes(archive, "After the Nova kickoff", "archived raw content");
  if (existsSync(join(input.vaultPath, capturePath))) {
    throw new Error("raw capture remained in inbox/raw after digestion");
  }
}

async function assertQuerySeesCapture(
  vaultPath: string,
  opts: SmokeOptions,
): Promise<void> {
  const query = await runDomeJson<QueryPayload>(
    ["query", "--vault", vaultPath, "Nova kickoff", "--json"],
    opts,
  );
  if (query.schema !== "dome.search.query/v1") {
    throw new Error(`unexpected query schema ${query.schema}`);
  }
  const hasGeneratedCapture = query.matches.some((match) =>
    (match.path ?? "").startsWith("wiki/generated/intake/")
  );
  if (!hasGeneratedCapture) {
    throw new Error("query did not return the generated intake page");
  }
}

function assertSettledStatus(status: StatusPayload): void {
  if (status.sync_needed) throw new Error("status still reports sync_needed");
  const unexpectedAttention = status.attention.filter((reason) =>
    reason !== "questions"
  );
  if (unexpectedAttention.length > 0) {
    throw new Error(
      `status requires unexpected attention: ${unexpectedAttention.join(", ")}`,
    );
  }
  const failures = [
    ["dirty_modified", status.dirty_modified],
    ["dirty_untracked", status.dirty_untracked],
    ["diagnostics", status.diagnostics],
    ["pending_runs", status.pending_runs],
    ["failed_runs", status.failed_runs],
    ["outbox_failed", status.outbox_failed],
    ["quarantined", status.quarantined],
  ].filter(([, value]) => value !== 0);
  if (failures.length > 0) {
    throw new Error(
      `status not settled: ${
        failures.map(([name, value]) => `${name}=${value}`).join(", ")
      }`,
    );
  }
}

async function assertQuestionsAreAgentSafe(input: {
  readonly vaultPath: string;
  readonly status: StatusPayload;
  readonly opts: SmokeOptions;
}): Promise<void> {
  if (input.status.questions === 0) return;
  const questions = await runDomeJson<ReadonlyArray<QuestionRow>>(
    ["inspect", "questions", "--vault", input.vaultPath, "--json"],
    input.opts,
  );
  const openQuestions = questions.filter((question) =>
    question.status === "open"
  );
  if (openQuestions.length !== input.status.questions) {
    throw new Error(
      `status reports ${input.status.questions} question(s), ` +
        `inspect returned ${openQuestions.length} open question(s)`,
    );
  }
  const unsafe = openQuestions.filter((question) =>
    question.metadata?.automationPolicy !== "agent-safe" ||
    question.metadata.risk !== "low"
  );
  if (unsafe.length > 0) {
    throw new Error(
      `expected only low-risk agent-safe questions, found ids ${
        unsafe.map((question) => question.id).join(", ")
      }`,
    );
  }
}

function assertIncludes(
  haystack: string,
  needle: string,
  label: string,
): void {
  if (!haystack.includes(needle)) {
    throw new Error(`missing ${label}: ${needle}`);
  }
}

async function statusJson(
  vaultPath: string,
  opts: SmokeOptions,
): Promise<StatusPayload> {
  return await runDomeJson<StatusPayload>(
    ["status", "--vault", vaultPath, "--json"],
    opts,
  );
}

async function runDomeJson<T>(
  args: ReadonlyArray<string>,
  opts: SmokeOptions,
): Promise<T> {
  const result = await runDome(args, opts);
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `bin/dome ${args.join(" ")} returned non-JSON stdout: ${message}`,
    );
  }
}

async function runDome(
  args: ReadonlyArray<string>,
  opts: SmokeOptions = { keep: false, model: null, vaultPath: null },
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await runCommand({
    cmd: [domeBin, ...args],
    cwd: repoRoot,
    env: modelEnv(opts),
  });
}

async function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<void> {
  await runCommand({ cmd: gitCommand(args), cwd });
}

async function gitStdout(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<string> {
  const result = await runCommand({ cmd: gitCommand(args), cwd });
  return result.stdout.trim();
}

function gitCommand(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return Object.freeze([
    "git",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    ...args,
  ]);
}

async function runCommand(input: {
  readonly cmd: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn({
    cmd: [...input.cmd],
    cwd: input.cwd,
    env: input.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${input.cmd.join(" ")} exited ${exitCode}${formatStderr(stderr)}`,
    );
  }
  return Object.freeze({ stdout, stderr });
}

function modelEnv(
  opts: SmokeOptions,
): Record<string, string | undefined> {
  return {
    ...Bun.env,
    ...(opts.model === null ? {} : { ANTHROPIC_MODEL: opts.model }),
    ANTHROPIC_MAX_TOKENS: Bun.env.ANTHROPIC_MAX_TOKENS ?? "2048",
  };
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "" : `: ${trimmed}`;
}

function relativeToVault(vaultPath: string, path: string): string {
  return path.slice(resolve(vaultPath).length + 1);
}

function parseArgs(args: ReadonlyArray<string>): SmokeOptions {
  let keep = false;
  let model: string | null = null;
  let vaultPath: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    if (arg === "--model") {
      model = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--vault") {
      vaultPath = resolve(readValue(args, i, arg));
      keep = true;
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return Object.freeze({ keep, model, vaultPath });
}

function readValue(
  args: ReadonlyArray<string>,
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun scripts/v1-llm-smoke.ts [options]",
      "",
      "Runs an optional networked V1 capture-digestion smoke against a",
      "temporary vault using `dome init --with-model-provider anthropic`.",
      "",
      "Options:",
      "  --model <id>       Override ANTHROPIC_MODEL for the scaffolded provider.",
      "  --vault <path>     Use an existing/new vault path and keep it afterward.",
      "  --keep             Keep the temporary vault after the smoke.",
    ].join("\n"),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`v1-llm-smoke: ${message}`);
  process.exit(1);
});
