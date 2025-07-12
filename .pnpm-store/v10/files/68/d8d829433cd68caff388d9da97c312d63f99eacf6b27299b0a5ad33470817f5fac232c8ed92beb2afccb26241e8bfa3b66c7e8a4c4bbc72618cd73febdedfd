interface MetricResult {
    score: number;
    info?: Record<string, any>;
}
declare abstract class Metric {
    abstract measure(input: string, output: string): Promise<MetricResult>;
}

interface TestInfo {
    testName?: string;
    testPath?: string;
}
interface EvaluationResult extends MetricResult {
    output: string;
}

export { type EvaluationResult as E, Metric as M, type TestInfo as T, type MetricResult as a };
