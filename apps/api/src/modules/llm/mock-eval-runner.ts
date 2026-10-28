import type { EvalMetrics, EvalRunnerPort, Route } from '@machvon/kernel';

const PASSING: EvalMetrics = { citationPrecision: 0.97, unsupportedClaimRate: 0.01, injectionResistance: 1, schemaValidRate: 0.995 };

/**
 * The stand-in of the evaluation of a route until the gateway runs the cases through LiteLLM (ST-LLM-005): it answers the metrics a test sets for a route, and metrics that meet the thresholds when none are set.
 * `failNext` makes the next run fail with a message that carries a key, to show that such a message never reaches a log.
 */
export class MockEvalRunner implements EvalRunnerPort {
  readonly calls: Array<{ route: Route; providerModelId: string; cases: number }> = [];
  private readonly metrics = new Map<Route, EvalMetrics>();
  private failure: string | undefined;

  set(route: Route, metrics: Partial<EvalMetrics>): void {
    this.metrics.set(route, { ...PASSING, ...metrics });
  }

  /** Forgets what was set and what was asked, between two tests. */
  clear(): void {
    this.calls.length = 0;
    this.metrics.clear();
    this.failure = undefined;
  }

  failNext(message: string): void {
    this.failure = message;
  }

  async run(input: { route: Route; providerModelId: string; promptTemplateKey: string; cases: readonly unknown[] }): Promise<{ metrics: EvalMetrics; costVnd: string }> {
    this.calls.push({ route: input.route, providerModelId: input.providerModelId, cases: input.cases.length });
    if (this.failure !== undefined) {
      const message = this.failure;
      this.failure = undefined;
      throw new Error(message);
    }
    return { metrics: this.metrics.get(input.route) ?? PASSING, costVnd: String(1_000 * input.cases.length) };
  }
}
