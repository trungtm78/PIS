import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LangfuseTraceExporter, SanitisingTraceExporter, maskPii, piiMatches, sanitizeTrace } from '../src/llm-trace';
import type { LlmTrace, TraceExporter } from '../src/llm-trace';

const NATIONAL_ID = '001204123456';
const SPACED_NATIONAL_ID = '001 204 123 456';
const OLD_NATIONAL_ID = '024123456';
const EMAIL = 'nguyen.van.a+kyc@example.gov.vn';
const PHONE = '0912 345 678';
const INTERNATIONAL_PHONE = '+84 912-345-678';
const TRACE_ID = '00000000-0000-4000-8000-000000000001';

/** The sink: it keeps what it was handed, as the store of the traces does. */
class StoredTraces implements TraceExporter {
  readonly stored: string[] = [];
  async export(trace: LlmTrace): Promise<void> {
    this.stored.push(JSON.stringify(trace));
  }
}

const dirtyTrace = (): LlmTrace => ({
  id: TRACE_ID,
  name: 'assess-claim',
  timestamp: '2026-11-03T08:00:00.000Z',
  input: {
    messages: [
      { role: 'system', content: 'Summarise the file.' },
      { role: 'user', content: `Citizen ${NATIONAL_ID} wrote from ${EMAIL} and called ${PHONE}.` },
    ],
  },
  output: `Reply to ${EMAIL}; the id on the form is ${SPACED_NATIONAL_ID}, the old one ${OLD_NATIONAL_ID}, mobile ${INTERNATIONAL_PHONE}.`,
  metadata: { citizen: { email: EMAIL, notes: [`id ${NATIONAL_ID}`] }, attempts: 2 },
  tags: ['llm', `user:${EMAIL}`],
});

describe('maskPii and piiMatches (ST-KERNEL-046)', () => {
  it('names every national id, email and phone number in a text, and nothing in a text without them', () => {
    const text = `${NATIONAL_ID} ${SPACED_NATIONAL_ID} ${OLD_NATIONAL_ID} ${EMAIL} ${PHONE} ${INTERNATIONAL_PHONE}`;
    expect(piiMatches(text).map((match) => match.kind)).toEqual(['NATIONAL_ID', 'NATIONAL_ID', 'NATIONAL_ID', 'EMAIL', 'PHONE', 'PHONE']);
    expect(piiMatches(`Order 12345 of 2026-11-03 came to 1.500.000.000 VND, trace ${TRACE_ID}`)).toEqual([]);
  });

  it('replaces each with a placeholder that names the kind and leaves the rest of the text alone', () => {
    expect(maskPii(`Citizen ${NATIONAL_ID} wrote from ${EMAIL} and called ${PHONE}.`)).toBe('Citizen [NATIONAL_ID] wrote from [EMAIL] and called [PHONE].');
    expect(maskPii(`${SPACED_NATIONAL_ID}, ${OLD_NATIONAL_ID}, ${INTERNATIONAL_PHONE}`)).toBe('[NATIONAL_ID], [NATIONAL_ID], [PHONE]');
  });

  it('does not read the last group of an identifier as a national id, nor a longer number as one', () => {
    expect(maskPii(TRACE_ID)).toBe(TRACE_ID);
    expect(maskPii('amount 5000000000000 and 0123456789012345')).toBe('amount 5000000000000 and 0123456789012345');
  });

  it('reports an email once when its name is made of digits that would read as a phone number or an id', () => {
    expect(piiMatches('0912345678@example.vn 001204123456@example.vn').map((match) => match.kind)).toEqual(['EMAIL', 'EMAIL']);
  });

  it('keeps a national id that starts with 0 whole instead of reading the front of it as a phone number', () => {
    expect(maskPii(`id ${NATIONAL_ID}`)).toBe('id [NATIONAL_ID]');
  });
});

describe('sanitizeTrace and SanitisingTraceExporter (ST-KERNEL-046)', () => {
  it('AC-ST-KERNEL-046-2 UAT-AC465: masks the national id and the email in every field of the trace before the sink stores it, and 0 pattern matches remain in the stored traces', async () => {
    const sink = new StoredTraces();
    await new SanitisingTraceExporter(sink).export(dirtyTrace());
    expect(sink.stored).toHaveLength(1);
    expect(piiMatches(sink.stored.join('\n'))).toEqual([]);
    for (const secret of [NATIONAL_ID, SPACED_NATIONAL_ID, OLD_NATIONAL_ID, EMAIL, PHONE, INTERNATIONAL_PHONE]) expect(sink.stored[0]).not.toContain(secret);
    const stored = JSON.parse(sink.stored[0] as string) as LlmTrace;
    expect(stored.output).toBe('Reply to [EMAIL]; the id on the form is [NATIONAL_ID], the old one [NATIONAL_ID], mobile [PHONE].');
    expect(stored.tags).toEqual(['llm', 'user:[EMAIL]']);
  });

  it('keeps what is not personal, so the trace is still useful: names, times, counts, the structure of the messages', () => {
    const clean = sanitizeTrace(dirtyTrace());
    expect(clean.id).toBe(TRACE_ID);
    expect(clean.name).toBe('assess-claim');
    expect(clean.timestamp).toBe('2026-11-03T08:00:00.000Z');
    expect((clean.metadata as { attempts: number }).attempts).toBe(2);
    expect((clean.input as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it('does not change the trace it was given', () => {
    const trace = dirtyTrace();
    sanitizeTrace(trace);
    expect(trace).toEqual(dirtyTrace());
  });

  it('redacts the value of a credential under a secret-like key, whatever it looks like', () => {
    const clean = sanitizeTrace({ id: 't', name: 'n', metadata: { authorization: 'Bearer abc', nested: { apiKey: 'sk-live-1', fine: 'ok' } } });
    expect(clean.metadata).toEqual({ authorization: '[REDACTED]', nested: { apiKey: '[REDACTED]', fine: 'ok' } });
  });

  it('masks a name that is itself personal, as a map keyed by email would have it', () => {
    expect(sanitizeTrace({ id: 't', name: 'n', metadata: { [EMAIL]: 'ok' } }).metadata).toEqual({ '[EMAIL]': 'ok' });
  });

  it('writes dates and big numbers as text, and leaves out what JSON cannot hold', () => {
    const clean = sanitizeTrace({ id: 't', name: 'n', metadata: { at: new Date('2026-11-03T00:00:00.000Z'), cost: 12345678901234567890n, skipped: undefined } });
    expect(clean.metadata).toEqual({ at: '2026-11-03T00:00:00.000Z', cost: '12345678901234567890' });
  });

  it('exports nothing when the trace cannot be sanitised (fail closed)', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sink = new StoredTraces();
    await expect(new SanitisingTraceExporter(sink).export({ id: 't', name: 'n', metadata: circular })).rejects.toThrow();
    expect(sink.stored).toEqual([]);
  });
});

describe('LangfuseTraceExporter behind the sanitiser (ST-KERNEL-046)', () => {
  let server: Server;
  let baseUrl: string;
  const received: Array<{ path: string | undefined; authorization: string | undefined; body: string }> = [];
  let status = 207;

  const bodyOf = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };

  beforeAll(async () => {
    server = createServer((request, response) => {
      void bodyOf(request).then((body) => {
        received.push({ path: request.url, authorization: request.headers.authorization, body });
        response.statusCode = status;
        response.end('{"detail":"a body that must not be repeated"}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received.length = 0;
    status = 207;
  });

  const exporter = (): TraceExporter =>
    new SanitisingTraceExporter(new LangfuseTraceExporter({ baseUrl: `${baseUrl}/`, publicKey: 'pk-test', secretKey: 'sk-test', newId: () => 'event-1', now: () => new Date('2026-11-03T08:00:01.000Z') }));

  it('AC-ST-KERNEL-046-2 UAT-AC465: what reaches the Langfuse server over HTTP holds no national id and no email, and it is a trace-create event', async () => {
    await exporter().export(dirtyTrace());
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request?.path).toBe('/api/public/ingestion');
    expect(request?.authorization).toBe(`Basic ${Buffer.from('pk-test:sk-test').toString('base64')}`);
    expect(piiMatches(request?.body ?? '')).toEqual([]);
    for (const secret of [NATIONAL_ID, EMAIL]) expect(request?.body).not.toContain(secret);
    const { batch } = JSON.parse(request?.body ?? '{}') as { batch: Array<{ id: string; type: string; timestamp: string; body: LlmTrace }> };
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ id: 'event-1', type: 'trace-create', timestamp: '2026-11-03T08:00:01.000Z', body: { id: TRACE_ID, name: 'assess-claim' } });
  });

  it('fails with the status, never with the body of the answer, when Langfuse refuses', async () => {
    status = 401;
    const failure = await exporter()
      .export(dirtyTrace())
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(failure?.message).toBe('LANGFUSE_HTTP_401');
  });

  it('fails when Langfuse takes the batch with 207 but refuses the event', async () => {
    const refusing = (async () => new Response(JSON.stringify({ successes: [], errors: [{ id: 'event-1', status: 400 }] }), { status: 207 })) as typeof fetch;
    const failure = await new LangfuseTraceExporter({ baseUrl, publicKey: 'p', secretKey: 's', fetchImpl: refusing }).export({ id: 't', name: 'n' }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toBe('LANGFUSE_EVENT_REFUSED');
  });

  it('draws an event id and a time of its own when none is given', async () => {
    await new LangfuseTraceExporter({ baseUrl, publicKey: 'pk-test', secretKey: 'sk-test' }).export({ id: 't', name: 'n' });
    const { batch } = JSON.parse(received[0]?.body ?? '{}') as { batch: Array<{ id: string; timestamp: string }> };
    expect(batch[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(batch[0]?.timestamp ?? ''))).toBe(false);
  });
});
