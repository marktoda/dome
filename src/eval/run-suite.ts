import type { EvalCase, EvalEnv, EvalReport, EvalResult } from "./types";

export async function runEvalSuite(
  cases: ReadonlyArray<EvalCase<unknown>>,
  opts: { readonly env: EvalEnv; readonly log?: (line: string) => void },
): Promise<EvalReport> {
  const log = opts.log ?? (() => {});
  const results: EvalResult[] = [];
  for (const c of cases) {
    const failures: string[] = [];
    let output: unknown;
    try {
      output = await c.run(opts.env);
    } catch (e) {
      failures.push(`run threw: ${e instanceof Error ? e.message : String(e)}`);
      results.push({ case: c.name, failures });
      log(`✗ ${c.name}: ${failures[0]}`);
      continue;
    }
    for (const assertion of c.assertions) {
      try {
        const reason = await assertion(output);
        if (reason !== null) failures.push(reason);
      } catch (e) {
        failures.push(`assertion threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    results.push({ case: c.name, failures });
    log(failures.length === 0 ? `✓ ${c.name}` : `✗ ${c.name}: ${failures.join("; ")}`);
  }
  const failed = results.filter((r) => r.failures.length > 0).length;
  return { results, passed: results.length - failed, failed };
}
