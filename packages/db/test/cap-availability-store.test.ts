import { randomUUID } from 'node:crypto';
import { assertOneWinner, runLoops, tallyOutcomes } from '@machvon/kernel';
import { CapAvailabilityStore } from '../src/cap-availability-store';
import type { CommitInput } from '../src/cap-availability-store';
import { CapAvcPolicyStore } from '../src/cap-avc-policy-store';
import type { NewAvcPolicy } from '../src/cap-avc-policy-store';
import { APPROVER, CapWorld, MAKER, PUBLISHER, money } from './support/cap-fixtures';
import type { PublishedLine } from './support/cap-fixtures';
import { memberId } from './support/authz-fixtures';

const world = new CapWorld();
const availability = new CapAvailabilityStore();
const policies = new CapAvcPolicyStore();
const ACTOR = memberId(PUBLISHER);
const FOREVER = { effectiveFrom: '2000-01-01', effectiveUntil: '2099-12-31' };

interface Refusal {
  code: string;
  status: number;
  detail?: string;
  extensions?: Record<string, unknown>;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string; extensions?: Record<string, unknown> };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }), ...(e.extensions === undefined ? {} : { extensions: e.extensions }) };
  }
  throw new Error('expected a refusal');
}

let counter = 0;
const publishPolicy = async (input: Omit<NewAvcPolicy, 'policyCode' | 'legalBasis' | 'effectiveFrom' | 'effectiveUntil'>): Promise<string> => {
  counter += 1;
  const draft = await world.as((tx) => policies.create(tx, { policyCode: `AVC-T-${counter}`, legalBasis: 'Quyết định 12/QĐ-UBND', ...FOREVER, ...input }, memberId(MAKER)));
  await world.as((tx) => policies.publish(tx, draft.id, draft.version, memberId(APPROVER)), APPROVER);
  return draft.id;
};
/** A fund source of its own, so a policy that names it governs only the lines of the test that made it. */
async function ownFund(category: string): Promise<{ versionId: string; key: string }> {
  const versionId = await world.fundSource(category);
  return { versionId, key: await world.businessKeyOf(versionId) };
}
const commit = (line: PublishedLine, amount: string, options: Partial<CommitInput> = {}) =>
  world.as((tx) => availability.checkAndCommit(tx, { allocationLineId: line.lineId, amountVnd: amount, sourceKind: 'CONTRACT', sourceId: randomUUID(), acknowledgeWarning: false, ...options }, ACTOR), PUBLISHER);
const entriesOf = (lineId: string) =>
  world.owner<{ entry_type: string; amount: string; source_ref_kind: string; reason: string | null; appropriation_id: string; project_id: string }>(
    "select entry_type, amount_vnd::text as amount, source_ref_kind, reason, appropriation_id, project_id from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type = 'COMMIT'",
    [lineId],
  );

beforeAll(() => world.start(), 240_000);
afterAll(() => world.stop(), 60_000);
jest.setTimeout(240_000);

describe('CapAvailabilityStore.ofLine and ofAppropriation (getCapitalAvailability)', () => {
  it('reads what is left of a line and where it stands against the default thresholds of the tenant', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    await world.setFigures(line.balanceId, { committed: '500', disbursed: '100', reserved: '200' });
    const found = await world.as((tx) => availability.ofLine(tx, line.lineId));
    expect(found).toMatchObject({
      allocationLineId: line.lineId,
      appropriationId: line.appropriationId,
      figures: { allocatedVnd: '1000', reservedVnd: '200', committedVnd: '500', disbursedVnd: '100' },
      thresholds: { policyId: null, warnPct: '90.00', blockPct: '100.00', includeReservations: true },
      verdict: { state: 'OK', consumptionPct: '80.00', usedVnd: '800', availableVnd: '200' },
    });
    expect(await world.as((tx) => availability.ofLine(tx, randomUUID()))).toBeUndefined();
  });

  it('adds the lines of an appropriation and judges them only when a policy controls the appropriation', async () => {
    const fund = await ownFund('ADDUP');
    const first = await world.publishedLine({ allocated: '1000', appropriationAmount: '10000', fundVersionId: fund.versionId });
    const second = await world.publishedLine({ allocated: '2000', appropriationId: first.appropriationId, year: first.year, fundVersionId: fund.versionId });
    await world.setFigures(first.balanceId, { committed: '900' });
    await world.setFigures(second.balanceId, { committed: '1500', reserved: '300' });
    const none = await world.as((tx) => availability.ofAppropriation(tx, first.appropriationId));
    expect(none).toMatchObject({ allocationLineId: null, appropriationId: first.appropriationId, figures: { allocatedVnd: '10000', reservedVnd: '300', committedVnd: '2400', disbursedVnd: '0' }, thresholds: undefined, verdict: undefined });
    const policyId = await publishPolicy({ scopeKind: 'FUND_SOURCE', scopeValue: fund.key, controlObject: 'APPROPRIATION', warnPct: '20', blockPct: '50' });
    const judged = await world.as((tx) => availability.ofAppropriation(tx, first.appropriationId));
    expect(judged).toMatchObject({ thresholds: { policyId, warnPct: '20.00', blockPct: '50.00' }, verdict: { state: 'WARN', consumptionPct: '27.00', usedVnd: '2700', availableVnd: '7300' } });
    expect(await world.as((tx) => availability.ofAppropriation(tx, randomUUID()))).toBeUndefined();
  });
});

describe('CapAvailabilityStore.checkAndCommit (AC-ST-CAP-005-1)', () => {
  it('commits an amount below the warning threshold: the balance moves with its ledger entry in the same transaction', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const result = await commit(line, '400');
    expect(result).toMatchObject({ allocationLineId: line.lineId, appropriationId: line.appropriationId, projectId: line.projectId, amountVnd: '400', replayed: false, warningAcknowledged: false, policyId: null });
    expect(result.line).toMatchObject({ state: 'OK', consumptionPct: '40.00', usedVnd: '400' });
    expect(result.appropriation).toBeUndefined();
    expect(await world.balanceOf(line.balanceId)).toMatchObject({ committed: '400', allocated: '1000', version: '2' });
    expect(await entriesOf(line.lineId)).toEqual([{ entry_type: 'COMMIT', amount: '400', source_ref_kind: 'CONTRACT', reason: null, appropriation_id: line.appropriationId, project_id: line.projectId }]);
  });

  it('answers a line that was allocated nothing with AVC_BLOCKED and ZERO_ALLOCATION', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    await world.owner('update machvon.allocation_balance set allocated_vnd = 0 where id = $1::uuid', [line.balanceId]);
    expect(await refusal(commit(line, '1', { acknowledgeWarning: true }))).toMatchObject({
      code: 'AVC_BLOCKED',
      status: 422,
      extensions: { reason: 'ZERO_ALLOCATION', warn_pct: '90.00', block_pct: '100.00', policy_id: null, control_object: 'ALLOCATION_LINE' },
    });
    expect(await entriesOf(line.lineId)).toEqual([]);
    expect((await world.balanceOf(line.balanceId)).committed).toBe('0');
  });

  it('asks for the acknowledgement of a warning, records it with the share, and blocks above the block threshold', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const warned = await refusal(commit(line, '950'));
    expect(warned).toMatchObject({ code: 'AVC_WARNING_ACK_REQUIRED', status: 422, extensions: { consumption_pct: '95.00', warn_pct: '90.00', block_pct: '100.00', policy_id: null, control_object: 'ALLOCATION_LINE' } });
    expect((await world.balanceOf(line.balanceId)).committed).toBe('0');
    const done = await commit(line, '950', { acknowledgeWarning: true });
    expect(done).toMatchObject({ warningAcknowledged: true, line: { state: 'WARN', consumptionPct: '95.00' } });
    expect((await entriesOf(line.lineId))[0]?.reason).toBe('AVC warning acknowledged at 95.00%');
    // 951 of 1000 after 950 is above the block threshold, whatever the acknowledgement.
    expect(await refusal(commit(line, '51', { acknowledgeWarning: true }))).toMatchObject({ code: 'AVC_BLOCKED', extensions: { reason: 'ABOVE_BLOCK', consumption_pct: '100.10' } });
    // Exactly the last 50 is allowed with the acknowledgement, and the line is full.
    expect((await commit(line, '50', { acknowledgeWarning: true })).line).toMatchObject({ state: 'WARN', consumptionPct: '100.00', availableVnd: '0' });
    expect(await refusal(commit(line, '1', { acknowledgeWarning: true }))).toMatchObject({ code: 'AVC_BLOCKED' });
  });

  it('judges by the policy that governs the line, with its reservations counted, and by the default once the policy ends', async () => {
    const line = await world.publishedLine({ allocated: '1000', group: 'QTQG' });
    await world.setFigures(line.balanceId, { reserved: '600' });
    const policyId = await publishPolicy({ scopeKind: 'PROJECT_GROUP', scopeValue: 'QTQG', controlObject: 'ALLOCATION_LINE', warnPct: '50', blockPct: '70', includeReservations: true });
    // 600 reserved + 150 asked is 75 percent: above the block threshold of 70 of this policy (and below the default one).
    expect(await refusal(commit(line, '150', { acknowledgeWarning: true }))).toMatchObject({ code: 'AVC_BLOCKED', extensions: { policy_id: policyId, warn_pct: '50.00', block_pct: '70.00', consumption_pct: '75.00' } });
    expect((await commit(line, '100', { acknowledgeWarning: true })).line).toMatchObject({ state: 'WARN', consumptionPct: '70.00' });
    await world.owner("update machvon.avc_policy set effective_until = '2000-01-02' where id = $1::uuid", [policyId]);
    // The policy no longer governs: the default thresholds judge the next one (600 reserved and 100 committed plus 100 is 80 percent).
    expect((await commit(line, '100', { acknowledgeWarning: false })).line.state).toBe('OK');
  });

  it('controls the appropriation as well when a policy does: the block is the appropriation\'s, not the line\'s', async () => {
    const fund = await ownFund('CEILING');
    const line = await world.publishedLine({ allocated: '1000', appropriationAmount: '1000', fundVersionId: fund.versionId });
    const policyId = await publishPolicy({ scopeKind: 'FUND_SOURCE', scopeValue: fund.key, controlObject: 'APPROPRIATION', warnPct: '60', blockPct: '80' });
    expect(await refusal(commit(line, '600'))).toMatchObject({ code: 'AVC_WARNING_ACK_REQUIRED', extensions: { control_object: 'APPROPRIATION', policy_id: policyId, consumption_pct: '60.00' } });
    const done = await commit(line, '600', { acknowledgeWarning: true });
    expect(done.appropriation).toMatchObject({ state: 'WARN', consumptionPct: '60.00' });
    expect(done.line.state).toBe('OK');
    expect(await refusal(commit(line, '201', { acknowledgeWarning: true }))).toMatchObject({ code: 'AVC_BLOCKED', extensions: { control_object: 'APPROPRIATION', reason: 'ABOVE_BLOCK' } });
  });

  it('posts a business fact once: the same fact with the same amount answers what was done, with another amount it is 409', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    const sourceId = randomUUID();
    const first = await commit(line, '300', { sourceId });
    const again = await commit(line, '300', { sourceId });
    expect([first.replayed, again.replayed, again.entryId]).toEqual([false, true, first.entryId]);
    expect(await refusal(commit(line, '301', { sourceId }))).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409, extensions: { committed_vnd: '300' } });
    expect((await world.balanceOf(line.balanceId)).committed).toBe('300');
    expect(await entriesOf(line.lineId)).toHaveLength(1);
  });

  it('refuses an amount that is not whole VND above zero, and a line that is not in force', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    for (const amount of ['0', '-5', '1.5', 'abc', '']) expect(await refusal(commit(line, amount))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(await refusal(world.as((tx) => availability.checkAndCommit(tx, { allocationLineId: randomUUID(), amountVnd: '1', sourceKind: 'CONTRACT', sourceId: randomUUID(), acknowledgeWarning: true }, ACTOR)))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect((await world.balanceOf(line.balanceId)).committed).toBe('0');
  });

  it('lets exactly one of two concurrent requests of 100 win on a balance of 100, 25 times, and never overspends (AC-ST-CAP-005-1)', async () => {
    const line = await world.publishedLine({ allocated: '100' });
    const LOOPS = 25;
    const rounds = await runLoops({
      loops: LOOPS,
      reset: async () => {
        await world.owner('update machvon.allocation_balance set committed_vnd = 0, reserved_vnd = 0, disbursed_vnd = 0 where id = $1::uuid', [line.balanceId]);
      },
      commands: () => [0, 1].map(() => () => commit(line, '100', { acknowledgeWarning: true }).then(() => undefined)),
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['422 AVC_BLOCKED']);
        expect((await world.balanceOf(line.balanceId)).committed).toBe('100');
      },
    });
    expect(tallyOutcomes(rounds.flatMap((round) => round.outcomes))).toEqual({ '200': LOOPS, '422 AVC_BLOCKED': LOOPS });
    expect(await entriesOf(line.lineId)).toHaveLength(LOOPS);
  });

  it('keeps the commitments of two lines of one appropriation inside the appropriation policy when they race', async () => {
    const fund = await ownFund('RACE');
    const first = await world.publishedLine({ allocated: '100', appropriationAmount: '1000', fundVersionId: fund.versionId });
    const second = await world.publishedLine({ allocated: '100', appropriationId: first.appropriationId, year: first.year, fundVersionId: fund.versionId });
    await publishPolicy({ scopeKind: 'FUND_SOURCE', scopeValue: fund.key, controlObject: 'APPROPRIATION', warnPct: '10', blockPct: '15' });
    const LOOPS = 15;
    const rounds = await runLoops({
      loops: LOOPS,
      reset: async () => {
        await world.owner('update machvon.allocation_balance set committed_vnd = 0 where id = any($1::uuid[])', [[first.balanceId, second.balanceId]]);
      },
      // 100 on each line is 20 percent of the appropriation together; the block is at 15 percent (150), so only one of the two fits.
      commands: () => [first, second].map((line) => () => commit(line, '100', { acknowledgeWarning: true }).then(() => undefined)),
      verify: async ({ outcomes }) => {
        assertOneWinner(outcomes, ['422 AVC_BLOCKED']);
        const total = BigInt((await world.balanceOf(first.balanceId)).committed) + BigInt((await world.balanceOf(second.balanceId)).committed);
        expect(total).toBe(100n);
      },
    });
    expect(rounds).toHaveLength(LOOPS);
  });

  it('holds what the ledger says: the commitments are entries of the line posted by the caller, and the balance is their sum', async () => {
    const line = await world.publishedLine({ allocated: money(1) });
    await commit(line, '123456');
    await commit(line, '654321');
    const entries = await entriesOf(line.lineId);
    expect(entries.map((entry) => entry.amount).sort()).toEqual(['123456', '654321']);
    expect((await world.balanceOf(line.balanceId)).committed).toBe('777777');
    const [posted] = await world.owner<{ posted_by: string }>("select posted_by from machvon.capital_ledger_entry where allocation_line_id = $1::uuid and entry_type = 'COMMIT' limit 1", [line.lineId]);
    expect(posted?.posted_by).toBe(ACTOR);
  });
});

describe('CapAvailabilityStore.assertCanAbsorb (the evaluation of a change that adds to a contract)', () => {
  it('lets an amount through that the policy would allow or only warn about, and commits nothing', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    await world.as((tx) => availability.assertCanAbsorb(tx, line.lineId, '400'));
    await world.as((tx) => availability.assertCanAbsorb(tx, line.lineId, '950'));
    expect((await world.balanceOf(line.balanceId)).committed).toBe('0');
    expect(await entriesOf(line.lineId)).toEqual([]);
  });

  it('refuses an amount the policy blocks, and a line that is not in force', async () => {
    const line = await world.publishedLine({ allocated: '1000' });
    expect(await refusal(world.as((tx) => availability.assertCanAbsorb(tx, line.lineId, '1001')))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422, detail: 'allocation_line_id', extensions: { reason: 'ABOVE_BLOCK' } });
    expect(await refusal(world.as((tx) => availability.assertCanAbsorb(tx, randomUUID(), '1')))).toMatchObject({ code: 'ALLOCATION_UNAVAILABLE', status: 422, extensions: { reason: 'NOT_IN_FORCE' } });
  });
});
