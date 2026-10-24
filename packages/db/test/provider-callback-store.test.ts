import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { BODY_HMAC_SHA256_PREFIXED, defineStatusTable } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import { INBOX_MAX_ATTEMPTS, ProviderCallbackStore, RECONCILIATION_DUE_SECONDS, RESULT_UNCERTAIN_EVENT } from '../src/provider-callback-store';
import type { ProviderItemRef, ReceiveCallbackInput } from '../src/provider-callback-store';
import { TenantDatabase } from '../src/tenant-database';
import type { TenantTx } from '../src/tenant-database';
import type { TestDatabase } from '../src/test-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000f1';
const REVIEWER = '00000000-0000-4000-8000-0000000000f2';
const MESSAGE_1 = '00000000-0000-4000-8000-0000000000c1';
const MESSAGE_2 = '00000000-0000-4000-8000-0000000000c2';
const CORRELATION = '00000000-0000-4000-8000-0000000000aa';
const SECRET = Buffer.from('provider-app-secret-0123456789abcdef');
const NOW = 1_800_000_000;

type Delivery = 'SENDING' | 'UNCERTAIN' | 'ACCEPTED' | 'DELIVERED' | 'READ' | 'FAILED';

const DELIVERY = defineStatusTable<Delivery>(
  'delivery',
  {
    SENDING: ['UNCERTAIN', 'ACCEPTED', 'FAILED'],
    UNCERTAIN: ['ACCEPTED', 'DELIVERED', 'FAILED'],
    ACCEPTED: ['DELIVERED', 'FAILED'],
    DELIVERED: ['READ'],
    READ: [],
    FAILED: [],
  },
  ['SENDING'],
);
const WITHOUT_UNCERTAIN = defineStatusTable('plain', { SENDING: ['DONE'], DONE: [] }, ['SENDING']);

const REF: ProviderItemRef = { provider: 'ZALO_ZNS', subjectType: 'channel_message', subjectId: MESSAGE_1 };

const context = (tenantId: string): TenantContext => ({ tenantId, membershipId: MEMBERSHIP, scopeVersion: 1 });

function signedCallback(eventKey: string, status: string, overrides: Partial<ReceiveCallbackInput> = {}): ReceiveCallbackInput {
  const rawBody = Buffer.from(JSON.stringify({ id: eventKey, status }), 'utf8');
  const signature = createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${NOW}.`), rawBody])).digest('hex');
  return {
    provider: REF.provider,
    eventKey,
    eventType: 'message.status',
    rawBody,
    signature,
    timestampSeconds: NOW,
    keys: [{ keyId: 'k1', secret: SECRET }],
    payloadReference: `object://callbacks/${eventKey}`,
    now: () => NOW,
    ...overrides,
  };
}

class CountingMetrics implements MetricsSink {
  readonly counted: Array<{ name: string; labels: Record<string, string> | undefined }> = [];

  increment(name: string, labels?: Record<string, string>): void {
    this.counted.push({ name, labels });
  }

  gauge(): void {
    // not used by the store
  }
}

describe('ProviderCallbackStore', () => {
  let database: TestDatabase;
  let pool: Pool;
  let tenants: TenantDatabase;
  const store = new ProviderCallbackStore();
  const inTenant = <T>(work: (tx: TenantTx) => Promise<T>, tenantId = TENANT_A): Promise<T> => tenants.withTenant(context(tenantId), work);

  async function admin<T extends object>(text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: database.adminUrl });
    await client.connect();
    try {
      return (await client.query<T>(text, params)).rows;
    } finally {
      await client.end();
    }
  }

  /** Receives the callback and applies its status in one tenant transaction, as a webhook handler does. */
  const receiveAndApply = (eventKey: string, status: string, ref: ProviderItemRef = REF, metrics?: MetricsSink) =>
    inTenant(async (tx) => {
      const received = await store.receive(tx, signedCallback(eventKey, status));
      if (received.duplicate) return { received, applied: undefined };
      const applied = await store.applyEvent(tx, {
        inboxId: received.inboxId,
        ref,
        table: DELIVERY,
        status,
        occurredAt: new Date('2026-10-24T03:00:00Z'),
        ...(metrics === undefined ? {} : { metrics }),
      });
      return { received, applied };
    });

  const statusOf = async (ref: ProviderItemRef = REF): Promise<string | undefined> => (await inTenant((tx) => store.find(tx, ref)))?.status;

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    pool = new Pool({ connectionString: database.urlFor('machvon_app'), max: 6 });
    tenants = new TenantDatabase(pool);
  }, 180_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (database) await database.stop();
  }, 60_000);

  beforeEach(async () => {
    await admin('delete from machvon.provider_status_history');
    await admin('delete from machvon.provider_reconciliation_task');
    await admin('delete from machvon.provider_status_item');
    await admin('delete from machvon.integration_event_inbox');
    await admin('delete from machvon.outbox_event');
  });

  describe('callback order and duplicates', () => {
    it('ends at DELIVERED for ACCEPTED, DELIVERED, a duplicate DELIVERED and a late ACCEPTED, with one history row per change (AC-ST-KERNEL-071-1)', async () => {
      const metrics = new CountingMetrics();
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const accepted = await receiveAndApply('evt-1', 'ACCEPTED', REF, metrics);
      const delivered = await receiveAndApply('evt-2', 'DELIVERED', REF, metrics);
      const duplicate = await receiveAndApply('evt-3', 'DELIVERED', REF, metrics);
      const late = await receiveAndApply('evt-4', 'ACCEPTED', REF, metrics);

      expect([accepted, delivered, duplicate, late].map((result) => result.applied?.outcome)).toEqual(['APPLIED', 'APPLIED', 'DUPLICATE', 'STALE']);
      expect(await statusOf()).toBe('DELIVERED');
      const item = await inTenant((tx) => store.find(tx, REF));
      const history = await inTenant((tx) => store.history(tx, item?.id ?? ''));
      expect(history.map((row) => [row.fromStatus, row.toStatus, row.cause, row.itemVersion])).toEqual([
        [null, 'SENDING', 'CREATED', 1],
        ['SENDING', 'ACCEPTED', 'CALLBACK', 2],
        ['ACCEPTED', 'DELIVERED', 'CALLBACK', 3],
      ]);
      expect(history[1]?.inboxEventId).toBe(accepted.received.inboxId);
      // The late event is ignored with a record: the inbox row says why, and the counter moved.
      const codes = await admin<{ event_key: string; status: string; error_code: string | null }>(
        'select event_key, status, error_code from machvon.integration_event_inbox order by event_key',
      );
      expect(codes).toEqual([
        { event_key: 'evt-1', status: 'PROCESSED', error_code: null },
        { event_key: 'evt-2', status: 'PROCESSED', error_code: null },
        { event_key: 'evt-3', status: 'PROCESSED', error_code: 'STATUS_DUPLICATE' },
        { event_key: 'evt-4', status: 'PROCESSED', error_code: 'STATUS_STALE' },
      ]);
      expect(metrics.counted).toEqual([{ name: 'provider_callback_ignored_total', labels: { provider: 'ZALO_ZNS', reason: 'STALE' } }]);
    });

    it('reaches the same final status whichever order two callbacks are applied in, even in parallel', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      await Promise.all([receiveAndApply('evt-2', 'DELIVERED'), receiveAndApply('evt-1', 'ACCEPTED')]);
      expect(await statusOf()).toBe('DELIVERED');
      const item = await inTenant((tx) => store.find(tx, REF));
      const history = await inTenant((tx) => store.history(tx, item?.id ?? ''));
      expect(history.map((row) => row.toStatus)).toEqual(expect.arrayContaining(['SENDING', 'DELIVERED']));
      expect(new Set(history.map((row) => row.itemVersion)).size).toBe(history.length);
    });

    it('writes a redelivered event once, applies it once and reports a duplicate', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const first = await receiveAndApply('evt-1', 'ACCEPTED');
      const again = await receiveAndApply('evt-1', 'ACCEPTED');
      expect(again.received).toMatchObject({ duplicate: true, payloadChanged: false, inboxId: first.received.inboxId });
      expect(await admin('select id from machvon.integration_event_inbox')).toHaveLength(1);
      const item = await inTenant((tx) => store.find(tx, REF));
      expect(await inTenant((tx) => store.history(tx, item?.id ?? ''))).toHaveLength(2);
    });

    it('does not apply an inbox event twice when the same row is applied again', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const first = await receiveAndApply('evt-1', 'ACCEPTED');
      const second = await inTenant((tx) =>
        store.applyEvent(tx, { inboxId: first.received.inboxId, ref: REF, table: DELIVERY, status: 'DELIVERED', occurredAt: new Date() }),
      );
      expect(second).toMatchObject({ outcome: 'ALREADY_PROCESSED', status: 'ACCEPTED' });
      expect(await statusOf()).toBe('ACCEPTED');
    });

    it('flags an event id reused with another body and does not apply it', async () => {
      const metrics = new CountingMetrics();
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      await receiveAndApply('evt-1', 'ACCEPTED');
      const changed = await inTenant((tx) => store.receive(tx, { ...signedCallback('evt-1', 'FAILED'), metrics }));
      expect(changed).toMatchObject({ duplicate: true, payloadChanged: true });
      expect(metrics.counted).toEqual([{ name: 'provider_callback_ignored_total', labels: { provider: 'ZALO_ZNS', reason: 'PAYLOAD_CHANGED' } }]);
      expect(await statusOf()).toBe('ACCEPTED');
    });

    it('opens a reconciliation task when a callback contradicts the item, and keeps the status', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      await receiveAndApply('evt-1', 'DELIVERED');
      const conflict = await receiveAndApply('evt-2', 'FAILED');
      expect(conflict.applied).toMatchObject({ outcome: 'CONFLICT', status: 'DELIVERED' });
      const tasks = await inTenant((tx) => store.openTasks(tx, 10));
      expect(tasks).toEqual([expect.objectContaining({ reason: 'STATUS_CONFLICT', detail: 'DELIVERED then FAILED', id: conflict.applied?.taskId })]);
      // A second contradiction joins the open task.
      const again = await receiveAndApply('evt-3', 'FAILED');
      expect(again.applied?.taskId).toBe(conflict.applied?.taskId);
      expect(await inTenant((tx) => store.openTasks(tx, 10))).toHaveLength(1);
    });

    it('ignores a status the table does not know and records it', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const result = await receiveAndApply('evt-1', 'BOUNCED');
      expect(result.applied).toMatchObject({ outcome: 'UNKNOWN_STATUS', status: 'SENDING' });
      const [row] = await admin<{ error_code: string }>('select error_code from machvon.integration_event_inbox');
      expect(row?.error_code).toBe('STATUS_UNKNOWN');
    });

    it('answers 404 for a callback about an item that is not tracked, and the rollback leaves no inbox row', async () => {
      await expect(receiveAndApply('evt-1', 'ACCEPTED')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await admin('select id from machvon.integration_event_inbox')).toHaveLength(0);
      await expect(inTenant((tx) => store.applyEvent(tx, { inboxId: CORRELATION, ref: REF, table: DELIVERY, status: 'ACCEPTED', occurredAt: new Date() }))).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    });

    it('tracks an item once, from a declared initial status only', async () => {
      const first = await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const second = await inTenant((tx) => store.track(tx, REF, DELIVERY));
      expect(second.id).toBe(first.id);
      expect(await admin('select id from machvon.provider_status_history')).toHaveLength(1);
      await expect(inTenant((tx) => store.track(tx, { ...REF, subjectId: MESSAGE_2 }, DELIVERY, 'DELIVERED'))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('signature and replay', () => {
    it('answers 401 SIGNATURE_INVALID for a bad signature and writes no inbox row (AC-ST-KERNEL-071-2)', async () => {
      const metrics = new CountingMetrics();
      const forged = signedCallback('evt-1', 'ACCEPTED', { rawBody: Buffer.from('{"id":"evt-1","status":"DELIVERED"}'), metrics });
      await expect(inTenant((tx) => store.receive(tx, forged))).rejects.toMatchObject({ code: 'SIGNATURE_INVALID', status: 401 });
      expect(await admin('select id from machvon.integration_event_inbox')).toHaveLength(0);
      expect(metrics.counted).toEqual([{ name: 'webhook_signature_failures_total', labels: { provider: 'ZALO_ZNS' } }]);
    });

    it('answers 401 REPLAY_WINDOW_EXCEEDED for a good signature on a stale timestamp and writes no inbox row', async () => {
      const rawBody = Buffer.from('{"id":"evt-1","status":"ACCEPTED"}');
      const stale = NOW - 600;
      const signature = createHmac('sha256', SECRET).update(Buffer.concat([Buffer.from(`${stale}.`), rawBody])).digest('hex');
      await expect(inTenant((tx) => store.receive(tx, signedCallback('evt-1', 'ACCEPTED', { rawBody, signature, timestampSeconds: stale })))).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_EXCEEDED',
        status: 401,
      });
      expect(await admin('select id from machvon.integration_event_inbox')).toHaveLength(0);
    });

    it('verifies with the scheme and the replay window the caller names', async () => {
      const rawBody = Buffer.from('{"id":"evt-9","status":"ACCEPTED"}');
      const prefixed = `sha256=${createHmac('sha256', SECRET).update(rawBody).digest('hex')}`;
      const input = signedCallback('evt-9', 'ACCEPTED', { rawBody, signature: prefixed, scheme: BODY_HMAC_SHA256_PREFIXED, replayWindowSeconds: 30 });
      expect(await inTenant((tx) => store.receive(tx, input))).toMatchObject({ duplicate: false });
      await expect(inTenant((tx) => store.receive(tx, { ...input, eventKey: 'evt-10', now: () => NOW + 31 }))).rejects.toMatchObject({ code: 'REPLAY_WINDOW_EXCEEDED' });
    });

    it('stores the hash and the pointer of a good callback, the key that signed it and the tenant of the transaction', async () => {
      const received = await inTenant((tx) => store.receive(tx, signedCallback('evt-1', 'ACCEPTED')));
      expect(received).toMatchObject({ duplicate: false, signatureKeyId: 'k1' });
      const [row] = await admin<object>(
        'select tenant_id, status, payload_hash, payload_reference, provider_event_type, channel_account_id, signature_key_id from machvon.integration_event_inbox',
      );
      expect(row).toEqual({
        tenant_id: TENANT_A,
        status: 'RECEIVED',
        payload_hash: createHash('sha256').update('{"id":"evt-1","status":"ACCEPTED"}').digest('hex'),
        payload_reference: 'object://callbacks/evt-1',
        provider_event_type: 'message.status',
        channel_account_id: null,
        signature_key_id: 'k1',
      });
    });
  });

  describe('uncertain results', () => {
    it('moves a lost acknowledgement to UNCERTAIN with a reconciliation task and an outbox event, not a retry (AC-ST-KERNEL-071-3)', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const marked = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION, detail: 'acknowledgement lost after the request', now: new Date('2026-10-24T03:00:00Z') }));
      expect(marked).toMatchObject({ outcome: 'APPLIED' });
      expect(await statusOf()).toBe('UNCERTAIN');
      const tasks = await inTenant((tx) => store.openTasks(tx, 10));
      expect(tasks).toEqual([{ id: marked.taskId, itemId: marked.itemId, reason: 'RESULT_UNCERTAIN', detail: 'acknowledgement lost after the request', dueAt: `2026-10-25T03:00:00.000000Z` }]);
      expect(RECONCILIATION_DUE_SECONDS).toBe(86_400);
      const events = await admin<{ type: string; event_key: string; aggregate_id: string; payload: Record<string, unknown> }>(
        'select type, event_key, aggregate_id, payload from machvon.outbox_event',
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: RESULT_UNCERTAIN_EVENT, aggregate_id: marked.itemId, event_key: `provider-uncertain:${marked.itemId}:2` });
      expect(events[0]?.payload).toEqual({ provider: 'ZALO_ZNS', subject_type: 'channel_message', subject_id: MESSAGE_1, task_id: marked.taskId });
    });

    it('does not open a second task or event when the result is reported uncertain again', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const first = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION }));
      const second = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION }));
      expect(second).toMatchObject({ outcome: 'DUPLICATE', taskId: first.taskId });
      expect(await admin('select id from machvon.outbox_event')).toHaveLength(1);
      expect(await admin('select id from machvon.provider_reconciliation_task')).toHaveLength(1);
    });

    it('leaves an item that already moved on alone', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      await receiveAndApply('evt-1', 'DELIVERED');
      const marked = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION }));
      expect(marked).toMatchObject({ outcome: 'STALE', taskId: null });
      expect(await statusOf()).toBe('DELIVERED');
      expect(await admin('select id from machvon.outbox_event')).toHaveLength(0);
    });

    it('needs UNCERTAIN in the table and a tracked item', async () => {
      await inTenant((tx) => store.track(tx, REF, WITHOUT_UNCERTAIN));
      await expect(inTenant((tx) => store.markUncertain(tx, { ref: REF, table: WITHOUT_UNCERTAIN, correlationId: CORRELATION }))).rejects.toThrow('UNCERTAIN');
      await expect(inTenant((tx) => store.markUncertain(tx, { ref: { ...REF, subjectId: MESSAGE_2 }, table: DELIVERY, correlationId: CORRELATION }))).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    });

    it('lets a late callback resolve the uncertainty, and a person confirm it', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const marked = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION }));
      expect((await receiveAndApply('evt-1', 'ACCEPTED')).applied?.outcome).toBe('APPLIED');
      const resolved = await inTenant((tx) => store.resolveTask(tx, { taskId: marked.taskId ?? '', table: DELIVERY, status: 'ACCEPTED', note: 'confirmed at the provider console', resolvedBy: REVIEWER }));
      expect(resolved).toEqual({ itemId: marked.itemId, status: 'ACCEPTED' });
      expect(await inTenant((tx) => store.openTasks(tx, 10))).toHaveLength(0);
    });

    it('lets a person resolve an uncertain item to what the provider holds, with a history row', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const marked = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION }));
      const resolved = await inTenant((tx) => store.resolveTask(tx, { taskId: marked.taskId ?? '', table: DELIVERY, status: 'FAILED', note: 'the provider never saw the request', resolvedBy: REVIEWER }));
      expect(resolved.status).toBe('FAILED');
      const history = await inTenant((tx) => store.history(tx, marked.itemId));
      expect(history.map((row) => [row.toStatus, row.cause])).toEqual([
        ['SENDING', 'CREATED'],
        ['UNCERTAIN', 'UNCERTAIN'],
        ['FAILED', 'RECONCILED'],
      ]);
      const [task] = await admin<{ status: string; resolved_status: string; resolved_by: string }>('select status, resolved_status, resolved_by from machvon.provider_reconciliation_task');
      expect(task).toEqual({ status: 'RESOLVED', resolved_status: 'FAILED', resolved_by: REVIEWER });
    });

    it('refuses a resolution that is short of a note, closed, backwards, unknown or "still unknown"', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const marked = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION }));
      const taskId = marked.taskId ?? '';
      const resolve = (status: string, note = 'checked with the provider') => inTenant((tx) => store.resolveTask(tx, { taskId, table: DELIVERY, status, note, resolvedBy: REVIEWER }));
      await expect(resolve('ACCEPTED', 'short')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      await expect(resolve('UNCERTAIN')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      await expect(resolve('BOUNCED')).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
      await expect(resolve('SENDING')).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      await resolve('ACCEPTED');
      await expect(resolve('DELIVERED')).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      await expect(inTenant((tx) => store.resolveTask(tx, { taskId: CORRELATION, table: DELIVERY, status: 'ACCEPTED', note: 'checked with the provider', resolvedBy: REVIEWER }))).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
      });
    });
  });

  describe('failed processing', () => {
    it('backs off a failed event and parks it as DEAD after the last attempt', async () => {
      const received = await inTenant((tx) => store.receive(tx, signedCallback('evt-1', 'ACCEPTED')));
      for (let attempt = 1; attempt < INBOX_MAX_ATTEMPTS; attempt += 1) {
        expect(await inTenant((tx) => store.failEvent(tx, received.inboxId, 'PROCESSING_FAILED'))).toBe('FAILED');
      }
      const [failed] = await admin<{ attempts: number; status: string; error_code: string; waits: boolean }>(
        "select attempts, status, error_code, next_attempt_at > now() + interval '200 seconds' as waits from machvon.integration_event_inbox",
      );
      expect(failed).toEqual({ attempts: 9, status: 'FAILED', error_code: 'PROCESSING_FAILED', waits: true });
      expect(await inTenant((tx) => store.failEvent(tx, received.inboxId, 'PROCESSING_FAILED'))).toBe('DEAD');
      await expect(inTenant((tx) => store.failEvent(tx, received.inboxId, 'PROCESSING_FAILED'))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
      await expect(inTenant((tx) => store.failEvent(tx, CORRELATION, 'PROCESSING_FAILED'))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('applies an event that failed before once it is tried again', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const received = await inTenant((tx) => store.receive(tx, signedCallback('evt-1', 'ACCEPTED')));
      await inTenant((tx) => store.failEvent(tx, received.inboxId, 'PROCESSING_FAILED'));
      const applied = await inTenant((tx) => store.applyEvent(tx, { inboxId: received.inboxId, ref: REF, table: DELIVERY, status: 'ACCEPTED', occurredAt: new Date() }));
      expect(applied.outcome).toBe('APPLIED');
      await expect(inTenant((tx) => store.failEvent(tx, received.inboxId, 'PROCESSING_FAILED'))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
    });
  });

  describe('isolation and guards', () => {
    it('keeps the same subject of two tenants apart', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      await inTenant((tx) => store.track(tx, REF, DELIVERY), TENANT_B);
      await receiveAndApply('evt-1', 'DELIVERED');
      expect(await statusOf()).toBe('DELIVERED');
      expect((await inTenant((tx) => store.find(tx, REF), TENANT_B))?.status).toBe('SENDING');
      const item = await inTenant((tx) => store.find(tx, REF));
      expect(await inTenant((tx) => store.history(tx, item?.id ?? ''), TENANT_B)).toHaveLength(0);
      expect(await inTenant((tx) => store.openTasks(tx, 10), TENANT_B)).toHaveLength(0);
    });

    it('never lets the runtime role change or remove history, or remove items and tasks', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      for (const statement of [
        'update machvon.provider_status_history set to_status = $1',
        'delete from machvon.provider_status_history',
        'delete from machvon.provider_status_item',
        'delete from machvon.provider_reconciliation_task',
      ]) {
        await expect(inTenant((tx) => tx.query(statement, statement.startsWith('update') ? ['DELIVERED'] : []))).rejects.toMatchObject({ code: '42501' });
      }
    });

    it('rejects a jump in version, a change of identity and a reopened task at the database', async () => {
      const item = await inTenant((tx) => store.track(tx, REF, DELIVERY));
      await expect(admin('update machvon.provider_status_item set status = $2, version = 5 where id = $1', [item.id, 'ACCEPTED'])).rejects.toMatchObject({ code: '23514' });
      await expect(admin('update machvon.provider_status_item set subject_id = $2, version = 2 where id = $1', [item.id, MESSAGE_2])).rejects.toMatchObject({ code: '23514' });
      const marked = await inTenant((tx) => store.markUncertain(tx, { ref: REF, table: DELIVERY, correlationId: CORRELATION }));
      await expect(admin("update machvon.provider_reconciliation_task set reason = 'STATUS_CONFLICT' where id = $1", [marked.taskId])).rejects.toMatchObject({ code: '23514' });
      await inTenant((tx) => store.resolveTask(tx, { taskId: marked.taskId ?? '', table: DELIVERY, status: 'ACCEPTED', note: 'checked with the provider', resolvedBy: REVIEWER }));
      await expect(admin("update machvon.provider_reconciliation_task set resolution_note = 'rewritten later' where id = $1", [marked.taskId])).rejects.toMatchObject({ code: '23514' });
      await expect(admin("update machvon.provider_reconciliation_task set status = 'OPEN' where id = $1", [marked.taskId])).rejects.toMatchObject({ code: '23514' });
    });

    it('keeps the identity of an inbox event and does not reopen a processed one', async () => {
      await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const first = await receiveAndApply('evt-1', 'ACCEPTED');
      const id = first.received.inboxId;
      await expect(admin("update machvon.integration_event_inbox set payload_hash = repeat('a', 64) where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin("update machvon.integration_event_inbox set event_key = 'other' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin("update machvon.integration_event_inbox set status = 'FAILED' where id = $1", [id])).rejects.toMatchObject({ code: '23514' });
    });

    it('lets a history row exist for a callback event once only', async () => {
      const item = await inTenant((tx) => store.track(tx, REF, DELIVERY));
      const first = await receiveAndApply('evt-1', 'ACCEPTED');
      await expect(
        admin(
          `insert into machvon.provider_status_history (tenant_id, item_id, item_version, from_status, to_status, cause, inbox_event_id, occurred_at)
           values ($1, $2, 9, 'ACCEPTED', 'DELIVERED', 'CALLBACK', $3, now())`,
          [TENANT_A, item.id, first.received.inboxId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });
});
