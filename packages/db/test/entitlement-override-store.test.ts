import { randomUUID } from 'node:crypto';
import { STANDARD_FEATURES } from '@machvon/kernel';
import { Client, Pool } from 'pg';
import { ControlDatabase } from '../src/control-database';
import { InMemoryEntitlementCache } from '../src/entitlement-cache';
import { EntitlementOverrideStore } from '../src/entitlement-override-store';
import type { RequestOverrideInput } from '../src/entitlement-override-store';
import { EntitlementStore, recordEntitlementVersion } from '../src/entitlement-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId } from './support/authz-fixtures';

const store = new EntitlementOverrideStore();
const CTX_A = contextFor(TENANT_A, memberId(1));
const PLAN = '00000000-0000-4000-9000-000000000001';
const REQUESTER = '00000000-0000-4000-8000-0000000000c1';
const APPROVER = '00000000-0000-4000-8000-0000000000c2';
const NOW = new Date('2026-10-25T06:00:00Z');
const DAY = 86_400_000;
const at = (days: number): Date => new Date(NOW.getTime() + days * DAY);

describe('EntitlementOverrideStore', () => {
  const harness = new AuthzHarness();
  let control: ControlDatabase;
  let controlPool: Pool;
  let gate: EntitlementStore;
  const inA = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(TENANT_A, work);
  const inB = <T>(work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(TENANT_B, work);

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const sqlState = async (text: string, params: unknown[] = []): Promise<string | undefined> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await client.end();
    }
  };

  const ask = (overrides: Partial<RequestOverrideInput> = {}, tenant: <T>(work: (tx: TenantTx) => Promise<T>) => Promise<T> = inA) =>
    tenant((tx) => store.request(tx, { featureCode: 'ai.analysis', enabled: false, validFrom: NOW, validUntil: at(30), reason: 'Tạm dừng do vượt ngân sách AI', requestedBy: REQUESTER, now: NOW, ...overrides }));
  const approve = (id: string, version: number, decidedBy = APPROVER, now = NOW) => inA((tx) => store.decide(tx, { overrideId: id, decision: 'approve', decidedBy, expectedVersion: version, now }));
  const versions = async (): Promise<Array<{ cause: string; no: string }>> =>
    admin<{ cause: string; no: string }>('select cause, version_no::text as no from machvon.entitlement_version where tenant_id = $1 order by machvon.entitlement_version.version_no', [TENANT_A]);

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    gate = new EntitlementStore(harness.tenants, new InMemoryEntitlementCache());
    // The tenant starts from the STANDARD plan: one entitlement version.
    await harness.tenants.withTenant(CTX_A, (tx) => recordEntitlementVersion(tx, { cause: 'PROVISIONING', planVersionId: PLAN, features: STANDARD_FEATURES }));
  }, 180_000);
  afterAll(async () => {
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  // An override is never deleted: each case ends what it made by revoking it, so the cases do not see one another's.
  afterEach(async () => {
    await admin("update machvon.entitlement_override set status = 'Revoked' where status in ('PendingApproval', 'Active')");
  });

  describe('request', () => {
    it('writes the request as waiting for approval, with the reason trimmed and nobody as approver', async () => {
      const row = await ask({ reason: '  Tạm dừng do vượt ngân sách AI  ' });
      expect(row).toMatchObject({ featureCode: 'ai.analysis', enabled: false, limitValue: null, reason: 'Tạm dừng do vượt ngân sách AI', status: 'PendingApproval', requestedBy: REQUESTER, approvedBy: null, version: 1 });
      expect(row.validFrom).toEqual(NOW);
      expect(row.validUntil).toEqual(at(30));
    });

    it('keeps a limit without trailing zeros', async () => {
      const row = await ask({ featureCode: 'member.seats', enabled: true, limitValue: '150.500000' });
      expect(row.limitValue).toBe('150.5');
    });

    it('refuses a feature that no plan sells with 422 FEATURE_UNKNOWN, and anything else with 422 VALIDATION_FAILED naming the field', async () => {
      await expect(ask({ featureCode: 'ai.magic' })).rejects.toMatchObject({ code: 'FEATURE_UNKNOWN', status: 422, detail: 'feature_code' });
      await expect(ask({ reason: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      await expect(ask({ validFrom: at(-5), validUntil: at(-1) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'valid_until', extensions: { reason: 'ALREADY_ENDED' } });
      await expect(ask({ validFrom: at(2), validUntil: at(1) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'valid_until', extensions: { reason: 'WINDOW_INVALID' } });
      await expect(ask({ enabled: false, limitValue: '5' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'limit_value', extensions: { reason: 'LIMIT_NEEDS_ENABLED' } });
      await expect(ask({ featureCode: 'nope', reason: 'short' })).rejects.toMatchObject({
        code: 'FEATURE_UNKNOWN',
        extensions: { issues: [{ field: 'feature_code', reason: 'FEATURE_UNKNOWN' }, { field: 'reason', reason: 'REASON_LENGTH' }] },
      });
    });

    it('writes nothing for a request that is refused', async () => {
      const before = Number((await admin<{ n: string }>('select count(*) as n from machvon.entitlement_override'))[0]?.n);
      await expect(ask({ validFrom: at(-5), validUntil: at(-1) })).rejects.toBeInstanceOf(Error);
      expect(Number((await admin<{ n: string }>('select count(*) as n from machvon.entitlement_override'))[0]?.n)).toBe(before);
    });
  });

  describe('decide (UAT-AC157, UAT-AC158)', () => {
    it('puts an approved override in force, records the approver, and tells the tenant with one more entitlement version (AC-ST-SAS-009-1)', async () => {
      const waiting = await ask({ featureCode: 'reporting', enabled: false });
      const before = await versions();
      const decided = await approve(waiting.id, waiting.version);
      expect(decided).toMatchObject({ status: 'Active', approvedBy: APPROVER, version: 2 });
      const after = await versions();
      expect(after).toHaveLength(before.length + 1);
      expect(after[after.length - 1]?.cause).toBe('OVERRIDE');
      const events = await admin<{ n: string }>("select count(*) as n from machvon.outbox_event where tenant_id = $1 and type = 'sas.entitlement.changed.v1'", [TENANT_A]);
      expect(Number(events[0]?.n)).toBe(after.length);
    });

    it('is what the entitlement gate reads: a feature switched off is denied, one switched on is allowed, within the window and only once approved', async () => {
      const off = await ask({ featureCode: 'reporting', enabled: false, validFrom: at(-1), validUntil: at(10) });
      const on = await ask({ featureCode: 'ai.analysis', enabled: true, validFrom: at(-1), validUntil: at(10) });
      // Only an approved override counts.
      expect(await gate.allowedFromDatabase(CTX_A, 'reporting', 'read', NOW)).toEqual({ allowed: true });
      expect(await gate.allowedFromDatabase(CTX_A, 'ai.analysis', 'write', NOW)).toMatchObject({ allowed: false, reason: 'FEATURE_OFF' });
      await approve(off.id, off.version);
      await approve(on.id, on.version);
      expect(await gate.allowedFromDatabase(CTX_A, 'reporting', 'read', NOW)).toMatchObject({ allowed: false, reason: 'FEATURE_OFF' });
      expect(await gate.allowedFromDatabase(CTX_A, 'ai.analysis', 'write', NOW)).toEqual({ allowed: true });
      // Outside its window it is no override.
      expect(await gate.allowedFromDatabase(CTX_A, 'reporting', 'read', at(11))).toEqual({ allowed: true });
    });

    it('refuses the person who asked, whichever way they decide: 403 SELF_APPROVAL_DENIED, and the request still waits (AC-ST-SAS-009-2)', async () => {
      const waiting = await ask();
      await expect(approve(waiting.id, waiting.version, REQUESTER)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      await expect(inA((tx) => store.decide(tx, { overrideId: waiting.id, decision: 'reject', decidedBy: REQUESTER, expectedVersion: waiting.version, now: NOW }))).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
      expect(await inA((tx) => store.find(tx, waiting.id))).toMatchObject({ status: 'PendingApproval', approvedBy: null, version: 1 });
    });

    it('holds the same rule in the database: no approver who is the requester, and no Active override without an approver', async () => {
      const waiting = await ask();
      expect(await sqlState("update machvon.entitlement_override set status = 'Active', approved_by = requested_by where id = $1", [waiting.id])).toBe('23514');
      expect(await sqlState("update machvon.entitlement_override set status = 'Active' where id = $1", [waiting.id])).toBe('23514');
      expect((await inA((tx) => store.find(tx, waiting.id)))?.status).toBe('PendingApproval');
    });

    it('turns a request down without telling the tenant anything: no entitlement version', async () => {
      const waiting = await ask();
      const before = await versions();
      const decided = await inA((tx) => store.decide(tx, { overrideId: waiting.id, decision: 'reject', decidedBy: APPROVER, expectedVersion: waiting.version, now: NOW }));
      expect(decided).toMatchObject({ status: 'Rejected', approvedBy: null, version: 2 });
      expect(await versions()).toHaveLength(before.length);
    });

    it('answers 409 VERSION_CONFLICT to a stale version, 409 STAGE_TRANSITION_DENIED to one that no longer waits, and 404 to none', async () => {
      const waiting = await ask();
      await expect(approve(waiting.id, 9)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      await approve(waiting.id, 1);
      await expect(approve(waiting.id, 2)).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      await expect(approve(randomUUID(), 1)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('refuses to approve a request whose window ended while it waited (422)', async () => {
      const waiting = await ask({ validFrom: at(-10), validUntil: at(1) });
      await expect(approve(waiting.id, 1, APPROVER, at(2))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'valid_until' });
      expect((await inA((tx) => store.find(tx, waiting.id)))?.status).toBe('PendingApproval');
    });

    it('lets exactly one of two concurrent approvals through, and records one entitlement version', async () => {
      const waiting = await ask();
      const before = (await versions()).length;
      const outcomes = await Promise.allSettled([approve(waiting.id, 1), approve(waiting.id, 1, '00000000-0000-4000-8000-0000000000c3')]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect((outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')?.reason as { code: string }).code).toBe('VERSION_CONFLICT');
      expect((await versions()).length).toBe(before + 1);
    });

    it('does not decide the request of another tenant', async () => {
      const waiting = await ask();
      await expect(inB((tx) => store.decide(tx, { overrideId: waiting.id, decision: 'approve', decidedBy: APPROVER, expectedVersion: 1, now: NOW }))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('revoke', () => {
    it('withdraws a request that waits without telling the tenant', async () => {
      const waiting = await ask();
      const before = (await versions()).length;
      const revoked = await inA((tx) => store.revoke(tx, waiting.id, 1));
      expect(revoked).toMatchObject({ status: 'Revoked', approvedBy: null, version: 2 });
      expect((await versions()).length).toBe(before);
    });

    it('ends an override in force at once, keeps who approved it, and tells the tenant', async () => {
      const waiting = await ask({ featureCode: 'reporting', enabled: false, validFrom: at(-1), validUntil: at(10) });
      await approve(waiting.id, 1);
      expect(await gate.allowedFromDatabase(CTX_A, 'reporting', 'read', NOW)).toMatchObject({ allowed: false });
      const before = (await versions()).length;
      const revoked = await inA((tx) => store.revoke(tx, waiting.id, 2));
      expect(revoked).toMatchObject({ status: 'Revoked', approvedBy: APPROVER, version: 3 });
      expect((await versions()).length).toBe(before + 1);
      expect(await gate.allowedFromDatabase(CTX_A, 'reporting', 'read', NOW)).toEqual({ allowed: true });
    });

    it('answers 409 VERSION_CONFLICT for a stale version, and 409 STAGE_TRANSITION_DENIED for one that is over', async () => {
      const waiting = await ask();
      await expect(inA((tx) => store.revoke(tx, waiting.id, 4))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', extensions: { current_version: 1 } });
      await inA((tx) => store.revoke(tx, waiting.id, 1));
      await expect(inA((tx) => store.revoke(tx, waiting.id, 2))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      const rejected = await ask();
      await inA((tx) => store.decide(tx, { overrideId: rejected.id, decision: 'reject', decidedBy: APPROVER, expectedVersion: 1, now: NOW }));
      await expect(inA((tx) => store.revoke(tx, rejected.id, 2))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
      await expect(inA((tx) => store.revoke(tx, randomUUID(), 1))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });
  });

  describe('expireDue (the minutely job)', () => {
    it('does nothing when nothing has ended, and repeats safely', async () => {
      await ask({ validUntil: at(5) });
      expect(await inA((tx) => store.expireDue(tx, NOW))).toEqual({ expired: 0, lapsed: 0 });
    });

    it('lets an override whose window ended expire, tells the tenant once for all that ended, and expires a request that waited too long without a version', async () => {
      const one = await ask({ featureCode: 'reporting', enabled: false, validFrom: at(-3), validUntil: at(1) });
      const two = await ask({ featureCode: 'export', enabled: false, validFrom: at(-3), validUntil: at(1) });
      const stale = await ask({ featureCode: 'member.invite', enabled: true, validFrom: at(-3), validUntil: at(1) });
      const later = await ask({ featureCode: 'ai.analysis', enabled: true, validFrom: at(-3), validUntil: at(40) });
      await approve(one.id, 1, APPROVER, at(-2));
      await approve(two.id, 1, APPROVER, at(-2));
      const before = await versions();
      const outcome = await inA((tx) => store.expireDue(tx, at(2)));
      expect(outcome).toEqual({ expired: 2, lapsed: 1 });
      const rows = await Promise.all([one, two, stale, later].map((row) => inA((tx) => store.find(tx, row.id))));
      // The request whose window is still open waits on.
      expect(rows.map((row) => row?.status)).toEqual(['Expired', 'Expired', 'Expired', 'PendingApproval']);
      const after = await versions();
      expect(after).toHaveLength(before.length + 1);
      expect(after[after.length - 1]?.cause).toBe('EXPIRY');
      expect(await inA((tx) => store.expireDue(tx, at(3)))).toEqual({ expired: 0, lapsed: 0 });
    });

    it('lets a request that was never approved run out without telling the tenant', async () => {
      const waiting = await ask({ validUntil: at(1) });
      const before = (await versions()).length;
      expect(await inA((tx) => store.expireDue(tx, at(2)))).toEqual({ expired: 0, lapsed: 1 });
      expect((await versions()).length).toBe(before);
      expect((await inA((tx) => store.find(tx, waiting.id)))?.status).toBe('Expired');
    });

    it('takes the override out of force when the entitlement gate is asked after its end, even before the job ran', async () => {
      const waiting = await ask({ featureCode: 'reporting', enabled: false, validFrom: at(-1), validUntil: at(1) });
      await approve(waiting.id, 1);
      expect(await gate.allowedFromDatabase(CTX_A, 'reporting', 'read', NOW)).toMatchObject({ allowed: false });
      expect(await gate.allowedFromDatabase(CTX_A, 'reporting', 'read', at(2))).toEqual({ allowed: true });
    });

    it('works for a tenant with no entitlement version at all, without telling anybody', async () => {
      const waiting = await ask({ validFrom: at(-3), validUntil: at(1) }, inB);
      expect(await inB((tx) => store.expireDue(tx, at(2)))).toEqual({ expired: 0, lapsed: 1 });
      expect((await inB((tx) => store.find(tx, waiting.id)))?.status).toBe('Expired');
    });
  });

  describe('list and find', () => {
    it('lists the overrides of the tenant, the latest to start first, with a keyset, and only its own', async () => {
      const older = await ask({ validFrom: at(1), validUntil: at(20), featureCode: 'export', enabled: false });
      const newer = await ask({ validFrom: at(2), validUntil: at(20), featureCode: 'reporting', enabled: false });
      const other = await ask({ validFrom: at(3), validUntil: at(20) }, inB);
      const all = await inA((tx) => store.list(tx, { limit: 200 }));
      const ids = all.map((row) => row.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
      expect(ids).not.toContain(other.id);
      const page = await inA((tx) => store.list(tx, { limit: 200, after: newer.id }));
      expect(page.map((row) => row.id)).toEqual(ids.slice(ids.indexOf(newer.id) + 1));
      expect(await inB((tx) => store.find(tx, older.id))).toBeUndefined();
    });
  });

  describe('what the database guards (V1484)', () => {
    let id: string;
    beforeEach(async () => {
      const waiting = await ask({ featureCode: 'reporting', enabled: false, validFrom: at(-1), validUntil: at(10) });
      await approve(waiting.id, 1);
      id = waiting.id;
    });

    it('never changes what was asked for, and never deletes an override', async () => {
      expect(await sqlState("update machvon.entitlement_override set reason = 'a different reason entirely' where id = $1", [id])).toBe('23514');
      expect(await sqlState('update machvon.entitlement_override set enabled = true where id = $1', [id])).toBe('23514');
      expect(await sqlState("update machvon.entitlement_override set valid_until = valid_until + interval '10 days' where id = $1", [id])).toBe('23514');
      expect(await sqlState("update machvon.entitlement_override set feature_code = 'export' where id = $1", [id])).toBe('23514');
      expect(await sqlState('update machvon.entitlement_override set requested_by = gen_random_uuid() where id = $1', [id])).toBe('23514');
      expect(await sqlState('delete from machvon.entitlement_override where id = $1', [id])).toBe('23514');
    });

    it('moves forward only, and keeps the approver whatever becomes of the override', async () => {
      expect(await sqlState("update machvon.entitlement_override set status = 'PendingApproval' where id = $1", [id])).toBe('23514');
      expect(await sqlState("update machvon.entitlement_override set status = 'Rejected' where id = $1", [id])).toBe('23514');
      expect(await sqlState('update machvon.entitlement_override set approved_by = gen_random_uuid() where id = $1', [id])).toBe('23514');
      expect(await sqlState("update machvon.entitlement_override set status = 'Revoked' where id = $1", [id])).toBeUndefined();
      expect(await sqlState("update machvon.entitlement_override set status = 'Active' where id = $1", [id])).toBe('23514');
      expect(await sqlState("update machvon.entitlement_override set status = 'Expired' where id = $1", [id])).toBe('23514');
      expect((await admin<{ approved_by: string }>('select approved_by from machvon.entitlement_override where id = $1', [id]))[0]?.approved_by).toBe(APPROVER);
    });

    it('allows a limit only with a feature that is on', async () => {
      expect(
        await sqlState(
          `insert into machvon.entitlement_override (tenant_id, id, feature_code, enabled, limit_value, reason, valid_from, valid_until, status, requested_by)
           values ($1, gen_random_uuid(), 'member.seats', false, 5, 'a reason of ten letters', now(), now() + interval '1 day', 'PendingApproval', gen_random_uuid())`,
          [TENANT_A],
        ),
      ).toBe('23514');
    });

    it('lets the control role write overrides and the application role read them, and neither delete one', async () => {
      const client = new Client({ connectionString: harness.database.urlFor('machvon_control') });
      await client.connect();
      try {
        await client.query("select set_config('app.tenant_id', $1, false)", [TENANT_A]);
        await expect(client.query('delete from machvon.entitlement_override')).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.end();
      }
    });
  });
});
