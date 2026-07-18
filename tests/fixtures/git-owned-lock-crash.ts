import { readFile } from "node:fs/promises";

import {
  commitFilesOnHead,
  commitInitialFiles,
  resolveRef,
} from "../../src/git";

type CrashStage = "candidate" | "index" | "head" | "ref" | "after-ref" | "active-index";
type Payload = Readonly<{
  path: string;
  token: string;
  stage: CrashStage;
  rootCommit?: boolean;
}>;

const payloadPath = process.argv[2];
if (payloadPath === undefined) process.exit(64);
const payload = JSON.parse(await readFile(payloadPath, "utf8")) as Payload;

const crash = async (): Promise<never> => {
  if (payload.stage === "active-index") await new Promise<never>(() => {});
  process.exit(86);
};
const hooks = {
  lockOwnerToken: payload.token,
  afterLockCandidateDurable: async (role: string) => {
    if (payload.stage === "candidate" && role === "index") await crash();
  },
  afterIndexLock: async () => {
    if (payload.stage === "index" || payload.stage === "active-index") await crash();
  },
  afterHeadLock: async () => { if (payload.stage === "head") await crash(); },
  afterRefLock: async () => { if (payload.stage === "ref") await crash(); },
  afterRefAdvance: async () => { if (payload.stage === "after-ref") await crash(); },
};

if (payload.rootCommit === true) {
  await commitInitialFiles({
    path: payload.path,
    files: [{ filepath: "Dome.md", content: Buffer.from("dome\n"), mode: "100644" }],
    message: "Dome root crash fixture",
    expectedBranch: "main",
    ...hooks,
  });
} else {
  const head = await resolveRef({ path: payload.path, ref: "HEAD" });
  await commitFilesOnHead({
    path: payload.path,
    files: [{ filepath: "Dome.md", content: "dome\n" }],
    message: "Dome crash fixture",
    expectedHead: head,
    retryOnCas: false,
    ...hooks,
  });
}

process.exit(0);
