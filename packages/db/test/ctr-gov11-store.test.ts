import { randomUUID } from 'node:crypto';
import type { AuditWriter } from '../src/audit-writer';
import { CtrAdjustmentStore } from '../src/ctr-adjustment-store';
import { CtrLinkageReads } from '../src/ctr-linkage-reads';
import { putRevisionInForce } from '../src/ctr-revision-effective';
import { CtrSettlementClockStore } from '../src/ctr-settlement-clock-store';
import type { TenantTx } from '../src/tenant-database';
import { AcceptanceWorld } from './support/acceptance-fixtures';
import { TENANT_A, memberId } from './support/authz-fixtures';
import { adminStatement } from './support/settled-payment';

jest.setTimeout(600_000);

const fixtures = new AcceptanceWorld();
const clocks = new CtrSettlementClockStore();
const adjustments = new CtrAdjustmentStore();
const linkage = new CtrLinkageReads();
const CREATOR = 1;
const REVIEWER = 5;
const NOW = new Date('2026-11-10T05:00:00Z');
const scope = () => ({ sql: 'true', params: [] as unknown[] });
const none = () => ({ sql: 'false', params: [] as unknown[] });
const as = <T>(work: (tx: TenantTx) => Promise<T>, member = CREATOR): Promise<T> => fixtures.as(work, member);
const owner = fixtures.owner.bind(fixtures);
const events: Array<{ type: string }> = [];
const noAudit = { recordInTx: async () => randomUUID() } as unknown as Pick<AuditWriter, 'recordInTx'>;
const collect = async (event: { type: string }): Promise<void> => void events.push(event);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function completed(group: string | null, completedOn: string): Promise<string> {
  const contract = await fixtures.seedContract();
  await adminStatement(fixtures, "update machvon.project set project_group = $2, status = case when $2::text is null then 'CONCEPT' else 'IMPLEMENTATION' end where id = $1::uuid", [fixtures.projectId, group]);
  await adminStatement(
    fixtures,
    `update machvon.contract set status = 'COMPLETED', completed_on = $2::date, completion_quality_acceptance_id = gen_random_uuid(), completed_by = $3::uuid where id = $1::uuid`,
    [contract.contractId, completedOn, memberId(CREATOR)],
  );
  return contract.contractId;
}

describe('the settlement clock, the adjustment versions and the linkage of a contract (G1-18)', () => {
  beforeAll(async () => {
    await fixtures.start();
  }, 240_000);

  afterAll(async () => {
    await fixtures.stop();
  }, 60_000);

  describe('the settlement clock', () => {
    it('starts one clock for each completed contract with the months of its group, once, and judges it on the day it is read', async () => {
      const contractB = await completed('B', '2026-06-15');
      const first = await as((tx) => clocks.sync(tx, memberId(CREATOR), noAudit, collect, NOW));
      expect(first.started).toBeGreaterThanOrEqual(1);
      expect(events.some((event) => event.type === 'ctr.settlement_clock_started.v1')).toBe(true);
      expect(await as((tx) => clocks.sync(tx, memberId(CREATOR), noAudit, collect, NOW))).toMatchObject({ started: 0, met: 0 });
      const rows = await owner<{ months_allowed: number; due_on: string; project_group: string | null; state: string }>(
        "select months_allowed, due_on::text as due_on, project_group, state from machvon.contract_settlement_clock where contract_id = $1::uuid",
        [contractB],
      );
      expect(rows).toEqual([{ months_allowed: 5, due_on: '2026-11-15', project_group: 'B', state: 'OPEN' }]);
      const contractC = await completed('C', '2026-06-15');
      await as((tx) => clocks.sync(tx, memberId(CREATOR), noAudit, collect, NOW));
      const board = await as((tx) => clocks.board(tx, scope, {}, NOW));
      const byContract = new Map(board.all.map((row) => [row.contract.id, row]));
      expect(byContract.get(contractB)?.contractor?.name).toBeTruthy();
      expect(byContract.get(contractB)).toMatchObject({ monthsAllowed: 5, dueOn: '2026-11-15', state: 'NEAR', daysLeft: 5 });
      expect(byContract.get(contractC)).toMatchObject({ monthsAllowed: 4, dueOn: '2026-10-15', state: 'OVERDUE', daysLeft: -26 });
      expect(board.rule).toMatchObject({ source: 'DEFAULT', unverified: true });
      const attention = await as((tx) => clocks.attention(tx, scope, NOW));
      expect(attention.map((row) => row.contract.id)).toEqual(expect.arrayContaining([contractB, contractC]));
      expect((await as((tx) => clocks.board(tx, scope, { state: 'OVERDUE' }, NOW))).rows.every((row) => row.state === 'OVERDUE')).toBe(true);
    });

    it('gives a project without a group the default months and says so, and shows nothing outside the scope', async () => {
      const contract = await completed(null, '2026-07-01');
      await as((tx) => clocks.sync(tx, memberId(CREATOR), noAudit, collect, NOW));
      const board = await as((tx) => clocks.board(tx, scope, {}, NOW));
      expect(board.all.find((row) => row.contract.id === contract)).toMatchObject({ projectGroup: null, monthsAllowed: 5, dueOn: '2026-12-01' });
      expect((await as((tx) => clocks.board(tx, none, {}, NOW))).all).toEqual([]);
    });

    it('does not let the identity of a clock change or a clock be deleted', async () => {
      const contract = await completed('B', '2026-05-01');
      await as((tx) => clocks.sync(tx, memberId(CREATOR), noAudit, collect, NOW));
      const state = async (work: Promise<unknown>): Promise<string> => {
        try {
          await work;
        } catch (error) {
          return (error as { code?: string }).code ?? '';
        }
        return 'none';
      };
      expect(await state(owner("update machvon.contract_settlement_clock set due_on = due_on + 30 where contract_id = $1::uuid", [contract]))).toBe('23514');
      expect(await state(owner('delete from machvon.contract_settlement_clock where contract_id = $1::uuid', [contract]))).toBe('23514');
    });
  });

  describe('the adjustment versions', () => {
    async function versionOf(amount: string): Promise<{ contractId: string; revisionId: string }> {
      const contract = await fixtures.seedContract();
      const first = (await owner<{ id: string }>('select id from machvon.contract_revision where contract_id = $1::uuid and revision = 1', [contract.contractId]))[0] as { id: string };
      await adminStatement(fixtures, "update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2::uuid, decided_at = now() where id = $1::uuid", [first.id, memberId(CREATOR)]);
      const revisionId = randomUUID();
      const document = await fixtures.documentVersion();
      await adminStatement(
        fixtures,
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, supersedes_id, version, created_by, updated_by, decided_by, decided_at)
         values ($1, $2, $3, 2, $4::numeric, $5, date '2026-11-10', 'PENDING_EFFECTIVE', 'AMENDMENT', $6, 1, $7, $7, $7, now())`,
        [TENANT_A, revisionId, contract.contractId, amount, document.id, first.id, memberId(CREATOR)],
      );
      await as((tx) => putRevisionInForce(tx, { contractId: contract.contractId, revisionId, validFrom: '2026-11-10', amountVnd: amount, actor: memberId(CREATOR) }));
      return { contractId: contract.contractId, revisionId };
    }

    it('records what a version that took effect did, once, with the class of the rule: over the threshold it waits for a review', async () => {
      const target = await versionOf('10000000000');
      const list = await as((tx) => adjustments.ofContract(tx, scope, target.contractId));
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ revision: 2, originalVnd: '9000000000', previousVnd: '9000000000', newVnd: '10000000000', deltaVnd: '1000000000', deltaPctOfPrevious: '11.11', cumulativePctOfOriginal: '11.11', classification: 'REVIEW_REQUIRED', reviewStatus: 'PENDING', madeBy: memberId(CREATOR) });
      expect(list[0]?.reasons).toContain('ORIGINAL');
      expect(await as((tx) => adjustments.record(tx, { contractId: target.contractId, revisionId: target.revisionId, actor: memberId(CREATOR), now: NOW }))).toMatchObject({ id: list[0]?.id });
      expect((await owner<{ n: string }>('select count(*)::text as n from machvon.contract_adjustment where contract_id = $1::uuid', [target.contractId]))[0]?.n).toBe('1');
      expect((await as((tx) => adjustments.pending(tx, scope))).some((row) => row.id === list[0]?.id)).toBe(true);
    });

    it('waits for a review when there is no baseline to compare a small change with, and the database refuses to close it from outside', async () => {
      const small = await versionOf('9090000000');
      const [row] = await as((tx) => adjustments.ofContract(tx, scope, small.contractId));
      expect(row).toMatchObject({ classification: 'NO_BASELINE', reviewStatus: 'PENDING' });
      expect(await sqlState(owner("update machvon.contract_adjustment set review_status = 'DECIDED' where id = $1::uuid", [row?.id]))).toBe('23514');
    });

    it('is reviewed once, by a person other than who made the change, under the version that was read, with the words the rule asks for', async () => {
      const target = await versionOf('10000000000');
      const [row] = await as((tx) => adjustments.ofContract(tx, scope, target.contractId));
      const review = (member: number, input: Partial<{ expectedVersion: number; decision: string; note: string | undefined }> = {}) =>
        as((tx) => adjustments.review(tx, scope, { id: (row as { id: string }).id, expectedVersion: input.expectedVersion ?? 1, decision: input.decision ?? 'KEEP_BASELINE', note: 'note' in input ? input.note : 'The baseline still holds after this change.', actor: memberId(member), now: NOW }), member);
      expect(await refusal(review(CREATOR))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await refusal(review(REVIEWER, { expectedVersion: 7 }))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect(await refusal(review(REVIEWER, { decision: 'MAYBE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect(await refusal(review(REVIEWER, { note: 'short' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'note' });
      const done = await review(REVIEWER);
      expect(done.row).toMatchObject({ reviewStatus: 'DECIDED', reviewDecision: 'KEEP_BASELINE', reviewedBy: memberId(REVIEWER), version: 2 });
      expect(await refusal(review(REVIEWER, { expectedVersion: 2 }))).toMatchObject({ code: 'ADJUSTMENT_STATE_INVALID', status: 409 });
      expect(await refusal(as((tx) => adjustments.review(tx, none, { id: (row as { id: string }).id, expectedVersion: 2, decision: 'KEEP_BASELINE', note: 'The baseline still holds after this change.', actor: memberId(REVIEWER), now: NOW }), REVIEWER))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    });
  });

  describe('the linkage', () => {
    it('proves the chain of a contract on the record and breaks where the award does not match', async () => {
      const contract = await fixtures.seedContract();
      const read = await as((tx) => linkage.read(tx, scope, contract.contractId));
      expect(read?.contract).toMatchObject({ originalValueVnd: '9000000000', revisions: 1 });
      expect(read?.package?.code).toBeDefined();
      expect(read?.contractor?.name).toBeTruthy();
      expect(read?.parties.every((party) => party.name !== '')).toBe(true);
      expect(read?.reading.findings.map((finding) => finding.code)).toContain('PACKAGE_NOT_AWARDED');
      expect(read?.reading.ok).toBe(false);
      expect(await as((tx) => linkage.read(tx, none, contract.contractId))).toBeUndefined();
    });
  });
});

const sqlState = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  return 'none';
};
