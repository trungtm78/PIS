import { Client } from 'pg';
import { RESTORE_STALLED_AFTER_MS, recoveryWindowEndingAt, restoreReportReference, verifyRestore, canonicalJson, sha256Hex } from '@machvon/kernel';
import type { RecoveryWindow, RestoreVerificationReport } from '@machvon/kernel';
import type { ApprovalEffects } from '../src/approval-store';
import { TenantRestoreStore } from '../src/tenant-restore-store';
import type { RestoreRow } from '../src/tenant-restore-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from './support/authz-fixtures';

const store = new TenantRestoreStore();
const PLACEMENT = '00000000-0000-4000-8000-0000000000b2';
const ASKER = memberId(1);
const DECIDER = memberId(2);
const NOW = new Date('2026-11-03T03:00:00Z');
const WINDOW = recoveryWindowEndingAt(NOW);
const POINT = new Date('2026-11-01T02:00:00Z');
const REASON = 'A wrong import at noon must be undone for the province.';
const hours = (n: number, from = NOW): Date => new Date(from.getTime() + n * 3_600_000);

interface Recorded {
  audits: Array<{ action: string; resourceId: string; diff: unknown }>;
  events: Array<{ type: string; eventKey: string; payload: unknown }>;
}

function recorder(actor = ASKER): ApprovalEffects & Recorded {
  const audits: Recorded['audits'] = [];
  const events: Recorded['events'] = [];
  return {
    actor,
    audits,
    events,
    audit: async (entry) => void audits.push({ action: entry.action, resourceId: entry.resourceId, diff: entry.diff }),
    emit: async (event) => void events.push({ type: event.type, eventKey: event.eventKey, payload: event.payload }),
  };
}

const matching = (rowsOfNote = 4): RestoreVerificationReport => {
  const measured = { tables: { note: { rows: rowsOfNote, checksum: 'abc', money: { amount_vnd: '1500' } } } };
  return verifyRestore(measured, { ...measured, foreignRows: 0 }, { recoveryPoint: POINT, restoredTo: POINT, approvedAt: NOW, verifiedAt: hours(0.1) });
};

describe('the restore of one tenant (ST-SAS-019, SAS.md 3.11)', () => {
  const harness = new AuthzHarness();
  const asTenant = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: ASKER, scopeVersion: 0 }, work);
  const snapshotOf = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => harness.tenants.withSnapshot({ tenantId: tenant, membershipId: ASKER, scopeVersion: 0 }, work);

  const admin = async <T extends object = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };
  const sqlError = async (text: string, params: unknown[] = []): Promise<{ code: string | undefined; message: string } | undefined> => {
    const client = new Client({ connectionString: harness.database.adminUrl });
    await client.connect();
    try {
      await client.query(text, params);
      return undefined;
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    } finally {
      await client.end();
    }
  };

  /** Each test gets a tenant of its own: only one in-place restore is open for a tenant. */
  let counter = 0;
  async function tenant(status = 'Active', reason: string | null = null): Promise<string> {
    counter += 1;
    const id = `00000000-0000-4000-8000-${(0xf000 + counter).toString(16).padStart(12, '0')}`;
    await admin("insert into machvon.tenant (id, code, name, status, placement_id, region, lifecycle_reason) values ($1, $2, $2, $3, $4, 'vn-north', $5)", [id, `restore-${counter}`, status, PLACEMENT, reason]);
    return id;
  }
  const suspended = (): Promise<string> => tenant('Suspended', 'NON_PAYMENT');

  const request = (tenantId: string, overrides: Partial<{ recoveryPoint: Date; target: 'SANDBOX' | 'IN_PLACE'; reason: string; window: RecoveryWindow | undefined; requestedBy: string; now: Date }> = {}, effects = recorder()) =>
    asTenant(tenantId, (tx) => store.request(tx, effects, { recoveryPoint: POINT, target: 'SANDBOX', reason: REASON, requestedBy: ASKER, window: WINDOW, now: NOW, ...overrides }));

  const decide = (tenantId: string, restore: RestoreRow, overrides: Partial<Parameters<TenantRestoreStore['decide']>[2]> = {}, effects = recorder(DECIDER)) =>
    asTenant(tenantId, (tx) =>
      store.decide(tx, effects, { restoreId: restore.id, decision: 'approve', decidedBy: DECIDER, reason: 'The incident is confirmed.', evidenceIds: [], expectedVersion: restore.version, window: WINDOW, now: hours(1), ...overrides }),
    );

  const approved = async (tenantId: string, overrides: Parameters<typeof request>[1] = {}): Promise<RestoreRow> => decide(tenantId, await request(tenantId, overrides));

  beforeAll(async () => {
    await harness.start();
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active') on conflict do nothing", [PLACEMENT]);
    for (const [id, code] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b']] as const) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north') on conflict (id) do nothing", [id, code, PLACEMENT]);
    }
    await harness.seedUnits(TENANT_A, [{ n: 1, path: '/u1/' }, { n: 2, path: '/u2/' }]);
    await harness.seedUnits(TENANT_B, [{ n: 1, path: '/u1/' }]);
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the request', () => {
    it('AC-ST-SAS-019-1 UAT-AC171: waits for a second administrator, audits, and keeps what was asked for', async () => {
      const tenantId = await tenant();
      const effects = recorder();
      const restore = await request(tenantId, { reason: `  ${REASON}  ` }, effects);
      expect(restore).toMatchObject({
        status: 'Requested',
        target: 'SANDBOX',
        reason: REASON,
        requestedBy: ASKER,
        requestedAt: NOW,
        recoveryPoint: POINT,
        version: 1,
        decidedBy: null,
        approvedBy: null,
        report: null,
        verificationReportRef: null,
        sandboxRef: null,
        errorCode: null,
      });
      expect(effects.audits).toEqual([{ action: 'tenant.restore_requested', resourceId: restore.id, diff: { target: 'SANDBOX', recovery_point: POINT.toISOString() } }]);
      expect(effects.events).toEqual([]);
    });

    it('AC-ST-SAS-019-1 UAT-AC171: a sandbox is made for a tenant that has data, an in-place restore only while the tenant is Suspended (409 TENANT_STATE_INVALID)', async () => {
      for (const [status, reason] of [['Active', null], ['Suspended', 'NON_PAYMENT'], ['Offboarding', null]] as const) {
        expect((await request(await tenant(status, reason))).status).toBe('Requested');
      }
      for (const [status, reason] of [['Archived', null], ['Provisioning', null], ['Requested', null]] as const) {
        await expect(request(await tenant(status, reason))).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', status: 409, detail: status });
      }
      expect((await request(await suspended(), { target: 'IN_PLACE' })).target).toBe('IN_PLACE');
      for (const [status, reason] of [['Active', null], ['Offboarding', null]] as const) {
        await expect(request(await tenant(status, reason), { target: 'IN_PLACE' })).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', status: 409, detail: status });
      }
      const refused = await tenant();
      await expect(request(refused, { target: 'IN_PLACE' })).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID' });
      expect(await admin('select id from machvon.tenant_restore_request where tenant_id = $1', [refused])).toEqual([]);
    });

    it('holds a recovery point only inside the window of the backups, ends included, and none at all when the engine holds none (422 RECOVERY_POINT_UNAVAILABLE)', async () => {
      const tenantId = await tenant();
      expect((await request(tenantId, { recoveryPoint: WINDOW.earliest })).recoveryPoint).toEqual(WINDOW.earliest);
      expect((await request(tenantId, { recoveryPoint: WINDOW.latest })).recoveryPoint).toEqual(WINDOW.latest);
      for (const recoveryPoint of [new Date(WINDOW.earliest.getTime() - 1000), new Date(WINDOW.latest.getTime() + 1000)]) {
        await expect(request(tenantId, { recoveryPoint })).rejects.toMatchObject({ code: 'RECOVERY_POINT_UNAVAILABLE', status: 422 });
      }
      await expect(request(tenantId, { window: undefined })).rejects.toMatchObject({ code: 'RECOVERY_POINT_UNAVAILABLE', status: 422 });
    });

    it('refuses a reason that is too short or too long and a recovery point that is not an instant (422 VALIDATION_FAILED naming the field)', async () => {
      const tenantId = await tenant();
      await expect(request(tenantId, { reason: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason' });
      await expect(request(tenantId, { reason: 'x'.repeat(2001) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      await expect(request(tenantId, { recoveryPoint: new Date('nonsense') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', detail: 'recovery_point' });
    });

    it('AC-ST-SAS-019-1: one in-place restore at a time for a tenant (409 RESTORE_IN_PROGRESS) until it ends; sandbox restores run side by side', async () => {
      const tenantId = await suspended();
      const first = await request(tenantId, { target: 'IN_PLACE' });
      await expect(request(tenantId, { target: 'IN_PLACE' })).rejects.toMatchObject({ code: 'RESTORE_IN_PROGRESS', status: 409 });
      expect((await request(tenantId)).target).toBe('SANDBOX');
      expect((await request(tenantId)).target).toBe('SANDBOX');
      await decide(tenantId, first, { decision: 'reject' });
      expect((await request(tenantId, { target: 'IN_PLACE' })).status).toBe('Requested');
    });
  });

  describe('the decision', () => {
    it('AC-ST-SAS-019-1 UAT-AC171: a second administrator approves, and the approval is audited with the evidence', async () => {
      const tenantId = await tenant();
      const effects = recorder(DECIDER);
      const requested = await request(tenantId);
      const evidence = ['00000000-0000-4000-8000-0000000000e1'];
      const done = await decide(tenantId, requested, { evidenceIds: evidence, reason: '  The incident is confirmed.  ' }, effects);
      expect(done).toMatchObject({ status: 'Approved', decidedBy: DECIDER, approvedBy: DECIDER, decidedAt: hours(1), decisionReason: 'The incident is confirmed.', version: 2 });
      expect(effects.audits).toEqual([{ action: 'tenant.restore_decided', resourceId: requested.id, diff: { decision: 'approve', target: 'SANDBOX', requested_by: ASKER, evidence_ids: evidence } }]);
    });

    it('turning a request down leaves no approver and never starts a restore', async () => {
      const tenantId = await tenant();
      const rejected = await decide(tenantId, await request(tenantId), { decision: 'reject' });
      expect(rejected).toMatchObject({ status: 'Rejected', decidedBy: DECIDER, approvedBy: null });
      expect(await asTenant(tenantId, (tx) => store.claim(tx, NOW))).toBeUndefined();
    });

    it('AC-ST-SAS-019-1: the person who asked cannot decide, either way (403 SELF_APPROVAL_DENIED), and the request stays as it was', async () => {
      const tenantId = await tenant();
      const requested = await request(tenantId);
      for (const decision of ['approve', 'reject'] as const) {
        await expect(decide(tenantId, requested, { decision, decidedBy: ASKER.toUpperCase() })).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      }
      expect(await asTenant(tenantId, (tx) => store.find(tx, requested.id))).toMatchObject({ status: 'Requested', version: 1, decidedBy: null });
    });

    it('refuses a stale version (409 VERSION_CONFLICT), a request that was decided (409 STAGE_TRANSITION_DENIED) and one that does not exist (404)', async () => {
      const tenantId = await tenant();
      const requested = await request(tenantId);
      await expect(decide(tenantId, requested, { expectedVersion: 7 })).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const done = await decide(tenantId, requested);
      await expect(decide(tenantId, done)).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', status: 409 });
      await expect(decide(tenantId, { ...requested, id: '00000000-0000-4000-8000-0000000000ff' })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('AC-ST-SAS-019-1: asks again for the state of the tenant when it approves (an in-place restore of a tenant resumed meanwhile is 409 TENANT_STATE_INVALID); a rejection needs no state', async () => {
      const tenantId = await suspended();
      const requested = await request(tenantId, { target: 'IN_PLACE' });
      await admin("update machvon.tenant set status = 'Active', lifecycle_reason = null, version = version + 1 where id = $1", [tenantId]);
      await expect(decide(tenantId, requested)).rejects.toMatchObject({ code: 'TENANT_STATE_INVALID', status: 409 });
      expect(await decide(tenantId, requested, { decision: 'reject' })).toMatchObject({ status: 'Rejected' });
    });

    it('asks again for the recovery point when it approves: one that left the window of the backups while it waited is 422 RECOVERY_POINT_UNAVAILABLE', async () => {
      const tenantId = await tenant();
      const requested = await request(tenantId, { recoveryPoint: WINDOW.earliest });
      const later = recoveryWindowEndingAt(hours(48));
      await expect(decide(tenantId, requested, { window: later })).rejects.toMatchObject({ code: 'RECOVERY_POINT_UNAVAILABLE', status: 422 });
      await expect(decide(tenantId, requested, { window: undefined })).rejects.toMatchObject({ code: 'RECOVERY_POINT_UNAVAILABLE' });
      expect(await decide(tenantId, requested, { decision: 'reject', window: undefined })).toMatchObject({ status: 'Rejected' });
    });
  });

  describe('the restore, as the worker makes it', () => {
    it('AC-ST-SAS-019-1 UAT-AC171 AC-ST-SAS-019-2 OPS01: Approved, Restoring, Verifying and Completed with the report, its reference, the event and the audit', async () => {
      const tenantId = await tenant();
      const decided = await approved(tenantId);
      const effects = recorder('00000000-0000-4000-8000-000000000000');
      const claimed = await asTenant(tenantId, (tx) => store.claim(tx, hours(2)));
      expect(claimed).toMatchObject({ id: decided.id, status: 'Restoring', startedAt: hours(2), version: 3 });
      expect(await asTenant(tenantId, (tx) => store.claim(tx, hours(2)))).toBeUndefined();
      const verifying = await asTenant(tenantId, (tx) => store.restored(tx, decided.id, { restoredTo: POINT, sandboxRef: 'sandbox/1' }));
      expect(verifying).toMatchObject({ status: 'Verifying', restoredTo: POINT, sandboxRef: 'sandbox/1', version: 4 });
      const report = matching();
      const done = await asTenant(tenantId, (tx) => store.complete(tx, effects, decided.id, report, hours(3)));
      expect(done).toMatchObject({ status: 'Completed', completedAt: hours(3), verificationReportRef: restoreReportReference(report), version: 5 });
      expect(done.report).toEqual(report);
      // The record of the drill: the reference is the sha256 of the report as it is stored.
      const [stored] = await admin<{ verification_report: unknown; verification_report_ref: string }>('select verification_report, verification_report_ref from machvon.tenant_restore_request where id = $1', [decided.id]);
      expect(stored?.verification_report_ref).toBe(`sha256:${sha256Hex(canonicalJson(stored?.verification_report))}`);
      expect(effects.audits).toEqual([
        {
          action: 'tenant.restore_completed',
          resourceId: decided.id,
          diff: { target: 'SANDBOX', tables: 1, rows: 4, rpo_seconds: 0, rto_seconds: 360, within_targets: true, report_ref: done.verificationReportRef },
        },
      ]);
      expect(effects.events).toEqual([{ type: 'sas.tenant_restore.completed.v1', eventKey: `tenant_restore:${decided.id}:completed`, payload: { restore_id: decided.id, target: 'SANDBOX', within_targets: true } }]);
    });

    it('AC-ST-SAS-019-2 OPS01: a report that did not match cannot complete a restore, and it ends as Failed with the report and the class of the failure', async () => {
      const tenantId = await tenant();
      const decided = await approved(tenantId);
      await asTenant(tenantId, (tx) => store.claim(tx, hours(2)));
      await asTenant(tenantId, (tx) => store.restored(tx, decided.id, { restoredTo: POINT, sandboxRef: 'sandbox/2' }));
      const bad = verifyRestore({ tables: { note: { rows: 4, checksum: 'abc', money: {} } } }, { tables: { note: { rows: 3, checksum: 'abc', money: {} } }, foreignRows: 0 }, { recoveryPoint: POINT, restoredTo: POINT, approvedAt: NOW, verifiedAt: hours(3) });
      expect(bad.matched).toBe(false);
      await expect(asTenant(tenantId, (tx) => store.complete(tx, recorder(), decided.id, bad, hours(3)))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED', detail: 'REPORT_NOT_MATCHED' });
      const effects = recorder();
      await asTenant(tenantId, (tx) => store.fail(tx, effects, decided.id, 'VERIFICATION_MISMATCH', hours(3), bad));
      const failed = await asTenant(tenantId, (tx) => store.find(tx, decided.id));
      expect(failed).toMatchObject({ status: 'Failed', errorCode: 'VERIFICATION_MISMATCH', completedAt: hours(3), verificationReportRef: restoreReportReference(bad) });
      expect(failed?.report?.mismatches).toEqual(['rows:note']);
      expect(effects.audits).toEqual([{ action: 'tenant.restore_failed', resourceId: decided.id, diff: { error_code: 'VERIFICATION_MISMATCH', mismatches: 1 } }]);
      expect(effects.events).toEqual([]);
    });

    it('a failure without a report keeps the class of the failure only; a restore that has ended is left as it is; one that is not Verifying cannot be completed', async () => {
      const tenantId = await tenant();
      const decided = await approved(tenantId);
      await expect(asTenant(tenantId, (tx) => store.complete(tx, recorder(), decided.id, matching(), hours(3)))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
      await expect(asTenant(tenantId, (tx) => store.restored(tx, decided.id, { restoredTo: POINT, sandboxRef: null }))).rejects.toMatchObject({ code: 'STAGE_TRANSITION_DENIED' });
      const effects = recorder();
      await asTenant(tenantId, (tx) => store.fail(tx, effects, decided.id, 'RestoreEngineUnbound', hours(3)));
      expect(await asTenant(tenantId, (tx) => store.find(tx, decided.id))).toMatchObject({ status: 'Failed', errorCode: 'RestoreEngineUnbound', report: null, verificationReportRef: null });
      await asTenant(tenantId, (tx) => store.fail(tx, effects, decided.id, 'Other', hours(4)));
      expect((await asTenant(tenantId, (tx) => store.find(tx, decided.id)))?.errorCode).toBe('RestoreEngineUnbound');
      expect(effects.audits.map((entry) => entry.action)).toEqual(['tenant.restore_failed']);
    });

    it('takes the oldest approved restore first, and two workers that ask at the same time get different ones', async () => {
      const tenantId = await tenant();
      const [first, second, third] = [await approved(tenantId, { now: hours(-3) }), await approved(tenantId, { now: hours(-2) }), await approved(tenantId, { now: hours(-1) })];
      expect((await asTenant(tenantId, (tx) => store.claim(tx, hours(2))))?.id).toBe(first.id);
      const [one, two] = await Promise.all([asTenant(tenantId, (tx) => store.claim(tx, hours(2))), asTenant(tenantId, (tx) => store.claim(tx, hours(2)))]);
      expect([one?.id, two?.id].sort()).toEqual([second.id, third.id].sort());
      expect(await asTenant(tenantId, (tx) => store.claim(tx, hours(2)))).toBeUndefined();
    });

    it('ends a restore lost with its process as Failed (Stalled) once the time to recover and two hours more have passed, and counts the backlog and the failures of the last day', async () => {
      const tenantId = await tenant();
      const lost = await approved(tenantId, { now: hours(-3) });
      const running = await approved(tenantId, { now: hours(-2.5) });
      const young = await approved(tenantId, { now: hours(-2) });
      const waiting = await approved(tenantId, { now: hours(-1) });
      const at = new Date(NOW.getTime() + RESTORE_STALLED_AFTER_MS);
      // Started at the instant the limit counts from (lost), two hours into its time, and at the moment of the pass.
      await asTenant(tenantId, (tx) => store.claim(tx, NOW));
      await asTenant(tenantId, (tx) => store.claim(tx, hours(2)));
      await asTenant(tenantId, (tx) => store.claim(tx, at));
      expect(await asTenant(tenantId, (tx) => store.counts(tx, at))).toEqual({ pending: 4, failed: 0 });
      const effects = recorder();
      expect(await asTenant(tenantId, (tx) => store.sweepStalled(tx, effects, at))).toEqual([lost.id]);
      expect(await asTenant(tenantId, (tx) => store.find(tx, lost.id))).toMatchObject({ status: 'Failed', errorCode: 'Stalled' });
      for (const still of [running, young]) expect((await asTenant(tenantId, (tx) => store.find(tx, still.id)))?.status).toBe('Restoring');
      expect((await asTenant(tenantId, (tx) => store.find(tx, waiting.id)))?.status).toBe('Approved');
      expect(await asTenant(tenantId, (tx) => store.counts(tx, at))).toEqual({ pending: 3, failed: 1 });
      expect(await asTenant(tenantId, (tx) => store.counts(tx, hours(25, at)))).toEqual({ pending: 3, failed: 0 });
      expect(effects.audits).toEqual([{ action: 'tenant.restore_failed', resourceId: lost.id, diff: { error_code: 'Stalled', mismatches: 0 } }]);
    });

    it('lists the restores of the tenant, the newest first, a page at a time, and finds one by its id; another tenant sees none of them', async () => {
      const tenantId = await tenant();
      const first = await request(tenantId, {}, recorder());
      const second = await asTenant(tenantId, (tx) => store.request(tx, recorder(), { recoveryPoint: POINT, target: 'SANDBOX', reason: REASON, requestedBy: ASKER, window: WINDOW, now: hours(1) }));
      const third = await asTenant(tenantId, (tx) => store.request(tx, recorder(), { recoveryPoint: POINT, target: 'SANDBOX', reason: REASON, requestedBy: ASKER, window: WINDOW, now: hours(2) }));
      const page = await asTenant(tenantId, (tx) => store.list(tx, { limit: 2 }));
      expect(page.map((row) => row.id)).toEqual([third.id, second.id]);
      const next = await asTenant(tenantId, (tx) => store.list(tx, { limit: 2, after: { requestedAt: second.requestedAt.toISOString(), id: second.id } }));
      expect(next.map((row) => row.id)).toEqual([first.id]);
      expect(await asTenant(TENANT_B, (tx) => store.find(tx, first.id))).toBeUndefined();
      expect(await asTenant(TENANT_B, (tx) => store.list(tx, { limit: 10 }))).toEqual([]);
      await expect(asTenant(TENANT_B, (tx) => store.decide(tx, recorder(), { restoreId: first.id, decision: 'approve', decidedBy: DECIDER, reason: REASON, evidenceIds: [], expectedVersion: 1, window: WINDOW, now: NOW }))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    });

    it('finds the tenant of a restore by its id alone, for the decision that names nothing else', async () => {
      const tenantId = await tenant();
      const restore = await request(tenantId);
      const client = new Client({ connectionString: harness.database.urlFor('machvon_control') });
      await client.connect();
      try {
        const answer = async (id: string): Promise<string | null> => ((await client.query('select machvon.restore_tenant_of($1::uuid) as tenant_id', [id])).rows[0] as { tenant_id: string | null }).tenant_id;
        expect(await answer(restore.id)).toBe(tenantId);
        expect(await answer('00000000-0000-4000-8000-0000000000fe')).toBeNull();
      } finally {
        await client.end();
      }
    });
  });

  describe('what the database holds whatever the application did', () => {
    const raw = (restoreId: string, set: string, params: unknown[] = []) => sqlError(`update machvon.tenant_restore_request set ${set} where id = $1`, [restoreId, ...params]);

    it('AC-ST-SAS-019-1: never deletes a restore, and does not let what was asked for or what was decided change', async () => {
      const tenantId = await tenant();
      const decided = await approved(tenantId);
      expect((await sqlError('delete from machvon.tenant_restore_request where id = $1', [decided.id]))?.message).toContain('RESTORE_IMMUTABLE');
      for (const set of ["reason = 'Another reason that is long enough'", "target = 'IN_PLACE'", "recovery_point = now()", "requested_by = '00000000-0000-4000-8000-0000000000aa'", "requested_at = now()"]) {
        expect((await raw(decided.id, set))?.message).toContain('RESTORE_IMMUTABLE: what was asked for does not change');
      }
      for (const set of ["decision_reason = 'changed'", "decided_at = now()"]) {
        expect((await raw(decided.id, set))?.message).toContain('RESTORE_IMMUTABLE: what was decided does not change');
      }
    });

    it('AC-ST-SAS-019-1: the person who decided is never the one who asked, and an approver is the person who decided', async () => {
      const tenantId = await tenant();
      const requested = await request(tenantId);
      const decidedBySelf = await raw(requested.id, `status = 'Rejected', decided_by = requested_by, decided_at = now(), decision_reason = 'myself'`);
      expect([decidedBySelf?.code, decidedBySelf?.message]).toEqual(['23514', expect.stringContaining('tenant_restore_request_decider_ck')]);
      const approverIsNotDecider = await raw(requested.id, `status = 'Approved', decided_by = $2::uuid, approved_by = $3::uuid, decided_at = now(), decision_reason = 'x'`, [DECIDER, memberId(3)]);
      expect(approverIsNotDecider?.message).toContain('tenant_restore_request_decision_ck');
      const rejectedWithApprover = await raw(requested.id, `status = 'Rejected', decided_by = $2::uuid, approved_by = $2::uuid, decided_at = now(), decision_reason = 'x'`, [DECIDER]);
      expect(rejectedWithApprover?.message).toContain('tenant_restore_request_decision_ck');
      const approvedAtOnceWithoutDecision = await raw(requested.id, `status = 'Approved'`);
      expect(approvedAtOnceWithoutDecision?.message).toContain('tenant_restore_request_decision_ck');
    });

    it('a restore moves forward only, and what has ended does not change', async () => {
      const tenantId = await tenant();
      const decided = await approved(tenantId);
      const skipped = await raw(decided.id, `status = 'Completed', started_at = now(), completed_at = now(), restored_to = now(), verification_report = '{"matched":true}'::jsonb, verification_report_ref = 'sha256:x'`);
      expect(skipped?.message).toContain('RESTORE_IMMUTABLE: a restore does not go from Approved to Completed');
      expect((await raw(decided.id, `status = 'Requested'`))?.message).toContain('does not go from Approved to Requested');
      await asTenant(tenantId, (tx) => store.fail(tx, recorder(), decided.id, 'Stopped', hours(3)));
      expect((await raw(decided.id, `error_code = 'Other'`))?.message).toContain('RESTORE_IMMUTABLE: a restore that has ended does not change');
      const rejected = await decide(tenantId, await request(tenantId), { decision: 'reject' });
      expect((await raw(rejected.id, `status = 'Approved'`))?.message).toContain('a restore that has ended does not change');
    });

    it('AC-ST-SAS-019-2 OPS01: is Completed only with a report that matched, whose reference is kept with it, and the report never changes after', async () => {
      const tenantId = await tenant();
      const decided = await approved(tenantId);
      await asTenant(tenantId, (tx) => store.claim(tx, hours(2)));
      await asTenant(tenantId, (tx) => store.restored(tx, decided.id, { restoredTo: POINT, sandboxRef: 'sandbox/3' }));
      const noReport = await raw(decided.id, `status = 'Completed', completed_at = now()`);
      expect(noReport?.message).toContain('tenant_restore_request_report_ck');
      const notMatched = await raw(decided.id, `status = 'Completed', completed_at = now(), verification_report = '{"matched":false}'::jsonb, verification_report_ref = 'sha256:x'`);
      expect(notMatched?.message).toContain('tenant_restore_request_report_ck');
      const noReference = await raw(decided.id, `verification_report = '{"matched":true}'::jsonb`);
      expect(noReference?.message).toContain('tenant_restore_request_report_ck');
      const done = await asTenant(tenantId, (tx) => store.complete(tx, recorder(), decided.id, matching(), hours(3)));
      expect(done.status).toBe('Completed');
      expect((await raw(decided.id, `verification_report_ref = 'sha256:other'`))?.message).toContain('a restore that has ended does not change');
    });

    it('a report that is set while the restore still runs cannot be replaced', async () => {
      const tenantId = await tenant();
      const decided = await approved(tenantId);
      await asTenant(tenantId, (tx) => store.claim(tx, hours(2)));
      await asTenant(tenantId, (tx) => store.restored(tx, decided.id, { restoredTo: POINT, sandboxRef: 'sandbox/4' }));
      expect(await raw(decided.id, `verification_report = '{"matched":false}'::jsonb, verification_report_ref = 'sha256:a'`)).toBeUndefined();
      expect((await raw(decided.id, `verification_report = '{"matched":true}'::jsonb, verification_report_ref = 'sha256:b'`))?.message).toContain('RESTORE_IMMUTABLE: the verification report does not change');
    });

    it('a failure names its class, an unstarted restore has no run, and only a sandbox copy has a placement', async () => {
      const tenantId = await tenant();
      const requested = await request(tenantId);
      expect((await raw(requested.id, `status = 'Failed'`))?.message).toContain('RESTORE_IMMUTABLE: a restore does not go from Requested to Failed');
      const decided = await decide(tenantId, requested);
      expect((await raw(decided.id, `sandbox_ref = 'early'`))?.message).toContain('tenant_restore_request_run_ck');
      expect((await raw(decided.id, `status = 'Failed', completed_at = now()`))?.message).toContain('tenant_restore_request_run_ck');
      expect((await raw(decided.id, `status = 'Restoring'`))?.message).toContain('tenant_restore_request_run_ck');
      const inPlace = await suspended();
      const place = await approved(inPlace, { target: 'IN_PLACE' });
      await asTenant(inPlace, (tx) => store.claim(tx, hours(2)));
      expect((await raw(place.id, `status = 'Verifying', restored_to = now(), sandbox_ref = 'not in place'`))?.message).toContain('tenant_restore_request_sandbox_ck');
    });

    it('is closed to the application role for deleting and truncating, and open to the control role for the work of the commands', async () => {
      const privileges = await admin<{ role: string; privilege: string; held: boolean }>(
        `select r.role, p.privilege, has_table_privilege(r.role, 'machvon.tenant_restore_request', p.privilege) as held
           from (values ('machvon_app'), ('machvon_control')) r(role), (values ('DELETE'), ('TRUNCATE'), ('SELECT'), ('INSERT'), ('UPDATE')) p(privilege)`,
      );
      const held = (role: string): string[] => privileges.filter((entry) => entry.role === role && entry.held).map((entry) => entry.privilege).sort();
      expect(held('machvon_app')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      expect(held('machvon_control')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    });
  });

  describe('the measure of a tenant', () => {
    beforeAll(async () => {
      await admin(`create table machvon.restore_probe (tenant_id uuid not null, id uuid not null, label text not null, amount_vnd numeric(24,0) not null default 0, share numeric(5,2) not null default 0, primary key (tenant_id, id))`);
      await admin(`alter table machvon.restore_probe enable row level security`);
      await admin(`alter table machvon.restore_probe force row level security`);
      await admin(`create policy tenant_boundary on machvon.restore_probe using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`);
      await admin(`grant select, insert, update, delete on machvon.restore_probe to machvon_app`);
    });
    afterAll(async () => {
      await admin('drop table machvon.restore_probe');
    });

    const put = (tenantId: string, n: number, label: string, amount: string, share = '0') =>
      admin('insert into machvon.restore_probe (tenant_id, id, label, amount_vnd, share) values ($1, $2, $3, $4, $5)', [tenantId, `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`, label, amount, share]);
    const measured = (tenantId: string) => snapshotOf(tenantId, (tx) => store.measure(tx));

    it('AC-ST-SAS-019-2 OPS01: counts the rows of the tenant only, sums its money columns exactly and leaves the other numeric columns out', async () => {
      const tenantId = await tenant();
      await put(tenantId, 1, 'a', '1000000');
      await put(tenantId, 2, 'b', '234567', '12.5');
      await put(TENANT_B, 3, 'c', '999999999');
      const probe = (await measured(tenantId)).tables.restore_probe;
      expect(probe).toMatchObject({ rows: 2, money: { amount_vnd: '1234567' } });
      expect(probe?.checksum).toMatch(/^[0-9a-f]{32}$/);
      expect((await measured(TENANT_B)).tables.restore_probe).toMatchObject({ rows: 1, money: { amount_vnd: '999999999' } });
      expect(Object.keys(probe?.money ?? {})).toEqual(['amount_vnd']);
    });

    it('AC-ST-SAS-019-2 OPS01: the checksum follows the content of the rows, not their order, and changes with any column', async () => {
      const one = await tenant();
      await put(one, 11, 'x', '5');
      await put(one, 12, 'y', '6');
      const before = (await measured(one)).tables.restore_probe;
      // The same rows written again in the other order (a restore writes them in the order of its own).
      await admin('delete from machvon.restore_probe where tenant_id = $1', [one]);
      await put(one, 12, 'y', '6');
      await put(one, 11, 'x', '5');
      expect((await measured(one)).tables.restore_probe).toEqual(before);
      await admin("update machvon.restore_probe set label = 'z' where tenant_id = $1 and id = $2", [one, '00000000-0000-4000-8000-00000000000b']);
      expect((await measured(one)).tables.restore_probe?.checksum).not.toBe(before?.checksum);
      expect((await measured(one)).tables.restore_probe?.rows).toBe(2);
    });

    it('measures a table with no rows and leaves out the machinery of the platform (the requests themselves, the outbox, the stored answers)', async () => {
      const tenantId = await tenant();
      await request(tenantId);
      const tables = (await measured(tenantId)).tables;
      expect(tables.restore_probe).toMatchObject({ rows: 0, money: { amount_vnd: '0' } });
      for (const machinery of ['tenant_restore_request', 'tenant_export_job', 'outbox_event', 'idempotency_record']) expect(Object.keys(tables)).not.toContain(machinery);
      expect(Object.keys(tables)).toContain('organization_unit');
      expect(Object.keys(tables)).toEqual([...Object.keys(tables)].sort());
    });

    it('is the same measure twice when nothing changed, which is what a restored copy is compared to', async () => {
      expect(await measured(TENANT_A)).toEqual(await measured(TENANT_A));
    });
  });
});
