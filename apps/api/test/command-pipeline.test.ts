import { randomUUID } from 'node:crypto';
import { IdempotencyStore } from '@machvon/db';
import { keyHashOf } from '@machvon/kernel';
import type { QueryResultRow } from 'pg';
import { CommandHarness, newKey } from './command-harness';
import { TENANT_IDS } from './isolation/suite';

describe('command pipeline (ST-ADM-001, ST-ADM-002, ST-KERNEL-023, ST-KERNEL-028)', () => {
  const harness = new CommandHarness();
  const { state } = harness;
  const send = harness.send.bind(harness);
  const count = harness.count.bind(harness);
  const admin = { query: <R extends QueryResultRow>(text: string, params?: unknown[]) => harness.admin.query<R>(text, params) };

  const widgetsNamed = (name: string): Promise<number> => count('select count(*) as n from public.test_widget where name = $1', [name]);
  const auditRows = (action: string, outcome = 'SUCCESS'): Promise<number> =>
    count('select count(*) as n from machvon.audit_event where action = $1 and outcome = $2', [action, outcome]);
  const outboxRows = (type: string): Promise<number> => count('select count(*) as n from machvon.outbox_event where type = $1', [type]);
  const recordCount = (): Promise<number> => count('select count(*) as n from machvon.idempotency_record');

  beforeAll(() => harness.start(), 180_000);
  afterAll(() => harness.stop(), 60_000);

  it.each([
    ['is missing', null],
    ['is shorter than 16 characters', 'short-key'],
  ])('rejects a command whose Idempotency-Key %s with 400 INVALID_REQUEST and writes nothing (AC-ST-ADM-001-2)', async (_label, key) => {
    const name = `nokey-${randomUUID()}`;
    const before = await recordCount();
    const reply = await send('POST', '/test/widgets', { key, body: { name } });
    expect(reply.status).toBe(400);
    expect(reply.json.code).toBe('INVALID_REQUEST');
    expect(await widgetsNamed(name)).toBe(0);
    expect(await recordCount()).toBe(before);
  });

  it('executes once, replays the stored answer, and refuses the same key with another body (AC-ST-KERNEL-028-1, AC-ST-ADM-001-1, AC-ST-ADM-001-2)', async () => {
    const key = newKey();
    const name = `once-${randomUUID()}`;
    const first = await send('POST', '/test/widgets', { key, body: { name } });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ status: 'SUBMITTED', version: 5 });
    expect(first.headers.get('etag')).toBe('"5"');
    expect(first.headers.get('idempotency-replayed')).toBeNull();

    const replay = await send('POST', '/test/widgets', { key, body: { name } });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');

    const other = await send('POST', '/test/widgets', { key, body: { name: `${name}-other` } });
    expect(other.status).toBe(409);
    expect(other.json.code).toBe('IDEMPOTENCY_CONFLICT');

    const id = first.json.id as string;
    expect(await widgetsNamed(name)).toBe(1);
    expect(await count('select count(*) as n from machvon.audit_event where resource_id = $1', [id])).toBe(1);
    expect(await count('select count(*) as n from machvon.outbox_event where aggregate_id = $1', [id])).toBe(1);
    const { rows } = await admin.query<{ safe_diff: Record<string, unknown>; outcome: string }>(
      'select safe_diff, outcome from machvon.audit_event where resource_id = $1',
      [id],
    );
    const redacted = '[REDACTED]';
    expect(rows[0]).toEqual({ safe_diff: { name, password: redacted }, outcome: 'SUCCESS' });
  });

  it('runs the handler once for 20 parallel requests with one key and body (AC-ST-ADM-001-1)', async () => {
    const key = newKey();
    const name = `parallel-${randomUUID()}`;
    const before = state.executions;
    const replies = await Promise.all(Array.from({ length: 20 }, () => send('POST', '/test/widgets', { key, body: { name } })));
    expect(state.executions - before).toBe(1);
    expect(await widgetsNamed(name)).toBe(1);
    for (const reply of replies) {
      if (reply.status === 200) continue;
      expect(reply.status).toBe(409);
      expect(reply.json.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(reply.headers.get('retry-after')).toBe('2');
    }
    expect(replies.some((reply) => reply.status === 200)).toBe(true);
  });

  it('lets one of two writers with the same If-Match win and answers the other 409 with the current version (AC-ST-KERNEL-028-2, AC-ST-ADM-001-4)', async () => {
    const created = await send('POST', '/test/widgets', { body: { name: `versioned-${randomUUID()}` } });
    const path = `/test/widgets/${created.json.id as string}`;
    const replies = await Promise.all(
      ['a', 'b'].map((suffix) => send('PUT', path, { ifMatch: '"5"', body: { name: `edit-${suffix}-${randomUUID()}` } })),
    );
    const winner = replies.find((reply) => reply.status === 200);
    const loser = replies.find((reply) => reply.status === 409);
    expect(winner?.json.version).toBe(6);
    expect(winner?.headers.get('etag')).toBe('"6"');
    expect(loser?.json.code).toBe('VERSION_CONFLICT');
    expect(loser?.json.current_version).toBe(6);
    expect(loser?.json.safe_diff).toEqual({ name: expect.stringMatching(/^edit-/) });

    const missing = await send('PUT', path, { body: { name: 'x' } });
    expect(missing.status).toBe(428);
    expect(missing.json.code).toBe('PRECONDITION_REQUIRED');
  });

  it('rolls everything back when the handler fails, settles the key as retryable and runs the retry (AC-ST-KERNEL-028-3)', async () => {
    const key = newKey();
    const name = `fail-${randomUUID()}`;
    state.failing = true;
    const failed = await send('POST', '/test/widgets/fail', { key, body: { name } });
    expect(failed.status).toBe(500);
    expect(failed.json.code).toBe('INTERNAL_ERROR');
    expect(failed.text).not.toContain('secret_table');
    expect(await widgetsNamed(name)).toBe(0);
    expect(await auditRows('widget.fail')).toBe(0);
    expect(await outboxRows('WidgetFailed')).toBe(0);
    const { rows } = await admin.query<{ status: string }>("select status from machvon.idempotency_record where operation = 'failWidget'");
    expect(rows.map((row) => row.status)).toEqual(['FAILED_RETRYABLE']);

    state.failing = false;
    const retried = await send('POST', '/test/widgets/fail', { key, body: { name } });
    expect(retried.status).toBe(200);
    expect(retried.headers.get('idempotency-replayed')).toBeNull();
    expect(await widgetsNamed(name)).toBe(1);
    expect(await auditRows('widget.fail')).toBe(1);
  });

  it('answers a denied command 403, replays the denial and records one DENIED audit row outside the rolled back transaction (AC-ST-KERNEL-023-3, AC-ST-ADM-002-2)', async () => {
    const key = newKey();
    const first = await send('POST', '/test/widgets/deny', { key });
    expect(first.status).toBe(403);
    expect(first.json.code).toBe('SCOPE_DENIED');
    const replay = await send('POST', '/test/widgets/deny', { key });
    expect(replay.status).toBe(403);
    expect(replay.json.code).toBe('SCOPE_DENIED');
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(await auditRows('command.denied:denyWidget', 'DENIED')).toBe(1);
    // The correlation id the caller receives finds the audit row, even though the caller sent none.
    const { rows } = await admin.query<{ correlation_id: string }>("select correlation_id from machvon.audit_event where action = 'command.denied:denyWidget'");
    expect(rows.map((row) => row.correlation_id)).toEqual([first.json.correlation_id]);
  });

  it('keeps a correlation id sent by the caller across the response and the audit row', async () => {
    const correlationId = randomUUID();
    const reply = await send('POST', '/test/widgets/deny', { extraHeaders: { 'x-correlation-id': correlationId } });
    expect(reply.json.correlation_id).toBe(correlationId);
    expect(await count("select count(*) as n from machvon.audit_event where action = 'command.denied:denyWidget' and correlation_id = $1", [correlationId])).toBe(1);
  });

  it('fails a command that wrote no audit entry and rolls its effects back (AC-ST-KERNEL-023-3)', async () => {
    const name = `silent-${randomUUID()}`;
    const reply = await send('POST', '/test/widgets/silent', { body: { name } });
    expect(reply.status).toBe(500);
    expect(reply.json.code).toBe('INTERNAL_ERROR');
    expect(await widgetsNamed(name)).toBe(0);
  });

  it('rejects a request without a verified tenant context before any idempotency record exists', async () => {
    const before = await recordCount();
    const reply = await send('POST', '/test/widgets', { authenticated: false });
    expect(reply.status).toBe(400);
    expect(reply.json.code).toBe('TENANT_CONTEXT_INVALID');
    expect(await recordCount()).toBe(before);
  });

  it('keeps the same key of two tenants apart: each executes once', async () => {
    const key = newKey();
    const name = `twin-${randomUUID()}`;
    const [a, b] = await Promise.all([
      send('POST', '/test/widgets', { tenant: 'TNT-A', key, body: { name } }),
      send('POST', '/test/widgets', { tenant: 'TNT-B', key, body: { name } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.headers.get('idempotency-replayed')).toBeNull();
    expect(b.headers.get('idempotency-replayed')).toBeNull();
    const { rows } = await admin.query<{ tenant_id: string }>('select tenant_id from public.test_widget where name = $1 order by tenant_id', [name]);
    expect(rows.map((row) => row.tenant_id)).toEqual([TENANT_IDS['TNT-A'], TENANT_IDS['TNT-B']]);
  });

  describe('legal holds and the records of real commands (BR-PLT-04)', () => {
    const HOLD_ID = '00000000-0000-4000-a009-0000000000f1';
    const PLACER = '00000000-0000-4000-8000-0000000000f1';
    const tenantA = { tenantId: TENANT_IDS['TNT-A'], membershipId: PLACER, scopeVersion: 1 };
    const recordOf = async (key: string): Promise<Record<string, unknown> | undefined> =>
      (await admin.query<Record<string, unknown>>('select * from machvon.idempotency_record where key_hash = $1', [keyHashOf(key)])).rows[0];
    const expire = (key: string): Promise<unknown> =>
      admin.query("update machvon.idempotency_record set created_at = now() - interval '4 days', expires_at = now() - interval '1 day' where key_hash = $1", [keyHashOf(key)]);

    async function holdResource(resourceId: string): Promise<void> {
      const client = await harness.admin.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        await client.query(
          `insert into machvon.legal_hold (tenant_id, id, resource_scope, authority_reference, reason, effective_at, hold_kind, status, placed_by, version)
           values ($1, $2, $3::jsonb, 'Decision 12/QD-TTCP', 'Inspection of the widget', now() - interval '1 minute', 'INSPECTION', 'Active', $4, 1)`,
          [TENANT_IDS['TNT-A'], HOLD_ID, JSON.stringify({ kind: 'RESOURCE', ids: [resourceId] }), PLACER],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    afterEach(async () => {
      await admin.query('delete from machvon.legal_hold where id = $1', [HOLD_ID]);
    });

    it('points the record of a command at the resource it audited, so a hold on that resource keeps the record from a purge', async () => {
      const key = newKey();
      const created = await send('POST', '/test/widgets', { key, body: { name: `held-${randomUUID()}` } });
      const widgetId = created.json.id as string;
      expect(await recordOf(key)).toMatchObject({ resource_type: 'widget', resource_id: widgetId, status: 'COMPLETED' });

      await holdResource(widgetId);
      await expire(key);
      expect(await new IdempotencyStore(harness.tenants).purgeExpired(tenantA)).toBe(0);
      expect(await recordOf(key)).toBeDefined();

      await admin.query('delete from machvon.legal_hold where id = $1', [HOLD_ID]);
      expect(await new IdempotencyStore(harness.tenants).purgeExpired(tenantA)).toBeGreaterThanOrEqual(1);
      expect(await recordOf(key)).toBeUndefined();
    });

    it('keeps the held record intact when a client reuses its expired key, and runs the new request on a record of its own', async () => {
      const key = newKey();
      const first = await send('POST', '/test/widgets', { key, body: { name: `held-${randomUUID()}` } });
      const before = await recordOf(key);
      await holdResource(first.json.id as string);
      await expire(key);
      const evidence = (await admin.query<Record<string, unknown>>('select * from machvon.idempotency_record where id = $1', [before?.id])).rows[0];

      const second = await send('POST', '/test/widgets', { key, body: { name: `reuse-${randomUUID()}` } });
      expect(second.status).toBe(200);
      expect(second.json.id).not.toBe(first.json.id);

      const kept = (await admin.query<Record<string, unknown>>('select * from machvon.idempotency_record where id = $1', [before?.id])).rows[0];
      expect({ ...kept, key_hash: undefined }).toEqual({ ...evidence, key_hash: undefined });
      expect(kept?.response_ref).toEqual(evidence?.response_ref);
      const current = await recordOf(key);
      expect(current?.id).not.toBe(before?.id);
      expect(current).toMatchObject({ status: 'COMPLETED', resource_id: second.json.id });
    });
  });
});
