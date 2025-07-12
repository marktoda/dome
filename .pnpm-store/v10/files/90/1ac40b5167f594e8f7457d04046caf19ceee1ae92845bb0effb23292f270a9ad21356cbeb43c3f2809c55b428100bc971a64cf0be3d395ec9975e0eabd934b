'use strict';

var chunkST5RMVLG_cjs = require('./chunk-ST5RMVLG.cjs');
var chunkB6TOBUS6_cjs = require('./chunk-B6TOBUS6.cjs');

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
    throw new chunkB6TOBUS6_cjs.MastraError(
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
    chunkST5RMVLG_cjs.executeHook("onEvaluation" /* ON_EVALUATION */, traceObject);
  } catch (e) {
    throw new chunkB6TOBUS6_cjs.MastraError(
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

exports.Metric = Metric;
exports.evaluate = evaluate;
