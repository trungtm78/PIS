import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DelegationStore } from '../src/delegation-store';
import type { DelegationRecord } from '../src/delegation-store';
import type { ApprovalEffects } from '../src/approval-store';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedContractor } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const store = new DelegationStore();
const LEADER = 1;
const DELEGATE = 2;
const THIRD = 3;
const ADMIN = 4;
const GUEST = 5;
const SUSPENDED = 6;
const ROOT = 1;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let NOW = new Date();

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = LEADER): Promise<T> => harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number };
    return { code: e.code ?? '', status: e.status ?? 0 };
  }
  throw new Error('expected a refusal');
}

interface Recorded {
  audits: Array<{ action: string; diff?: unknown }>;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}
const effects = (recorded: Recorded = { audits: [], events: [] }): ApprovalEffects & { recorded: Recorded } => ({
  actor: memberId(ADMIN),
  audit: (entry) => {
    recorded.audits.push({ action: entry.action, diff: entry.diff });
    return Promise.resolve();
  },
  emit: (event) => {
    recorded.events.push({ type: event.type, payload: event.payload });
    return Promise.resolve();
  },
  recorded,
});

const insert = (options: { from?: Date; until?: Date; delegator?: number; delegate?: number; permissions?: string[]; now?: Date } = {}): Promise<DelegationRecord> =>
  as((tx) =>
    store.insert(tx, {
      delegatorId: memberId(options.delegator ?? LEADER),
      delegateId: memberId(options.delegate ?? DELEGATE),
      permissions: options.permissions ?? ['approval.decide'],
      scopeKind: 'UNIT_SUBTREE',
      scopeRefIds: [unitId(ROOT)],
      validFrom: options.from ?? NOW,
      validUntil: options.until ?? new Date(NOW.getTime() + 7 * DAY),
      reason: 'Đi công tác dài ngày, ủy quyền duyệt hồ sơ.',
      legalBasisRef: undefined,
      now: options.now ?? NOW,
    }),
  options.delegator ?? LEADER,
);
const scopeVersionOf = async (member: number): Promise<number> => Number((await owner<{ v: string }>('select scope_version::text as v from machvon.membership where id = $1', [memberId(member)]))[0]?.v);

describe('the delegations of approval authority (ST-ADM-014, ADM 3.5, BR-ADM-06)', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const member of [LEADER, DELEGATE, THIRD, ADMIN, SUSPENDED]) await harness.seedMembership(TENANT_A, member, ROOT);
    await harness.seedMembership(TENANT_A, GUEST, ROOT);
    const contractor = await seedContractor(harness);
    await harness.owner(TENANT_A, [
      // A guest contractor belongs to a contractor of the registry.
      ["update machvon.membership set membership_type = 'GUEST_CONTRACTOR', contractor_id = $2::uuid, valid_until = now() + interval '1 year' where id = $1::uuid", [memberId(GUEST), contractor]],
      ["update machvon.membership set status = 'Suspended' where id = $1", [memberId(SUSPENDED)]],
    ]);
    NOW = new Date();
  }, 180_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the record', () => {
    it('is in force at once when it starts now and waits (Scheduled) when it starts later, with the scope stored as kind and ids', async () => {
      const now = await insert();
      expect(now).toMatchObject({ status: 'Active', delegatorId: memberId(LEADER), delegateId: memberId(DELEGATE), permissions: ['approval.decide'], scopeKind: 'UNIT_SUBTREE', scopeRefIds: [unitId(ROOT)], version: 1, revokedAt: null, endedAt: null });
      const later = await insert({ from: new Date(NOW.getTime() + 2 * DAY), until: new Date(NOW.getTime() + 9 * DAY) });
      expect(later.status).toBe('Scheduled');
    });

    it('the table refuses what the rule refuses: more than 90 days, the same person on both sides, a permission of the administration', async () => {
      const row = (extra: Record<string, unknown>) =>
        owner(
          `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
           values ($1, gen_random_uuid(), $2, $3, $4::text[], '{"kind":"UNIT_SUBTREE","ref_ids":[]}'::jsonb, now(), now() + ($5 || ' days')::interval, 'a long enough reason', 'Active')`,
          [TENANT_A, memberId(extra.delegator as number), memberId(extra.delegate as number), extra.permissions, String(extra.days)],
        );
      await expect(row({ delegator: LEADER, delegate: DELEGATE, permissions: '{approval.decide}', days: 91 })).rejects.toThrow(/check/i);
      await expect(row({ delegator: LEADER, delegate: LEADER, permissions: '{approval.decide}', days: 5 })).rejects.toThrow(/check/i);
      await expect(row({ delegator: LEADER, delegate: DELEGATE, permissions: '{iam.role.grant}', days: 5 })).rejects.toThrow(/delegation_permissions_chk/);
      await expect(row({ delegator: LEADER, delegate: DELEGATE, permissions: '{adm.workflow.manage}', days: 5 })).rejects.toThrow(/delegation_permissions_chk/);
      await expect(row({ delegator: LEADER, delegate: DELEGATE, permissions: '{*}', days: 5 })).rejects.toThrow(/delegation_permissions_chk/);
      await expect(row({ delegator: LEADER, delegate: DELEGATE, permissions: '{}', days: 5 })).rejects.toThrow(/delegation_permissions_chk/);
      await expect(row({ delegator: LEADER, delegate: DELEGATE, permissions: '{approval.decide}', days: 90 })).resolves.toBeDefined();
    });

    it('the migration ends a delegation made before the rule that passes on a wildcard or an administrative permission, so that it is not stuck for the sweep and the revocation', async () => {
      await owner('alter table machvon.delegation_grant drop constraint delegation_permissions_chk');
      try {
        const [legacy] = await owner<{ id: string }>(
          `insert into machvon.delegation_grant (tenant_id, id, delegator_membership_id, delegate_membership_id, permissions, scope_json, valid_from, valid_until, reason, status)
           values ($1, gen_random_uuid(), $2, $3, '{iam.role.grant,approval.decide}', '{"kind":"UNIT_SUBTREE","ref_ids":[]}'::jsonb, now(), now() + interval '30 days', 'made before the rule', 'Active') returning id`,
          [TENANT_A, memberId(LEADER), memberId(DELEGATE)],
        );
        const migration = readFileSync(join(__dirname, '../../../db/migrations/V1307__adm1_delegation_lifecycle.sql'), 'utf8');
        const backfill = /^(UPDATE machvon.delegation_grant SET status = 'Ended'[^;]*);$/m.exec(migration)?.[1];
        expect(backfill).toBeDefined();
        await owner(backfill as string);
        expect((await as((tx) => store.find(tx, legacy?.id as string)))).toMatchObject({ status: 'Ended', endReason: 'SOURCE_ENDED' });
        // A delegation whose permissions are fine is left alone.
        const fine = await insert();
        await owner(backfill as string);
        expect((await as((tx) => store.find(tx, fine.id)))?.status).toBe('Active');
      } finally {
        await owner('alter table machvon.delegation_grant add constraint delegation_permissions_chk check (machvon.delegation_permissions_ok(permissions)) not valid');
      }
    });

    it('what a delegation grants never changes, its state only moves forward and a delegation that is over is final; nobody deletes one', async () => {
      const created = await insert();
      await expect(owner('update machvon.delegation_grant set valid_until = valid_until + interval \'1 day\' where id = $1', [created.id])).rejects.toThrow(/what a delegation grants is not changed/);
      await expect(owner("update machvon.delegation_grant set permissions = '{approval.decide,doc.outgoing.sign}' where id = $1", [created.id])).rejects.toThrow(/not changed/);
      await expect(owner("update machvon.delegation_grant set status = 'Scheduled' where id = $1", [created.id])).rejects.toThrow(/does not go from/);
      await as((tx) => store.revoke(tx, created.id, 1, memberId(LEADER), 'Quay lại làm việc sớm hơn dự kiến.', NOW));
      await expect(owner("update machvon.delegation_grant set status = 'Active' where id = $1", [created.id])).rejects.toThrow(/that is over is not changed/);
      await expect(harness.tenants.withTenant(contextFor(TENANT_A, memberId(LEADER)), (tx) => tx.query('delete from machvon.delegation_grant where id = $1::uuid', [created.id]))).rejects.toThrow(/permission denied/);
    });
  });

  describe('the reads', () => {
    it('lists what the person gave and received, newest first, and every one of the tenant for who may see them all', async () => {
      const mine = await insert({ delegator: THIRD, delegate: DELEGATE });
      const asThird = await as((tx) => store.list(tx, { membershipId: memberId(THIRD), all: false }, {}, { limit: 50, after: undefined }), THIRD);
      expect(asThird.map((row) => row.id)).toContain(mine.id);
      expect(asThird.every((row) => row.delegatorId === memberId(THIRD) || row.delegateId === memberId(THIRD))).toBe(true);
      const asDelegate = await as((tx) => store.list(tx, { membershipId: memberId(DELEGATE), all: false }, { role: 'received' }, { limit: 50, after: undefined }), DELEGATE);
      expect(asDelegate.length).toBeGreaterThan(0);
      expect(asDelegate.every((row) => row.delegateId === memberId(DELEGATE))).toBe(true);
      const given = await as((tx) => store.list(tx, { membershipId: memberId(THIRD), all: true }, { role: 'given' }, { limit: 50, after: undefined }), THIRD);
      expect(given.every((row) => row.delegatorId === memberId(THIRD))).toBe(true);
      const nobody = await as((tx) => store.list(tx, { membershipId: memberId(ADMIN), all: false }, {}, { limit: 50, after: undefined }), ADMIN);
      expect(nobody).toEqual([]);
      const everything = await as((tx) => store.list(tx, { membershipId: memberId(ADMIN), all: true }, {}, { limit: 500, after: undefined }), ADMIN);
      expect(everything.length).toBeGreaterThan(asThird.length);
      const ordered = everything.map((row) => row.createdAt);
      expect([...ordered].sort().reverse()).toEqual(ordered);
    });

    it('pages by the cursor and filters by state', async () => {
      const first = await as((tx) => store.list(tx, { membershipId: memberId(ADMIN), all: true }, {}, { limit: 2, after: undefined }), ADMIN);
      expect(first).toHaveLength(2);
      const last = first[1] as DelegationRecord;
      const next = await as((tx) => store.list(tx, { membershipId: memberId(ADMIN), all: true }, {}, { limit: 2, after: { code: last.sortKey, id: last.id } }), ADMIN);
      expect(next.map((row) => row.id)).not.toContain(first[0]?.id);
      const revoked = await as((tx) => store.list(tx, { membershipId: memberId(ADMIN), all: true }, { status: 'Revoked' }, { limit: 50, after: undefined }), ADMIN);
      expect(revoked.length).toBeGreaterThan(0);
      expect(revoked.every((row) => row.status === 'Revoked' && row.revokeReason !== null && row.revokedBy !== null)).toBe(true);
    });

    it('says what a member holds through delegations they received, and who may be a delegate', async () => {
      await insert({ delegator: LEADER, delegate: THIRD, permissions: ['approval.decide', 'doc.outgoing.sign'] });
      expect((await as((tx) => store.heldThroughDelegations(tx, memberId(THIRD), NOW))).sort()).toEqual(['approval.decide', 'doc.outgoing.sign']);
      expect(await as((tx) => store.heldThroughDelegations(tx, memberId(THIRD), new Date(NOW.getTime() + 30 * DAY)))).toEqual([]);
      expect(await as((tx) => store.delegateState(tx, memberId(DELEGATE), NOW))).toBe('ACTIVE');
      expect(await as((tx) => store.delegateState(tx, memberId(SUSPENDED), NOW))).toBe('INACTIVE');
      expect(await as((tx) => store.delegateState(tx, memberId(GUEST), NOW))).toBe('GUEST');
      expect(await as((tx) => store.delegateState(tx, randomUUID(), NOW))).toBe('UNKNOWN');
    });
  });

  describe('revoking', () => {
    it('revokes a delegation that is not over, with the reason and who did it; a second revocation and a stale version are refused', async () => {
      const created = await insert();
      expect(await refusal(as((tx) => store.revoke(tx, created.id, 9, memberId(LEADER), 'Quay lại làm việc sớm hơn dự kiến.', NOW)))).toEqual({ code: 'VERSION_CONFLICT', status: 409 });
      const { before, after } = await as((tx) => store.revoke(tx, created.id, 1, memberId(LEADER), 'Quay lại làm việc sớm hơn dự kiến.', NOW));
      expect(before.status).toBe('Active');
      expect(after).toMatchObject({ status: 'Revoked', revokedBy: memberId(LEADER), revokeReason: 'Quay lại làm việc sớm hơn dự kiến.', version: 2 });
      expect(after.revokedAt).not.toBeNull();
      expect(await refusal(as((tx) => store.revoke(tx, created.id, 2, memberId(LEADER), 'Quay lại làm việc sớm hơn dự kiến.', NOW)))).toEqual({ code: 'DELEGATION_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => store.revoke(tx, randomUUID(), 1, memberId(LEADER), 'Quay lại làm việc sớm hơn dự kiến.', NOW)))).toEqual({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });

    it('revokes one that is still waiting', async () => {
      const waiting = await insert({ from: new Date(NOW.getTime() + 3 * DAY), until: new Date(NOW.getTime() + 10 * DAY) });
      const { after } = await as((tx) => store.revoke(tx, waiting.id, 1, memberId(LEADER), 'Không còn cần ủy quyền nữa.', NOW));
      expect(after.status).toBe('Revoked');
    });
  });

  describe('the job (the life of a delegation by the clock and by its source)', () => {
    beforeEach(async () => {
      await harness.owner(TENANT_A, [["update machvon.delegation_grant set status = 'Revoked', revoked_by = delegator_membership_id, revoked_at = now(), revoke_reason = 'cleared before a test' where status in ('Scheduled', 'Active')", []]]);
    });
    const sweep = (at: Date, holds: (delegation: DelegationRecord) => boolean = () => true, e = effects()) => as((tx) => store.sweep(tx, e, at, (delegation) => Promise.resolve(holds(delegation))), ADMIN);

    it('puts a waiting delegation in force when its first instant has come, not before, and tells the delegate\'s access changed', async () => {
      const waiting = await insert({ from: new Date(NOW.getTime() + 2 * DAY), until: new Date(NOW.getTime() + 9 * DAY) });
      expect(await sweep(NOW)).toMatchObject({ activated: 0, active: 0 });
      const before = await scopeVersionOf(DELEGATE);
      const e = effects();
      expect(await sweep(new Date(NOW.getTime() + 2 * DAY), () => true, e)).toMatchObject({ activated: 1, active: 1 });
      expect((await as((tx) => store.find(tx, waiting.id)))?.status).toBe('Active');
      expect(e.recorded.events).toEqual([expect.objectContaining({ type: 'iam.delegation.activated.v1', payload: expect.objectContaining({ delegation_id: waiting.id }) })]);
      expect(await scopeVersionOf(DELEGATE)).toBe(before + 1);
      // The pass repeated changes nothing.
      expect(await sweep(new Date(NOW.getTime() + 2 * DAY))).toMatchObject({ activated: 0, active: 1 });
    });

    it('ends a delegation at the last instant of its window (EXPIRED), with the audit row and the event', async () => {
      const created = await insert();
      const end = new Date(created.validUntil);
      const e = effects();
      expect(await sweep(new Date(end.getTime() - 1000))).toMatchObject({ expired: 0, active: 1 });
      expect(await sweep(end, () => true, e)).toMatchObject({ expired: 1, active: 0 });
      expect(await as((tx) => store.find(tx, created.id))).toMatchObject({ status: 'Ended', endReason: 'EXPIRED' });
      expect((await as((tx) => store.find(tx, created.id)))?.endedAt).not.toBeNull();
      expect(e.recorded.audits.map((audit) => audit.action)).toEqual(['delegation.ended']);
      expect(e.recorded.events).toEqual([expect.objectContaining({ type: 'iam.delegation.ended.v1', payload: expect.objectContaining({ end_reason: 'EXPIRED' }) })]);
      expect(await sweep(end)).toMatchObject({ expired: 0 });
    });

    it('ends a delegation whose delegator no longer holds what it passed on (SOURCE_ENDED), in force or waiting, and keeps the ones whose source holds', async () => {
      const kept = await insert({ delegator: LEADER, delegate: DELEGATE });
      const lost = await insert({ delegator: THIRD, delegate: DELEGATE });
      const waitingLost = await insert({ delegator: THIRD, delegate: LEADER, from: new Date(NOW.getTime() + DAY), until: new Date(NOW.getTime() + 8 * DAY) });
      const e = effects();
      const before = await scopeVersionOf(DELEGATE);
      expect(await sweep(NOW, (delegation) => delegation.delegatorId !== memberId(THIRD), e)).toMatchObject({ sourceEnded: 2, active: 1 });
      expect((await as((tx) => store.find(tx, kept.id)))?.status).toBe('Active');
      expect(await as((tx) => store.find(tx, lost.id))).toMatchObject({ status: 'Ended', endReason: 'SOURCE_ENDED' });
      expect((await as((tx) => store.find(tx, waitingLost.id)))?.status).toBe('Ended');
      expect(e.recorded.events.filter((event) => event.type === 'iam.delegation.ended.v1')).toHaveLength(2);
      expect(await scopeVersionOf(DELEGATE)).toBeGreaterThan(before);
    });

    it('takes more delegations than a pass holds in turns, so that none is starved: every one is looked at over a few passes, and the ones whose window is over come first', async () => {
      const made = [await insert(), await insert(), await insert(), await insert(), await insert()].map((row) => row.id);
      const rounds: string[][] = [];
      for (let pass = 0; pass < 3; pass += 1) {
        const looked: string[] = [];
        await as((tx) => store.sweep(tx, effects(), NOW, (delegation) => Promise.resolve(looked.push(delegation.id) > 0), 2), ADMIN);
        rounds.push(looked);
      }
      expect(rounds.map((round) => round.length)).toEqual([2, 2, 2]);
      // The count of the delegations in force is the tenant's, not the batch's.
      expect(await as((tx) => store.sweep(tx, effects(), NOW, () => Promise.resolve(true), 2), ADMIN)).toMatchObject({ active: 5 });
      expect(new Set(rounds.flat())).toEqual(new Set(made));
      expect(rounds[0]).not.toEqual(rounds[1]);
      // One whose window is over is taken first, whatever was looked at before.
      const over = await insert({ from: new Date(NOW.getTime() - 3 * DAY), until: new Date(NOW.getTime() - DAY) });
      expect(await as((tx) => store.sweep(tx, effects(), NOW, () => Promise.resolve(true), 1), ADMIN)).toMatchObject({ expired: 1 });
      expect((await as((tx) => store.find(tx, over.id)))?.status).toBe('Ended');
    });

    it('leaves a delegation that a command holds to the next pass', async () => {
      const created = await insert();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked: () => void = () => undefined;
      const taken = new Promise<void>((resolve) => (locked = resolve));
      const holder = as(async (tx) => {
        await tx.query('select id from machvon.delegation_grant where id = $1::uuid for update', [created.id]);
        locked();
        await held;
      });
      await taken;
      expect(await sweep(new Date(created.validUntil))).toMatchObject({ expired: 0 });
      release();
      await holder;
      expect(await sweep(new Date(created.validUntil))).toMatchObject({ expired: 1 });
    });
  });
});
