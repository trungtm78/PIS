import { GatewayFailure } from '@machvon/kernel';
import type { GatewayCall } from '@machvon/kernel';
import { AnthropicGateway, PdfFallbackTextPort, extractJsonObject } from '../e2e-stack/anthropic-gateway';

const CALL: GatewayCall = {
  route: 'INTERNATIONAL',
  providerCode: 'ANTHROPIC',
  providerModelId: 'claude-sonnet-5-5',
  inputRef: 'playground/abc',
  inputSha256: 'a'.repeat(64),
  promptTemplateKey: 'k',
  promptSha256: 'b'.repeat(64),
  sourceIds: ['11111111-1111-4111-8111-111111111111'],
  outputSchema: { type: 'object' },
  maxOutputTokens: 1000,
  effort: null,
  timeoutMs: 30_000,
  tools: [],
};

const files = { readStored: async () => ({ object: {} as never, bytes: new Uint8Array() }) };
const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('AnthropicGateway (demo adapter)', () => {
  it('maps a reply to the port result, counting cached tokens in the input total', async () => {
    const gateway = new AnthropicGateway({
      apiKey: 'test-key',
      files,
      fetchImpl: reply(200, { id: 'msg_1', content: [{ type: 'text', text: 'Here: {"statements":[]} done' }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } }),
    });
    const result = await gateway.complete(CALL);
    expect(result.output).toBe('{"statements":[]}');
    expect(result.providerRequestId).toBe('msg_1');
    expect(result.usage).toEqual({ inputTotal: 15, cachedInput: 5, outputTotal: 7 });
  });

  it('maps provider errors, refusals and timeouts to the failure kinds', async () => {
    const failure = async (fetchImpl: typeof fetch) => {
      try {
        await new AnthropicGateway({ apiKey: 'k', files, fetchImpl }).complete(CALL);
      } catch (error) {
        return error instanceof GatewayFailure ? error.kind : 'other';
      }
      return 'none';
    };
    expect(await failure(reply(529, {}))).toBe('PROVIDER_ERROR');
    expect(await failure(reply(401, {}))).toBe('PROVIDER_ERROR');
    expect(await failure(reply(504, {}))).toBe('TIMEOUT');
    expect(await failure(reply(200, { stop_reason: 'refusal', content: [] }))).toBe('REFUSAL');
    expect(await failure((async () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' }))) as unknown as typeof fetch)).toBe('TIMEOUT');
  });

  it('extracts the first balanced JSON object, also from a fenced reply', () => {
    expect(extractJsonObject('```json\n{"a":{"b":"}"}}\n```')).toBe('{"a":{"b":"}"}}');
  });

  it('reads the plain text lines of a demo PDF when no OCR was recorded', async () => {
    const pdf = Buffer.from('BT (Line one) Tj T* (Line \\(two\\)) Tj ET', 'latin1');
    const ocr = { pages: async () => Promise.reject(new Error('no ocr')) };
    const port = new PdfFallbackTextPort(ocr, { get: async () => ({ bytes: new Uint8Array(pdf), mime: 'application/pdf' }) });
    const tx = { query: async () => [{ object_key: 'tenants/x' }] } as never;
    expect(await port.pages(tx, { tenantId: 't', membershipId: 'm', scopeVersion: 1 }, 'v')).toEqual(['Line one\nLine (two)']);
  });
});
