'use strict';

var chunkLI436ITD_cjs = require('./chunk-LI436ITD.cjs');
var chunkPZQDCRPV_cjs = require('./chunk-PZQDCRPV.cjs');
var chunk2KZFMI6P_cjs = require('./chunk-2KZFMI6P.cjs');
var chunk75ZPJI57_cjs = require('./chunk-75ZPJI57.cjs');
var web = require('stream/web');

// src/server/handlers/legacyWorkflows.ts
var legacyWorkflows_exports = {};
chunk75ZPJI57_cjs.__export(legacyWorkflows_exports, {
  createLegacyWorkflowRunHandler: () => createLegacyWorkflowRunHandler,
  getLegacyWorkflowByIdHandler: () => getLegacyWorkflowByIdHandler,
  getLegacyWorkflowRunHandler: () => getLegacyWorkflowRunHandler,
  getLegacyWorkflowRunsHandler: () => getLegacyWorkflowRunsHandler,
  getLegacyWorkflowsHandler: () => getLegacyWorkflowsHandler,
  resumeAsyncLegacyWorkflowHandler: () => resumeAsyncLegacyWorkflowHandler,
  resumeLegacyWorkflowHandler: () => resumeLegacyWorkflowHandler,
  startAsyncLegacyWorkflowHandler: () => startAsyncLegacyWorkflowHandler,
  startLegacyWorkflowRunHandler: () => startLegacyWorkflowRunHandler,
  watchLegacyWorkflowHandler: () => watchLegacyWorkflowHandler
});
async function getLegacyWorkflowsHandler({ mastra }) {
  try {
    const workflows = mastra.legacy_getWorkflows({ serialized: false });
    const _workflows = Object.entries(workflows).reduce((acc, [key, workflow]) => {
      if (workflow.isNested) return acc;
      acc[key] = {
        stepGraph: workflow.stepGraph,
        stepSubscriberGraph: workflow.stepSubscriberGraph,
        serializedStepGraph: workflow.serializedStepGraph,
        serializedStepSubscriberGraph: workflow.serializedStepSubscriberGraph,
        name: workflow.name,
        triggerSchema: workflow.triggerSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(workflow.triggerSchema)) : void 0,
        steps: Object.entries(workflow.steps).reduce((acc2, [key2, step]) => {
          const _step = step;
          acc2[key2] = {
            id: _step.id,
            description: _step.description,
            workflowId: _step.workflowId,
            inputSchema: _step.inputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(_step.inputSchema)) : void 0,
            outputSchema: _step.outputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(_step.outputSchema)) : void 0
          };
          return acc2;
        }, {})
      };
      return acc;
    }, {});
    return _workflows;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "error getting workflows");
  }
}
async function getLegacyWorkflowByIdHandler({ mastra, workflowId }) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow not found" });
    }
    return {
      stepGraph: workflow.stepGraph,
      stepSubscriberGraph: workflow.stepSubscriberGraph,
      serializedStepGraph: workflow.serializedStepGraph,
      serializedStepSubscriberGraph: workflow.serializedStepSubscriberGraph,
      name: workflow.name,
      triggerSchema: workflow.triggerSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(workflow.triggerSchema)) : void 0,
      steps: Object.entries(workflow.steps).reduce((acc, [key, step]) => {
        const _step = step;
        acc[key] = {
          id: _step.id,
          description: _step.description,
          workflowId: _step.workflowId,
          inputSchema: _step.inputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(_step.inputSchema)) : void 0,
          outputSchema: _step.outputSchema ? chunkLI436ITD_cjs.stringify(chunkLI436ITD_cjs.esm_default(_step.outputSchema)) : void 0
        };
        return acc;
      }, {})
    };
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "error getting workflow by id");
  }
}
async function startAsyncLegacyWorkflowHandler({
  mastra,
  runtimeContext,
  workflowId,
  runId,
  triggerData
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow not found" });
    }
    if (!runId) {
      const newRun = workflow.createRun();
      const result2 = await newRun.start({
        triggerData,
        runtimeContext
      });
      return result2;
    }
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow run not found" });
    }
    const result = await run.start({
      triggerData,
      runtimeContext
    });
    return result;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "error starting workflow");
  }
}
async function getLegacyWorkflowRunHandler({
  mastra,
  workflowId,
  runId
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Run ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow not found" });
    }
    const run = await workflow.getRun(runId);
    if (!run) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow run not found" });
    }
    return run;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "error getting workflow run");
  }
}
async function createLegacyWorkflowRunHandler({
  mastra,
  workflowId,
  runId: prevRunId
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow not found" });
    }
    const newRun = workflow.createRun({ runId: prevRunId });
    return { runId: newRun.runId };
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "error creating workflow run");
  }
}
async function startLegacyWorkflowRunHandler({
  mastra,
  runtimeContext,
  workflowId,
  runId,
  triggerData
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "runId required to start run" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow run not found" });
    }
    void run.start({
      triggerData,
      runtimeContext
    });
    return { message: "Workflow run started" };
  } catch (e) {
    return chunkPZQDCRPV_cjs.handleError(e, "Error starting workflow run");
  }
}
async function watchLegacyWorkflowHandler({
  mastra,
  workflowId,
  runId
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "runId required to watch workflow" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow run not found" });
    }
    let unwatch;
    let asyncRef = null;
    const stream = new web.ReadableStream({
      start(controller) {
        unwatch = run.watch(({ activePaths, runId: runId2, timestamp, results }) => {
          const activePathsObj = Object.fromEntries(activePaths);
          controller.enqueue(JSON.stringify({ activePaths: activePathsObj, runId: runId2, timestamp, results }));
          if (asyncRef) {
            clearImmediate(asyncRef);
            asyncRef = null;
          }
          asyncRef = setImmediate(() => {
            const runDone = Object.values(activePathsObj).every((value) => value.status !== "executing");
            if (runDone) {
              controller.close();
              unwatch?.();
            }
          });
        });
      },
      cancel() {
        unwatch?.();
      }
    });
    return stream;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error watching workflow");
  }
}
async function resumeAsyncLegacyWorkflowHandler({
  mastra,
  workflowId,
  runId,
  body,
  runtimeContext
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "runId required to resume workflow" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow run not found" });
    }
    const result = await run.resume({
      stepId: body.stepId,
      context: body.context,
      runtimeContext
    });
    return result;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error resuming workflow step");
  }
}
async function resumeLegacyWorkflowHandler({
  mastra,
  workflowId,
  runId,
  body,
  runtimeContext
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "runId required to resume workflow" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new chunk2KZFMI6P_cjs.HTTPException(404, { message: "Workflow run not found" });
    }
    void run.resume({
      stepId: body.stepId,
      context: body.context,
      runtimeContext
    });
    return { message: "Workflow run resumed" };
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error resuming workflow");
  }
}
async function getLegacyWorkflowRunsHandler({
  mastra,
  workflowId,
  fromDate,
  toDate,
  limit,
  offset,
  resourceId
}) {
  try {
    if (!workflowId) {
      throw new chunk2KZFMI6P_cjs.HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const workflowRuns = await workflow.getWorkflowRuns({ fromDate, toDate, limit, offset, resourceId }) || {
      runs: [],
      total: 0
    };
    return workflowRuns;
  } catch (error) {
    return chunkPZQDCRPV_cjs.handleError(error, "Error getting workflow runs");
  }
}

exports.createLegacyWorkflowRunHandler = createLegacyWorkflowRunHandler;
exports.getLegacyWorkflowByIdHandler = getLegacyWorkflowByIdHandler;
exports.getLegacyWorkflowRunHandler = getLegacyWorkflowRunHandler;
exports.getLegacyWorkflowRunsHandler = getLegacyWorkflowRunsHandler;
exports.getLegacyWorkflowsHandler = getLegacyWorkflowsHandler;
exports.legacyWorkflows_exports = legacyWorkflows_exports;
exports.resumeAsyncLegacyWorkflowHandler = resumeAsyncLegacyWorkflowHandler;
exports.resumeLegacyWorkflowHandler = resumeLegacyWorkflowHandler;
exports.startAsyncLegacyWorkflowHandler = startAsyncLegacyWorkflowHandler;
exports.startLegacyWorkflowRunHandler = startLegacyWorkflowRunHandler;
exports.watchLegacyWorkflowHandler = watchLegacyWorkflowHandler;
