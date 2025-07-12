import { executeHook } from './chunk-BB4KXGBU.js';
import { MastraError } from './chunk-6UNGH46J.js';

// src/eval/metric.ts
var Metric = class {
};

// src/eval/evaluation.ts
async function evaluate({
  agentName,
  input,
  metric,
  output,
  runId,
  globalRunId,
  testInfo,
  instructions
}) {
  const runIdToUse = runId || crypto.randomUUID();
  let metricResult;
  let metricName = metric.constructor.name;
  try {
    metricResult = await metric.measure(input.toString(), output);
  } catch (e) {
    throw new MastraError(
      {
        id: "EVAL_METRIC_MEASURE_EXECUTION_FAILED",
        domain: "EVAL" /* EVAL */,
        category: "USER" /* USER */,
        details: {
          agentName,
          metricName,
          globalRunId
        }
      },
      e
    );
  }
  const traceObject = {
    input: input.toString(),
    output,
    result: metricResult,
    agentName,
    metricName,
    instructions,
    globalRunId,
    runId: runIdToUse,
    testInfo
  };
  try {
    executeHook("onEvaluation" /* ON_EVALUATION */, traceObject);
  } catch (e) {
    throw new MastraError(
      {
        id: "EVAL_HOOK_EXECUTION_FAILED",
        domain: "EVAL" /* EVAL */,
        category: "USER" /* USER */,
        details: {
          agentName,
          metricName,
          globalRunId
        }
      },
      e
    );
  }
  return { ...metricResult, output };
}

export { Metric, evaluate };
