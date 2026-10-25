import { randomUUID } from 'node:crypto';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CtrRetentionDue } from '../src/ctr-retention-due';
import { CtrRetentionStore } from '../src/ctr-retention-store';
import type { ReleaseInput } from '../src/ctr-retention-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { adminStatement, settledPayment } from './support/settled-payment';
import type { SettledPayment } from './support/settled-payment';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const retention = new CtrRetentionStore();
const MAKER = 1;
const SENDER = 2; // sends the payment request: the retention is held in his name
const CHECKER = 3;
const MATCHER = 4;
const ACCOUNTANT = 6; // releases the retention
const NOW = new Date('2027-09-02T03:00:00Z');
const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });
const nothing: ScopeBuilder = () => ({ sql: 'false', params: [] });
const all: ContractScopes = { update: everything, read: everything };
const readOnly: ContractScopes = { update: nothing, read: everything };
const invisible: ContractScopes = { update: nothing, read: nothing };

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = ACCOUNTANT): Promise<T> => fixtures.as(work, member);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string; extensions?: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

const databaseRefusal = async (work: Promise<unknown>): Promise<{ message: string; sqlstate: string }> => {
  try {
    await work;
  } catch (error) {
    const e = error as { message: string; code?: string };
    return { message: e.message, sqlstate: e.code ?? '' };
  }
  throw new Error('expected the database to refuse');
};

interface HoldRow {
  id: string;
  held_vnd: string;
  released_vnd: string;
  status: string;
  version: string;
  release_condition: string;
  released_by: string | null;
  release_reason: string | null;
  boq_key: string;
}

/** A contract with a payment of 3bn settled: 150m is held back, 100m on B01 and 50m on B02. The payment holds it until the completion of the contract; the holds of these tests wait for the end of the warranty unless they are asked otherwise. */
async function paid(condition: 'WARRANTY_END' | 'COMPLETION' = 'WARRANTY_END'): Promise<{ payment: SettledPayment; b01: HoldRow; b02: HoldRow }> {
  const payment = await settledPayment(fixtures, { maker: MAKER, sender: SENDER, checker: CHECKER, matcher: MATCHER });
  const rows = await holdsOf(payment.contractId);
  const b01 = rows.find((row) => row.boq_key === 'B01');
  const b02 = rows.find((row) => row.boq_key === 'B02');
  if (b01 === undefined || b02 === undefined) throw new Error('the fixture holds no retention');
  if (condition === 'WARRANTY_END') for (const hold of [b01, b02]) await setHold(hold.id, "release_condition = 'WARRANTY_END'");
  return { payment, b01: { ...b01, release_condition: condition }, b02: { ...b02, release_condition: condition } };
}

const holdsOf = (contractId: string) =>
  fixtures.owner<HoldRow>(
    `select h.id, h.held_vnd::text as held_vnd, h.released_vnd::text as released_vnd, h.status, h.version::text as version, h.release_condition, h.released_by, h.release_reason, i.business_key as boq_key
       from machvon.retention_hold h join machvon.boq_item i on i.id = h.boq_item_id where h.contract_id = $1::uuid order by i.business_key`,
    [contractId],
  );
const holdOf = async (id: string): Promise<HoldRow> => {
  const [row] = await fixtures.owner<HoldRow>(
    `select h.id, h.held_vnd::text as held_vnd, h.released_vnd::text as released_vnd, h.status, h.version::text as version, h.release_condition, h.released_by, h.release_reason, '' as boq_key
       from machvon.retention_hold h where h.id = $1::uuid`,
    [id],
  );
  if (row === undefined) throw new Error('no hold');
  return row;
};

/** A warranty obligation of the contract, written straight to the database (the commands that create one are another story). */
const obligation = (contractId: string, status: 'ACTIVE' | 'CLOSED') =>
  adminStatement(
    fixtures,
    `insert into machvon.warranty_obligation
       (tenant_id, id, project_id, contract_id, handover_id, scope_description, starts_on, ends_on, period_months, retention_amount_vnd, status, created_by, updated_by, closed_by, closed_at)
     values ($1, gen_random_uuid(), $2, $3, gen_random_uuid(), 'Whole work', date '2026-01-01', date '2027-01-01', 12, 1, $4, $5, $5, case when $4 = 'CLOSED' then $5::uuid end, case when $4 = 'CLOSED' then now() end)`,
    [TENANT_A, fixtures.projectId, contractId, status, memberId(MAKER)],
  );
const closeObligations = (contractId: string) =>
  adminStatement(fixtures, "update machvon.warranty_obligation set status = 'CLOSED', closed_by = $2::uuid, closed_at = now() where contract_id = $1::uuid", [contractId, memberId(MAKER)]);
const setHold = (id: string, set: string, params: unknown[] = []) => adminStatement(fixtures, `update machvon.retention_hold set ${set} where id = $1::uuid`, [id, ...params]);

const release = (hold: HoldRow, overrides: Partial<ReleaseInput> = {}, options: { actor?: number; version?: number; scopes?: ContractScopes; now?: Date } = {}) =>
  as(
    (tx) =>
      retention.release(
        tx,
        hold.id,
        options.version ?? Number(hold.version),
        { amountVnd: hold.held_vnd, reason: 'The warranty has ended.', ...overrides },
        memberId(options.actor ?? ACCOUNTANT),
        randomUUID(),
        options.scopes ?? all,
        options.now ?? NOW,
      ),
    options.actor ?? ACCOUNTANT,
  );

const contractRow = async (contractId: string) =>
  (
    await fixtures.owner<{ held: string; released: string; version: string }>(
      'select retention_held_vnd::text as held, retention_released_vnd::text as released, version::text as version from machvon.contract where id = $1::uuid',
      [contractId],
    )
  )[0];

describe('the release of the retention (ST-CTR-010)', () => {
  beforeAll(async () => {
    await fixtures.start();
    for (const member of [MATCHER, ACCOUNTANT]) await fixtures.harness.seedMembership(TENANT_A, member, 1);
    await adminStatement(fixtures, "update machvon.project set status = 'IMPLEMENTATION', project_group = 'B' where id = $1::uuid", [fixtures.projectId]);
  }, 600_000);
  afterAll(() => fixtures.stop(), 60_000);

  describe('releasing', () => {
    it('AC-ST-CTR-010-1, UAT-AC309: refuses the maker, then a warranty that is open, then more than is held, and releases B01 on the exact amount, leaving B02 held', async () => {
      const { payment, b01, b02 } = await paid();
      expect(b01).toMatchObject({ held_vnd: '100000000', released_vnd: '0', status: 'HELD', release_condition: 'WARRANTY_END', version: '1' });
      expect(b02).toMatchObject({ held_vnd: '50000000', status: 'HELD' });
      expect(await contractRow(payment.contractId)).toMatchObject({ held: '150000000', released: '0' });

      // The person who sent the payment is the one the money was held in the name of; he does not release it.
      await obligation(payment.contractId, 'ACTIVE');
      expect(await refusal(release(b01, {}, { actor: SENDER }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      // The warranty is open.
      expect(await refusal(release(b01))).toMatchObject({ code: 'RELEASE_CONDITION_NOT_MET', status: 422, extensions: { condition: 'WARRANTY_END', reason: 'WARRANTY_OPEN', open_obligations: 1 } });
      await closeObligations(payment.contractId);
      expect(await refusal(release(b01, { amountVnd: '100000001' }))).toMatchObject({
        code: 'RELEASE_EXCEEDS_HELD',
        status: 422,
        extensions: { held_vnd: '100000000', left_vnd: '100000000', amount_vnd: '100000001' },
      });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'HELD', released_vnd: '0', version: '1' });

      const done = await release(b01, { amountVnd: '100000000', reason: 'The warranty has ended.' });
      expect(done).toMatchObject({
        id: b01.id,
        contractId: payment.contractId,
        heldVnd: '100000000',
        amountVnd: '100000000',
        releasedVnd: '100000000',
        fromStatus: 'HELD',
        status: 'RELEASED',
        version: 2,
        releaseCondition: 'WARRANTY_END',
        contractRetentionHeldVnd: '150000000',
        contractRetentionReleasedVnd: '100000000',
      });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'RELEASED', released_vnd: '100000000', released_by: memberId(ACCOUNTANT), release_reason: 'The warranty has ended.', version: '2' });
      expect(await holdOf(b02.id)).toMatchObject({ status: 'HELD', released_vnd: '0', held_vnd: '50000000', version: '1' });
      expect(await contractRow(payment.contractId)).toMatchObject({ held: '150000000', released: '100000000' });
    });

    it('puts the release on the ledger as an entry of its own and takes it off the balance of the line', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      const before = (
        await fixtures.owner<{ retention: string; version: string }>(
          'select retention_held_vnd::text as retention, version::text as version from machvon.cumulative_ledger where contract_id = $1::uuid and boq_item_id = (select boq_item_id from machvon.retention_hold where id = $2::uuid)',
          [payment.contractId, b01.id],
        )
      )[0];
      expect(before?.retention).toBe('100000000');
      await release(b01, { amountVnd: '30000000' });
      const entries = await fixtures.owner<{ entry_kind: string; retention_delta_vnd: string; payment_request_id: string; reason: string; created_by: string }>(
        "select entry_kind, retention_delta_vnd::text as retention_delta_vnd, payment_request_id, reason, created_by from machvon.cumulative_ledger_entry where contract_id = $1::uuid and entry_kind = 'RETENTION_RELEASE'",
        [payment.contractId],
      );
      expect(entries).toEqual([
        { entry_kind: 'RETENTION_RELEASE', retention_delta_vnd: '-30000000', payment_request_id: payment.paymentRequestId, reason: 'The warranty has ended.', created_by: memberId(ACCOUNTANT) },
      ]);
      const after = (
        await fixtures.owner<{ retention: string; version: string }>(
          'select retention_held_vnd::text as retention, version::text as version from machvon.cumulative_ledger where contract_id = $1::uuid and boq_item_id = (select boq_item_id from machvon.retention_hold where id = $2::uuid)',
          [payment.contractId, b01.id],
        )
      )[0];
      expect(after?.retention).toBe('70000000');
    });

    it('releases in parts: partially released after the first, released after the last, and nothing is left to release after that, whatever version the caller saw', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      const first = await release(b01, { amountVnd: '40000000', reason: 'First part.' });
      expect(first).toMatchObject({ status: 'PARTIALLY_RELEASED', releasedVnd: '40000000', version: 2 });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'PARTIALLY_RELEASED', released_vnd: '40000000' });
      expect(await refusal(release(b01, { amountVnd: '60000001' }, { version: 2 }))).toMatchObject({ code: 'RELEASE_EXCEEDS_HELD', extensions: { left_vnd: '60000000' } });
      const last = await release(b01, { amountVnd: '60000000', reason: 'The rest.' }, { version: 2 });
      expect(last).toMatchObject({ status: 'RELEASED', releasedVnd: '100000000', version: 3, contractRetentionReleasedVnd: '100000000' });
      // A new key after the success, with the version it was read at: the hold has nothing left, and that is the answer.
      expect(await refusal(release(b01, { amountVnd: '100000000' }, { version: 2 }))).toMatchObject({ code: 'RELEASE_EXCEEDS_HELD', status: 422, extensions: { left_vnd: '0' } });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'RELEASED', released_vnd: '100000000', version: '3', release_reason: 'The rest.' });
      expect((await contractRow(payment.contractId))?.released).toBe('100000000');
      expect(await fixtures.owner("select 1 from machvon.cumulative_ledger_entry where contract_id = $1::uuid and entry_kind = 'RETENTION_RELEASE'", [payment.contractId])).toHaveLength(2);
    });

    it('refuses a stale version, an amount of nothing and a badly formed request, and changes nothing', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      expect(await refusal(release(b01, {}, { version: 7 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, extensions: { current_version: 1 } });
      expect(await refusal(release(b01, { amountVnd: '0' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(release(b01, { amountVnd: '12.5' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(release(b01, { amountVnd: '-1' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount_vnd' });
      expect(await refusal(release(b01, { reason: '   ' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(release(b01, { decisionDocumentVersionId: 'nope' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision_document_version_id' });
      expect(await refusal(as((tx) => retention.release(tx, 'nope', 1, { amountVnd: '1', reason: 'r' }, memberId(ACCOUNTANT), randomUUID(), all, NOW)))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'id',
      });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'HELD', released_vnd: '0', version: '1' });
      expect((await contractRow(payment.contractId))?.released).toBe('0');
    });

    it('says that a contract with no warranty obligation has not ended its warranty', async () => {
      const { b01 } = await paid();
      expect(await refusal(release(b01))).toMatchObject({ code: 'RELEASE_CONDITION_NOT_MET', extensions: { condition: 'WARRANTY_END', reason: 'NO_WARRANTY' } });
    });

    it('waits for the earliest day, and releases on it', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      await setHold(b01.id, "release_not_before = date '2028-03-01'");
      expect(await refusal(release(b01, {}, { now: new Date('2028-02-29T03:00:00Z') }))).toMatchObject({
        code: 'RELEASE_CONDITION_NOT_MET',
        extensions: { reason: 'NOT_BEFORE', release_not_before: '2028-03-01' },
      });
      expect(await release(b01, {}, { now: new Date('2028-03-01T03:00:00Z') })).toMatchObject({ status: 'RELEASED' });
    });

    it('waits for the completion of the contract when that is the condition', async () => {
      const { payment, b01 } = await paid('COMPLETION');
      expect(await refusal(release(b01))).toMatchObject({ code: 'RELEASE_CONDITION_NOT_MET', extensions: { condition: 'COMPLETION', reason: 'CONTRACT_NOT_COMPLETED' } });
      await adminStatement(
        fixtures,
        "update machvon.contract set status = 'COMPLETED', completed_on = date '2027-08-01', completion_quality_acceptance_id = gen_random_uuid(), completed_by = $2::uuid where id = $1::uuid",
        [payment.contractId, memberId(MAKER)],
      );
      expect(await release(b01)).toMatchObject({ status: 'RELEASED', releaseCondition: 'COMPLETION' });
    });

    it('waits for the decision of the authority, as a clean document, when that is the condition', async () => {
      const { b01 } = await paid();
      await setHold(b01.id, "release_condition = 'MANUAL_DECISION'");
      expect(await refusal(release(b01))).toMatchObject({ code: 'RELEASE_CONDITION_NOT_MET', extensions: { condition: 'MANUAL_DECISION', reason: 'DECISION_REQUIRED' } });
      const unscanned = await fixtures.documentVersion('PENDING');
      expect(await refusal(release(b01, { decisionDocumentVersionId: unscanned.id }))).toMatchObject({ code: 'DOCUMENT_NOT_CLEAN', status: 422 });
      expect(await refusal(release(b01, { decisionDocumentVersionId: randomUUID() }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        detail: 'decision_document_version_id',
        extensions: { reason: 'NOT_FOUND' },
      });
      const decision = await fixtures.documentVersion();
      expect(await release(b01, { amountVnd: '40000000', decisionDocumentVersionId: decision.id })).toMatchObject({ status: 'PARTIALLY_RELEASED', decisionDocumentVersionId: decision.id });
      // The decision stays with the hold: the next part needs no new one.
      expect(await release(b01, { amountVnd: '60000000' }, { version: 2 })).toMatchObject({ status: 'RELEASED', decisionDocumentVersionId: decision.id });
    });

    it('is judged by the scope of the caller: one it can read and not change is refused, one it cannot see does not exist', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      expect(await refusal(release(b01, {}, { scopes: readOnly }))).toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      expect(await refusal(release(b01, {}, { scopes: invisible }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
      expect(await refusal(as((tx) => retention.release(tx, randomUUID(), 1, { amountVnd: '1', reason: 'r' }, memberId(ACCOUNTANT), randomUUID(), all, NOW)))).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'HELD' });
    });

    it('does not release a hold that was forfeited', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      await setHold(b01.id, "status = 'FORFEITED'");
      expect(await refusal(release(b01))).toMatchObject({ code: 'RELEASE_EXCEEDS_HELD', extensions: { left_vnd: '0' } });
    });

    it('does not post a release for a line that is not on the ledger', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      await adminStatement(
        fixtures,
        'update machvon.cumulative_ledger set acceptance_id = gen_random_uuid() where contract_id = $1::uuid and boq_item_id = (select boq_item_id from machvon.retention_hold where id = $2::uuid)',
        [payment.contractId, b01.id],
      );
      expect(await refusal(release(b01))).toMatchObject({ code: 'PAYMENT_STATE_INVALID', status: 409, extensions: { reason: 'NOT_ON_THE_LEDGER' } });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'HELD', released_vnd: '0' });
    });
  });

  describe('the database', () => {
    it('keeps what a hold is, never takes back what was released and moves the status only forward', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      await release(b01, { amountVnd: '40000000' });
      const update = (set: string) => fixtures.owner(`update machvon.retention_hold set ${set} where id = $1::uuid`, [b01.id]);
      expect((await databaseRefusal(update('held_vnd = held_vnd + 1'))).message).toContain('never changes');
      expect((await databaseRefusal(update("release_condition = 'COMPLETION'"))).message).toContain('never changes');
      expect((await databaseRefusal(update("release_not_before = date '2030-01-01'"))).message).toContain('never changes');
      expect((await databaseRefusal(update('released_vnd = 10000000'))).message).toContain('not taken back');
      expect((await databaseRefusal(update("status = 'HELD', released_vnd = 40000000"))).message).toContain('this move of the status');
      await update('due_notified_on = current_date');
      await release(b01, { amountVnd: '60000000' }, { version: 2 });
      expect((await databaseRefusal(update("status = 'FORFEITED'"))).message).toContain('does not change');
    });

    it('refuses a release without its author or its reason, one by the maker, and a status that does not say how much is released', async () => {
      const { b02 } = await paid();
      const update = (set: string, params: unknown[] = []) => fixtures.owner(`update machvon.retention_hold set ${set} where id = $1::uuid`, [b02.id, ...params]);
      const partly = "released_vnd = 10000000, status = 'PARTIALLY_RELEASED'";
      expect((await databaseRefusal(update(`${partly}, released_by = $2::uuid, released_at = now()`, [memberId(ACCOUNTANT)]))).message).toContain('retention_hold_release_audit_chk');
      expect((await databaseRefusal(update(`${partly}, released_by = $2::uuid, released_at = now(), release_reason = 'x'`, [memberId(SENDER)]))).message).toContain('retention_hold_release_actor_chk');
      expect((await databaseRefusal(update(`${partly}, released_by = $2::uuid, release_reason = 'x'`, [memberId(ACCOUNTANT)]))).message).toContain('retention_hold_release_actor_chk');
      expect((await databaseRefusal(update(`${partly}, released_by = $2::uuid, released_at = now(), release_reason = '  '`, [memberId(ACCOUNTANT)]))).message).toContain(
        'retention_hold_release_reason_chk',
      );
      expect((await databaseRefusal(update("released_vnd = 10000000, status = 'HELD', released_by = $2::uuid, released_at = now(), release_reason = 'x'", [memberId(ACCOUNTANT)]))).message).toContain(
        'retention_hold_progress_chk',
      );
      expect(await holdOf(b02.id)).toMatchObject({ status: 'HELD', released_vnd: '0' });
    });
  });

  describe('reading', () => {
    it('gives the totals of the contract and the holds, each with what is left, the condition and whether the money may be released today', async () => {
      const { payment, b01, b02 } = await paid();
      const header = await as((tx) => retention.header(tx, payment.contractId, everything));
      expect(header).toMatchObject({ contractId: payment.contractId, contractStatus: 'ACTIVE', retentionHeldVnd: '150000000', retentionReleasedVnd: '0' });
      expect(header?.place.projectId).toBe(fixtures.projectId);
      const lines = await as((tx) => retention.list(tx, payment.contractId, everything, { limit: 10 }, NOW));
      expect(lines.map((line) => line.boqItem.key).sort()).toEqual(['B01', 'B02']);
      const one = lines.find((line) => line.id === b01.id);
      expect(one).toMatchObject({
        heldVnd: '100000000',
        releasedVnd: '0',
        leftVnd: '100000000',
        releaseCondition: 'WARRANTY_END',
        releaseNotBefore: null,
        status: 'HELD',
        blocker: 'NO_WARRANTY',
        releasedAt: null,
        releaseReason: null,
        version: 1,
      });
      expect(one?.boqItem.description).not.toBe('');
      await obligation(payment.contractId, 'ACTIVE');
      expect((await as((tx) => retention.list(tx, payment.contractId, everything, { limit: 10 }, NOW))).every((line) => line.blocker === 'WARRANTY_OPEN')).toBe(true);
      await closeObligations(payment.contractId);
      await release(b01, { amountVnd: '100000000' });
      const after = await as((tx) => retention.list(tx, payment.contractId, everything, { limit: 10 }, NOW));
      expect(after.find((line) => line.id === b01.id)).toMatchObject({ status: 'RELEASED', leftVnd: '0', releasedVnd: '100000000', blocker: null });
      expect(after.find((line) => line.id === b01.id)?.releasedAt).not.toBeNull();
      expect(after.find((line) => line.id === b02.id)).toMatchObject({ status: 'HELD', leftVnd: '50000000', blocker: null });
      expect((await as((tx) => retention.header(tx, payment.contractId, everything)))?.retentionReleasedVnd).toBe('100000000');
    });

    it('filters by status, pages with a cursor and refuses a filter that is not one', async () => {
      const { payment, b01 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      await release(b01, { amountVnd: '100000000' });
      const list = (filter: { status?: string; limit: number; after?: { code: string; id: string } }) => as((tx) => retention.list(tx, payment.contractId, everything, filter, NOW));
      expect((await list({ status: 'RELEASED', limit: 10 })).map((line) => line.id)).toEqual([b01.id]);
      expect((await list({ status: 'HELD', limit: 10 })).map((line) => line.boqItem.key)).toEqual(['B02']);
      const page = await list({ limit: 1 });
      const next = await list({ limit: 1, after: { code: page[0]?.createdAt ?? '', id: page[0]?.id ?? '' } });
      expect(page).toHaveLength(1);
      expect(next).toHaveLength(1);
      expect(next[0]?.id).not.toBe(page[0]?.id);
      expect(await refusal(list({ status: 'GONE', limit: 10 }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'status' });
      expect(await refusal(list({ limit: 0 }))).toMatchObject({ detail: 'limit' });
      expect(await refusal(list({ limit: 202 }))).toMatchObject({ detail: 'limit' });
      expect(await refusal(as((tx) => retention.list(tx, 'nope', everything, { limit: 5 }, NOW)))).toMatchObject({ detail: 'contract_id' });
    });

    it('shows nothing of a contract outside the scope of the caller', async () => {
      const { payment } = await paid();
      expect(await as((tx) => retention.header(tx, payment.contractId, nothing))).toBeUndefined();
      expect(await as((tx) => retention.list(tx, payment.contractId, nothing, { limit: 10 }, NOW))).toEqual([]);
    });
  });

  describe('the job retention-due', () => {
    const job = new CtrRetentionDue();
    const remindersOf = (holdId: string) =>
      fixtures.owner<{ payload: Record<string, unknown> }>("select payload from machvon.outbox_event where aggregate_id = $1 and type = 'ctr.retention.due.v1' order by created_at, id", [holdId]);

    it('reminds once, on the morning the earliest day comes, the holds that still hold something, and releases nothing', async () => {
      const { payment, b01, b02 } = await paid();
      await setHold(b01.id, "release_not_before = date '2028-03-01'");
      await setHold(b02.id, "release_not_before = date '2028-03-02'");
      expect(await as((tx) => job.run(tx, new Date('2028-02-29T00:00:00Z')))).toEqual({ reminded: 0 });
      expect(await as((tx) => job.run(tx, new Date('2028-03-01T00:00:00Z')))).toEqual({ reminded: 1 });
      const [reminder] = await remindersOf(b01.id);
      expect(reminder?.payload).toMatchObject({ hold_id: b01.id, contract_id: payment.contractId, release_condition: 'WARRANTY_END', release_not_before: '2028-03-01', left_vnd: '100000000' });
      expect(reminder?.payload.notification).toMatchObject({
        deepLink: `/ctr/ctr-21?contract=${payment.contractId}`,
        resource: { type: 'retention_hold', id: b01.id, contractId: payment.contractId },
      });
      expect(await remindersOf(b02.id)).toEqual([]);
      // The same morning, and the next, send nothing; the hold is not changed by the reminder.
      expect(await as((tx) => job.run(tx, new Date('2028-03-01T04:00:00Z')))).toEqual({ reminded: 0 });
      expect(await as((tx) => job.run(tx, new Date('2028-03-02T00:00:00Z')))).toEqual({ reminded: 1 });
      expect(await as((tx) => job.run(tx, new Date('2028-03-03T00:00:00Z')))).toEqual({ reminded: 0 });
      expect(await holdOf(b01.id)).toMatchObject({ status: 'HELD', released_vnd: '0', version: '1' });
      expect((await fixtures.owner<{ due: string | null }>('select due_notified_on::text as due from machvon.retention_hold where id = $1::uuid', [b01.id]))[0]?.due).toBe('2028-03-01');
    });

    it('does not remind a hold that is released, has no earliest day, or whose day is not set', async () => {
      const { payment, b01, b02 } = await paid();
      await obligation(payment.contractId, 'CLOSED');
      await setHold(b01.id, "release_not_before = date '2028-03-01'");
      await release(b01, { amountVnd: '100000000' }, { now: new Date('2028-03-01T03:00:00Z') });
      expect(await as((tx) => job.run(tx, new Date('2028-03-05T00:00:00Z')))).toEqual({ reminded: 0 });
      expect(await remindersOf(b01.id)).toEqual([]);
      expect(await remindersOf(b02.id)).toEqual([]);
    });
  });
});
