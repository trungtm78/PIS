import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { EffectiveAccess, Scope } from '@machvon/kernel';
import { CtrContractStore, contractScope } from '../src/ctr-contract-store';
import type { ContractScopes } from '../src/ctr-contract-store';
import { CtrEarlyWarningStore } from '../src/ctr-early-warning-store';
import { HomeContractRegisterSources } from '../src/home-contract-register-sources';
import { DEFAULT_SEVERITY_RULES } from '../src/home-work-rules';
import type { SourceContext } from '../src/home-work-sources';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, memberId, unitId } from './support/authz-fixtures';
import { seedCtrWorld } from './support/ctr-fixtures';
import type { CtrWorld } from './support/ctr-fixtures';

const harness = new AuthzHarness();
const contracts = new CtrContractStore();
const warnings = new CtrEarlyWarningStore();
const sources = new HomeContractRegisterSources();
const CLERK = 1; // raises, assesses, agrees actions, records meetings
const LEAD = 2; // answers for the warnings and closes them
const REVIEWER = 3; // closes what the lead answers for
const PROVINCE = 1;
const DEPARTMENT = 2;
const OTHER_BRANCH = 3;
const FAMILY = 0xb8;
const NOW = new Date('2026-06-20T03:00:00Z');
const day = (offset: number): Date => new Date(NOW.getTime() + offset * 86_400_000);
const TODAY_SCOPE_NOW = new Date();

let world: CtrWorld;
let counter = 0;

const as = <T>(work: (tx: TenantTx) => Promise<T>, tenant = TENANT_A, member = CLERK): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; detail?: string }> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; status?: number; detail?: string };
    return { code: e.code ?? '', status: e.status ?? 0, ...(e.detail === undefined ? {} : { detail: e.detail }) };
  }
  throw new Error('expected a refusal');
}

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code ?? '';
  }
  throw new Error('expected the database to refuse');
}

const grant = (permission: string, scope: Scope, member = CLERK): EffectiveAccess => ({
  membershipId: memberId(member),
  scopeVersion: 1,
  membershipActive: true,
  grants: [{ roleCode: 'TEST', rank: 10, permissions: [permission], scope, status: 'Active', effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: null }],
});
const scopesFor = (member = CLERK): ContractScopes => ({
  update: contractScope(grant('early_warning.manage', { kind: 'TENANT' }, member), 'early_warning.manage', TODAY_SCOPE_NOW),
  read: contractScope(grant('early_warning.read', { kind: 'TENANT' }, member), 'early_warning.read', TODAY_SCOPE_NOW),
});
const readScope = (scope: Scope = { kind: 'TENANT' }) => contractScope(grant('early_warning.read', scope), 'early_warning.read', TODAY_SCOPE_NOW);

async function admin(statements: Array<[string, unknown[]]>): Promise<void> {
  const client = new Client({ connectionString: harness.database.adminUrl });
  await client.connect();
  try {
    await client.query('set session_replication_role = replica');
    for (const [sql, params] of statements) await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function activeContract(effectiveFrom = '2026-06-01'): Promise<string> {
  counter += 1;
  const created = await as((tx) =>
    contracts.create(
      tx,
      { projectId: world.project, packageId: world.packageId, contractorId: world.lead, code: `HD-EW-${String(counter).padStart(3, '0')}`, title: 'Construction of the bridge', type: 'UNIT_PRICE', advanceCategory: 'CONSTRUCTION', contractValueVnd: '10000000000', documentVersionId: world.document },
      memberId(CLERK),
      '2026-05-01',
    ),
  );
  await admin([["update machvon.contract set status = 'ACTIVE', signed_on = $2::date, effective_from = $2::date where id = $1::uuid", [created.id, effectiveFrom]]]);
  return created.id;
}

const newWarning = (extra: Record<string, unknown> = {}) => ({ title: 'The crane may arrive late', description: 'The supplier says the crane arrives after the foundation pour.', category: 'TIME', raisedByParty: 'CONTRACTOR', raisedOn: '2026-06-18', ...extra });
const raise = (contractId: string, extra: Record<string, unknown> = {}, member = CLERK, now = NOW) => as((tx) => warnings.raise(tx, contractId, newWarning(extra) as never, memberId(member), scopesFor(member), now), TENANT_A, member);
const assess = (id: string, version: number, extra: Record<string, unknown> = {}, member = CLERK) =>
  as((tx) => warnings.assess(tx, id, version, { ownerMembershipId: memberId(LEAD), likelihood: 'HIGH', expectedTimeDays: 14, expectedCostVnd: '250000000', ...extra } as never, memberId(member), scopesFor(member), NOW), TENANT_A, member);
const addAction = (id: string, extra: Record<string, unknown> = {}, now = NOW) =>
  as((tx) => warnings.addAction(tx, id, { description: 'Order the crane from the second supplier.', ownerMembershipId: memberId(LEAD), dueOn: '2026-06-25', ...extra } as never, memberId(CLERK), scopesFor(), now));
const complete = (actionId: string, version: number, outcome: unknown = 'DONE', note: unknown = 'The crane was ordered on the 22nd.', member = LEAD, now = NOW) =>
  as((tx) => warnings.completeAction(tx, actionId, version, outcome, note, memberId(member), scopesFor(member), now), TENANT_A, member);
const close = (id: string, version: number, input: Record<string, unknown>, member = REVIEWER) => as((tx) => warnings.close(tx, id, version, input as never, memberId(member), scopesFor(member), NOW), TENANT_A, member);
const meeting = (contractId: string, reviews: Array<{ warning_id: string; outcome: string; note?: string }>, heldOn = '2026-06-18', now = NOW) =>
  as((tx) => warnings.recordMeeting(tx, contractId, { heldOn, attendees: 'Owner, contractor, supervisor', notes: 'The register was reviewed.', reviews } as never, memberId(CLERK), scopesFor(), now));
const issue = (contractId: string, input: { issuedOn?: unknown; meetingId?: unknown } = {}, now = NOW) => as((tx) => warnings.issueRegister(tx, contractId, input, memberId(CLERK), scopesFor(), now));
const row = async (id: string) => (await owner<Record<string, unknown>>('select * from machvon.contract_early_warning where id = $1::uuid', [id]))[0];
const registerAt = (contractId: string, now = NOW) => as((tx) => warnings.register(tx, contractId, readScope(), now));

const sourceContext = (tx: TenantTx, now: Date, member = CLERK, view: 'mine' | 'scope' = 'scope'): SourceContext => ({
  tx,
  membershipId: memberId(member),
  now,
  today: now.toISOString().slice(0, 10),
  view,
  unitScope: () => ({ sql: 'true', params: [] }),
  projectScope: () => ({ sql: 'true', params: [] }),
  rules: DEFAULT_SEVERITY_RULES,
  counting: false,
});

describe('the early-warning register of a contract (G1-15)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: '/u1/' },
        { n: DEPARTMENT, path: '/u1/u2/', parent: PROVINCE },
        { n: OTHER_BRANCH, path: '/u3/' },
      ]);
      for (const n of [CLERK, LEAD, REVIEWER]) await harness.seedMembership(tenant, n, PROVINCE);
    }
    world = await seedCtrWorld(harness.database.adminUrl, TENANT_A, FAMILY, CLERK, DEPARTMENT, PROVINCE);
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('a warning', () => {
    it('is raised by any party, numbered per contract, and assessed with an owner, a likelihood and the expected impact', async () => {
      const contract = await activeContract();
      const first = await raise(contract);
      const second = await raise(contract, { raisedByParty: 'SUPERVISOR', category: 'QUALITY', title: 'The rebar delivery is below grade' });
      expect([first.code, second.code]).toEqual(['EW-001', 'EW-002']);
      expect(first).toMatchObject({ status: 'RAISED', version: 1, ownerMembershipId: null });
      expect(await row(first.id)).toMatchObject({ raised_by_party: 'CONTRACTOR', raised_by: memberId(CLERK), status: 'RAISED', owner_membership_id: null });
      expect(await refusal(assess(first.id, 1, { expectedTimeDays: undefined, expectedCostVnd: undefined }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'expected_time_days' });
      expect(await refusal(assess(first.id, 1, { ownerMembershipId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'owner_membership_id' });
      expect(await refusal(assess(first.id, 5))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const assessed = await assess(first.id, 1);
      expect(assessed).toMatchObject({ status: 'ASSESSED', fromStatus: 'RAISED', version: 2, ownerMembershipId: memberId(LEAD) });
      expect(await row(first.id)).toMatchObject({ likelihood: 'HIGH', expected_time_days: 14, expected_cost_vnd: '250000000', assessed_by: memberId(CLERK), no_impact_expected: false });
      // A re-assessment changes the figures and keeps the state.
      const again = await assess(first.id, 2, { likelihood: 'MEDIUM', expectedTimeDays: 7, expectedCostVnd: undefined });
      expect(again).toMatchObject({ status: 'ASSESSED', version: 3 });
      // "No impact" is a statement, not a blank.
      await assess(second.id, 1, { expectedTimeDays: undefined, expectedCostVnd: undefined, noImpactExpected: true });
      expect(await row(second.id)).toMatchObject({ no_impact_expected: true, expected_time_days: null, expected_cost_vnd: null });
    });

    it('takes mitigation actions only after the assessment, makes the warning MITIGATING with the first, and ends an action with words', async () => {
      const contract = await activeContract();
      const warning = await raise(contract);
      expect(await refusal(addAction(warning.id))).toEqual({ code: 'EARLY_WARNING_STATE_INVALID', status: 409, detail: 'status' });
      await assess(warning.id, 1);
      expect(await refusal(addAction(warning.id, { dueOn: '2026-06-19' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'due_on' });
      const action = await addAction(warning.id);
      expect(action).toMatchObject({ status: 'MITIGATING', fromStatus: 'ASSESSED', version: 3, actionStatus: 'OPEN', dueOn: '2026-06-25' });
      const second = await addAction(warning.id, { description: 'Agree a revised foundation sequence.', dueOn: '2026-06-30' });
      expect(second).toMatchObject({ status: 'MITIGATING', version: 3 });
      expect(await refusal(complete(action.actionId, 1, 'DONE', null))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'note' });
      expect(await refusal(complete(action.actionId, 1, 'MAYBE'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'outcome' });
      expect(await refusal(complete(action.actionId, 9))).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      const done = await complete(action.actionId, 1);
      expect(done).toMatchObject({ actionStatus: 'DONE', actionVersion: 2 });
      expect(await refusal(complete(action.actionId, 2))).toEqual({ code: 'EARLY_WARNING_STATE_INVALID', status: 409, detail: 'status' });
      expect(await databaseRefusal(owner('update machvon.contract_early_warning_action set due_on = date \'2030-01-01\' where id = $1::uuid', [action.actionId]))).toBe('23514');
      expect((await as((tx) => warnings.get(tx, warning.id, readScope(), day(10)))).actions.map((entry) => [entry.status, entry.overdue])).toEqual([['DONE', false], ['OPEN', false]]);
    });

    it('is resolved only with no open action and by somebody other than the person who answers for it; the database keeps the same rule', async () => {
      const contract = await activeContract();
      const warning = await raise(contract);
      await assess(warning.id, 1);
      const action = await addAction(warning.id);
      const reason = { outcome: 'RESOLVED', reason: 'The second supplier delivered on time.' };
      expect(await refusal(close(warning.id, 3, reason))).toEqual({ code: 'EARLY_WARNING_ACTIONS_OPEN', status: 409, detail: 'actions' });
      await complete(action.actionId, 1);
      expect(await refusal(close(warning.id, 3, reason, LEAD))).toEqual({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect(await databaseRefusal(owner("update machvon.contract_early_warning set status = 'CLOSED_RESOLVED', closed_by = owner_membership_id, closed_at = now(), closed_reason = 'Closed by its own owner.' where id = $1::uuid", [warning.id]))).toBe('23514');
      const closed = await close(warning.id, 3, reason);
      expect(closed).toMatchObject({ status: 'CLOSED_RESOLVED', fromStatus: 'MITIGATING', version: 4 });
      expect(await row(warning.id)).toMatchObject({ closed_by: memberId(REVIEWER), closed_reason: 'The second supplier delivered on time.' });
      expect(await refusal(close(warning.id, 4, reason))).toEqual({ code: 'EARLY_WARNING_STATE_INVALID', status: 409, detail: 'status' });
      expect(await databaseRefusal(owner("update machvon.contract_early_warning set status = 'RAISED' where id = $1::uuid", [warning.id]))).toBe('23514');
    });

    it('names the change order or the claim a warning that came true became, of the same contract only, and withdraws one raised in error', async () => {
      const contract = await activeContract();
      const other = await activeContract();
      const warning = await raise(contract);
      await assess(warning.id, 1);
      const change = randomUUID();
      const foreign = randomUUID();
      await admin([
        [`insert into machvon.change_request (tenant_id, id, contract_id, baseline_revision_id, amount_delta_vnd, schedule_impact_days, reason, status, version, code, stage, submitted_by, created_by, updated_by) values ($1, $2, $3, gen_random_uuid(), 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-EW-1', 'CO', $5, $5, $5), ($1, $4, $6, gen_random_uuid(), 0, 5, 'Reason', 'SUBMITTED', 1, 'CR-EW-2', 'CO', $5, $5, $5)`, [TENANT_A, change, contract, foreign, memberId(CLERK), other]],
      ]);
      const into = { outcome: 'MATERIALISED', reason: 'The delay happened and a change order was raised.', materialisedInto: 'CHANGE_REQUEST' };
      expect(await refusal(close(warning.id, 2, { ...into, materialisedId: foreign }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'materialised_id' });
      expect(await refusal(close(warning.id, 2, into))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'materialised_id' });
      const closed = await close(warning.id, 2, { ...into, materialisedId: change }, CLERK);
      expect(closed).toMatchObject({ status: 'CLOSED_MATERIALISED', materialisedInto: 'CHANGE_REQUEST', materialisedId: change });
      expect(await row(warning.id)).toMatchObject({ change_request_id: change, claim_id: null });
      const raisedInError = await raise(contract, { title: 'Raised by mistake about the crane' });
      expect(await refusal(close(raisedInError.id, 1, { outcome: 'RESOLVED', reason: 'It was never a risk at all.' }))).toEqual({ code: 'EARLY_WARNING_STATE_INVALID', status: 409, detail: 'status' });
      expect((await close(raisedInError.id, 1, { outcome: 'WITHDRAWN', reason: 'Raised in error by the supplier.' })).status).toBe('CLOSED_WITHDRAWN');
    });
  });

  describe('the register of a contract', () => {
    it('reviews every open warning at a meeting, keeps the meeting as it was, and issues the register after it with a snapshot and a hash', async () => {
      const contract = await activeContract();
      const a = await raise(contract);
      const b = await raise(contract, { title: 'The rebar delivery is below grade', category: 'QUALITY' });
      await assess(a.id, 1);
      const review = [{ warning_id: a.id, outcome: 'ACTION_AGREED', note: 'Second supplier.' }, { warning_id: b.id, outcome: 'NO_CHANGE' }];
      expect(await refusal(meeting(contract, [review[0] as never]))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'reviews' });
      expect(await refusal(meeting(contract, review as never, '2026-05-30'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'held_on' });
      const held = await meeting(contract, review);
      expect(held).toMatchObject({ ordinal: 1, heldOn: '2026-06-18', reviewed: 2 });
      expect(await refusal(meeting(contract, review, '2026-06-18'))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'held_on' });
      expect(await databaseRefusal(owner("update machvon.contract_early_warning_meeting set notes = 'rewritten' where id = $1::uuid", [held.id]))).toBe('23514');
      expect(await databaseRefusal(owner('delete from machvon.contract_early_warning_review where meeting_id = $1::uuid', [held.id]))).toBe('23514');

      const initial = await issue(contract, { issuedOn: '2026-06-05' });
      expect(initial).toMatchObject({ ordinal: 1, kind: 'INITIAL', warningCount: 2, openCount: 2, meetingId: null });
      expect(initial.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await refusal(issue(contract, { issuedOn: '2026-05-30' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'issued_on' });
      expect(await refusal(issue(contract, { meetingId: held.id, issuedOn: '2026-06-17' }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'issued_on' });
      expect(await refusal(issue(contract, { meetingId: randomUUID() }))).toEqual({ code: 'VALIDATION_FAILED', status: 422, detail: 'meeting_id' });
      const after = await issue(contract, { meetingId: held.id, issuedOn: '2026-06-19' });
      expect(after).toMatchObject({ ordinal: 2, kind: 'AFTER_MEETING', meetingId: held.id });
      expect(await refusal(issue(contract, { meetingId: held.id }))).toEqual({ code: 'EARLY_WARNING_STATE_INVALID', status: 409, detail: 'meeting_id' });
      const snapshot = (await owner<{ snapshot: Array<{ code: string; status: string }>; content_hash: string }>('select snapshot, content_hash from machvon.contract_early_warning_issue where id = $1::uuid', [after.id]))[0];
      expect(snapshot?.snapshot.map((entry) => [entry.code, entry.status])).toEqual([['EW-001', 'ASSESSED'], ['EW-002', 'RAISED']]);
      expect(snapshot?.content_hash).toBe(after.contentHash);
      // The warnings changed: the next issue hashes another text.
      await assess(b.id, 1, { ownerMembershipId: memberId(REVIEWER) });
      expect((await issue(contract, { issuedOn: '2026-06-20' })).contentHash).not.toBe(after.contentHash);
      expect(await databaseRefusal(owner("update machvon.contract_early_warning_issue set kind = 'PERIODIC' where id = $1::uuid", [after.id]))).toBe('23514');
    });

    it('reads the rhythm on the day: first issue a week after the start, a meeting every two weeks, a re-issue a week after each meeting', async () => {
      const contract = await activeContract('2026-06-01');
      const early = await registerAt(contract, new Date('2026-06-05T03:00:00Z'));
      expect(early.clocks.initial).toMatchObject({ state: 'APPROACHING', dueOn: '2026-06-08' });
      expect(early.clocks.meeting).toMatchObject({ state: 'RUNNING', dueOn: '2026-06-15' });
      expect(early.clocks.reissue).toBeNull();
      expect(early.policy).toMatchObject({ source: 'DEFAULT', unverified: true, initialIssueWithinDays: 7, meetingEveryDays: 14, reissueWithinDaysAfterMeeting: 7, basis: 'CALENDAR_DAYS' });
      expect(early.contract).toMatchObject({ status: 'ACTIVE', effectiveFrom: '2026-06-01' });
      const late = await registerAt(contract, NOW);
      expect(late.clocks.initial).toMatchObject({ state: 'MISSED', daysLeft: -12 });
      expect(late.clocks.meeting).toMatchObject({ state: 'MISSED' });
      await issue(contract, { issuedOn: '2026-06-08' });
      const held = await meeting(contract, [], '2026-06-12');
      const afterMeeting = await registerAt(contract, NOW);
      expect(afterMeeting.clocks.initial.state).toBe('MET');
      expect(afterMeeting.clocks.meeting).toMatchObject({ startedOn: '2026-06-12', dueOn: '2026-06-26', state: 'RUNNING' });
      expect(afterMeeting.clocks.reissue).toMatchObject({ meetingId: held.id, dueOn: '2026-06-19', state: 'MISSED' });
      expect(afterMeeting.meetings[0]).toMatchObject({ id: held.id, reissuedOn: null });
      await issue(contract, { meetingId: held.id, issuedOn: '2026-06-17' });
      const reissued = await registerAt(contract, NOW);
      expect(reissued.clocks.reissue?.state).toBe('MET');
      expect(reissued.issues.map((entry) => entry.kind)).toEqual(['AFTER_MEETING', 'INITIAL']);
      // A contract that is not in force keeps no rhythm.
      await admin([["update machvon.contract set status = 'DRAFT', signed_on = null, effective_from = null where id = $1::uuid", [contract]]]);
      expect((await registerAt(contract, NOW)).clocks.initial.state).toBe('NOT_STARTED');
    });

    it('lists the warnings of a filter with the summary of all of them, and keeps another tenant and another branch out', async () => {
      const contract = await activeContract();
      const a = await raise(contract);
      const b = await raise(contract, { title: 'The rebar delivery is below grade', category: 'QUALITY', raisedByParty: 'OWNER' });
      await assess(a.id, 1);
      const page = await as((tx) => warnings.list(tx, { contractId: contract }, readScope(), { limit: 1 }, NOW));
      expect(page.summary).toMatchObject({ total: 2, open: 2, unassessed: 1, withoutOwner: 1, exposureCostVnd: '250000000', exposureTimeDays: 14, impactUnknown: 1, byParty: { CONTRACTOR: 1, OWNER: 1 } });
      expect(page.rows).toHaveLength(1);
      expect(page.nextCursor).toBe(page.rows[0]?.id);
      const next = await as((tx) => warnings.list(tx, { contractId: contract }, readScope(), { limit: 5, after: page.nextCursor ?? undefined }, NOW));
      expect(next.nextCursor).toBeNull();
      expect([page.rows[0]?.id, next.rows[0]?.id].sort()).toEqual([a.id, b.id].sort());
      expect((await as((tx) => warnings.list(tx, { contractId: contract, category: 'QUALITY', open: true }, readScope(), { limit: 5 }, NOW))).rows.map((entry) => entry.id)).toEqual([b.id]);
      expect((await as((tx) => warnings.list(tx, {}, readScope(), { limit: 5 }, NOW), TENANT_B)).rows).toEqual([]);
      const elsewhere = readScope({ kind: 'UNIT_SUBTREE', refIds: [unitId(OTHER_BRANCH)] });
      expect((await as((tx) => warnings.list(tx, { contractId: contract }, elsewhere, { limit: 5 }, NOW))).rows).toEqual([]);
      await expect(as((tx) => warnings.get(tx, a.id, elsewhere, NOW))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await expect(as((tx) => warnings.register(tx, contract, elsewhere, NOW))).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      const readOnly: ContractScopes = { update: () => ({ sql: 'false', params: [] }), read: readScope() };
      expect(await refusal(as((tx) => warnings.assess(tx, a.id, 2, { ownerMembershipId: memberId(LEAD), likelihood: 'LOW', expectedTimeDays: 1 } as never, memberId(CLERK), readOnly, NOW)))).toEqual({ code: 'SCOPE_DENIED', status: 403 });
    });
  });

  describe('the alert centre (the alerts EW_*)', () => {
    it('raises the first issue, the meeting, the re-issue and the actions that are late, each with its own item, severity and consequence', async () => {
      const contract = await activeContract('2026-06-01');
      const warning = await raise(contract);
      await assess(warning.id, 1);
      const action = await addAction(warning.id, { dueOn: '2026-06-22' });
      const found = async (now: Date, member = CLERK, view: 'mine' | 'scope' = 'scope') => (await as((tx) => sources.earlyWarnings(sourceContext(tx, now, member, view)))).filter((item) => item.target.id === contract || item.target.id === warning.id);
      // 2026-06-05: the first issue is due on the 8th (approaching, to be watched).
      const soon = await found(new Date('2026-06-05T03:00:00Z'));
      expect(soon.map((item) => [item.kind, item.severity, item.status])).toEqual([['EW_REGISTER_OVERDUE', 'WATCH', 'DUE_SOON']]);
      // 2026-06-20: the first issue and the meeting are both late; the action is due on the 22nd, so it is not.
      const late = await found(NOW);
      expect(late.map((item) => item.kind).sort()).toEqual(['EW_MEETING_OVERDUE', 'EW_REGISTER_OVERDUE']);
      expect(late.every((item) => item.severity === 'ACTION' && item.source === 'CONTRACT_EARLY_WARNING' && item.lifecycle === 'NEW' && item.target.screen === 'CTR-35')).toBe(true);
      expect(late.find((item) => item.kind === 'EW_REGISTER_OVERDUE')).toMatchObject({ id: `${contract}:initial`, dueOn: '2026-06-08', title: expect.stringContaining('lần đầu') });
      expect(late[0]?.consequence).toBeTruthy();
      // The action is late on the 23rd and is the work of the person it was given to.
      const actionLate = await found(day(3), LEAD, 'mine');
      expect(actionLate.find((item) => item.kind === 'EW_ACTION_OVERDUE')).toMatchObject({ id: action.actionId, severity: 'ACTION', status: 'OVERDUE', target: { screen: 'CTR-36', id: warning.id }, dueOn: '2026-06-22' });
      expect((await found(day(3), REVIEWER, 'mine')).find((item) => item.kind === 'EW_ACTION_OVERDUE')).toBeUndefined();
      // Done, the action is no longer an item; issued and held, the register items go.
      await complete(action.actionId, 1);
      expect((await found(day(3))).find((item) => item.kind === 'EW_ACTION_OVERDUE')).toBeUndefined();
      await issue(contract, { issuedOn: '2026-06-08' });
      const held = await meeting(contract, [{ warning_id: warning.id, outcome: 'NO_CHANGE' }], '2026-06-10');
      const afterMeeting = await found(NOW);
      // The meeting of the 10th was due again by the 24th, and the re-issue owed for it was due on the 17th.
      expect(afterMeeting.map((item) => item.kind)).toEqual(['EW_REGISTER_OVERDUE']);
      expect(afterMeeting[0]).toMatchObject({ id: `reissue:${held.id}`, dueOn: '2026-06-17' });
      await issue(contract, { meetingId: held.id, issuedOn: '2026-06-16' });
      expect(await found(NOW)).toEqual([]);
    });
  });
});
