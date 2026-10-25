import { randomUUID } from 'node:crypto';
import type { MetricsSink } from '@machvon/kernel';
import { AuditWriter } from '../src/audit-writer';
import { linkReconciliationIssue, PAY_RECONCILIATION_OPEN_METRIC, PAY_RECONCILIATION_OVERDUE_METRIC, PayReconciliationOverdueJob, PayReconciliationStore, RECONCILIATION_OVERDUE_EVENT } from '../src/pay-reconciliation-store';
import type { ReconciliationItemView } from '../src/pay-reconciliation-store';
import { PayTreasuryTracking } from '../src/pay-treasury-tracking';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { AcceptanceWorld } from './support/acceptance-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const gauges: Array<[string, number]> = [];
const metrics: MetricsSink = { increment: () => undefined, gauge: (name, value) => void gauges.push([name, value]) };
const store = new PayReconciliationStore(metrics);
const tracking = new PayTreasuryTracking();
const OWNER = 1;
const APPROVER = 2;
const OTHER = 3;
const NOW = new Date('2026-07-11T06:00:00Z');
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = OWNER): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
}

/** An item of difference of the project of the tests, as the commands that open one leave it: -10m, open, with the owner and the day it is due. */
async function item(options: { ownerMember?: number; dueAt?: string; status?: string; internal?: string; confirmed?: string; kind?: string; contractId?: string } = {}): Promise<{ id: string; version: number }> {
  const id = randomUUID();
  await owner(
    `insert into machvon.reconciliation_item
       (tenant_id, id, project_id, contract_id, kind, internal_amount_vnd, confirmed_amount_vnd, owner_membership_id, due_at, status, created_by, updated_by)
     values ($1, $2::uuid, $3::uuid, $10::uuid, $4, $5::numeric, $6::numeric, $7::uuid, $8::timestamptz, 'OPEN', $9::uuid, $9::uuid)`,
    [TENANT_A, id, fixtures.projectId, options.kind ?? 'AMOUNT_MISMATCH', options.internal ?? '1000000000', options.confirmed ?? '990000000', memberId(options.ownerMember ?? OWNER), options.dueAt ?? '2026-07-10T10:00:00Z', memberId(OTHER), options.contractId ?? null],
  );
  // The item reaches its status along the edges of its life, the way the commands take it.
  const status = options.status ?? 'OPEN';
  if (status !== 'OPEN') {
    const steps: Array<[string, unknown[]]> = [];
    if (status === 'EXPLAINED' || status === 'RESOLVED') steps.push(["update machvon.reconciliation_item set status = 'EXPLAINED', resolution_note = 'earlier' where id = $1::uuid", [id]]);
    if (status === 'RESOLVED') steps.push(["update machvon.reconciliation_item set status = 'RESOLVED', resolved_by = $2::uuid, resolved_at = now() where id = $1::uuid", [id, memberId(APPROVER)]]);
    if (status === 'WRITTEN_OFF_APPROVED') {
      steps.push(["update machvon.reconciliation_item set status = 'WRITTEN_OFF_APPROVED', resolution_note = 'earlier', resolved_by = $2::uuid, resolved_at = now(), approval_document_version_id = $3::uuid where id = $1::uuid", [id, memberId(APPROVER), (await fixtures.documentVersion()).id]]);
    }
    await fixtures.harness.owner(TENANT_A, steps);
  }
  return { id, version: 1 };
}
const rowOf = async (id: string) =>
  (
    await owner<{ status: string; version: string; owner: string; due_at: string; note: string | null; resolved_by: string | null; resolved_at: string | null; approval: string | null; difference: string | null; flagged: string | null }>(
      `select status, version::text, owner_membership_id as owner, due_at::text, resolution_note as note, resolved_by, resolved_at::text, approval_document_version_id as approval, difference_vnd::text as difference,
              overdue_flagged_at::text as flagged from machvon.reconciliation_item where id = $1::uuid`,
      [id],
    )
  )[0];

const resolve = (id: string, version: number, input: { resolution: string; note?: string | undefined; approval?: string | undefined }, member = OWNER, scope: ScopeBuilder = everything) =>
  as((tx) => store.resolve(tx, id, version, { resolution: input.resolution, note: input.note, approvalDocumentVersionId: input.approval }, memberId(member), scope, NOW), member);
const assign = (id: string, version: number, ownerId: string, dueAt: string, scope: ScopeBuilder = everything) => as((tx) => store.assign(tx, id, version, { ownerMembershipId: ownerId, dueAt }, memberId(APPROVER), scope, NOW), APPROVER);

describe('the work on a difference (ST-PAY-007)', () => {
  beforeAll(async () => {
    await fixtures.start();
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('reading the items', () => {
    it('lists the items due first with both figures, the signed difference and whether they are past their day, and pages by the day and the id', async () => {
      const late = await item({ dueAt: '2026-07-09T10:00:00Z', internal: '1000000000', confirmed: '990000000' });
      const soon = await item({ dueAt: '2026-07-20T10:00:00Z', internal: '500', confirmed: '700' });
      const ended = await item({ dueAt: '2026-07-01T10:00:00Z', status: 'RESOLVED' });
      const all = await as((tx) => store.list(tx, everything, { limit: 200, after: undefined }, NOW));
      const mine = all.filter((row) => [late.id, soon.id, ended.id].includes(row.id));
      expect(mine.map((row) => row.id)).toEqual([ended.id, late.id, soon.id]);
      expect(mine.find((row) => row.id === late.id)).toMatchObject({
        kind: 'AMOUNT_MISMATCH',
        status: 'OPEN',
        internalAmountVnd: '1000000000',
        confirmedAmountVnd: '990000000',
        differenceVnd: '-10000000',
        overdue: true,
        ownerMembershipId: memberId(OWNER),
        issueId: null,
        version: 1,
        projectId: fixtures.projectId,
      });
      expect(mine.find((row) => row.id === soon.id)).toMatchObject({ differenceVnd: '200', overdue: false });
      // An item that ended is not overdue however old its day.
      expect(mine.find((row) => row.id === ended.id)?.overdue).toBe(false);
      const first = await as((tx) => store.list(tx, everything, { limit: 2, after: undefined }, NOW));
      const last = first[first.length - 1] as ReconciliationItemView;
      const next = await as((tx) => store.list(tx, everything, { limit: 200, after: { code: last.dueAtKey, id: last.id } }, NOW));
      expect([...first, ...next].map((row) => row.id)).toEqual(all.map((row) => row.id));
    });

    it('filters by status and by owner, and refuses a filter that is not one', async () => {
      const mineOpen = await item({ ownerMember: APPROVER, dueAt: '2026-07-30T10:00:00Z' });
      const mineEnded = await item({ ownerMember: APPROVER, status: 'EXPLAINED', dueAt: '2026-07-31T10:00:00Z' });
      const owned = await as((tx) => store.list(tx, everything, { ownerMembershipId: memberId(APPROVER), limit: 200, after: undefined }, NOW));
      expect(owned.map((row) => row.id)).toEqual(expect.arrayContaining([mineOpen.id, mineEnded.id]));
      expect(owned.every((row) => row.ownerMembershipId === memberId(APPROVER))).toBe(true);
      const explained = await as((tx) => store.list(tx, everything, { status: 'EXPLAINED', limit: 200, after: undefined }, NOW));
      expect(explained.every((row) => row.status === 'EXPLAINED')).toBe(true);
      expect(explained.map((row) => row.id)).toContain(mineEnded.id);
      expect(await refusal(as((tx) => store.list(tx, everything, { status: 'DONE', limit: 10, after: undefined }, NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(as((tx) => store.list(tx, everything, { ownerMembershipId: 'x', limit: 10, after: undefined }, NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_membership_id' });
      expect(await refusal(as((tx) => store.list(tx, everything, { limit: 0, after: undefined }, NOW)))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'limit' });
      expect(await refusal(as((tx) => store.list(tx, everything, { limit: 5, after: { code: 'yesterday', id: randomUUID() } }, NOW)))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('finds one item inside the scope of the caller and no other', async () => {
      const target = await item();
      expect(await as((tx) => store.find(tx, everything, target.id, NOW))).toMatchObject({ id: target.id, projectCode: expect.any(String), contractId: null, requestNo: null, documentNo: null, sourceFileName: null });
      expect(await as((tx) => store.find(tx, nothing, target.id, NOW))).toBeUndefined();
      expect(await as((tx) => store.find(tx, everything, randomUUID(), NOW))).toBeUndefined();
      expect(await refusal(as((tx) => store.find(tx, everything, 'x', NOW)))).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('counts what waits, what is past its day and the difference it holds, for the projects in the scope', async () => {
      const before = await as((tx) => store.summary(tx, everything, NOW));
      await item({ dueAt: '2026-07-01T00:00:00Z', internal: '100', confirmed: '40' });
      await item({ dueAt: '2026-08-01T00:00:00Z', internal: '100', confirmed: '150' });
      await item({ dueAt: '2026-07-01T00:00:00Z', status: 'RESOLVED' });
      const after = await as((tx) => store.summary(tx, everything, NOW));
      expect({ waiting: after.waiting - before.waiting, overdue: after.overdue - before.overdue, difference: BigInt(after.waitingDifferenceVnd) - BigInt(before.waitingDifferenceVnd) }).toEqual({ waiting: 2, overdue: 1, difference: -10n });
      expect(await as((tx) => store.summary(tx, nothing, NOW))).toEqual({ waiting: 0, overdue: 0, waitingDifferenceVnd: '0' });
    });
  });

  describe('giving an item to an owner (AC-ST-PAY-007-3)', () => {
    it('changes the owner and the day while it waits, and bumps the version', async () => {
      const target = await item();
      const done = await assign(target.id, 1, memberId(APPROVER), '2026-07-20T10:00:00Z');
      expect(done).toMatchObject({ fromStatus: 'OPEN', fromOwnerMembershipId: memberId(OWNER), view: { ownerMembershipId: memberId(APPROVER), version: 2, status: 'OPEN', overdue: false } });
      expect(Date.parse(done.view.dueAt)).toBe(Date.parse('2026-07-20T10:00:00Z'));
      expect((await rowOf(target.id))?.owner).toBe(memberId(APPROVER));
      // The same owner may be given a later day, and an explained item is still waiting.
      await owner("update machvon.reconciliation_item set status = 'EXPLAINED', resolution_note = 'why' where id = $1::uuid", [target.id]);
      expect(await assign(target.id, 2, memberId(APPROVER), '2026-07-25T10:00:00Z')).toMatchObject({ fromStatus: 'EXPLAINED', view: { version: 3 } });
    });

    it('asks for an owner who is an active member and a day that has not come yet', async () => {
      const target = await item();
      expect(await refusal(assign(target.id, 1, memberId(APPROVER), '2026-07-10T10:00:00Z'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_at', extensions: { reason: 'NOT_IN_THE_FUTURE' } });
      expect(await refusal(assign(target.id, 1, memberId(APPROVER), 'tomorrow'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_at' });
      expect(await refusal(assign(target.id, 1, memberId(APPROVER), '2026-13-40T10:00:00Z'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'due_at' });
      expect(await refusal(assign(target.id, 1, memberId(99), '2026-07-20T10:00:00Z'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_membership_id', extensions: { reason: 'NOT_AN_ACTIVE_MEMBER' } });
      expect(await refusal(assign(target.id, 1, 'x', '2026-07-20T10:00:00Z'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'owner_membership_id' });
      await owner("update machvon.membership set status = 'Suspended' where id = $1::uuid", [memberId(OTHER)]);
      try {
        expect(await refusal(assign(target.id, 1, memberId(OTHER), '2026-07-20T10:00:00Z'))).toMatchObject({ detail: 'owner_membership_id', extensions: { reason: 'NOT_AN_ACTIVE_MEMBER' } });
      } finally {
        await owner("update machvon.membership set status = 'Active' where id = $1::uuid", [memberId(OTHER)]);
      }
      expect((await rowOf(target.id))?.owner).toBe(memberId(OWNER));
    });

    it('refuses a stale version, an item outside the scope and an item that ended', async () => {
      const target = await item();
      expect(await refusal(assign(target.id, 7, memberId(APPROVER), '2026-07-20T10:00:00Z'))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(assign(target.id, 1, memberId(APPROVER), '2026-07-20T10:00:00Z', nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      const ended = await item({ status: 'RESOLVED' });
      expect(await refusal(assign(ended.id, 1, memberId(APPROVER), '2026-07-20T10:00:00Z'))).toMatchObject({ code: 'RECONCILIATION_STATE_INVALID', status: 409, extensions: { status: 'RESOLVED' } });
      expect((await rowOf(target.id))?.version).toBe('1');
    });
  });

  describe('explaining, resolving and writing off (UAT-AC12, UAT-AC336)', () => {
    it('explains an item with a note, then resolves it, and keeps the two figures it was opened with', async () => {
      const target = await item();
      expect(await refusal(resolve(target.id, 1, { resolution: 'EXPLAINED' }))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      expect(await refusal(resolve(target.id, 1, { resolution: 'EXPLAINED', note: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      const explained = await resolve(target.id, 1, { resolution: 'EXPLAINED', note: 'Kho bạc trừ phí 10.000.000 theo thông báo TB-77' });
      expect(explained).toMatchObject({ fromStatus: 'OPEN', view: { status: 'EXPLAINED', version: 2, resolutionNote: 'Kho bạc trừ phí 10.000.000 theo thông báo TB-77', resolvedBy: null, resolvedAt: null, differenceVnd: '-10000000' } });
      expect(await refusal(resolve(target.id, 2, { resolution: 'EXPLAINED', note: 'again' }))).toMatchObject({ code: 'RECONCILIATION_STATE_INVALID', status: 409, extensions: { status: 'EXPLAINED', resolution: 'EXPLAINED' } });
      const resolved = await resolve(target.id, 2, { resolution: 'RESOLVED', note: 'The fee was booked as an expense.' }, APPROVER);
      expect(resolved).toMatchObject({ fromStatus: 'EXPLAINED', view: { status: 'RESOLVED', version: 3, resolvedBy: memberId(APPROVER), internalAmountVnd: '1000000000', confirmedAmountVnd: '990000000', differenceVnd: '-10000000' } });
      expect(resolved.view.resolvedAt).not.toBeNull();
      expect(await refusal(resolve(target.id, 3, { resolution: 'WRITTEN_OFF', note: 'x', approval: (await fixtures.documentVersion()).id }, APPROVER))).toMatchObject({ code: 'RECONCILIATION_STATE_INVALID', extensions: { status: 'RESOLVED' } });
    });

    it('does not resolve an item that was not explained, and refuses a resolution it does not know or a stale version', async () => {
      const target = await item();
      expect(await refusal(resolve(target.id, 1, { resolution: 'RESOLVED', note: 'x' }))).toMatchObject({ code: 'RECONCILIATION_STATE_INVALID', extensions: { status: 'OPEN', resolution: 'RESOLVED' } });
      expect(await refusal(resolve(target.id, 1, { resolution: 'IGNORED', note: 'x' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'resolution' });
      expect(await refusal(resolve(target.id, 4, { resolution: 'EXPLAINED', note: 'x' }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(resolve(target.id, 1, { resolution: 'EXPLAINED', note: 'x' }, OWNER, nothing))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(resolve(target.id, 1, { resolution: 'EXPLAINED', note: 'x'.repeat(2001) }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      expect((await rowOf(target.id))?.status).toBe('OPEN');
    });

    it('writes a difference off only with the document that approves it and only by someone other than its owner, and leaves the difference as it was', async () => {
      const target = await item({ internal: '1000000000', confirmed: '990000000' });
      const paper = (await fixtures.documentVersion()).id;
      expect(await refusal(resolve(target.id, 1, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered' }))).toMatchObject({ code: 'APPROVAL_REQUIRED', status: 422 });
      expect(await refusal(resolve(target.id, 1, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval: paper }, OWNER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(resolve(target.id, 1, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval: (await fixtures.documentVersion('PENDING')).id }, APPROVER))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(resolve(target.id, 1, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval: randomUUID() }, APPROVER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approval_document_version_id', extensions: { reason: 'NOT_FOUND' } });
      expect(await refusal(resolve(target.id, 1, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval: 'x' }, APPROVER))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'approval_document_version_id' });
      expect((await rowOf(target.id))?.status).toBe('OPEN');
      const done = await resolve(target.id, 1, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval: paper }, APPROVER);
      expect(done).toMatchObject({ view: { status: 'WRITTEN_OFF_APPROVED', approvalDocumentVersionId: paper, resolvedBy: memberId(APPROVER), differenceVnd: '-10000000', internalAmountVnd: '1000000000', confirmedAmountVnd: '990000000' } });
      expect(await rowOf(target.id)).toMatchObject({ status: 'WRITTEN_OFF_APPROVED', difference: '-10000000', approval: paper, resolved_by: memberId(APPROVER) });
    });

    it('writes off an item that was explained', async () => {
      const target = await item({ status: 'EXPLAINED' });
      const done = await resolve(target.id, 1, { resolution: 'WRITTEN_OFF', note: 'Cannot be recovered', approval: (await fixtures.documentVersion()).id }, APPROVER);
      expect(done).toMatchObject({ fromStatus: 'EXPLAINED', view: { status: 'WRITTEN_OFF_APPROVED' } });
    });
  });

  describe('the database holds the rules when the application does not (V1567)', () => {
    it('never changes the figures an item was opened with, whoever writes the row', async () => {
      const target = await item();
      for (const column of ["internal_amount_vnd = 1", "confirmed_amount_vnd = 1", "kind = 'DUPLICATE_CONFLICT'", "project_id = gen_random_uuid()"]) {
        expect((await databaseRefusal(owner(`update machvon.reconciliation_item set ${column} where id = $1::uuid`, [target.id]))).sqlstate).toMatch(/^23/);
      }
      expect((await rowOf(target.id))?.difference).toBe('-10000000');
    });

    it('moves only along the edges of its life', async () => {
      const target = await item();
      expect((await databaseRefusal(owner("update machvon.reconciliation_item set status = 'RESOLVED', resolution_note = 'x', resolved_by = created_by, resolved_at = now() where id = $1::uuid", [target.id]))).message).toContain('RECONCILIATION_STATE_INVALID');
      const ended = await item({ status: 'RESOLVED' });
      expect((await databaseRefusal(owner("update machvon.reconciliation_item set resolution_note = 'rewritten' where id = $1::uuid", [ended.id]))).message).toContain('an item that ended is kept as it is');
      expect((await databaseRefusal(owner("update machvon.reconciliation_item set status = 'OPEN' where id = $1::uuid", [ended.id]))).message).toContain('RECONCILIATION_STATE_INVALID');
      expect((await databaseRefusal(owner(`insert into machvon.reconciliation_item (tenant_id, id, project_id, kind, owner_membership_id, due_at, status, created_by, updated_by)
        values ($1, gen_random_uuid(), $2::uuid, 'ADVANCE_OVERDUE', $3::uuid, now(), 'RESOLVED', $3::uuid, $3::uuid)`, [TENANT_A, fixtures.projectId, memberId(OWNER)]))).message).toContain('begins open');
    });

    it('refuses a write-off without the document or by its own owner, even when the application is bypassed', async () => {
      const target = await item({ ownerMember: OWNER });
      const paper = (await fixtures.documentVersion()).id;
      expect((await databaseRefusal(owner("update machvon.reconciliation_item set status = 'WRITTEN_OFF_APPROVED', resolution_note = 'x', resolved_by = $2::uuid, resolved_at = now() where id = $1::uuid", [target.id, memberId(APPROVER)]))).message).toContain('reconciliation_item_write_off_chk');
      expect(
        (await databaseRefusal(owner("update machvon.reconciliation_item set status = 'WRITTEN_OFF_APPROVED', resolution_note = 'x', resolved_by = owner_membership_id, resolved_at = now(), approval_document_version_id = $2::uuid where id = $1::uuid", [target.id, paper]))).message,
      ).toContain('reconciliation_item_write_off_chk');
      expect((await databaseRefusal(owner("update machvon.reconciliation_item set resolved_by = $2::uuid where id = $1::uuid", [target.id, memberId(APPROVER)]))).message).toContain('reconciliation_item_waiting_chk');
    });

    it('tells what a check refused in the words of the contract and leaves any other failure as it is', () => {
      const tell = (error: unknown): unknown => (store as unknown as { mapRefusal(error: unknown): unknown }).mapRefusal(error);
      expect(tell({ code: '23514', message: 'RECONCILIATION_STATE_INVALID: this move' })).toMatchObject({ code: 'RECONCILIATION_STATE_INVALID', status: 409 });
      expect(tell({ code: '23514', message: 'violates check constraint "reconciliation_item_write_off_chk"' })).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      const other = { code: '23514', message: 'something else' };
      expect(tell(other)).toBe(other);
      expect(tell({ code: '40001' })).toEqual({ code: '40001' });
      expect(tell({ code: '23514' })).toEqual({ code: '23514' });
    });

    it('lets the identifier of the issue be written back after the item ended: only the key of the issue can refuse it', async () => {
      const ended = await item({ status: 'RESOLVED' });
      expect((await databaseRefusal(as((tx) => linkReconciliationIssue(tx, ended.id, randomUUID())))).sqlstate).toBe('23503');
      expect((await rowOf(ended.id))?.status).toBe('RESOLVED');
    });
  });

  describe('the items past their day (the job reconciliation-overdue, UAT-AC336)', () => {
    const job = new PayReconciliationOverdueJob(new AuditWriter(fixtures.harness.tenants), metrics);
    const eventsOf = (id: string) => owner<{ payload: Record<string, unknown>; event_key: string }>("select payload, event_key from machvon.outbox_event where aggregate_id = $1::uuid and type = $2", [id, RECONCILIATION_OVERDUE_EVENT]);

    it('reports an item that waits past its day once, with the members the issue intake reads and nothing a person said', async () => {
      const late = await item({ dueAt: '2026-07-10T10:00:00Z' });
      const fine = await item({ dueAt: '2026-07-20T10:00:00Z' });
      const ended = await item({ dueAt: '2026-07-01T10:00:00Z', status: 'RESOLVED' });
      const first = await as((tx) => job.run(tx, memberId(OWNER), NOW));
      expect(first.reported).toBeGreaterThanOrEqual(1);
      const events = await eventsOf(late.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_key).toBe(`reconciliation_item:${late.id}:overdue`);
      expect(events[0]?.payload).toMatchObject({
        source_ref_id: late.id,
        reference_code: `RI-${late.id.slice(0, 8)}`,
        project_id: fixtures.projectId,
        severity: 'MEDIUM',
        kind: 'AMOUNT_MISMATCH',
        status: 'OPEN',
        source_module: 'PAY',
      });
      expect(events[0]?.payload).not.toHaveProperty('contract_id');
      expect(JSON.stringify(events[0]?.payload)).not.toMatch(/note|name/);
      expect((await rowOf(late.id))?.flagged).not.toBeNull();
      expect((await rowOf(fine.id))?.flagged).toBeNull();
      expect((await rowOf(ended.id))?.flagged).toBeNull();
      expect(await eventsOf(fine.id)).toHaveLength(0);
      expect(await owner("select 1 from machvon.audit_event where resource_id = $1::uuid and action = 'pay.reconciliation_overdue'", [late.id])).toHaveLength(1);
      // A second pass, or a hundred, report nothing more.
      const second = await as((tx) => job.run(tx, memberId(OWNER), new Date('2026-07-11T07:00:00Z')));
      expect(second.reported).toBe(0);
      expect(await eventsOf(late.id)).toHaveLength(1);
    });

    it('reports an item later when its day comes, and sets the gauges of the backlog at every pass', async () => {
      const later = await item({ dueAt: '2026-07-12T10:00:00Z' });
      gauges.length = 0;
      const early = await as((tx) => job.run(tx, memberId(OWNER), NOW));
      expect(await eventsOf(later.id)).toHaveLength(0);
      expect(gauges.filter(([name]) => name === PAY_RECONCILIATION_OPEN_METRIC)).toHaveLength(1);
      expect(gauges.find(([name]) => name === PAY_RECONCILIATION_OVERDUE_METRIC)?.[1]).toBe(early.overdue);
      const passed = await as((tx) => job.run(tx, memberId(OWNER), new Date('2026-07-12T11:00:00Z')));
      expect(passed.reported).toBeGreaterThanOrEqual(1);
      expect(await eventsOf(later.id)).toHaveLength(1);
      expect(early.waiting).toBeGreaterThan(0);
    });

    it('carries the contract of an item that has one', async () => {
      const contract = await fixtures.seedContract();
      const target = await item({ dueAt: '2026-07-10T10:00:00Z', contractId: contract.contractId });
      await as((tx) => job.run(tx, memberId(OWNER), NOW));
      expect((await eventsOf(target.id))[0]?.payload).toMatchObject({ contract_id: contract.contractId });
    });
  });

  describe('where the projects stand with the Treasury (PAY-09)', () => {
    it('counts the requests with the Treasury, the payments confirmed, those not matched and the differences that wait, for the projects that have any', async () => {
      const rows = await as((tx) => tracking.list(tx, everything, { limit: 200, after: undefined }));
      const mine = rows.find((row) => row.projectId === fixtures.projectId);
      expect(mine).toBeDefined();
      expect(mine?.differences.count).toBeGreaterThan(0);
      expect(mine).toMatchObject({ sent: { count: expect.any(Number), amountVnd: expect.stringMatching(/^\d+$/) }, unmatched: expect.any(Number), lastImportAt: null });
      expect(await as((tx) => tracking.list(tx, nothing, { limit: 200, after: undefined }))).toEqual([]);
    });

    it('pages by the code of the project and refuses what is not a page', async () => {
      const rows = await as((tx) => tracking.list(tx, everything, { limit: 200, after: undefined }));
      expect(await as((tx) => tracking.list(tx, everything, { limit: 200, after: { code: rows[0]?.projectCode ?? '', id: rows[0]?.projectId ?? '' } }))).toHaveLength(Math.max(rows.length - 1, 0));
      expect(await refusal(as((tx) => tracking.list(tx, everything, { limit: 0, after: undefined })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'limit' });
      expect(await refusal(as((tx) => tracking.list(tx, everything, { limit: 5, after: { code: '', id: randomUUID() } })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'cursor' });
    });
  });
});
