import { randomUUID } from 'node:crypto';
import { GatewayFailure } from '@machvon/kernel';
import type { AiGatewayPort, GatewayCall, GatewayFailureKind, GatewayResult } from '@machvon/kernel';

export type MockStep = { fail: GatewayFailureKind } | { output: string; usage?: Partial<GatewayResult['usage']> } | ((call: GatewayCall) => GatewayResult);

/**
 * The stand-in of the models until the gateway goes through LiteLLM (ST-LLM-005 keeps the port, the adapter is for the deployment): a test scripts what each model answers, in order, by the identifier the provider knows it by;
 * a model with nothing scripted answers an object that follows a schema with a summary and one citation of the first source.
 */
export class MockAiGateway implements AiGatewayPort {
  readonly calls: GatewayCall[] = [];
  private readonly scripts = new Map<string, MockStep[]>();
  private sequence = 0;

  /** What the model answers on its next calls, one step for each call. */
  script(providerModelId: string, steps: MockStep[]): void {
    this.scripts.set(providerModelId, [...steps]);
  }

  clear(): void {
    this.calls.length = 0;
    this.scripts.clear();
    this.sequence = 0;
  }

  async complete(call: GatewayCall): Promise<GatewayResult> {
    this.calls.push(call);
    const step = this.scripts.get(call.providerModelId)?.shift();
    this.sequence += 1;
    // Unique for ever: a provider request id belongs to one request of the tenant.
    const providerRequestId = `mock-${randomUUID()}`;
    const usage = { inputTotal: 1_200, cachedInput: 200, outputTotal: 300 };
    if (typeof step === 'function') return step(call);
    if (step !== undefined && 'fail' in step) throw new GatewayFailure(step.fail);
    if (step !== undefined) return { providerRequestId, output: step.output, usage: { ...usage, ...step.usage }, latencyMs: 120 };
    return { providerRequestId, output: JSON.stringify({ summary: 'ok', citations: call.sourceIds.slice(0, 1).map((id) => ({ document_version_id: id })) }), usage, latencyMs: 120 };
  }
}
