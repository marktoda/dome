import { stringify, esm_default } from './chunk-MEGCYGBU.js';
import { handleError } from './chunk-LF7P5PLR.js';
import { HTTPException } from './chunk-LCM566I4.js';
import { __export } from './chunk-MLKGABMK.js';
import { ReadableStream } from 'stream/web';

// src/server/handlers/legacyWorkflows.ts
var legacyWorkflows_exports = {};
__export(legacyWorkflows_exports, {
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
        triggerSchema: workflow.triggerSchema ? stringify(esm_default(workflow.triggerSchema)) : void 0,
        steps: Object.entries(workflow.steps).reduce((acc2, [key2, step]) => {
          const _step = step;
          acc2[key2] = {
            id: _step.id,
            description: _step.description,
            workflowId: _step.workflowId,
            inputSchema: _step.inputSchema ? stringify(esm_default(_step.inputSchema)) : void 0,
            outputSchema: _step.outputSchema ? stringify(esm_default(_step.outputSchema)) : void 0
          };
          return acc2;
        }, {})
      };
      return acc;
    }, {});
    return _workflows;
  } catch (error) {
    return handleError(error, "error getting workflows");
  }
}
async function getLegacyWorkflowByIdHandler({ mastra, workflowId }) {
  try {
    if (!workflowId) {
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new HTTPException(404, { message: "Workflow not found" });
    }
    return {
      stepGraph: workflow.stepGraph,
      stepSubscriberGraph: workflow.stepSubscriberGraph,
      serializedStepGraph: workflow.serializedStepGraph,
      serializedStepSubscriberGraph: workflow.serializedStepSubscriberGraph,
      name: workflow.name,
      triggerSchema: workflow.triggerSchema ? stringify(esm_default(workflow.triggerSchema)) : void 0,
      steps: Object.entries(workflow.steps).reduce((acc, [key, step]) => {
        const _step = step;
        acc[key] = {
          id: _step.id,
          description: _step.description,
          workflowId: _step.workflowId,
          inputSchema: _step.inputSchema ? stringify(esm_default(_step.inputSchema)) : void 0,
          outputSchema: _step.outputSchema ? stringify(esm_default(_step.outputSchema)) : void 0
        };
        return acc;
      }, {})
    };
  } catch (error) {
    return handleError(error, "error getting workflow by id");
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
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new HTTPException(404, { message: "Workflow not found" });
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
      throw new HTTPException(404, { message: "Workflow run not found" });
    }
    const result = await run.start({
      triggerData,
      runtimeContext
    });
    return result;
  } catch (error) {
    return handleError(error, "error starting workflow");
  }
}
async function getLegacyWorkflowRunHandler({
  mastra,
  workflowId,
  runId
}) {
  try {
    if (!workflowId) {
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new HTTPException(400, { message: "Run ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new HTTPException(404, { message: "Workflow not found" });
    }
    const run = await workflow.getRun(runId);
    if (!run) {
      throw new HTTPException(404, { message: "Workflow run not found" });
    }
    return run;
  } catch (error) {
    return handleError(error, "error getting workflow run");
  }
}
async function createLegacyWorkflowRunHandler({
  mastra,
  workflowId,
  runId: prevRunId
}) {
  try {
    if (!workflowId) {
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    if (!workflow) {
      throw new HTTPException(404, { message: "Workflow not found" });
    }
    const newRun = workflow.createRun({ runId: prevRunId });
    return { runId: newRun.runId };
  } catch (error) {
    return handleError(error, "error creating workflow run");
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
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new HTTPException(400, { message: "runId required to start run" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new HTTPException(404, { message: "Workflow run not found" });
    }
    void run.start({
      triggerData,
      runtimeContext
    });
    return { message: "Workflow run started" };
  } catch (e) {
    return handleError(e, "Error starting workflow run");
  }
}
async function watchLegacyWorkflowHandler({
  mastra,
  workflowId,
  runId
}) {
  try {
    if (!workflowId) {
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new HTTPException(400, { message: "runId required to watch workflow" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new HTTPException(404, { message: "Workflow run not found" });
    }
    let unwatch;
    let asyncRef = null;
    const stream = new ReadableStream({
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
    return handleError(error, "Error watching workflow");
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
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new HTTPException(400, { message: "runId required to resume workflow" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new HTTPException(404, { message: "Workflow run not found" });
    }
    const result = await run.resume({
      stepId: body.stepId,
      context: body.context,
      runtimeContext
    });
    return result;
  } catch (error) {
    return handleError(error, "Error resuming workflow step");
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
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    if (!runId) {
      throw new HTTPException(400, { message: "runId required to resume workflow" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const run = workflow.getMemoryRun(runId);
    if (!run) {
      throw new HTTPException(404, { message: "Workflow run not found" });
    }
    void run.resume({
      stepId: body.stepId,
      context: body.context,
      runtimeContext
    });
    return { message: "Workflow run resumed" };
  } catch (error) {
    return handleError(error, "Error resuming workflow");
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
      throw new HTTPException(400, { message: "Workflow ID is required" });
    }
    const workflow = mastra.legacy_getWorkflow(workflowId);
    const workflowRuns = await workflow.getWorkflowRuns({ fromDate, toDate, limit, offset, resourceId }) || {
      runs: [],
      total: 0
    };
    return workflowRuns;
  } catch (error) {
    return handleError(error, "Error getting workflow runs");
  }
}

export { createLegacyWorkflowRunHandler, getLegacyWorkflowByIdHandler, getLegacyWorkflowRunHandler, getLegacyWorkflowRunsHandler, getLegacyWorkflowsHandler, legacyWorkflows_exports, resumeAsyncLegacyWorkflowHandler, resumeLegacyWorkflowHandler, startAsyncLegacyWorkflowHandler, startLegacyWorkflowRunHandler, watchLegacyWorkflowHandler };
