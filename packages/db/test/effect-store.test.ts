import { randomUUID } from 'node:crypto';
import { EffectStore } from '../src/effect-store';
import type { ScopeBuilder } from '../src/scope-version';
import type { TenantTx } from '../src/tenant-database';
import { AuthzHarness, TENANT_A, TENANT_B, contextFor, id, memberId, unitId } from './support/authz-fixtures';
import { DEPARTMENT, PROVINCE, everything, nothing, seedAs } from './support/bid-proposal-fixtures';

const harness = new AuthzHarness();
const effects = new EffectStore();
const MAKER = 1;
const CHECKER = 2;
const THIRD = 3;
const NOW = new Date('2026-11-08T03:00:00Z');
const FAMILY = 0xa7;

const as = <T>(work: (tx: TenantTx) => Promise<T>, member = MAKER, tenant = TENANT_A): Promise<T> => harness.tenants.withTenant(contextFor(tenant, memberId(member)), work);
const owner = <R extends object = Record<string, unknown>>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);
const scopes = { act: everything, read: everything };
const blind = { act: nothing, read: nothing };
const readOnly = { act: nothing, read: everything };

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

async function databaseRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String((error as { message?: string }).message);
  }
  throw new Error('expected the database to refuse');
}

let counter = 0;
async function seedProject(options: { status?: string; group?: string | null; tenant?: string } = {}): Promise<string> {
  const projectId = randomUUID();
  counter += 1;
  await seedAs(harness, [
    [
      `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
       values ($1, $2, $3, 'Solar plant', $4, $5, $6, 'INTERNAL', 1000, $7, 1, $8)`,
      [options.tenant ?? TENANT_A, projectId, `EF-${counter}`, unitId(DEPARTMENT), unitId(PROVINCE), id(FAMILY, 90), options.status ?? 'IMPLEMENTATION', options.group === undefined ? 'A' : options.group],
    ],
  ]);
  return projectId;
}

const setStatus = (projectId: string, status: string) => seedAs(harness, [['update machvon.project set status = $2 where id = $1', [projectId, status]]]);

async function stageChange(projectId: string, to: string, day: string, version: number): Promise<void> {
  await seedAs(harness, [
    [
      `insert into machvon.project_stage_change (tenant_id, id, project_id, project_version, from_stage, to_stage, operation, actor_kind, actor_id, reason, effective_date)
       values ($1, $2, $3, $4, 'BUDGETED', $5, 'moveStage', 'USER', $6, 'Moved by the test', $7::date)`,
      [TENANT_A, randomUUID(), projectId, version, to, memberId(MAKER), day],
    ],
  ]);
}

const INDICATOR = {
  code: 'KWH_OUTPUT',
  name: 'Yearly output of the plant',
  unit: 'MWh',
  direction: 'HIGHER_IS_BETTER',
  baseline_value: '0',
  baseline_on: '2026-01-01',
  target_value: '1000',
  measure_after_months: 12,
  data_source: 'Meter readings of the plant',
  formula: 'Sum of the monthly meter readings',
};
const COST = { code: 'LOSS_RATE', name: 'Loss rate of the grid', unit: '%', direction: 'LOWER_IS_BETTER', baseline_value: '12', baseline_on: '2026-01-01', target_value: '6', data_source: 'Grid operator report', formula: 'Lost energy divided by energy sent' };

const draft = (projectId: string, member = MAKER, body: Record<string, unknown> = {}, scope = scopes) =>
  as((tx) => effects.saveDraft(tx, { projectId, body: { basis: 'Decision 123/QD-UBND of 2026-03-01', indicators: [INDICATOR, COST], ...body }, actor: memberId(member), scopes: scope, now: NOW }), member);
const fix = (setId: string, version: number, member = CHECKER, scope = scopes) => as((tx) => effects.fix(tx, { setId, expectedVersion: version, actor: memberId(member), scopes: scope, now: NOW }), member);
const measure = (projectId: string, body: Record<string, unknown>, member = MAKER, scope = scopes) =>
  as((tx) => effects.measure(tx, { projectId, body: { indicator_code: 'KWH_OUTPUT', measured_on: '2026-11-01', value: '800', method_note: 'Meter readings of the year', ...body }, actor: memberId(member), scopes: scope, now: NOW }), member);
const view = (projectId: string, scope: ScopeBuilder = everything, tenant = TENANT_A) => as((tx) => effects.view(tx, scope, projectId, NOW), MAKER, tenant);
const submit = (projectId: string, body: Record<string, unknown> = {}, member = MAKER) =>
  as((tx) => effects.submitAssessment(tx, { projectId, body: { kind: 'FINAL', conclusion: 'PARTIALLY_SATISFACTORY', summary: 'The plant reached eighty percent of its output target.', ...body }, actor: memberId(member), scopes, now: NOW }), member);
const decide = (assessmentId: string, version: number, body: Record<string, unknown>, member = CHECKER, scope = scopes) =>
  as((tx) => effects.decideAssessment(tx, { assessmentId, expectedVersion: version, body, actor: memberId(member), scopes: scope }), member);

/** A project whose targets stand FIXED, in the status the actuals are recorded in. */
async function fixedProject(status = 'COMPLETED', group: string | null = 'A'): Promise<{ projectId: string; setId: string }> {
  const projectId = await seedProject({ group });
  const made = await draft(projectId);
  await fix(made.id, made.rowVersion);
  await setStatus(projectId, status);
  return { projectId, setId: made.id };
}

describe('the post-investment effectiveness of a project (MR.03, G4-7)', () => {
  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: PROVINCE, path: `/${unitId(PROVINCE)}/` },
        { n: DEPARTMENT, path: `/${unitId(PROVINCE)}/${unitId(DEPARTMENT)}/`, parent: PROVINCE },
      ]);
      for (const member of [MAKER, CHECKER, THIRD]) await harness.seedMembership(tenant, member, PROVINCE);
    }
  }, 240_000);

  afterAll(async () => {
    await harness.stop();
  }, 60_000);

  describe('the target indicators', () => {
    it('drafts the targets of a project that is approved, and refuses a project that is not yet', async () => {
      const projectId = await seedProject();
      const made = await draft(projectId);
      expect(made).toMatchObject({ projectId, versionNo: 1, status: 'DRAFT', rowVersion: 1, indicatorCount: 2 });
      const seen = await view(projectId);
      expect(seen.draft?.indicators.map((line) => line.code)).toEqual(['KWH_OUTPUT', 'LOSS_RATE']);
      expect(seen.draft?.indicators[0]).toMatchObject({ targetValue: '1000', baselineValue: '0', actual: null });
      expect(seen.draft?.indicators[0]?.variance.band).toBe('NOT_MEASURED');
      expect(seen.fixed).toBeNull();
      const concept = await seedProject({ status: 'CONCEPT', group: null });
      expect(await refusal(draft(concept))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422 });
    });

    it('lets only the author rewrite the draft, as a whole list, and keeps the codes apart', async () => {
      const projectId = await seedProject();
      const first = await draft(projectId);
      const again = await draft(projectId, MAKER, { indicators: [COST] });
      expect(again).toMatchObject({ id: first.id, rowVersion: 2, indicatorCount: 1 });
      expect((await view(projectId)).draft?.indicators.map((line) => line.code)).toEqual(['LOSS_RATE']);
      expect(await refusal(draft(projectId, THIRD))).toMatchObject({ code: 'EFFECT_TARGET_STATE_INVALID', status: 409, extensions: { reason: 'NOT_THE_AUTHOR' } });
      expect(await refusal(draft(projectId, MAKER, { indicators: [COST, COST] }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'indicators[1].code' });
      expect(await refusal(draft(projectId, MAKER, { basis: '' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'basis' });
      expect((await refusal(draft(projectId, MAKER, {}, blind))).status).toBe(404);
      expect((await refusal(draft(projectId, MAKER, {}, readOnly))).code).toBe('SCOPE_DENIED');
    });

    it('is fixed by someone other than the author, once, under the version they saw', async () => {
      const projectId = await seedProject();
      const made = await draft(projectId);
      expect(await refusal(fix(made.id, made.rowVersion, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await refusal(fix(made.id, 9))).code).toBe('VERSION_CONFLICT');
      expect((await refusal(fix(made.id, made.rowVersion, CHECKER, readOnly))).code).toBe('SCOPE_DENIED');
      const done = await fix(made.id, made.rowVersion);
      expect(done).toMatchObject({ status: 'FIXED', versionNo: 1, supersededId: null });
      const seen = await view(projectId);
      expect(seen.fixed).toMatchObject({ status: 'FIXED', fixedOn: '2026-11-08' });
      expect(seen.fixed?.fixedBy?.membershipId).toBe(memberId(CHECKER));
      expect(seen.fixed?.draftedBy.membershipId).toBe(memberId(MAKER));
      expect(seen.draft).toBeNull();
      expect(await refusal(fix(made.id, done.rowVersion))).toMatchObject({ code: 'EFFECT_TARGET_STATE_INVALID', extensions: { status: 'FIXED' } });
    });

    it('does not fix targets of a project that is not approved yet, whoever asks', async () => {
      const projectId = await seedProject({ status: 'APPRAISAL' });
      const made = await draft(projectId);
      expect(await refusal(fix(made.id, made.rowVersion))).toMatchObject({ code: 'PROJECT_STAGE_INVALID' });
    });

    it('keeps a fixed set as it was, in the database: no indicator is changed, added or deleted, and the set only goes on to superseded', async () => {
      const { projectId, setId } = await fixedProject('IMPLEMENTATION');
      expect(await databaseRefusal(owner('update machvon.effect_indicator set target_value = 1 where target_set_id = $1', [setId]))).toContain('never changed');
      expect(await databaseRefusal(owner('delete from machvon.effect_indicator where target_set_id = $1', [setId]))).toContain('never changed');
      expect(
        await databaseRefusal(
          owner(`insert into machvon.effect_indicator (tenant_id, target_set_id, project_id, code, name, unit, direction, target_value, data_source, formula) values ($1, $2, $3, 'EXTRA', 'Extra', 'x', 'HIGHER_IS_BETTER', 1, 'source', 'formula')`, [TENANT_A, setId, projectId]),
        ),
      ).toContain('never changed');
      expect(await databaseRefusal(owner(`update machvon.effect_target_set set basis = 'Another decision' where id = $1`, [setId]))).toContain('only ever superseded');
      expect(await databaseRefusal(owner('delete from machvon.effect_target_set where id = $1', [setId]))).toContain('never deleted');
    });

    it('replaces a fixed set only through a new draft that says why, and the old set stays on record as superseded', async () => {
      const { projectId, setId } = await fixedProject('IMPLEMENTATION');
      expect(await refusal(draft(projectId))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'supersede_reason' });
      const next = await draft(projectId, THIRD, { supersede_reason: 'The decision on the investment was amended in October', indicators: [{ ...INDICATOR, target_value: '1200' }] });
      expect(next).toMatchObject({ versionNo: 2, status: 'DRAFT' });
      const standing = await view(projectId);
      expect(standing.fixed?.id).toBe(setId);
      expect(standing.draft?.supersedesId).toBe(setId);
      const done = await fix(next.id, next.rowVersion, CHECKER);
      expect(done).toMatchObject({ status: 'FIXED', supersededId: setId });
      const after = await view(projectId);
      expect(after.fixed?.id).toBe(next.id);
      expect(after.fixed?.indicators[0]?.targetValue).toBe('1200');
      expect(after.superseded).toEqual([{ id: setId, versionNo: 1, fixedOn: '2026-11-08' }]);
    });
  });

  describe('the actual values and their variance', () => {
    it('records an actual only after the commissioning, against an indicator of the fixed targets', async () => {
      const projectId = await seedProject();
      expect(await refusal(measure(projectId, {}))).toMatchObject({ code: 'PROJECT_STAGE_INVALID' });
      const { projectId: done } = await fixedProject('IMPLEMENTATION');
      expect(await refusal(measure(done, {}))).toMatchObject({ code: 'PROJECT_STAGE_INVALID', status: 422 });
      await setStatus(done, 'COMPLETED');
      const first = await measure(done, {});
      expect(first).toMatchObject({ indicatorCode: 'KWH_OUTPUT', measuredOn: '2026-11-01', value: '800', correctsId: null });
      expect(await refusal(measure(done, { indicator_code: 'NOPE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'indicator_code' });
      expect(await refusal(measure(done, { measured_on: '2026-11-09' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'measured_on' });
      expect(await refusal(measure(done, { value: 'lots' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'value' });
      expect(await refusal(measure(done, { method_note: '' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'method_note' });
      expect((await refusal(measure(done, {}, MAKER, readOnly))).code).toBe('SCOPE_DENIED');
    });

    it('needs fixed targets: a project with a draft only has nothing to measure against', async () => {
      const projectId = await seedProject();
      await draft(projectId);
      await setStatus(projectId, 'COMPLETED');
      expect(await refusal(measure(projectId, {}))).toMatchObject({ code: 'EFFECT_TARGETS_NOT_FIXED', status: 409 });
    });

    it('does not write the same indicator and day twice, and corrects a wrong value by a later row that says why', async () => {
      const { projectId } = await fixedProject();
      const first = await measure(projectId, {});
      expect(await refusal(measure(projectId, { value: '900' }))).toMatchObject({ code: 'EFFECT_MEASUREMENT_DUPLICATE', status: 409 });
      expect(await refusal(measure(projectId, { value: '850', corrects_id: first.id }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'correction_reason' });
      expect(await refusal(measure(projectId, { value: '850', corrects_id: randomUUID(), correction_reason: 'The meter was read twice in October' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'corrects_id' });
      const fixedUp = await measure(projectId, { value: '850', corrects_id: first.id, correction_reason: 'The meter was read twice in October' });
      expect(fixedUp.correctsId).toBe(first.id);
      expect(await refusal(measure(projectId, { value: '860', corrects_id: first.id, correction_reason: 'A second correction of the same row' }))).toMatchObject({ code: 'EFFECT_MEASUREMENT_DUPLICATE' });
      const seen = await view(projectId);
      const kwh = seen.fixed?.indicators.find((line) => line.code === 'KWH_OUTPUT');
      expect(kwh?.actual?.value).toBe('850');
      expect(seen.measurements.map((row) => [row.value, row.corrected])).toEqual([
        ['850', false],
        ['800', true],
      ]);
      expect(await databaseRefusal(owner('update machvon.effect_measurement set value = 1 where id = $1', [first.id]))).toContain('append-only');
      expect(await databaseRefusal(owner('delete from machvon.effect_measurement where id = $1', [first.id]))).toContain('append-only');
    });

    it('computes the variance in the kernel by the policy: achievement from the baseline to the target, the variance and the band', async () => {
      const { projectId } = await fixedProject();
      await measure(projectId, { value: '800' });
      await measure(projectId, { indicator_code: 'LOSS_RATE', value: '5.4', measured_on: '2026-10-31' });
      const seen = await view(projectId);
      const [kwh, loss] = seen.fixed?.indicators ?? [];
      expect(kwh?.variance).toEqual({ varianceValue: '-200', variancePct: '-20.00', achievementPct: '80.00', basis: 'BASELINE_TO_TARGET', band: 'PARTIAL' });
      expect(loss?.variance).toEqual({ varianceValue: '-0.6', variancePct: '-10.00', achievementPct: '110.00', basis: 'BASELINE_TO_TARGET', band: 'MET' });
      expect(seen.suggestedConclusion).toBe('PARTIALLY_SATISFACTORY');
      expect(seen.policy).toMatchObject({ version: 'built-in:1', unverified: true });
      expect(seen.policy.policy.metAtPct).toBe(100);
      expect(seen.policy.formula?.length).toBeGreaterThan(20);
      expect(seen.policy.source?.length).toBeGreaterThan(10);
      expect(seen.policy.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('reads nothing of a project out of sight or of another tenant', async () => {
      const { projectId } = await fixedProject();
      expect((await refusal(view(projectId, nothing))).status).toBe(404);
      expect((await refusal(view(projectId, everything, TENANT_B))).status).toBe(404);
      const inB = await owner<{ count: string }>('select count(*)::text as count from machvon.effect_target_set', [], TENANT_B);
      expect(inB[0]?.count).toBe('0');
    });
  });

  describe('the calendar of evaluations (Articles 76 and 77, flagged not verified)', () => {
    it('gives a group A project four evaluations from the days its stages fell on, once, and says which wait for a day not known yet', async () => {
      const projectId = await seedProject({ group: 'A', status: 'COMPLETED' });
      await stageChange(projectId, 'IMPLEMENTATION', '2025-01-31', 2);
      await stageChange(projectId, 'COMPLETED', '2026-06-30', 3);
      const made = await as((tx) => effects.generateCalendar(tx, { projectId, actor: memberId(MAKER), scopes, now: NOW }));
      expect(made.ruleCode).toBe('GROUP_A');
      expect(made.ruleVersion).toBe('built-in:1');
      expect(made.ruleUnverified).toBe(true);
      expect(made.created.map((entry) => [entry.kind, entry.dueOn])).toEqual([
        ['INITIAL', '2026-01-31'],
        ['MIDTERM', '2027-01-31'],
        ['FINAL', '2026-09-30'],
      ]);
      expect(made.waiting).toEqual([{ kind: 'IMPACT', anchor: 'HANDOVER' }]);
      const again = await as((tx) => effects.generateCalendar(tx, { projectId, actor: memberId(MAKER), scopes, now: NOW }));
      expect(again.created).toEqual([]);
      expect([...again.existing].sort()).toEqual(['FINAL', 'INITIAL', 'MIDTERM']);
      const seen = await view(projectId);
      expect(seen.calendar.map((row) => [row.kind, row.state, row.daysLate])).toEqual([
        ['INITIAL', 'OVERDUE', 281],
        ['FINAL', 'OVERDUE', 39],
        ['MIDTERM', 'UPCOMING', 0],
      ]);
      expect(seen.calendar.every((row) => row.ruleUnverified && row.ruleVersion === 'built-in:1' && row.ruleCode === 'GROUP_A')).toBe(true);
    });

    it('gives groups B and C two evaluations, takes the handover day from the acceptance, and refuses a project that has no group', async () => {
      const projectId = await seedProject({ group: 'B', status: 'COMPLETED' });
      await stageChange(projectId, 'COMPLETED', '2026-06-30', 2);
      await seedAs(harness, [
        [
          `insert into machvon.handover (tenant_id, id, project_id, contract_id, recipient_unit_id, document_version_id, punch_list, accepted_at, status) values ($1, $2, $3, $4, $5, $6, '[]'::jsonb, $7::timestamptz, 'ACCEPTED')`,
          [TENANT_A, randomUUID(), projectId, randomUUID(), unitId(DEPARTMENT), randomUUID(), '2026-07-15T03:00:00Z'],
        ],
      ]);
      const made = await as((tx) => effects.generateCalendar(tx, { projectId, actor: memberId(MAKER), scopes, now: NOW }));
      expect(made.created.map((entry) => [entry.kind, entry.dueOn, entry.anchor])).toEqual([
        ['FINAL', '2026-09-30', 'COMPLETION'],
        ['IMPACT', '2028-07-15', 'HANDOVER'],
      ]);
      expect(made.waiting).toEqual([]);
      const none = await seedProject({ group: null, status: 'CONCEPT' });
      expect(await refusal(as((tx) => effects.generateCalendar(tx, { projectId: none, actor: memberId(MAKER), scopes, now: NOW })))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'project_group' });
      expect((await refusal(as((tx) => effects.generateCalendar(tx, { projectId, actor: memberId(MAKER), scopes: readOnly, now: NOW })))).code).toBe('SCOPE_DENIED');
    });

    it('keeps an entry as it was in the database: its day and its rule never move, and it is never deleted', async () => {
      const projectId = await seedProject({ group: 'C', status: 'COMPLETED' });
      await stageChange(projectId, 'COMPLETED', '2026-06-30', 2);
      const made = await as((tx) => effects.generateCalendar(tx, { projectId, actor: memberId(MAKER), scopes, now: NOW }));
      const entry = made.created[0];
      expect(await databaseRefusal(owner(`update machvon.effect_calendar_entry set due_on = '2030-01-01' where id = $1`, [entry?.id]))).toContain('never change');
      expect(await databaseRefusal(owner('delete from machvon.effect_calendar_entry where id = $1', [entry?.id]))).toContain('append-only');
    });
  });

  describe('the assessment record', () => {
    it('freezes the variance on the day, closes nothing until it is approved, and is decided by someone other than who submitted it', async () => {
      const { projectId } = await fixedProject();
      await stageChange(projectId, 'COMPLETED', '2026-06-30', 2);
      await as((tx) => effects.generateCalendar(tx, { projectId, actor: memberId(MAKER), scopes, now: NOW }));
      expect(await refusal(submit(projectId))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'kind', extensions: { reason: 'NO_MEASUREMENT' } });
      await measure(projectId, { value: '800' });
      const sent = await submit(projectId);
      expect(sent).toMatchObject({ kind: 'FINAL', status: 'SUBMITTED', conclusion: 'PARTIALLY_SATISFACTORY', rowVersion: 1, closedCalendar: false });
      expect(sent.calendarEntryId).not.toBeNull();
      expect(await refusal(submit(projectId))).toMatchObject({ code: 'EFFECT_ASSESSMENT_STATE_INVALID', status: 409 });
      expect(await refusal(submit(projectId, { kind: 'OTHER' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'kind' });

      // The measurement moves on after the submission: the frozen lines do not.
      await measure(projectId, { value: '1000', measured_on: '2026-11-05' });
      const stored = await owner<{ lines: Array<{ code: string; actual_value: string | null; band: string; achievement_pct: string | null }>; policy_version: string; policy_unverified: boolean }>('select lines, policy_version, policy_unverified from machvon.effect_assessment where id = $1', [sent.id]);
      expect(stored[0]?.lines.find((line) => line.code === 'KWH_OUTPUT')).toMatchObject({ actual_value: '800', band: 'PARTIAL', achievement_pct: '80.00' });
      expect(stored[0]?.lines.find((line) => line.code === 'LOSS_RATE')).toMatchObject({ actual_value: null, band: 'NOT_MEASURED' });
      expect(stored[0]).toMatchObject({ policy_version: 'built-in:1', policy_unverified: true });

      expect(await refusal(decide(sent.id, 1, { decision: 'APPROVE' }, MAKER))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
      expect((await refusal(decide(sent.id, 7, { decision: 'APPROVE' }))).code).toBe('VERSION_CONFLICT');
      expect(await refusal(decide(sent.id, 1, { decision: 'RETURN' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
      expect(await refusal(decide(sent.id, 1, { decision: 'SHELVE' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
      expect((await refusal(decide(sent.id, 1, { decision: 'APPROVE' }, CHECKER, readOnly))).code).toBe('SCOPE_DENIED');
      const before = await view(projectId);
      expect(before.calendar.find((row) => row.kind === 'FINAL')?.status).toBe('PLANNED');

      const approved = await decide(sent.id, 1, { decision: 'APPROVE', reason: 'The figures agree with the meter records' });
      expect(approved).toMatchObject({ status: 'APPROVED', closedCalendar: true });
      const after = await view(projectId);
      expect(after.calendar.find((row) => row.kind === 'FINAL')).toMatchObject({ status: 'DONE', state: 'DONE', assessmentId: sent.id });
      expect(after.assessments[0]).toMatchObject({ status: 'APPROVED', kind: 'FINAL', conclusion: 'PARTIALLY_SATISFACTORY' });
      expect(after.assessments[0]?.submittedBy.membershipId).toBe(memberId(MAKER));
      expect(after.assessments[0]?.decidedBy?.membershipId).toBe(memberId(CHECKER));
      expect(await refusal(decide(sent.id, 2, { decision: 'APPROVE' }))).toMatchObject({ code: 'EFFECT_ASSESSMENT_STATE_INVALID', extensions: { status: 'APPROVED' } });
      // A kind that was approved is not submitted again; an assessment outside the calendar may be.
      expect(await refusal(submit(projectId))).toMatchObject({ code: 'EFFECT_ASSESSMENT_STATE_INVALID', extensions: { reason: 'ALREADY_APPROVED' } });
      expect(await submit(projectId, { kind: 'AD_HOC' })).toMatchObject({ kind: 'AD_HOC', calendarEntryId: null });
      expect(await databaseRefusal(owner(`update machvon.effect_assessment set conclusion = 'SATISFACTORY' where id = $1`, [sent.id]))).toContain('never changed');
      expect(await databaseRefusal(owner('delete from machvon.effect_assessment where id = $1', [sent.id]))).toContain('append-only');
    });

    it('returns an assessment with a reason, keeps the calendar entry open, and takes a new submission of the kind', async () => {
      const { projectId } = await fixedProject();
      await measure(projectId, { value: '700' });
      const sent = await submit(projectId, { kind: 'IMPACT' });
      const returned = await decide(sent.id, 1, { decision: 'RETURN', reason: 'The impact on the grid is not assessed' }, THIRD);
      expect(returned).toMatchObject({ status: 'RETURNED', closedCalendar: false });
      const seen = await view(projectId);
      expect(seen.assessments[0]).toMatchObject({ status: 'RETURNED', decisionReason: 'The impact on the grid is not assessed' });
      expect(await submit(projectId, { kind: 'IMPACT' })).toMatchObject({ status: 'SUBMITTED' });
    });

    it('takes up an assessment that was answered before the calendar was generated: an approved one closes the new entry, a submitted one is linked and closes it later', async () => {
      const early = await fixedProject();
      await stageChange(early.projectId, 'COMPLETED', '2026-06-30', 2);
      await measure(early.projectId, { value: '900' });
      const approvedFirst = await submit(early.projectId);
      expect(approvedFirst.calendarEntryId).toBeNull();
      await decide(approvedFirst.id, 1, { decision: 'APPROVE' });
      await as((tx) => effects.generateCalendar(tx, { projectId: early.projectId, actor: memberId(MAKER), scopes, now: NOW }));
      const closed = (await view(early.projectId)).calendar.find((row) => row.kind === 'FINAL');
      expect(closed).toMatchObject({ status: 'DONE', state: 'DONE', assessmentId: approvedFirst.id });

      const waiting = await fixedProject();
      await stageChange(waiting.projectId, 'COMPLETED', '2026-06-30', 2);
      await measure(waiting.projectId, { value: '900' });
      const sent = await submit(waiting.projectId);
      await as((tx) => effects.generateCalendar(tx, { projectId: waiting.projectId, actor: memberId(MAKER), scopes, now: NOW }));
      const linked = await owner<{ calendar_entry_id: string | null }>('select calendar_entry_id from machvon.effect_assessment where id = $1', [sent.id]);
      expect(linked[0]?.calendar_entry_id).not.toBeNull();
      expect(await decide(sent.id, 1, { decision: 'APPROVE' })).toMatchObject({ closedCalendar: true });
      expect((await view(waiting.projectId)).calendar.find((row) => row.kind === 'FINAL')).toMatchObject({ status: 'DONE', assessmentId: sent.id });
    });

    it('needs fixed targets, a project in a status that has them, and a scope', async () => {
      const bare = await seedProject({ status: 'COMPLETED' });
      expect(await refusal(submit(bare))).toMatchObject({ code: 'EFFECT_TARGETS_NOT_FIXED' });
      const early = await seedProject({ status: 'CONCEPT', group: null });
      expect(await refusal(submit(early))).toMatchObject({ code: 'PROJECT_STAGE_INVALID' });
      const { projectId } = await fixedProject();
      await measure(projectId, {});
      expect((await refusal(as((tx) => effects.submitAssessment(tx, { projectId, body: { kind: 'FINAL', conclusion: 'SATISFACTORY', summary: 'The plant reached its output target.' }, actor: memberId(MAKER), scopes: blind, now: NOW })))).status).toBe(404);
    });
  });
});
