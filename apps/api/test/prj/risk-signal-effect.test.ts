import { randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { EffectiveAccessStore, InMemoryAuthzCache, TenantDatabase } from '@machvon/db';
import { loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { mneModule } from '../../src/modules/mne';
import { EffectController, EffectReadsController } from '../../src/modules/mne/effect.controller';
import { prjModule } from '../../src/modules/prj';
import { ProjectRiskAlertController, ProjectRiskSignalReadsController } from '../../src/modules/prj/risk-signal.controller';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { seedAs } from '../../../../packages/db/test/support/bid-proposal-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

jest.setTimeout(180_000);

const SIGNING_KEY = randomBytes(32);
const MAKER = 1; // drafts the targets, measures, assesses, reads the alerts
const CHECKER = 2; // fixes the targets, decides the assessment, acknowledges the alerts
const READER = 3; // project.read only
const B_MEMBER = 21;
const ROOT = 1;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

describe('the risk board, its alerts and the effectiveness of a project (MR.02, MR.03: PRJ-28, MNE-11)', () => {
  const harness = new AuthzHarness();
  let app: RunningApp;
  let counter = 0;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);

  async function call(method: string, url: string, options: { member: number; tenantId?: string; body?: unknown; ifMatch?: string }): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member, options.tenantId), 'content-type': 'application/json' };
    if (method !== 'GET') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}) });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  const rows = async <R extends object>(sql: string, params: unknown[] = []): Promise<R[]> => harness.owner<R>(TENANT_A, [[sql, params]]);

  async function project(status = 'IMPLEMENTATION'): Promise<string> {
    counter += 1;
    const projectId = randomUUID();
    await seedAs(harness, [
      [
        `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version, project_group)
         values ($1, $2, $3, 'Solar plant', $4, $4, $5, 'INTERNAL', 1000, $6, 1, 'A')`,
        [TENANT_A, projectId, `MR-${counter}-${randomUUID().slice(0, 4)}`, unitId(ROOT), id(0xa8, 90), status],
      ],
    ]);
    return projectId;
  }

  const INDICATORS = [
    {
      code: 'OUTPUT',
      name: 'Yearly output of the plant',
      unit: 'MWh',
      direction: 'HIGHER_IS_BETTER',
      baseline_value: '0',
      baseline_on: '2026-01-01',
      target_value: '1000',
      data_source: 'Meter readings',
      formula: 'Sum of monthly readings',
    },
  ];

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) await harness.seedUnits(tenant, [{ n: ROOT, path: `/${unitId(ROOT)}/` }]);
    for (const n of [MAKER, CHECKER, READER]) await harness.seedMembership(TENANT_A, n, ROOT);
    await harness.seedMembership(TENANT_B, B_MEMBER, ROOT);
    await harness.seedRole(TENANT_A, 1, 'EFFECT_MAKER', ['project.read', 'project.risk.alert.read', 'effect.target.manage', 'effect.measure', 'effect.assess', 'effect.calendar.manage'], 40);
    await harness.seedRole(TENANT_A, 2, 'EFFECT_CHECKER', ['project.read', 'project.risk.alert.read', 'project.risk.alert.acknowledge', 'effect.target.approve', 'effect.assess.decide'], 40);
    await harness.seedRole(TENANT_A, 3, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedRole(TENANT_B, 3, 'PROJECT_READER', ['project.read'], 20);
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: READER, role: 3, kind: 'TENANT' },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: B_MEMBER, role: 3, kind: 'TENANT' }]);
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()) })],
      controllers: [ProjectRiskAlertController, ProjectRiskSignalReadsController, EffectController, EffectReadsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 240_000);

  afterAll(async () => {
    if (app) await app.close();
    await harness.stop();
  }, 60_000);

  it('is registered in the modules of PRJ and MNE', () => {
    expect(prjModule.controllers).toEqual(expect.arrayContaining([ProjectRiskAlertController, ProjectRiskSignalReadsController]));
    expect(mneModule.controllers).toEqual(expect.arrayContaining([EffectController, EffectReadsController]));
  });

  describe('the board and the alerts (PRJ-28)', () => {
    it('shows the lines in the scope of the reader with the rule that decided and its provenance, and refuses a filter that is not one', async () => {
      const projectId = await project();
      const signalId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.project_risk_signal (tenant_id, id, project_id, signal_kind, status, likelihood, impact, evidence, rule_version, rule_unverified, first_scored_on, last_scored_on)
           values ($1, $2, $3, 'FUNDING_GAP', 'ACTIVE', 5, 5, '{"indicators":{"FUNDING_GAP_PCT":45}}'::jsonb, 'built-in:1', true, date '2026-11-01', date '2026-11-01')`,
          [TENANT_A, signalId, projectId],
        ],
      ]);
      const board = await call('GET', '/risk-signals/board?level=CRITICAL&limit=200', { member: READER });
      expect(board.status).toBe(200);
      const items = board.json.items as Array<Record<string, unknown>>;
      expect(items.find((item) => item.id === signalId)).toMatchObject({ origin: 'SIGNAL', kind: 'FUNDING_GAP', score: 25, level: 'CRITICAL', trend: 'NEW', alert_open: false, rule_unverified: true, project_id: projectId });
      expect(board.json.policy).toMatchObject({ name: 'RISK_SIGNAL_POLICY', unverified: true, version: 'built-in:1', owner: 'PRJ', legal_status: 'UNVERIFIED' });
      expect((board.json.policy as { formula: string }).formula.length).toBeGreaterThan(20);
      expect((board.json.counts as { critical: number }).critical).toBeGreaterThanOrEqual(1);
      expect((await call('GET', '/risk-signals/board?level=HUGE', { member: READER })).status).toBe(422);
      expect((await call('GET', '/risk-signals/board?kind=NOPE', { member: READER })).status).toBe(422);
      const view = await call('GET', `/projects/${projectId}/risk-signals`, { member: READER });
      expect(view.status).toBe(200);
      expect((view.json.lines as unknown[]).length).toBe(1);
      expect(view.json.can).toEqual({ acknowledge_alert: false });
      expect((await call('GET', `/projects/${randomUUID()}/risk-signals`, { member: READER })).status).toBe(404);
      expect((await call('GET', `/projects/${projectId}/risk-signals`, { member: B_MEMBER, tenantId: TENANT_B })).status).toBe(404);
    });

    it('lists the alerts only to a holder of the read permission, and acknowledges one with a note, once, under the version seen', async () => {
      const projectId = await project();
      const signalId = randomUUID();
      const alertId = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.project_risk_signal (tenant_id, id, project_id, signal_kind, status, likelihood, impact, evidence, rule_version, rule_unverified, first_scored_on, last_scored_on)
           values ($1, $2, $3, 'SCHEDULE_DELAY', 'ACTIVE', 4, 4, '{}'::jsonb, 'built-in:1', true, date '2026-11-01', date '2026-11-01')`,
          [TENANT_A, signalId, projectId],
        ],
        [
          `insert into machvon.project_risk_alert (tenant_id, id, project_id, alert_type, subject_kind, signal_id, signal_kind, score, prior_score, threshold, rule_version, rule_unverified, status, raised_on, raised_by)
           values ($1, $2, $3, 'RISK_SCORE_CRITICAL', 'SIGNAL', $4, 'SCHEDULE_DELAY', 16, 0, 15, 'built-in:1', true, 'OPEN', date '2026-11-01', $5)`,
          [TENANT_A, alertId, projectId, signalId, memberId(MAKER)],
        ],
      ]);
      expect((await call('GET', '/project-risk-alerts', { member: READER })).status).toBe(403);
      const listed = await call('GET', `/project-risk-alerts?status=OPEN&project_id=${projectId}`, { member: MAKER });
      expect(listed.status).toBe(200);
      expect(listed.json.items).toEqual([expect.objectContaining({ id: alertId, alert_type: 'RISK_SCORE_CRITICAL', status: 'OPEN', score: 16, prior_score: 0, threshold: 15, version: 1 })]);
      expect((await call('GET', '/project-risk-alerts?status=GONE', { member: MAKER })).status).toBe(422);
      const asChecker = await call('GET', `/projects/${projectId}/risk-signals`, { member: CHECKER });
      expect(asChecker.json.can).toEqual({ acknowledge_alert: true });

      const body = { note: 'Seen, the site handover is brought forward' };
      expect((await call('POST', `/project-risk-alerts/${alertId}/acknowledgement`, { member: READER, ifMatch: '"1"', body })).status).toBe(403);
      expect((await call('POST', `/project-risk-alerts/${alertId}/acknowledgement`, { member: CHECKER, ifMatch: '"9"', body })).status).toBe(409);
      expect((await call('POST', `/project-risk-alerts/${alertId}/acknowledgement`, { member: CHECKER, ifMatch: '"1"', body: { note: '' } })).status).toBeGreaterThanOrEqual(400);
      const done = await call('POST', `/project-risk-alerts/${alertId}/acknowledgement`, { member: CHECKER, ifMatch: '"1"', body });
      expect(done.status).toBe(200);
      expect(done.json).toMatchObject({ status: 'ACKNOWLEDGED', resource_version: 2, project_id: projectId });
      const again = await call('POST', `/project-risk-alerts/${alertId}/acknowledgement`, { member: CHECKER, ifMatch: '"2"', body });
      expect([again.status, again.json.code]).toEqual([409, 'RISK_ALERT_STATE_INVALID']);
      const audit = await rows<{ reason: string; actor_id: string }>(`select reason, actor_id from machvon.audit_event where resource_id = $1 and action = 'project.risk_alert_acknowledged'`, [alertId]);
      expect(audit).toEqual([{ reason: body.note, actor_id: memberId(CHECKER) }]);
      expect(await rows(`select 1 from machvon.outbox_event where type = 'project.risk_alert_acknowledged.v1' and aggregate_id = $1`, [alertId])).toHaveLength(1);
    });
  });

  describe('the effectiveness of a project (MNE-11)', () => {
    it('goes from a draft by one person to fixed targets by another, an actual after the commissioning, an assessment and its decision by a third', async () => {
      const projectId = await project();
      const seen = await call('GET', `/projects/${projectId}/effectiveness`, { member: READER });
      expect(seen.status).toBe(200);
      expect(seen.json).toMatchObject({ fixed: null, draft: null, suggested_conclusion: null, can: { draft: false, fix: false, measure: false, generate_calendar: false, assess: false, decide: false } });
      expect(seen.json.policy).toMatchObject({ name: 'EFFECT_POLICY', unverified: true, version: 'built-in:1', owner: 'MNE' });

      const draftBody = { basis: 'Decision 123/QD-UBND of 2026-03-01', indicators: INDICATORS };
      expect((await call('POST', `/projects/${projectId}/effect-targets`, { member: READER, body: draftBody })).status).toBe(403);
      expect((await call('POST', `/projects/${projectId}/effect-targets`, { member: MAKER, body: { ...draftBody, indicators: [] } })).status).toBeGreaterThanOrEqual(400);
      const drafted = await call('POST', `/projects/${projectId}/effect-targets`, { member: MAKER, body: draftBody });
      expect(drafted.status).toBe(200);
      expect(drafted.json).toMatchObject({ status: 'DRAFT', resource_version: 1, version_no: 1, project_id: projectId });
      const setId = drafted.json.resource_id as string;

      const asChecker = await call('GET', `/projects/${projectId}/effectiveness`, { member: CHECKER });
      expect(asChecker.json.can).toMatchObject({ fix: true, draft: false });
      expect(((asChecker.json.draft as { indicators: Array<{ code: string }> }).indicators).map((line) => line.code)).toEqual(['OUTPUT']);
      expect((await call('GET', `/projects/${projectId}/effectiveness`, { member: MAKER })).json.can).toMatchObject({ fix: false, draft: true });

      // The one who drafted has no right to fix (the right of the checker is another one), so the project is out of the scope of the fix; the refusal of a drafter who does hold the right is tested with the store.
      expect((await call('POST', `/effect-target-sets/${setId}/fix`, { member: MAKER, ifMatch: '"1"' })).json.code).toBe('SCOPE_DENIED');
      const fixed = await call('POST', `/effect-target-sets/${setId}/fix`, { member: CHECKER, ifMatch: '"1"' });
      expect(fixed.status).toBe(200);
      expect(fixed.json).toMatchObject({ status: 'FIXED', version_no: 1 });
      expect(await rows(`select 1 from machvon.audit_event where resource_id = $1 and action = 'mne.effect_targets_fixed'`, [setId])).toHaveLength(1);
      expect(await rows(`select 1 from machvon.outbox_event where type = 'mne.effect_targets_fixed.v1' and aggregate_id = $1`, [setId])).toHaveLength(1);

      const measurement = { indicator_code: 'OUTPUT', measured_on: '2026-10-31', value: '800', method_note: 'Meter readings of the year' };
      const early = await call('POST', `/projects/${projectId}/effect-measurements`, { member: MAKER, body: measurement });
      expect([early.status, early.json.code]).toEqual([422, 'PROJECT_STAGE_INVALID']);
      await seedAs(harness, [['update machvon.project set status = $2 where id = $1', [projectId, 'COMPLETED']]]);
      const measured = await call('POST', `/projects/${projectId}/effect-measurements`, { member: MAKER, body: measurement });
      expect(measured.status).toBe(200);
      expect(measured.json).toMatchObject({ status: 'RECORDED', indicator_code: 'OUTPUT', value: '800' });
      const duplicate = await call('POST', `/projects/${projectId}/effect-measurements`, { member: MAKER, body: { ...measurement, value: '900' } });
      expect([duplicate.status, duplicate.json.code]).toEqual([409, 'EFFECT_MEASUREMENT_DUPLICATE']);

      const after = await call('GET', `/projects/${projectId}/effectiveness`, { member: MAKER });
      const line = (after.json.fixed as { indicators: Array<Record<string, unknown>> }).indicators[0];
      expect(line).toMatchObject({ code: 'OUTPUT', target_value: '1000', actual: { value: '800', measured_on: '2026-10-31' }, variance: { variance_value: '-200', variance_pct: '-20.00', achievement_pct: '80.00', band: 'PARTIAL' } });
      expect(after.json).toMatchObject({ suggested_conclusion: 'PARTIALLY_SATISFACTORY', can: { measure: true, assess: true } });

      const assessment = { kind: 'FINAL', conclusion: 'PARTIALLY_SATISFACTORY', summary: 'The plant reached eighty percent of its output target.' };
      const submitted = await call('POST', `/projects/${projectId}/effect-assessments`, { member: MAKER, body: assessment });
      expect(submitted.status).toBe(200);
      expect(submitted.json).toMatchObject({ status: 'SUBMITTED', kind: 'FINAL', resource_version: 1 });
      const assessmentId = submitted.json.resource_id as string;
      expect(((await call('POST', `/projects/${projectId}/effect-assessments`, { member: MAKER, body: assessment })).json as { code: string }).code).toBe('EFFECT_ASSESSMENT_STATE_INVALID');
      expect((await call('POST', `/effect-assessments/${assessmentId}/decision`, { member: MAKER, ifMatch: '"1"', body: { decision: 'APPROVE' } })).json.code).toBe('SCOPE_DENIED');
      expect((await call('POST', `/effect-assessments/${assessmentId}/decision`, { member: CHECKER, ifMatch: '"1"', body: { decision: 'RETURN' } })).status).toBe(422);
      const approved = await call('POST', `/effect-assessments/${assessmentId}/decision`, { member: CHECKER, ifMatch: '"1"', body: { decision: 'APPROVE', reason: 'The figures agree with the meter records' } });
      expect(approved.status).toBe(200);
      expect(approved.json).toMatchObject({ status: 'APPROVED', kind: 'FINAL' });
      const last = await call('GET', `/projects/${projectId}/effectiveness`, { member: READER });
      expect((last.json.assessments as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'APPROVED', kind: 'FINAL', conclusion: 'PARTIALLY_SATISFACTORY' });
      const audit = await rows<{ reason: string | null }>(`select reason from machvon.audit_event where resource_id = $1 and action = 'mne.effect_assessment_decided'`, [assessmentId]);
      expect(audit).toEqual([{ reason: 'The figures agree with the meter records' }]);
    });

    it('generates the calendar once, says nothing when it made nothing, and refuses a project that has no group', async () => {
      const projectId = await project('COMPLETED');
      await seedAs(harness, [
        [
          `insert into machvon.project_stage_change (tenant_id, id, project_id, project_version, from_stage, to_stage, operation, actor_kind, actor_id, reason, effective_date)
           values ($1, $2, $3, 2, 'IMPLEMENTATION', 'COMPLETED', 'moveStage', 'USER', $4, 'Moved by the test', date '2026-06-30')`,
          [TENANT_A, randomUUID(), projectId, memberId(MAKER)],
        ],
      ]);
      expect((await call('POST', `/projects/${projectId}/effect-calendar`, { member: READER })).status).toBe(403);
      const made = await call('POST', `/projects/${projectId}/effect-calendar`, { member: MAKER });
      expect(made.status).toBe(200);
      expect(made.json.created).toEqual([expect.objectContaining({ kind: 'FINAL', due_on: '2026-09-30', anchor: 'COMPLETION' })]);
      expect(made.json.rule).toMatchObject({ code: 'GROUP_A', version: 'built-in:1', unverified: true });
      expect((made.json.waiting as unknown[]).length).toBe(3);
      const again = await call('POST', `/projects/${projectId}/effect-calendar`, { member: MAKER });
      expect(again).toMatchObject({ status: 200, json: { created: [] } });
      expect(await rows(`select 1 from machvon.audit_event where action = 'mne.effect_calendar_generated' and safe_diff->>'project_id' = $1`, [projectId])).toHaveLength(1);
      const view = await call('GET', `/projects/${projectId}/effectiveness`, { member: READER });
      expect(view.json.calendar).toEqual([expect.objectContaining({ kind: 'FINAL', status: 'PLANNED', state: 'OVERDUE', rule_unverified: true })]);
      const none = randomUUID();
      await seedAs(harness, [
        [
          `insert into machvon.project (tenant_id, id, code, name, owner_unit_id, investor_unit_id, area_master_version_id, classification, total_investment_vnd, status, version)
           values ($1, $2, $3, 'Concept', $4, $4, $5, 'INTERNAL', 1000, 'CONCEPT', 1)`,
          [TENANT_A, none, `MR-NG-${randomUUID().slice(0, 4)}`, unitId(ROOT), id(0xa8, 90)],
        ],
      ]);
      const refused = await call('POST', `/projects/${none}/effect-calendar`, { member: MAKER });
      expect([refused.status, refused.json.code]).toEqual([422, 'VALIDATION_FAILED']);
    });
  });
});
