import { resolve } from 'node:path';
import { IDEMPOTENCY_TTL_HOURS, keyHashOf } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { IdempotencyStore } from '../src/idempotency-store';
import type { StoredResponse } from '../src/idempotency-store';
import { startMigratedTestDatabase } from '../src/migrated-test-database';
import type { TestDatabase } from '../src/test-database';
import { TenantDatabase } from '../src/tenant-database';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const MEMBER_1 = '00000000-0000-4000-8000-0000000000f1';
const MEMBER_2 = '00000000-0000-4000-8000-0000000000f2';
const ctx = (tenantId: string, membershipId: string): TenantContext => ({ tenantId, membershipId, scopeVersion: 1 });
const A1 = ctx(TENANT_A, MEMBER_1);
const A2 = ctx(TENANT_A, MEMBER_2);
const B1 = ctx(TENANT_B, MEMBER_1);

const OPERATION = 'createWidget';
const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);
const EXPIRE_NOW =
  "update machvon.idempotency_record set created_at = now() - interval '4 days', expires_at = now() - interval '1 day'";
const success = (body: unknown): StoredResponse => ({ kind: 'success', body });

interface RecordRow {
  id: string;
  status: string;
  request_hash: string;
  http_status: number | null;
  response_ref: StoredResponse;
  resource_type: string | null;
  resource_id: string | null;
  lock_seconds: number | null;
  ttl_hours: number;
}

describe('IdempotencyStore', () => {
  let database: TestDatabase;
  let pool: Pool;
  let store: IdempotencyStore;
  let tenantDb: TenantDatabase;
  let counter = 0;

  const nextKey = (): string => keyHashOf(`idempotency-key-${(counter += 1)}-${Date.now()}`);
  const input = (keyHash: string, requestHash = HASH_1, ttl: 'standard' | 'extended' = 'standard') => ({
    operation: OPERATION,
    keyHash,
    requestHash,
    ttl,
  });

  async function ownerQuery<T extends object>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = new Client({ connectionString: database.urlFor('machvon_owner') });
    await client.connect();
    try {
      await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
      return (await client.query<T>(text, params)).rows;
    } finally {
      await client.end();
    }
  }

  const recordOf = async (tenantId: string, keyHash: string): Promise<RecordRow | undefined> =>
    (
      await ownerQuery<RecordRow>(
        tenantId,
        `select id, status, request_hash, http_status, response_ref, resource_type, resource_id,
                extract(epoch from locked_until - now()) as lock_seconds,
                extract(epoch from expires_at - created_at) / 3600 as ttl_hours
           from machvon.idempotency_record where key_hash = $1`,
        [keyHash],
      )
    )[0];

  async function start(who: TenantContext, keyHash: string): Promise<string> {
    const result = await store.begin(who, input(keyHash));
    if (result.kind !== 'started') throw new Error(`expected started, got ${result.kind}`);
    return result.recordId;
  }

  beforeAll(async () => {
    database = await startMigratedTestDatabase(REPO_ROOT);
    pool = new Pool({ connectionString: database.urlFor('machvon_app') });
    tenantDb = new TenantDatabase(pool);
    store = new IdempotencyStore(tenantDb);
  }, 180_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (database) await database.stop();
  }, 60_000);

  it('starts a new key as IN_PROGRESS with a lock of about 30 seconds', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    const row = await recordOf(TENANT_A, keyHash);
    expect(row?.id).toBe(recordId);
    expect(row?.status).toBe('IN_PROGRESS');
    expect(Number(row?.lock_seconds)).toBeGreaterThan(25);
    expect(Number(row?.lock_seconds)).toBeLessThanOrEqual(30);
  });

  it('reports in_progress with a retry hint while the first request still holds the lock', async () => {
    const keyHash = nextKey();
    await start(A1, keyHash);
    expect(await store.begin(A1, input(keyHash))).toEqual({ kind: 'in_progress', retryAfterSeconds: 2 });
  });

  it('replays the stored status and body after completion, with resource references', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    const resourceId = '00000000-0000-4000-8000-0000000000aa';
    await tenantDb.withTenant(A1, (tx) =>
      store.completeInTx(tx, recordId, { httpStatus: 201, response: success({ id: 'w1', version: 5 }), resourceType: 'widget', resourceId }),
    );
    expect(await store.begin(A1, input(keyHash))).toEqual({ kind: 'replay', httpStatus: 201, response: success({ id: 'w1', version: 5 }) });
    expect(await recordOf(TENANT_A, keyHash)).toMatchObject({ status: 'COMPLETED', http_status: 201, resource_type: 'widget', resource_id: resourceId });
  });

  it('answers conflict for another request hash, while in progress and after completion (AC-ST-ADM-001-1)', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    expect(await store.begin(A1, input(keyHash, HASH_2))).toEqual({ kind: 'conflict' });
    await tenantDb.withTenant(A1, (tx) => store.completeInTx(tx, recordId, { httpStatus: 200, response: success({}) }));
    expect(await store.begin(A1, input(keyHash, HASH_2))).toEqual({ kind: 'conflict' });
  });

  it('tells a command whose commit failed to answer whether it went through: only a completed record means that the transaction committed (ST-LLM-002)', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    expect(await store.completedOutcome(A1, recordId)).toBeUndefined();
    // A transaction that completes the record and then fails leaves it as it was.
    await expect(tenantDb.withTenant(A1, async (tx) => {
      await store.completeInTx(tx, recordId, { httpStatus: 200, response: success({ ok: true }) });
      throw new Error('the commit failed');
    })).rejects.toThrow('the commit failed');
    expect(await store.completedOutcome(A1, recordId)).toBeUndefined();
    await tenantDb.withTenant(A1, (tx) => store.completeInTx(tx, recordId, { httpStatus: 200, response: success({ ok: true }) }));
    expect(await store.completedOutcome(A1, recordId)).toEqual({ httpStatus: 200, response: success({ ok: true }) });
    // A record of another tenant is not seen.
    expect(await store.completedOutcome(B1, recordId)).toBeUndefined();
  });

  it('waits for a transaction that is still committing before it says what the record holds, so that a commit in flight is not taken for a rollback', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => undefined;
    const taken = new Promise<void>((resolve) => (locked = resolve));
    // The command: it claims the record, completes it and goes on for a while before the commit is through.
    const command = tenantDb.withTenant(A1, async (tx) => {
      expect(await store.claimInTx(tx, recordId)).toBe(true);
      await store.completeInTx(tx, recordId, { httpStatus: 200, response: success({ ok: true }) });
      locked();
      await held;
    });
    await taken;
    const asked = store.completedOutcome(A1, recordId);
    let answered = false;
    void asked.then(() => (answered = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(answered).toBe(false);
    release();
    await command;
    expect(await asked).toEqual({ httpStatus: 200, response: success({ ok: true }) });
  });

  it('lets the same key start again after a retryable failure, on the same record', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    await store.finishOutsideTx(A1, recordId, { retryable: true });
    expect((await recordOf(TENANT_A, keyHash))?.status).toBe('FAILED_RETRYABLE');
    expect(await store.begin(A1, input(keyHash))).toEqual({ kind: 'started', recordId });
    expect((await recordOf(TENANT_A, keyHash))?.status).toBe('IN_PROGRESS');
  });

  it('stores a non-retryable business failure as COMPLETED and replays the problem', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    const problem: StoredResponse = { kind: 'problem', code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 8 } };
    await store.finishOutsideTx(A1, recordId, { retryable: false, httpStatus: 409, response: problem });
    expect(await store.begin(A1, input(keyHash))).toEqual({ kind: 'replay', httpStatus: 409, response: problem });
  });

  it('takes over a crashed request once its lock has passed, and keeps the conflict rule afterwards', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    await ownerQuery(TENANT_A, "update machvon.idempotency_record set locked_until = now() - interval '1 second' where id = $1", [recordId]);
    expect(await store.begin(A1, input(keyHash))).toEqual({ kind: 'started', recordId });
    expect(await store.begin(A1, input(keyHash, HASH_2))).toEqual({ kind: 'conflict' });
  });

  it('treats a record past expires_at as absent, even for another request hash', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    await tenantDb.withTenant(A1, (tx) => store.completeInTx(tx, recordId, { httpStatus: 200, response: success({ old: true }) }));
    await ownerQuery(TENANT_A, `${EXPIRE_NOW} where id = $1`, [recordId]);
    expect(await store.begin(A1, input(keyHash, HASH_2))).toEqual({ kind: 'started', recordId });
    const row = await recordOf(TENANT_A, keyHash);
    expect(row).toMatchObject({ status: 'IN_PROGRESS', request_hash: HASH_2 });
    expect(Number(row?.ttl_hours)).toBe(IDEMPOTENCY_TTL_HOURS.standard);
  });

  it('keeps keys independent per membership and per tenant', async () => {
    const keyHash = nextKey();
    const kinds = [(await store.begin(A1, input(keyHash))).kind, (await store.begin(A2, input(keyHash))).kind, (await store.begin(B1, input(keyHash))).kind];
    expect(kinds).toEqual(['started', 'started', 'started']);
    expect(await recordOf(TENANT_B, keyHash)).toBeDefined();
  });

  it('stores 72 hours for standard and 7 days for extended commands, inside the table CHECK', async () => {
    const standard = nextKey();
    const extended = nextKey();
    await store.begin(A1, input(standard, HASH_1, 'standard'));
    await store.begin(A1, input(extended, HASH_1, 'extended'));
    expect(Number((await recordOf(TENANT_A, standard))?.ttl_hours)).toBe(72);
    expect(Number((await recordOf(TENANT_A, extended))?.ttl_hours)).toBe(168);
  });

  it('lets exactly one of 20 parallel identical calls start', async () => {
    const keyHash = nextKey();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.begin(A1, input(keyHash))));
    expect(results.filter((result) => result.kind === 'started')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'in_progress')).toHaveLength(19);
  });

  it('purges only the expired rows of the tenant and returns their count', async () => {
    const expired = [nextKey(), nextKey()];
    const live = nextKey();
    for (const keyHash of [...expired, live]) await start(A1, keyHash);
    for (const keyHash of expired) await ownerQuery(TENANT_A, `${EXPIRE_NOW} where key_hash = $1`, [keyHash]);
    const otherTenantKey = nextKey();
    await start(B1, otherTenantKey);
    await ownerQuery(TENANT_B, `${EXPIRE_NOW} where key_hash = $1`, [otherTenantKey]);

    expect(await store.purgeExpired(A1)).toBe(2);
    expect(await recordOf(TENANT_A, expired[0] ?? '')).toBeUndefined();
    expect(await recordOf(TENANT_A, live)).toBeDefined();
    expect(await recordOf(TENANT_B, otherTenantKey)).toBeDefined();
  });

  it('leaves the record IN_PROGRESS when the transaction that completes it rolls back', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    await expect(
      tenantDb.withTenant(A1, async (tx) => {
        await store.completeInTx(tx, recordId, { httpStatus: 200, response: success({}) });
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    expect((await recordOf(TENANT_A, keyHash))?.status).toBe('IN_PROGRESS');
  });

  it('ignores finishOutsideTx for a record that is no longer IN_PROGRESS', async () => {
    const keyHash = nextKey();
    const recordId = await start(A1, keyHash);
    await tenantDb.withTenant(A1, (tx) => store.completeInTx(tx, recordId, { httpStatus: 200, response: success({ ok: 1 }) }));
    await store.finishOutsideTx(A1, recordId, { retryable: true });
    expect((await recordOf(TENANT_A, keyHash))?.status).toBe('COMPLETED');
  });

  describe('fencing a takeover against a command that is still running', () => {
    const expireLock = (recordId: string): Promise<unknown[]> =>
      ownerQuery(TENANT_A, "update machvon.idempotency_record set locked_until = now() - interval '1 second' where id = $1", [recordId]);

    it('answers in_progress, not started, while the original attempt holds its claim past the 30 second lock', async () => {
      const keyHash = nextKey();
      const recordId = await start(A1, keyHash);
      // The 30 second lock has already lapsed when the attempt claims its record (a slow start, a long command).
      await expireLock(recordId);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let claimed: () => void = () => undefined;
      const claimedSignal = new Promise<void>((resolve) => {
        claimed = resolve;
      });
      const original = tenantDb.withTenant(A1, async (tx) => {
        expect(await store.claimInTx(tx, recordId)).toBe(true);
        claimed();
        await held;
        await store.completeInTx(tx, recordId, { httpStatus: 200, response: success({ by: 'original' }) });
      });
      await claimedSignal;

      expect(await store.begin(A1, input(keyHash))).toEqual({ kind: 'in_progress', retryAfterSeconds: 2 });
      // The row lock does not hide a different body: the same key with another request is still a conflict.
      expect(await store.begin(A1, input(keyHash, HASH_2))).toEqual({ kind: 'conflict' });

      release();
      await original;
      expect(await store.begin(A1, input(keyHash))).toEqual({ kind: 'replay', httpStatus: 200, response: success({ by: 'original' }) });
    });

    it('refuses the claim of a stale attempt once a takeover has completed the record', async () => {
      const keyHash = nextKey();
      const staleId = await start(A1, keyHash);
      await expireLock(staleId);
      const takeoverId = await start(A1, keyHash);
      expect(takeoverId).toBe(staleId);
      await tenantDb.withTenant(A1, async (tx) => {
        expect(await store.claimInTx(tx, takeoverId)).toBe(true);
        await store.completeInTx(tx, takeoverId, { httpStatus: 200, response: success({ by: 'takeover' }) });
      });

      await tenantDb.withTenant(A1, async (tx) => {
        expect(await store.claimInTx(tx, staleId)).toBe(false);
      });
      expect((await recordOf(TENANT_A, keyHash))?.response_ref).toEqual(success({ by: 'takeover' }));
    });
  });
});
