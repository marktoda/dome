import { a as MetricResult, T as TestInfo, M as Metric } from '../types-Bo1uigWx.js';

type Handler<T = unknown> = (event: T) => void;

declare enum AvailableHooks {
    ON_EVALUATION = "onEvaluation",
    ON_GENERATION = "onGeneration"
}
type EvaluationHookData = {
    input: string;
    output: string;
    result: MetricResult;
    agentName: string;
    metricName: string;
    instructions: string;
    runId: string;
    globalRunId: string;
    testInfo?: TestInfo;
};
type GenerationHookData = {
    input: string;
    output: string;
    metric: Metric;
    runId: string;
    agentName: string;
    instructions: string;
};
declare function registerHook(hook: AvailableHooks.ON_EVALUATION, action: Handler<EvaluationHookData>): void;
declare function registerHook(hook: AvailableHooks.ON_GENERATION, action: Handler<GenerationHookData>): void;
declare function executeHook(hook: AvailableHooks.ON_EVALUATION, action: EvaluationHookData): void;
declare function executeHook(hook: AvailableHooks.ON_GENERATION, action: GenerationHookData): void;

export { AvailableHooks, executeHook, registerHook };
