import { randomUUID } from 'node:crypto';
import { PrjProjectStore } from '../../src/prj-project-store';
import { PwfWorkflowStore } from '../../src/pwf-workflow-store';
import type { ScopeBuilder } from '../../src/scope-version';
import type { AuthzHarness } from './authz-fixtures';
import { TENANT_A, contextFor, memberId, unitId } from './authz-fixtures';

/**
 * The data the tests of the scores of staff start from (PWF-3): a project with a workflow whose tasks are written next to it with the dates the test needs, and the ledger of who held them. The days are fixed in 2025
 * (calendars of Monday to Friday are published for 2023 to 2026) so that no weekday moves with the clock.
 */

export const SCORE_YEAR = 2025;
export const SCORE_TEMPLATE = {
  name: 'Score flow',
  phases: [{ code: 'P1', name: 'Phase one', gates: [] }],
  tasks: [
    {
      code: 'TA', name: 'Task A', phase: 'P1', kind: 'TASK', duration_working_days: 3, required: true, responsible_role: 'WORKER_ROLE', approver_role: 'CHECKER_ROLE', priority: 'HIGH', predecessors: [],
      legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [],
    },
  ],
};

const everything: ScopeBuilder = () => ({ sql: 'true', params: [] });

export interface FixtureOptions {
  harness: AuthzHarness;
  /** The membership that owns the project and the workflow (a member the test seeded). */
  maker: number;
  /** The unit number that owns the projects. */
  unit: number;
}

export interface SeededTask {
  status?: string;
  baselineFinish: string | null;
  baselineStart?: string;
  actualStart?: string | null;
  actualFinish?: string | null;
  cancelledBy?: number;
  cancelledAt?: string;
  priority?: string;
  days?: number;
  returns?: number;
  own?: boolean;
  createdAt?: string;
  estimate?: number;
  actual?: number;
  phase?: string;
}

export class ScoreFixtures {
  private areaVersion = '';
  private counter = 0;
  private readonly projects = new PrjProjectStore();
  private readonly workflows = new PwfWorkflowStore();

  constructor(private readonly options: FixtureOptions) {}

  private owner<R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    return this.options.harness.owner<R>(TENANT_A, [[sql, params]]);
  }

  /** The calendars, the master data of the area, the template and the scoring policy every test of the scores needs. */
  async seed(approvers: { maker: number; submitter: number; checker: number }, policy: Record<string, unknown>): Promise<void> {
    const { harness } = this.options;
    const recordId = randomUUID();
    const versionId = randomUUID();
    await harness.owner(TENANT_A, [
      [`insert into machvon.master_record (tenant_id, id, namespace, master_type, business_key, status, created_by, updated_by) values ($1, $2, 'TENANT', 'AREA', $3, 'EFFECTIVE', $4, $4)`, [TENANT_A, recordId, 'AREA-SCORE', memberId(this.options.maker)]],
      [
        `insert into machvon.master_record_version (tenant_id, id, master_type, code, revision, label, attributes, valid_from, status, master_record_id, published_at, created_by, updated_by)
         values ($1, $2, 'AREA', $3, 1, 'Area', '{}'::jsonb, '2020-01-01', 'EFFECTIVE', $4, now(), $5, $5)`,
        [TENANT_A, versionId, 'AREA-SCORE', recordId, memberId(this.options.maker)],
      ],
    ]);
    this.areaVersion = versionId;
    await harness.owner(
      TENANT_A,
      [SCORE_YEAR - 2, SCORE_YEAR - 1, SCORE_YEAR, SCORE_YEAR + 1].map((year): [string, unknown[]] => [
        `insert into machvon.work_calendar_version (tenant_id, id, calendar_code, year, revision, working_days, holidays, compensated_workdays, legal_basis_ref, status, created_by, published_by, published_at)
         values ($1, gen_random_uuid(), 'WORKDAY_VN', $2, 1, '[1,2,3,4,5]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Labour Code 2019', 'Published', $3, $3, now())`,
        [TENANT_A, year, memberId(this.options.maker)],
      ]),
    );
    const rule = (type: string, code: string, params: unknown): Promise<unknown> =>
      this.owner(
        `insert into machvon.governance_rule (tenant_id, rule_type, code, version, status, params, effective_from, reason, created_by, submitted_by, submitted_at, approved_by, approved_at)
         values ($1, $2, $3, 1, 'APPROVED', $4::jsonb, date '2020-01-01', 'A rule for the tests', $5, $6, now(), $7, now())`,
        [TENANT_A, type, code, JSON.stringify(params), memberId(approvers.maker), memberId(approvers.submitter), memberId(approvers.checker)],
      );
    await rule('PROJECT_WORKFLOW_TEMPLATE', 'SCOREFLOW', SCORE_TEMPLATE);
    await rule('STAFF_SCORING_POLICY', 'TESTPOL', policy);
  }

  /** A workflow of a project of the unit; its first baseline was taken at the start of 2025. */
  async workflow(): Promise<{ id: string; projectId: string }> {
    const { harness, maker, unit } = this.options;
    this.counter += 1;
    const code = `SC-${this.counter}-${randomUUID().slice(0, 6)}`;
    const today = new Date().toISOString().slice(0, 10);
    const created = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(maker)), (tx) =>
      this.projects.create(tx, { code, name: `Project ${code}`, ownerUnitId: unitId(unit), areaMasterVersionId: this.areaVersion, totalInvestmentVnd: '500000000000' }, memberId(maker), today),
    );
    await this.owner('update machvon.project set status = $2, project_group = $3 where id = $1::uuid', [created.id, 'IMPLEMENTATION', 'B']);
    const started = await harness.tenants.withTenant(contextFor(TENANT_A, memberId(maker)), (tx) =>
      this.workflows.start(tx, { projectId: created.id, templateCode: 'SCOREFLOW', plannedStartDate: `${SCORE_YEAR}-01-06`, facts: { project_group: 'B' }, actor: memberId(maker), scopes: { act: everything, read: everything }, now: new Date() }),
    );
    await this.owner('update machvon.project_workflow_baseline set taken_at = $2::timestamptz where workflow_id = $1::uuid and version = 1', [started.id, `${SCORE_YEAR}-01-06T03:00:00Z`]);
    return { id: started.id, projectId: created.id };
  }

  async task(wf: { id: string; projectId: string }, code: string, seed: SeededTask): Promise<string> {
    const status = seed.status ?? 'DONE';
    const rows = await this.owner<{ id: string }>(
      `insert into machvon.project_task (tenant_id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, own_task, status, tracked,
          baseline_start, baseline_finish, planned_start, planned_finish, actual_start, actual_finish, return_count, cancelled_by, cancelled_at, estimate_vnd, actual_vnd, created_at, created_by, updated_by)
       values ($1, $2::uuid, $3::uuid, $4, $5, $6, 900, 'TASK', false, 'WORKER_ROLE', $7, $8, $9, $10, true, $11::date, $12::date, $11::date, $12::date, $13::date, $14::date, $15, $16::uuid, $17::timestamptz, $18, $19,
          coalesce($20::timestamptz, now()), $21::uuid, $21::uuid) returning id`,
      [
        TENANT_A, wf.id, wf.projectId, code, `Task ${code}`, seed.phase ?? 'P1', seed.priority ?? 'NORMAL', seed.days ?? 10, seed.own ?? true, status,
        seed.baselineStart ?? seed.baselineFinish, seed.baselineFinish, seed.actualStart === undefined ? (status === 'NOT_STARTED' ? null : (seed.baselineStart ?? seed.baselineFinish)) : seed.actualStart,
        seed.actualFinish === undefined ? (status === 'DONE' ? seed.baselineFinish : null) : seed.actualFinish, seed.returns ?? 0, seed.cancelledBy === undefined ? null : memberId(seed.cancelledBy), seed.cancelledAt ?? null,
        seed.estimate ?? null, seed.actual ?? null, seed.createdAt ?? null, memberId(this.options.maker),
      ],
    );
    return (rows[0] as { id: string }).id;
  }

  hold(taskId: string, who: number, over: { role?: string; from?: string; to?: string | null; share?: number } = {}): Promise<unknown> {
    return this.owner(
      `insert into machvon.project_task_assignment (tenant_id, task_id, membership_id, role, valid_from, valid_to, share_pct, reason, assigned_by) values ($1, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7, 'Held for the test', $8::uuid)`,
      [TENANT_A, taskId, memberId(who), over.role ?? 'RESPONSIBLE', over.from ?? '2020-01-01', over.to === undefined ? null : over.to, over.share ?? 100, memberId(this.options.maker)],
    );
  }
}
