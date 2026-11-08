import { randomUUID } from 'node:crypto';
import type { ContractScopes } from '../src/ctr-contract-store';
import { PayClaimStore } from '../src/pay-claim-store';
import { PayClockStore } from '../src/pay-clock-store';
import { PayPaymentStore } from '../src/pay-payment-store';
import type { TenantTx } from '../src/tenant-database';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import { TENANT_A, memberId } from './support/authz-fixtures';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const payments = new PayPaymentStore();
const claims = new PayClaimStore();
const clocks = new PayClockStore();
const MAKER = 1;
const SENDER = 2;
const CHECKER = 3;
const NOW = new Date('2026-07-27T05:00:00Z');
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };
const scope = () => ({ sql: 'true', params: [] as unknown[] });
const none = () => ({ sql: 'false', params: [] as unknown[] });
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);
let counter = 0;

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

/** A request that was sent by the sender and waits to be checked, of a contract with an approved acceptance. */
async function sentRequest(kind: 'INTERIM' = 'INTERIM'): Promise<{ id: string; version: number; contractId: string }> {
  counter += 1;
  const contract = await fixtures.seedContract();
  await fixtures.owner('update machvon.contract_party set work_value_vnd = 10000000000 where contract_id = $1::uuid', [contract.contractId]);
  const approved = await fixtures.approve(contract, [
    { item: 0, quantity: '2000' },
    { item: 1, quantity: '500' },
  ]);
  const made = await as((tx) => payments.create(tx, { contractId: contract.contractId, requestKind: kind, acceptanceId: approved.acceptance.id, allocationLineId: fixtures.lineId, requestNo: `DNTT-C-${counter}-${randomUUID().slice(0, 6)}` }, memberId(MAKER), everything, '2026-07-25'));
  const document = await fixtures.documentVersion();
  await as((tx) => payments.attachDocument(tx, made.id, { documentVersionId: document.id, docKind: 'INVOICE', invoiceNo: `HD-C-${counter}-${randomUUID().slice(0, 6)}`, invoiceDate: '2026-07-01' }, memberId(MAKER), everything, { mayOverride: () => false }), MAKER);
  const sent = await as((tx) => claims.submit(tx, made.id, made.version, { expectedGrossVnd: made.grossVnd, expectedNetVnd: made.netVnd, requestId: randomUUID() }, memberId(SENDER), everything, '2026-07-25'), SENDER);
  return { id: made.id, version: sent.version, contractId: contract.contractId };
}

const giveBack = (target: { id: string; version: number }, input: { reason: string; reasonCode?: string }) =>
  as((tx) => claims.returnRequest(tx, target.id, target.version, { ...input, requestId: randomUUID() }, memberId(CHECKER), everything), CHECKER);

describe('the clock of the Treasury control and the standard return reasons (G1-17)', () => {
  beforeAll(async () => {
    await fixtures.start();
    await fixtures.harness.seedMembership(TENANT_A, CHECKER, 1);
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('returning a request', () => {
    it('refuses a return without a reason of the standard list (422 VALIDATION_FAILED at reason_code) and leaves the request as it was', async () => {
      const target = await sentRequest();
      expect(await refusal(giveBack(target, { reason: 'The invoice is missing from the dossier' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason_code' });
      expect(await refusal(giveBack(target, { reason: 'The invoice is missing from the dossier', reasonCode: 'NOT_A_REASON' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reason_code' });
      expect((await owner<{ status: string }>('select status from machvon.payment_request where id = $1::uuid', [target.id]))[0]?.status).toBe('SUBMITTED');
    });

    it('asks a reason that needs words for them, and stores the code of the standard reason with the return', async () => {
      const target = await sentRequest();
      expect(await refusal(giveBack(target, { reason: 'Other', reasonCode: 'OTHER' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      await giveBack(target, { reason: 'The invoice is missing from the dossier', reasonCode: 'MISSING_DOCUMENT' });
      const row = (await owner<{ status: string; return_reason_code: string | null; return_reason: string | null }>('select status, return_reason_code, return_reason from machvon.payment_request where id = $1::uuid', [target.id]))[0];
      expect(row).toMatchObject({ status: 'RETURNED', return_reason_code: 'MISSING_DOCUMENT', return_reason: 'The invoice is missing from the dossier' });
    });

    it('ends the open clock of the request with the reason code when it is returned, once', async () => {
      const target = await sentRequest();
      await owner(
        `insert into machvon.payment_clock (tenant_id, id, payment_request_id, project_id, contract_id, owner_unit_id, clock_kind, attempt, started_at, working_days, near_working_hours, due_at, basis, policy_version, created_by, updated_by)
         select $1, gen_random_uuid(), pr.id, pr.project_id, pr.contract_id, p.owner_unit_id, 'PAYMENT', 1, timestamptz '2026-07-24T03:00:00Z', 2, 8, timestamptz '2026-07-28T03:00:00Z', 'WORKING_TIME', 0, $3::uuid, $3::uuid
           from machvon.payment_request pr join machvon.project p on p.tenant_id = pr.tenant_id and p.id = pr.project_id where pr.id = $2::uuid`,
        [TENANT_A, target.id, memberId(SENDER)],
      );
      await giveBack(target, { reason: 'The invoice is missing from the dossier', reasonCode: 'MISSING_DOCUMENT' });
      const clock = (await owner<{ end_kind: string | null; return_reason_code: string | null; returned_by_treasury: boolean | null }>('select end_kind, return_reason_code, returned_by_treasury from machvon.payment_clock where payment_request_id = $1::uuid', [target.id]))[0];
      expect(clock).toEqual({ end_kind: 'RETURNED', return_reason_code: 'MISSING_DOCUMENT', returned_by_treasury: false });
      expect(await as((tx) => clocks.end(tx, { requestId: target.id, endKind: 'SETTLED', actor: memberId(SENDER), now: NOW }))).toBe(false);
    });
  });

  describe('the board of the clocks', () => {
    async function clockOf(target: { id: string }, over: { started: string; due: string | null; basis?: string; ended?: { at: string; kind: 'SETTLED' | 'RETURNED'; code?: string } }): Promise<void> {
      await owner(
        `insert into machvon.payment_clock (tenant_id, id, payment_request_id, project_id, contract_id, owner_unit_id, clock_kind, attempt, started_at, working_days, near_working_hours, due_at, basis, policy_version, created_by, updated_by,
                                           ended_at, end_kind, return_reason_code, returned_by_treasury, ended_by)
         select $1, gen_random_uuid(), pr.id, pr.project_id, pr.contract_id, p.owner_unit_id, 'PAYMENT', 1, $3::timestamptz, 2, 8, $4::timestamptz, $5, 0, $6::uuid, $6::uuid,
                $7::timestamptz, $8, $9, case when $8 = 'RETURNED' then false else null end, case when $8 is null then null else $6::uuid end
           from machvon.payment_request pr join machvon.project p on p.tenant_id = pr.tenant_id and p.id = pr.project_id where pr.id = $2::uuid`,
        [TENANT_A, target.id, over.started, over.due, over.basis ?? (over.due === null ? 'CALENDAR_UNAVAILABLE' : 'WORKING_TIME'), memberId(SENDER), over.ended?.at ?? null, over.ended?.kind ?? null, over.ended?.code ?? null],
      );
    }

    it('judges each clock on the day it is read, without a stored state, and counts the returns per reason', async () => {
      const running = await sentRequest();
      const breached = await sentRequest();
      const unknown = await sentRequest();
      await clockOf(running, { started: '2026-07-27T02:00:00Z', due: '2026-07-29T10:00:00Z' });
      await clockOf(breached, { started: '2026-07-20T02:00:00Z', due: '2026-07-22T10:00:00Z' });
      await clockOf(unknown, { started: '2026-07-27T02:00:00Z', due: null });
      await owner("insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at) values ($1, gen_random_uuid(), 'WORKDAY_VN', 2026, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $2, $2, now())", [TENANT_A, memberId(SENDER)]);
      const board = await as((tx) => clocks.board(tx, scope, { from: '2026-07-01' }, NOW));
      const byRequest = new Map(board.rows.map((row) => [row.paymentRequestId, row]));
      expect(byRequest.get(running.id)).toMatchObject({ state: 'RUNNING', basis: 'WORKING_TIME' });
      expect(byRequest.get(breached.id)).toMatchObject({ state: 'BREACHED' });
      expect(byRequest.get(unknown.id)).toMatchObject({ basis: 'CALENDAR_UNAVAILABLE', dueAt: null });
      expect(board.summary.breached).toBeGreaterThanOrEqual(1);
      expect(board.calendarFound).toBe(true);
      expect(board.calendarUnavailable).toBe(true);
    });

    it('shows nothing of a contract outside the scope of the caller and reads the catalogue of reasons from the rule', async () => {
      const board = await as((tx) => clocks.board(tx, none, { from: '2000-01-01' }, NOW));
      expect(board.rows).toEqual([]);
      const reasons = await as((tx) => clocks.reasons(tx, '2026-07-27'));
      expect(reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['MISSING_DOCUMENT', 'OTHER']));
      expect(reasons.every((reason) => reason.unverified && reason.source === 'DEFAULT')).toBe(true);
      const rule = await as((tx) => clocks.rule(tx, 'ADVANCE', '2026-07-27'));
      expect(rule.params.working_days).toBe(1);
      expect((await as((tx) => clocks.rule(tx, 'PAYMENT', '2026-07-27'))).params.working_days).toBe(2);
    });

    it('does not let an ended clock be changed or a clock be deleted', async () => {
      const target = await sentRequest();
      await clockOf(target, { started: '2026-07-20T02:00:00Z', due: '2026-07-22T10:00:00Z', ended: { at: '2026-07-21T02:00:00Z', kind: 'SETTLED' } });
      const sqlState = async (work: Promise<unknown>): Promise<string> => {
        try {
          await work;
        } catch (error) {
          return (error as { code?: string }).code ?? '';
        }
        return 'none';
      };
      expect(await sqlState(owner("update machvon.payment_clock set end_kind = 'RETURNED', return_reason_code = 'OTHER', returned_by_treasury = false where payment_request_id = $1::uuid", [target.id]))).toBe('23514');
      expect(await sqlState(owner('delete from machvon.payment_clock where payment_request_id = $1::uuid', [target.id]))).toBe('23514');
    });
  });
});
