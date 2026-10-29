import { Client, Pool } from 'pg';
import type { ApprovalEffects } from '../src/approval-store';
import { ControlDatabase } from '../src/control-database';
import { SupportAccessStore } from '../src/support-access-store';
import type { SupportGrantRow, SupportRequest } from '../src/support-access-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, memberId } from './support/authz-fixtures';

const store = new SupportAccessStore();
const OPERATOR = '00000000-0000-4000-8000-0000000000c1';
const PLACEMENT = '00000000-0000-4000-8000-0000000000b1';
const ALICE = memberId(1);
const BOB = memberId(2);
const NOW = new Date('2026-10-30T03:00:00Z');
const minutes = (n: number, from = NOW): Date => new Date(from.getTime() + n * 60_000);
const REASON = 'The customer asked for it in the ticket.';

interface Recorded {
  audits: Array<{ action: string; resourceId: string; diff: unknown }>;
  events: Array<{ type: string; eventKey: string; payload: unknown }>;
}

function recorder(actor = OPERATOR): ApprovalEffects & Recorded {
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

describe('controlled support access (ST-SAS-015, SAS.md 3.9, BR-SAS-16)', () => {
  const harness = new AuthzHarness();
  let control: ControlDatabase;
  let controlPool: Pool;
  let counter = 0;

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

  /** The operator's side: the control plane acts as the tenant. */
  const asOperator = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>): Promise<T> => control.withTenantOf(tenant, work);
  /** The tenant's side: its own transaction under the application role. */
  const asTenant = <T>(tenant: string, work: (tx: TenantTx) => Promise<T>, member = ALICE): Promise<T> => harness.tenants.withTenant({ tenantId: tenant, membershipId: member, scopeVersion: 0 }, work);

  async function ticket(tenant: string, status = 'Open'): Promise<string> {
    counter += 1;
    const code = `SUP-2026-${String(900000 + counter)}`;
    await admin(
      `insert into machvon.support_ticket (tenant_id, id, ticket_code, requester_membership_id, category, subject, description_ref, priority, status, sla_due_at)
       values ($1, gen_random_uuid(), $2, $3, 'DATA', 'Cannot open a contract', 'ref', 'P3', 'Open', now() + interval '3 days')`,
      [tenant, code, ALICE],
    );
    // A ticket starts open and is closed through the states between.
    for (const next of status === 'Open' ? [] : ['InProgress', 'Resolved', 'Closed'].slice(0, ['InProgress', 'Resolved', 'Closed'].indexOf(status) + 1)) await admin('update machvon.support_ticket set status = $3 where tenant_id = $1 and ticket_code = $2', [tenant, code, next]);
    return code;
  }

  const input = (tenant: string, ticketReference: string, overrides: Partial<SupportRequest> = {}): SupportRequest => ({
    tenantId: tenant,
    operatorId: OPERATOR,
    ticketReference,
    modules: ['CTR', 'DOC'],
    resourceIds: [],
    accessMode: 'READ_ONLY',
    durationMinutes: 60,
    reason: REASON,
    ...overrides,
  });

  const request = async (tenant: string, overrides: Partial<SupportRequest> = {}, effects = recorder()): Promise<SupportGrantRow> =>
    asOperator(tenant, async (tx) => store.request(tx, effects, input(tenant, await ticket(tenant), overrides), NOW));

  const decide = (tenant: string, grant: SupportGrantRow, approver = ALICE, extra: { decision?: 'approve' | 'reject'; startsAt?: Date; at?: Date; effects?: ApprovalEffects } = {}) =>
    asTenant(tenant, (tx) => store.decide(tx, extra.effects ?? recorder(approver), { grantId: grant.id, approverId: approver, decision: extra.decision ?? 'approve', startsAt: extra.startsAt, reason: REASON, expectedVersion: undefined }, extra.at ?? NOW), approver);

  const reload = async (tenant: string, grant: SupportGrantRow): Promise<SupportGrantRow> => (await asTenant(tenant, (tx) => store.find(tx, grant.id))) as SupportGrantRow;

  beforeAll(async () => {
    await harness.start();
    controlPool = new Pool({ connectionString: harness.database.urlFor('machvon_control'), max: 4 });
    controlPool.on('error', () => undefined);
    control = new ControlDatabase(controlPool);
    await admin("insert into machvon.placement (id, kind, region, db_cluster_ref, kms_key_ref, status) values ($1, 'POOL', 'vn-north', 'cluster-1', 'kms-1', 'Active') on conflict do nothing", [PLACEMENT]);
    for (const [tenant, code] of [[TENANT_A, 'tenant-a'], [TENANT_B, 'tenant-b']] as const) {
      await admin("insert into machvon.tenant (id, code, name, status, placement_id, region) values ($1, $2, $2, 'Active', $3, 'vn-north') on conflict (id) do nothing", [tenant, code, PLACEMENT]);
    }
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [{ n: 1, path: '/u1/' }]);
      for (const n of [1, 2]) await harness.seedMembership(tenant, n, 1);
    }
  }, 180_000);

  afterAll(async () => {
    await controlPool?.end();
    await harness.stop();
  }, 60_000);

  describe('the request', () => {
    it('is written by the operator acting as the tenant, waits for the tenant, audits and tells the platform', async () => {
      const effects = recorder();
      const grant = await request(TENANT_A, {}, effects);
      expect(grant).toMatchObject({ tenantId: TENANT_A, operatorId: OPERATOR, status: 'Requested', accessMode: 'READ_ONLY', modules: ['CTR', 'DOC'], durationMinutes: 60, ownerApprovedBy: null, startsAt: null, version: 1 });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['support_access.requested']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.support_access.requested.v1']);
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, NOW))).toBeUndefined();
    });

    it('needs a ticket of the tenant that is not closed: another tenant\'s ticket is not found, a closed one is refused', async () => {
      const ofB = await ticket(TENANT_B);
      await expect(asOperator(TENANT_A, (tx) => store.request(tx, recorder(), input(TENANT_A, ofB), NOW))).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND', status: 404 });
      await expect(asOperator(TENANT_A, (tx) => store.request(tx, recorder(), input(TENANT_A, 'SUP-2026-000000'), NOW))).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND', status: 404 });
      const closed = await ticket(TENANT_A, 'Closed');
      await expect(asOperator(TENANT_A, (tx) => store.request(tx, recorder(), input(TENANT_A, closed), NOW))).rejects.toMatchObject({ code: 'SUPPORT_GRANT_INVALID', status: 409 });
    });

    it('refuses 600 minutes, a window under 15, no module and a reason that is too short, with the field named', async () => {
      const code = await ticket(TENANT_A);
      for (const [bad, field] of [
        [{ durationMinutes: 600 }, 'duration_minutes'],
        [{ durationMinutes: 10 }, 'duration_minutes'],
        [{ modules: [] }, 'scope.modules'],
        [{ reason: 'short' }, 'reason'],
      ] as const) {
        await expect(asOperator(TENANT_A, (tx) => store.request(tx, recorder(), input(TENANT_A, code, bad), NOW))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
      }
    });

    it('allows one open request of an operator for a ticket, and a new one once the last ended (this is how an access is extended)', async () => {
      const code = await ticket(TENANT_A);
      const first = await asOperator(TENANT_A, (tx) => store.request(tx, recorder(), input(TENANT_A, code), NOW));
      await expect(asOperator(TENANT_A, (tx) => store.request(tx, recorder(), input(TENANT_A, code.toLowerCase()), NOW))).rejects.toMatchObject({ code: 'SUPPORT_GRANT_INVALID', status: 409 });
      await decide(TENANT_A, first, ALICE, { decision: 'reject' });
      const second = await asOperator(TENANT_A, (tx) => store.request(tx, recorder(), input(TENANT_A, code), NOW));
      expect(second.id).not.toBe(first.id);
    });

    it('keeps the grants of a tenant out of sight of another', async () => {
      const grant = await request(TENANT_A);
      expect(await asTenant(TENANT_B, (tx) => store.find(tx, grant.id))).toBeUndefined();
      expect((await asTenant(TENANT_B, (tx) => store.list(tx, { limit: 100, now: NOW }))).map((row) => row.id)).not.toContain(grant.id);
      await expect(decide(TENANT_B, grant)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the approval of a read', () => {
    it('puts the grant in force at once for what was asked, and lets in that operator and nobody else, until the window ends', async () => {
      const grant = await request(TENANT_A);
      const effects = recorder(ALICE);
      const approved = await decide(TENANT_A, grant, ALICE, { effects });
      expect(approved).toMatchObject({ status: 'Active', ownerApprovedBy: ALICE, secondApproverId: null, version: 2 });
      expect(approved.startsAt).toEqual(NOW);
      expect(approved.expiresAt).toEqual(minutes(60));
      expect(effects.audits.map((entry) => entry.action)).toEqual(['support_access.approved']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.support_access.approved.v1']);
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, minutes(59)))).toMatchObject({ id: grant.id });
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, memberId(9), minutes(59)))).toBeUndefined();
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, minutes(60)))).toBeUndefined();
    });

    it('starts at the time the approver names and is not in force before it', async () => {
      const grant = await request(TENANT_A);
      const approved = await decide(TENANT_A, grant, ALICE, { startsAt: minutes(30) });
      expect(approved).toMatchObject({ status: 'Approved' });
      expect(approved.expiresAt).toEqual(minutes(90));
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, minutes(10)))).toBeUndefined();
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, minutes(31)))).toBeDefined();
    });

    it('is decided once: the same request cannot be approved or rejected again, and a stale version is a conflict', async () => {
      const grant = await request(TENANT_A);
      await expect(asTenant(TENANT_A, (tx) => store.decide(tx, recorder(), { grantId: grant.id, approverId: ALICE, decision: 'approve', reason: REASON, expectedVersion: 7 }, NOW))).rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      await decide(TENANT_A, grant);
      await expect(decide(TENANT_A, grant, BOB)).rejects.toMatchObject({ code: 'SUPPORT_GRANT_INVALID', status: 409 });
      await expect(decide(TENANT_A, grant, BOB, { decision: 'reject' })).rejects.toMatchObject({ code: 'SUPPORT_GRANT_INVALID', status: 409 });
    });

    it('is not given by the operator to themselves', async () => {
      const grant = await request(TENANT_A);
      await expect(decide(TENANT_A, grant, OPERATOR)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      await expect(decide(TENANT_A, grant, OPERATOR, { decision: 'reject' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await reload(TENANT_A, grant)).status).toBe('Requested');
    });

    it('ends in a rejection that is final and says why', async () => {
      const grant = await request(TENANT_A);
      const effects = recorder(ALICE);
      const rejected = await decide(TENANT_A, grant, ALICE, { decision: 'reject', effects });
      expect(rejected).toMatchObject({ status: 'Rejected', revokeReason: REASON });
      expect(effects.audits.map((entry) => entry.action)).toEqual(['support_access.rejected']);
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, NOW))).toBeUndefined();
    });
  });

  describe('the approval of a write', () => {
    it('needs two different people: after the first the grant is not in force, the same person cannot be the second, the other one puts it in force', async () => {
      const grant = await request(TENANT_A, { accessMode: 'READ_WRITE' });
      const first = await decide(TENANT_A, grant, ALICE);
      expect(first).toMatchObject({ status: 'Requested', ownerApprovedBy: ALICE, secondApproverId: null, startsAt: null });
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, NOW))).toBeUndefined();
      await expect(decide(TENANT_A, grant, ALICE)).rejects.toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, NOW))).toBeUndefined();
      const second = await decide(TENANT_A, grant, BOB);
      expect(second).toMatchObject({ status: 'Active', ownerApprovedBy: ALICE, secondApproverId: BOB });
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, NOW))).toMatchObject({ accessMode: 'READ_WRITE' });
    });

    it('is held by the table too: a write cannot be in force with one approver or with the same one twice, whatever the application does', async () => {
      const grant = await request(TENANT_A, { accessMode: 'READ_WRITE' });
      const one = await sqlError("update machvon.support_access_grant set status = 'Active', owner_approved_by = $2, starts_at = $3, expires_at = $4 where id = $1", [grant.id, ALICE, NOW.toISOString(), minutes(60).toISOString()]);
      expect(one?.code).toBe('23514');
      const same = await sqlError("update machvon.support_access_grant set status = 'Active', owner_approved_by = $2, second_approver_id = $2, starts_at = $3, expires_at = $4 where id = $1", [grant.id, ALICE, NOW.toISOString(), minutes(60).toISOString()]);
      expect(same?.code).toBe('23514');
    });

    it('is held by the table that a window is at most eight hours and that the operator is not their own approver', async () => {
      const grant = await request(TENANT_A);
      const long = await sqlError("update machvon.support_access_grant set status = 'Active', owner_approved_by = $2, starts_at = $3, expires_at = $4 where id = $1", [grant.id, ALICE, NOW.toISOString(), minutes(481).toISOString()]);
      expect(long?.code).toBe('23514');
      const self = await sqlError("update machvon.support_access_grant set status = 'Active', owner_approved_by = operator_id, starts_at = $2, expires_at = $3 where id = $1", [grant.id, NOW.toISOString(), minutes(60).toISOString()]);
      expect(self?.code).toBe('23514');
    });
  });

  describe('the revocation', () => {
    it('puts the operator out at once, from a request that waits or a grant in force, once, and with a reason', async () => {
      const grant = await request(TENANT_A);
      await decide(TENANT_A, grant);
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, minutes(5)))).toBeDefined();
      const effects = recorder(ALICE);
      const revoked = await asTenant(TENANT_A, (tx) => store.revoke(tx, effects, grant.id, 'No longer needed.', undefined, minutes(5)));
      expect(revoked).toMatchObject({ status: 'Revoked', revokeReason: 'No longer needed.' });
      expect(revoked.revokedAt).toEqual(minutes(5));
      expect(effects.audits.map((entry) => entry.action)).toEqual(['support_access.revoked']);
      expect(effects.events.map((event) => event.type)).toEqual(['sas.support_access.revoked.v1']);
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, grant.id, OPERATOR, minutes(6)))).toBeUndefined();
      await expect(asTenant(TENANT_A, (tx) => store.revoke(tx, recorder(), grant.id, 'Again, for nothing.', undefined, minutes(7)))).rejects.toMatchObject({ code: 'SUPPORT_GRANT_INVALID', status: 409 });
      const waiting = await request(TENANT_A);
      expect((await asTenant(TENANT_A, (tx) => store.revoke(tx, recorder(), waiting.id, 'Asked in error.', undefined, NOW))).status).toBe('Revoked');
    });

    it('is final: nothing brings a revoked, rejected or expired grant back, and nothing deletes one', async () => {
      const grant = await request(TENANT_A);
      await decide(TENANT_A, grant);
      await asTenant(TENANT_A, (tx) => store.revoke(tx, recorder(), grant.id, 'No longer needed.', undefined, NOW));
      const back = await sqlError("update machvon.support_access_grant set status = 'Active', revoked_at = null where id = $1", [grant.id]);
      expect([back?.code, back?.message.includes('SUPPORT_GRANT_IMMUTABLE')]).toEqual(['23514', true]);
      const gone = await sqlError('delete from machvon.support_access_grant where id = $1', [grant.id]);
      expect(gone?.code).toBe('23514');
    });

    it('does not let what was asked for, or an approval, be changed after the request', async () => {
      const grant = await request(TENANT_A);
      for (const statement of [
        "update machvon.support_access_grant set ticket_reference = 'SUP-OTHER-1' where id = $1",
        "update machvon.support_access_grant set access_mode = 'READ_WRITE' where id = $1",
        "update machvon.support_access_grant set scope_json = '{\"modules\":[\"IAM\"]}' where id = $1",
        "update machvon.support_access_grant set operator_id = gen_random_uuid() where id = $1",
      ]) {
        expect((await sqlError(statement, [grant.id]))?.code).toBe('23514');
      }
      await decide(TENANT_A, grant);
      expect((await sqlError('update machvon.support_access_grant set owner_approved_by = null where id = $1', [grant.id]))?.code).toBe('23514');
      expect((await sqlError("update machvon.support_access_grant set expires_at = expires_at + interval '1 hour' where id = $1", [grant.id]))?.code).toBe('23514');
    });
  });

  describe('the lifecycle pass', () => {
    it('puts an approved grant in force at its start, ends it at its end, and says so once', async () => {
      const grant = await request(TENANT_B);
      await decide(TENANT_B, grant, ALICE, { startsAt: minutes(30) });
      const effects = recorder();
      expect(await asTenant(TENANT_B, (tx) => store.sweep(tx, effects, minutes(10)))).toMatchObject({ activated: [], expired: [], lapsed: [] });
      expect(await asTenant(TENANT_B, (tx) => store.sweep(tx, effects, minutes(31)))).toMatchObject({ activated: [grant.id], expired: [], active: 1 });
      expect((await reload(TENANT_B, grant)).status).toBe('Active');
      const ended = await asTenant(TENANT_B, (tx) => store.sweep(tx, effects, minutes(91)));
      expect(ended).toMatchObject({ activated: [], expired: [grant.id], active: 0 });
      expect((await reload(TENANT_B, grant)).status).toBe('Expired');
      expect(effects.audits.map((entry) => entry.action)).toEqual(['support_access.expired']);
      expect(await asTenant(TENANT_B, (tx) => store.sweep(tx, recorder(), minutes(92)))).toMatchObject({ activated: [], expired: [], lapsed: [] });
    });

    it('lapses a request nobody decided on within a week, and leaves a revoked grant alone', async () => {
      const waiting = await request(TENANT_B);
      const revoked = await request(TENANT_B);
      await asTenant(TENANT_B, (tx) => store.revoke(tx, recorder(), revoked.id, 'Asked in error.', undefined, NOW));
      const later = new Date(NOW.getTime() + 8 * 86_400_000);
      const swept = await asTenant(TENANT_B, (tx) => store.sweep(tx, recorder(), later));
      expect(swept.lapsed).toContain(waiting.id);
      expect(swept.lapsed).not.toContain(revoked.id);
      expect((await reload(TENANT_B, waiting)).status).toBe('Expired');
      expect((await reload(TENANT_B, revoked)).status).toBe('Revoked');
    });
  });

  describe('the list', () => {
    it('filters by the status the grant has now, not the one the last pass wrote, and keeps the grants in force whatever page they would fall on', async () => {
      const live = await request(TENANT_A);
      await decide(TENANT_A, live);
      const waiting = await request(TENANT_A);
      const later = await request(TENANT_A);
      await decide(TENANT_A, later, ALICE, { startsAt: minutes(30) });
      // Many newer requests come after the grant in force: it is not on the first page of the history, and the filter still finds it.
      for (let n = 0; n < 4; n += 1) await request(TENANT_A);
      const mine = new Set([live.id, waiting.id, later.id]);
      const only = (rows: SupportGrantRow[]): string[] => rows.map((row) => row.id).filter((id) => mine.has(id));
      const at = (n: number, filter: { status?: SupportGrantRow['status']; inForce?: boolean } = {}) => asTenant(TENANT_A, (tx) => store.list(tx, { limit: 200, now: minutes(n), ...filter }));
      // A page of one holds a grant that is in force, though the four newer requests come first in the history.
      const firstPage = await asTenant(TENANT_A, (tx) => store.list(tx, { limit: 1, now: minutes(10), inForce: true }));
      expect(firstPage).toHaveLength(1);
      expect(await asTenant(TENANT_A, (tx) => store.liveGrant(tx, (firstPage[0] as SupportGrantRow).id, OPERATOR, minutes(10)))).toBeDefined();
      expect(only(await at(10, { inForce: true }))).toEqual([live.id]);
      // At minute 31 the second grant has started and, at minute 61, the first has ended: the rows still say what the last pass wrote.
      expect(only(await at(31, { status: 'Active' })).sort()).toEqual([later.id, live.id].sort());
      expect(only(await at(61, { status: 'Active' }))).toEqual([later.id]);
      expect(only(await at(61, { status: 'Expired' }))).toEqual([live.id]);
      expect(only(await at(61, { inForce: true }))).toEqual([later.id]);
      expect(only(await at(10, { status: 'Approved' }))).toEqual([later.id]);
      expect(only(await at(0, { status: 'Requested' }))).toEqual([waiting.id]);
    });

    it('shows the newest request first, a page at a time, to the tenant that owns them', async () => {
      const grants: SupportGrantRow[] = [];
      for (let n = 0; n < 3; n += 1) {
        const code = await ticket(TENANT_B);
        grants.push(await asOperator(TENANT_B, (tx) => store.request(tx, recorder(), input(TENANT_B, code), minutes(1000 + n))));
      }
      const first = await asTenant(TENANT_B, (tx) => store.list(tx, { limit: 2, now: minutes(2000) }));
      expect(first.map((row) => row.id)).toEqual([grants[2]?.id, grants[1]?.id]);
      const last = first[first.length - 1] as SupportGrantRow;
      const next = await asTenant(TENANT_B, (tx) => store.list(tx, { limit: 2, now: minutes(2000), after: { requestedAt: last.requestedAt.toISOString(), id: last.id } }));
      expect(next[0]?.id).toBe(grants[0]?.id);
      expect((await asTenant(TENANT_B, (tx) => store.list(tx, { limit: 50, now: minutes(2000), status: 'Requested' }))).every((row) => row.status === 'Requested')).toBe(true);
    });
  });
});

