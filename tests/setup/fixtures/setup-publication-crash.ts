import { readFile } from "node:fs/promises";

import {
  createSetupPlanApplier,
  type SetupPublicationTransition,
} from "../../../src/setup/apply";
import type { SetupCompilerInput, SetupScaffoldEvidence } from "../../../src/setup/compiler";
import type { SetupConsent, SetupPlan } from "../../../src/setup/contracts";
import { inspectSetupVaultSource } from "../../../src/setup/vault-inspector";

type Payload = Readonly<{
  plan: SetupPlan;
  consent: SetupConsent;
  scaffold: SetupScaffoldEvidence;
  compilerInput: SetupCompilerInput;
}>;

const payloadPath = process.argv[2];
const crashTransition = process.argv[3] as SetupPublicationTransition | undefined;
if (payloadPath === undefined || crashTransition === undefined) process.exit(64);

const payload = JSON.parse(await readFile(payloadPath, "utf8")) as Payload;
const { plan, consent, scaffold, compilerInput } = payload;
await createSetupPlanApplier({
  discovery: {
    contentScope: plan.assessment.markdown.proposedScope,
    scaffold,
  },
  discover: async (target) => ({
    ...compilerInput,
    source: await inspectSetupVaultSource(target),
  }),
  afterPublicationTransition: async (transition) => {
    if (transition === crashTransition) process.exit(86);
  },
})(plan, consent);

process.exit(0);
