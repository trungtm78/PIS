import { randomUUID } from 'node:crypto';
import { InMemorySpanExporter, traceIdOfCorrelation } from '@machvon/kernel';
import type { FinishedSpan } from '@machvon/kernel';
import { createAlertSink } from '../../src/alerts/alert-sinks';
import { bootstrap } from '../../src/bootstrap';
import type { RunningApi } from '../../src/bootstrap';
import { TENANT_A, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { startBootstrapFixture } from '../support/bootstrap-fixture';
import type { BootstrapFixture } from '../support/bootstrap-fixture';
import { ManualTimers, until } from '../support/manual-timers';
import { expectCheckFails } from '../uat/uat-kit';

/**
 * One request that carries personal data, followed through the process: the API writes the outbox event, the relay hands it to the worker, and the collector gets spans. The spans of the request and of the
 * worker are in one trace (the trace id of the correlation id of the request), every span names the tenant, and neither the spans nor the log lines the process wrote hold the personal data of the request.
 */

const RELAY_DELAY = 5_000;
const PHONE = '0912345678';
const EMAIL = 'nguyen.van.a@example.vn';
const NATIONAL_ID = '079012345678';

/** What looks like personal data: a Vietnamese phone number, an e-mail address and a 12 digit national id, each as a token of its own (an identifier made of hex digits and dashes is not one). */
const PII_PATTERNS: RegExp[] = [/(?<![\w-])(?:\+84|0)\d{9}(?![\w-])/, /[\w.+-]+@[\w-]+\.[\w.]+/, /(?<![\w-])\d{12}(?![\w-])/];

const piiIn = (text: string): string[] => PII_PATTERNS.flatMap((pattern) => text.match(pattern) ?? []);

/** Every text a span or a log line gives to the outside, as one string each. */
const spanText = (span: FinishedSpan): string => JSON.stringify({ name: span.name, status: span.status, attributes: span.attributes });

function assertNoPii(texts: string[]): void {
  const found = texts.flatMap(piiIn);
  if (found.length > 0) throw new Error(`personal data found in what the process gave out: ${found.join(', ')}`);
}

describe('the checks of this suite can go red (negative control)', () => {
  it('a text that holds a phone number, an e-mail address or a national id is refused', () => {
    for (const leak of [`description ${PHONE}`, `mail ${EMAIL}`, `id ${NATIONAL_ID}`]) expectCheckFails(() => assertNoPii([leak]));
    assertNoPii(['trace 0af7651916cd43dd8448eb211c80319c request 12345678-1234-4234-8234-123456789012']);
  });
});

describe('TC-UAT-NFR-OBSERVABILITY-01 one trace across the API, the outbox and the worker, with the tenant on every span and no personal data', () => {
  const exporter = new InMemorySpanExporter();
  const running: RunningApi[] = [];
  let fixture: BootstrapFixture;
  let timers: ManualTimers;
  let lines: string[];

  beforeAll(async () => {
    fixture = await startBootstrapFixture(['organization_unit.read', 'iam.unit.manage']);
  }, 180_000);

  afterEach(async () => {
    while (running.length > 0) await running.pop()?.stop();
  });

  afterAll(async () => {
    await fixture.stop();
  }, 60_000);

  it('gives the request, the outbox event and the worker one trace id, names the tenant on every span, and leaves the phone number, the e-mail and the national id out of spans and logs', async () => {
    timers = new ManualTimers();
    lines = [];
    exporter.spans.length = 0;
    const config = fixture.configWith();
    const api = await bootstrap(config, {
      exporter,
      port: 0,
      timers,
      alerts: createAlertSink(config, { write: (line) => void lines.push(line) }),
      workerLog: (line) => void lines.push(line),
    });
    running.push(api);

    // The command of a signed-in member whose text fields carry personal data.
    const reply = await fetch(`http://127.0.0.1:${api.port}/org-units`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ code: `T${randomUUID().slice(0, 6).toUpperCase()}`, name: `Contact ${PHONE} ${EMAIL} ${NATIONAL_ID}`, parent_id: unitId(1), unit_type: 'DEPARTMENT', valid_from: '2026-02-01' }),
    });
    const created = (await reply.json()) as { resource_id: string };
    expect(reply.status).toBeLessThan(300);
    const correlationId = reply.headers.get('x-correlation-id') as string;
    const traceId = traceIdOfCorrelation(correlationId) as string;
    expect(traceId).toBeDefined();

    // The event the command wrote carries the correlation id of the request; the relay hands it to the worker.
    const events = await fixture.harness.owner<{ id: string; status: string; correlation_id: string }>(TENANT_A, [['select id, status, correlation_id from machvon.outbox_event where aggregate_id = $1', [created.resource_id]]]);
    expect(events).toHaveLength(1);
    expect(events[0]?.correlation_id).toBe(correlationId);
    timers.fire(RELAY_DELAY);
    await until(async () => (await fixture.harness.owner<{ status: string }>(TENANT_A, [['select status from machvon.outbox_event where aggregate_id = $1', [created.resource_id]]]))[0]?.status === 'PUBLISHED', 'the relay to publish the event');
    await new Promise((done) => setImmediate(done));

    const request = exporter.spans.find((span) => span.attributes.correlation_id === correlationId && span.name.endsWith('request'));
    const worker = exporter.spans.filter((span) => span.name === 'outbox consume' && span.attributes.correlation_id === correlationId);
    expect(request).toBeDefined();
    expect(worker).toHaveLength(1);
    expect([request?.traceId, worker[0]?.traceId]).toEqual([traceId, traceId]);
    // Every span the process exported names the tenant of its request.
    const spans = exporter.spans.filter((span) => span.traceId === traceId);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans.filter((span) => span.attributes.tenant_id !== TENANT_A)).toEqual([]);
    // No personal data in the spans, and none in the log lines of the process (alerts and workers).
    assertNoPii([...exporter.spans.map(spanText), ...lines]);
  }, 120_000);
});
