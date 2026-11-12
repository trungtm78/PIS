import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertBaselineCapturable,
  baselineDeviation,
  baselineTotal,
  deriveBaselineLines,
  earliestStart,
  latestFinish,
  reappraisalReasons,
  rescheduleCount,
  rescheduleNeedsAlert,
  scaledOf,
  versionConflict,
} from '@machvon/kernel';
import type { B1PolicyReader, ComponentFact, Deviation, MilestoneFact, ReappraisalReason, RescheduleFact } from '@machvon/kernel';
import { DEFAULT_B1_READER, b1PolicyOf } from './b1-policy-reader.ts';
import { idOf } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { lockProject } from './prj-stage-support.ts';
import type { LockedProject, StageScopes } from './prj-stage-support.ts';
import { SqlProjectScheduleReader } from './pwf-schedule-read.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The baseline of a project (G1-3; research F21, F3): version 0 is taken once by a command from the approved work breakdown and the baseline days of the milestones; every approved revision of the investment
 * total or the schedule adds the next version inside its own transaction; the deviation is always measured against version 0. Every move of a date to a later day is one row of an append-only table; a date moved as
 * many times as the rule says raises an alert to the auditors (AUD), and a deviation over the thresholds opens one request to appraise the project again, decided by someone other than the person whose change brought
 * it over the line. The thresholds are read through the governance port (`BASELINE_DEVIATION`), with the starting values of the lane when the tenant approved no rule, and the version that decided is stored with
 * what it decided. The hooks (`afterMilestoneProgress`, `afterRevisionApproved`) run inside the transaction of the command that moved the date, under the lock of the project it already holds.
 */

export const BASELINE_RESOURCE = 'project_baseline';
export const REAPPRAISAL_RESOURCE = 'project_reappraisal_request';
export const GOVERNANCE_ALERT_RESOURCE = 'project_governance_alert';
const FROZEN_STATUSES: readonly string[] = ['CLOSED', 'REJECTED', 'CANCELLED'];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface BaselineLineView {
  componentId: string;
  code: string;
  name: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
}

export interface BaselineVersionView {
  id: string;
  version: number;
  kind: 'V0' | 'REVISION';
  basis: 'BASELINE' | 'PLANNED';
  totalInvestmentVnd: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
  sourceRevisionId: string | null;
  takenBy: string;
  takenAt: string;
  lines: BaselineLineView[];
}

export interface RescheduleEventView {
  id: string;
  source: 'MILESTONE' | 'REVISION';
  milestoneId: string | null;
  milestoneCode: string | null;
  revisionId: string | null;
  fromDate: string;
  toDate: string;
  reason: string;
  recordedBy: string;
  recordedAt: string;
}

export interface GovernanceAlertView {
  id: string;
  projectId: string;
  projectCode: string;
  alertType: 'RESCHEDULE_COUNT';
  audience: 'AUD';
  subjectKind: 'MILESTONE' | 'PROJECT';
  subjectId: string | null;
  subjectCode: string | null;
  moveCount: number;
  threshold: number;
  ruleVersion: string;
  status: 'OPEN' | 'ACKNOWLEDGED';
  raisedBy: string;
  raisedAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  acknowledgeNote: string | null;
  version: number;
}

export interface ReappraisalView {
  id: string;
  baselineId: string;
  status: 'OPEN' | 'STARTED' | 'WAIVED';
  reasons: ReappraisalReason[];
  costPct: string | null;
  finishSlipDays: number | null;
  thresholdCostPct: string;
  thresholdSlipDays: number;
  ruleVersion: string;
  triggeredBy: 'REVISION' | 'MILESTONE';
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

export interface BaselinePolicyView {
  version: string;
  source: 'RULE' | 'BUILT_IN';
  costPct: number;
  slipDays: number;
  rescheduleAlertCount: number;
}

export interface BaselineView {
  projectId: string;
  projectCode: string;
  projectStatus: string;
  hasBaseline: boolean;
  versions: BaselineVersionView[];
  current: { totalInvestmentVnd: string; bacVnd: string; forecastFinish: string | null };
  deviation: Deviation | null;
  reasons: ReappraisalReason[];
  reschedule: { count: number; projectMoves: number; perMilestone: Array<{ milestoneId: string; code: string; moves: number }>; events: RescheduleEventView[] };
  alerts: GovernanceAlertView[];
  reappraisals: ReappraisalView[];
  policy: BaselinePolicyView;
  asOf: string;
}

/** What a hook did, for the controller that owns the transaction to write down (audit row, event): the store never writes the audit trail itself. */
export interface GovernanceEffects {
  rescheduleEvents: Array<{ id: string; source: 'MILESTONE' | 'REVISION'; milestoneId: string | null; revisionId: string | null; fromDate: string; toDate: string }>;
  alertsRaised: Array<{ id: string; subjectKind: 'MILESTONE' | 'PROJECT'; subjectId: string | null; moveCount: number; threshold: number; ruleVersion: string }>;
  baselineVersion: { id: string; version: number } | null;
  /** Components that a version of the baseline could not be taken for (no start or finish day): the version is skipped and the cause named. */
  baselineSkipped: string[] | null;
  reappraisalOpened: { id: string; reasons: ReappraisalReason[]; costPct: string | null; finishSlipDays: number | null; ruleVersion: string } | null;
}

export const noEffects = (): GovernanceEffects => ({ rescheduleEvents: [], alertsRaised: [], baselineVersion: null, baselineSkipped: null, reappraisalOpened: null });

export interface BaselineCapture {
  id: string;
  projectId: string;
  projectCode: string;
  classification: LockedProject['classification'];
  version: number;
  totalInvestmentVnd: string;
  bacVnd: string;
  plannedStart: string;
  plannedFinish: string;
  lineCount: number;
  effects: GovernanceEffects;
}

export interface ReappraisalDecision {
  id: string;
  projectId: string;
  projectCode: string;
  classification: LockedProject['classification'];
  status: 'STARTED' | 'WAIVED';
  version: number;
  reasons: ReappraisalReason[];
  decisionReason: string;
}

export interface AlertAcknowledgement {
  id: string;
  projectId: string;
  projectCode: string;
  classification: LockedProject['classification'];
  version: number;
  moveCount: number;
}

export interface MilestoneMove {
  milestoneId: string;
  code: string;
  fromDate: string;
  toDate: string;
  reason: string;
}

export interface RevisionApproved {
  id: string;
  kind: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  decisionReason: string | null;
}

interface BaselineSql {
  id: string;
  version: number;
  kind: 'V0' | 'REVISION';
  basis: 'BASELINE' | 'PLANNED';
  total_investment_vnd: string;
  bac_vnd: string;
  planned_start: string;
  planned_finish: string;
  source_revision_id: string | null;
  taken_by: string;
  taken_at: string;
}

interface LineSql {
  baseline_id: string;
  component_id: string;
  code: string;
  name: string;
  bac_vnd: string;
  planned_start: string;
  planned_finish: string;
}

const BASELINE_COLUMNS = `b.id, b.version, b.kind, b.basis, b.total_investment_vnd::text as total_investment_vnd, b.bac_vnd::text as bac_vnd, b.planned_start::text as planned_start, b.planned_finish::text as planned_finish,
  b.source_revision_id, b.taken_by, to_char(b.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as taken_at`;

const UTC = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** What a read of the facts of a project gives: its components and milestones as the pure functions of the kernel take them. */
export interface ProjectFacts {
  components: ComponentFact[];
  milestones: Array<MilestoneFact>;
  endYear: number | null;
  totalInvestmentVnd: string;
}

export async function loadProjectFacts(tx: TenantTx, projectId: string): Promise<ProjectFacts> {
  const components = await tx.query<{ id: string; parent_component_id: string | null; code: string; name: string; planned_value_vnd: string; valid_from: string; valid_until: string | null }>(
    `select id, parent_component_id, code, name, planned_value_vnd::text as planned_value_vnd, valid_from::text as valid_from, valid_until::text as valid_until from machvon.project_component where project_id = $1::uuid`,
    [projectId],
  );
  const milestones = await new SqlProjectScheduleReader().milestones(tx, projectId);
  const [project] = await tx.query<{ end_year: number | null; total_investment_vnd: string }>('select end_year, total_investment_vnd::text as total_investment_vnd from machvon.project where id = $1::uuid', [projectId]);
  if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  return {
    components: components.map((row) => ({ id: row.id, parentId: row.parent_component_id, code: row.code, name: row.name, plannedValueVnd: row.planned_value_vnd, validFrom: row.valid_from, validUntil: row.valid_until })),
    milestones: milestones.map((row) => ({ id: row.id, componentId: row.componentId, code: row.code, baselineDate: row.baselineDate, plannedDate: row.plannedDate, status: row.status })),
    endYear: project.end_year,
    totalInvestmentVnd: project.total_investment_vnd,
  };
}

/** The last day of the final year of the project, the finish of a work package that has no milestone. */
export const projectFinishOf = (endYear: number | null): string | null => (endYear === null ? null : `${String(endYear).padStart(4, '0')}-12-31`);

export class PrjBaselineStore {
  private readonly policy: B1PolicyReader<TenantTx>;

  constructor(policy: B1PolicyReader<TenantTx> = DEFAULT_B1_READER) {
    this.policy = policy;
  }

  /**
   * Takes version 0 of the baseline from the work breakdown and the baseline days of the milestones, under the lock of the project, once: a second call is 409 `BASELINE_ALREADY_TAKEN`. A work breakdown with
   * nothing in it is 422 `BASELINE_NO_WBS`; a first-level component with no start or finish day, or one that finishes before it starts, is 422 `BASELINE_INCOMPLETE` naming each of them.
   */
  async capture(tx: TenantTx, request: { projectId: string; actor: string; scopes: StageScopes; today: string }): Promise<BaselineCapture> {
    const project = await lockProject(tx, idOf(request.projectId, 'id'), request.scopes);
    if (FROZEN_STATUSES.includes(project.status)) throw new DomainError('PROJECT_STAGE_INVALID', 422, 'id', { extensions: { project_status: project.status } });
    const [taken] = await tx.query<{ id: string }>('select id from machvon.project_baseline where project_id = $1::uuid and version = 0', [project.id]);
    if (taken !== undefined) throw new DomainError('BASELINE_ALREADY_TAKEN', 409, 'id', { extensions: { baseline_id: taken.id } });
    const facts = await loadProjectFacts(tx, project.id);
    const draft = deriveBaselineLines({ components: facts.components, milestones: facts.milestones, basis: 'BASELINE', projectFinish: projectFinishOf(facts.endYear) });
    assertBaselineCapturable(draft);
    const id = await this.insertVersion(tx, { projectId: project.id, version: 0, kind: 'V0', basis: 'BASELINE', totalInvestmentVnd: project.totalInvestmentVnd, lines: draft.lines, revisionId: null, actor: request.actor });
    const effects = noEffects();
    effects.baselineVersion = { id, version: 0 };
    return {
      id,
      projectId: project.id,
      projectCode: project.code,
      classification: project.classification,
      version: 0,
      totalInvestmentVnd: project.totalInvestmentVnd,
      bacVnd: baselineTotal(draft.lines),
      plannedStart: earliestStart(draft.lines) ?? '',
      plannedFinish: latestFinish(draft.lines) ?? '',
      lineCount: draft.lines.length,
      effects,
    };
  }

  /** Hook of `PrjWbsStore.recordProgress`: a milestone delayed to a later day is a move of a date; it is counted, and the deviation is looked at again. */
  async afterMilestoneMove(tx: TenantTx, project: { id: string }, move: MilestoneMove, actor: string, today: string): Promise<GovernanceEffects> {
    const effects = noEffects();
    if (move.toDate <= move.fromDate) return effects;
    const id = await this.insertEvent(tx, { projectId: project.id, source: 'MILESTONE', milestoneId: move.milestoneId, revisionId: null, fromDate: move.fromDate, toDate: move.toDate, reason: move.reason, actor });
    effects.rescheduleEvents.push({ id, source: 'MILESTONE', milestoneId: move.milestoneId, revisionId: null, fromDate: move.fromDate, toDate: move.toDate });
    await this.countMoves(tx, project.id, actor, today, effects);
    await this.evaluate(tx, project, actor, 'MILESTONE', today, effects);
    return effects;
  }

  /**
   * Hook of `PrjRevisionStore.decide`, after the revision was applied to the project: an end year pushed back is a move of a date; a revision of the total or the schedule adds the next version of the baseline
   * (when version 0 exists); the deviation is looked at again.
   */
  async afterRevisionApproved(tx: TenantTx, project: { id: string }, revision: RevisionApproved, actor: string, today: string): Promise<GovernanceEffects> {
    const effects = noEffects();
    if (revision.kind === 'ADJUST_SCHEDULE') {
      const before = revision.before.end_year;
      const after = revision.after.end_year;
      if (typeof before === 'number' && typeof after === 'number' && after > before) {
        const fromDate = projectFinishOf(before) as string;
        const toDate = projectFinishOf(after) as string;
        const id = await this.insertEvent(tx, { projectId: project.id, source: 'REVISION', milestoneId: null, revisionId: revision.id, fromDate, toDate, reason: revision.decisionReason ?? 'ADJUST_SCHEDULE', actor });
        effects.rescheduleEvents.push({ id, source: 'REVISION', milestoneId: null, revisionId: revision.id, fromDate, toDate });
      }
    }
    if (revision.kind === 'ADJUST_INVESTMENT' || revision.kind === 'ADJUST_SCHEDULE') await this.addVersion(tx, project.id, revision.id, actor, effects);
    if (effects.rescheduleEvents.length > 0) await this.countMoves(tx, project.id, actor, today, effects);
    await this.evaluate(tx, project, actor, 'REVISION', today, effects);
    return effects;
  }

  /** Decides the request to appraise again under the version the decider saw. Whoever's change made it necessary does not decide it (403 `SELF_APPROVAL_DENIED`); a decided request is 409 `REAPPRAISAL_STATE_INVALID`. */
  async decideReappraisal(tx: TenantTx, request: { requestId: string; expectedVersion: number; decision: unknown; reason: unknown; actor: string; scopes: StageScopes }): Promise<ReappraisalDecision> {
    const id = idOf(request.requestId, 'id');
    const [target] = await tx.query<{ project_id: string }>('select project_id from machvon.project_reappraisal_request where id = $1::uuid', [id]);
    if (target === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, target.project_id, request.scopes);
    const [held] = await tx.query<{ status: string; requested_by: string; version: string; reasons: ReappraisalReason[] }>(
      'select status, requested_by, version::text as version, reasons from machvon.project_reappraisal_request where id = $1::uuid for update',
      [id],
    );
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (held.requested_by === request.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (Number(held.version) !== request.expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'OPEN') throw new DomainError('REAPPRAISAL_STATE_INVALID', 409, 'status', { extensions: { request_status: held.status } });
    if (request.decision !== 'START' && request.decision !== 'WAIVE') throw invalid('decision');
    const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
    if (reason.length < 1 || reason.length > 2000) throw invalid('reason');
    const status = request.decision === 'START' ? 'STARTED' : 'WAIVED';
    const [done] = await tx.query<{ version: string }>(
      `update machvon.project_reappraisal_request set status = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, version = version + 1 where id = $1::uuid returning version::text as version`,
      [id, status, request.actor, reason],
    );
    return { id, projectId: project.id, projectCode: project.code, classification: project.classification, status, version: Number(done?.version ?? 0), reasons: held.reasons, decisionReason: reason };
  }

  /** The auditor acknowledges an alert with a note, under the version of the alert; not the person whose delay raised it (403 `SELF_APPROVAL_DENIED`). */
  async acknowledgeAlert(tx: TenantTx, request: { alertId: string; expectedVersion: number; note: unknown; actor: string; scopes: StageScopes }): Promise<AlertAcknowledgement> {
    const id = idOf(request.alertId, 'id');
    const [target] = await tx.query<{ project_id: string }>('select project_id from machvon.project_governance_alert where id = $1::uuid', [id]);
    if (target === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, target.project_id, request.scopes);
    const [held] = await tx.query<{ status: string; raised_by: string; version: string; move_count: number }>('select status, raised_by, version::text as version, move_count from machvon.project_governance_alert where id = $1::uuid for update', [id]);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (held.raised_by === request.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (Number(held.version) !== request.expectedVersion) throw versionConflict(Number(held.version));
    if (held.status !== 'OPEN') throw new DomainError('GOVERNANCE_ALERT_STATE_INVALID', 409, 'status', { extensions: { alert_status: held.status } });
    const note = typeof request.note === 'string' ? request.note.trim() : '';
    if (note.length < 1 || note.length > 2000) throw invalid('note');
    const [done] = await tx.query<{ version: string }>(
      `update machvon.project_governance_alert set status = 'ACKNOWLEDGED', acknowledged_by = $2::uuid, acknowledged_at = now(), acknowledge_note = $3, version = version + 1 where id = $1::uuid returning version::text as version`,
      [id, request.actor, note],
    );
    return { id, projectId: project.id, projectCode: project.code, classification: project.classification, version: Number(done?.version ?? 0), moveCount: held.move_count };
  }

  /** The baseline of a project in the scope of the caller: its versions, the deviation from version 0, the moves of its dates, the alerts and the requests, and the thresholds that were used. A project out of sight is not found. */
  async view(tx: TenantTx, scope: ScopeBuilder, projectId: string, today: string): Promise<BaselineView> {
    const predicate = scope(2);
    const [project] = await tx.query<{ id: string; code: string; status: string; total: string }>(
      `select p.id, p.code, p.status, p.total_investment_vnd::text as total from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`,
      [projectId, ...predicate.params],
    );
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const versions = await this.versionsOf(tx, project.id);
    const facts = await loadProjectFacts(tx, project.id);
    const events = await this.eventsOf(tx, project.id);
    const counts = rescheduleCount(events.map((event): RescheduleFact => ({ source: event.source, milestoneId: event.milestoneId })));
    const policy = await b1PolicyOf(this.policy, tx, 'BASELINE_DEVIATION', today);
    const v0 = versions.find((version) => version.version === 0);
    const firstLevelBac = firstLevelTotal(facts.components);
    const live = facts.milestones.filter((milestone) => milestone.status !== 'CANCELLED');
    const forecastFinish = live.reduce<string | null>((last, milestone) => (last === null || milestone.plannedDate > last ? milestone.plannedDate : last), null);
    const deviation =
      v0 === undefined
        ? null
        : baselineDeviation({
            v0: { totalInvestmentVnd: v0.totalInvestmentVnd, bacVnd: v0.bacVnd, plannedStart: v0.plannedStart, plannedFinish: v0.plannedFinish },
            currentTotalInvestmentVnd: project.total,
            currentBacVnd: firstLevelBac,
            milestones: facts.milestones.map((milestone) => ({ ...milestone, moves: counts.perMilestone.get(milestone.id) ?? 0 })),
          });
    const codes = new Map(facts.milestones.map((milestone) => [milestone.id, milestone.code]));
    const alerts = await this.alertsOf(tx, project.id);
    const reappraisals = await this.reappraisalsOf(tx, project.id);
    return {
      projectId: project.id,
      projectCode: project.code,
      projectStatus: project.status,
      hasBaseline: v0 !== undefined,
      versions,
      current: { totalInvestmentVnd: project.total, bacVnd: firstLevelBac, forecastFinish },
      deviation,
      reasons: deviation === null ? [] : reappraisalReasons(deviation, policy.params),
      reschedule: {
        count: counts.count,
        projectMoves: counts.projectMoves,
        perMilestone: [...counts.perMilestone.entries()].map(([milestoneId, moves]) => ({ milestoneId, code: codes.get(milestoneId) ?? '', moves })).sort((a, b) => b.moves - a.moves || a.code.localeCompare(b.code)),
        events: events.map((event) => ({ ...event, milestoneCode: event.milestoneId === null ? null : (codes.get(event.milestoneId) ?? null) })),
      },
      alerts,
      reappraisals,
      policy: { version: policy.version, source: policy.version === 'built-in:1' ? 'BUILT_IN' : 'RULE', costPct: policy.params.costPct, slipDays: policy.params.slipDays, rescheduleAlertCount: policy.params.rescheduleAlertCount },
      asOf: today,
    };
  }

  /** The alerts to an audience in the scope of the caller, the open ones first, latest first. */
  async listAlerts(tx: TenantTx, scope: ScopeBuilder, filter: { status?: 'OPEN' | 'ACKNOWLEDGED' | undefined; projectId?: string | undefined }, limit: number): Promise<GovernanceAlertView[]> {
    const predicate = scope(3);
    const rows = await tx.query<AlertSql>(
      `${ALERT_SELECT}
        where a.audience = 'AUD' and ($1::text is null or a.status = $1) and ($2::uuid is null or a.project_id = $2::uuid) and ${predicate.sql}
        order by (a.status = 'OPEN') desc, a.raised_at desc, a.id limit ${Math.max(1, Math.min(limit, 200))}`,
      [filter.status ?? null, filter.projectId ?? null, ...predicate.params],
    );
    return rows.map(alertOf);
  }

  /** Whether an open request to appraise the project again exists (a warning on a payment, never a block). */
  async hasOpenReappraisal(tx: TenantTx, projectId: string): Promise<boolean> {
    const [row] = await tx.query<{ id: string }>("select id from machvon.project_reappraisal_request where project_id = $1::uuid and status = 'OPEN' limit 1", [projectId]);
    return row !== undefined;
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  private async insertVersion(
    tx: TenantTx,
    input: { projectId: string; version: number; kind: 'V0' | 'REVISION'; basis: 'BASELINE' | 'PLANNED'; totalInvestmentVnd: string; lines: ReturnType<typeof deriveBaselineLines>['lines']; revisionId: string | null; actor: string },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.project_baseline (tenant_id, id, project_id, version, kind, basis, total_investment_vnd, bac_vnd, planned_start, planned_finish, source_revision_id, taken_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4, $5, $6::numeric, $7::numeric, $8::date, $9::date, $10::uuid, $11::uuid)`,
      [id, input.projectId, input.version, input.kind, input.basis, input.totalInvestmentVnd, baselineTotal(input.lines), earliestStart(input.lines), latestFinish(input.lines), input.revisionId, input.actor],
    );
    await tx.query(
      `insert into machvon.project_baseline_line (tenant_id, id, baseline_id, project_id, component_id, code, name, bac_vnd, planned_start, planned_finish)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, x.component_id, x.code, x.name, x.bac_vnd, x.planned_start, x.planned_finish
         from jsonb_to_recordset($3::jsonb) as x(component_id uuid, code text, name text, bac_vnd numeric, planned_start date, planned_finish date)`,
      [id, input.projectId, JSON.stringify(input.lines.map((line) => ({ component_id: line.componentId, code: line.code, name: line.name, bac_vnd: line.bacVnd, planned_start: line.plannedStart, planned_finish: line.plannedFinish })))],
    );
    return id;
  }

  /** The next version after an approved revision, from the planned days of the milestones and the values of the components as they are now; skipped, with the components named, when they cannot be derived. */
  private async addVersion(tx: TenantTx, projectId: string, revisionId: string, actor: string, effects: GovernanceEffects): Promise<void> {
    const [last] = await tx.query<{ version: number }>('select max(version) as version from machvon.project_baseline where project_id = $1::uuid', [projectId]);
    if (last === undefined || last.version === null) return;
    const facts = await loadProjectFacts(tx, projectId);
    const draft = deriveBaselineLines({ components: facts.components, milestones: facts.milestones, basis: 'PLANNED', projectFinish: projectFinishOf(facts.endYear) });
    if (draft.lines.length === 0 || draft.issues.length > 0) {
      effects.baselineSkipped = draft.issues.map((issue) => issue.componentCode);
      return;
    }
    const version = last.version + 1;
    const id = await this.insertVersion(tx, { projectId, version, kind: 'REVISION', basis: 'PLANNED', totalInvestmentVnd: facts.totalInvestmentVnd, lines: draft.lines, revisionId, actor });
    effects.baselineVersion = { id, version };
  }

  private async insertEvent(tx: TenantTx, input: { projectId: string; source: 'MILESTONE' | 'REVISION'; milestoneId: string | null; revisionId: string | null; fromDate: string; toDate: string; reason: string; actor: string }): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.project_reschedule_event (tenant_id, id, project_id, source, milestone_id, revision_id, from_date, to_date, reason, recorded_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::date, $7::date, $8, $9::uuid)`,
      [id, input.projectId, input.source, input.milestoneId, input.revisionId, input.fromDate, input.toDate, input.reason.trim().slice(0, 2000) || 'moved', input.actor],
    );
    return id;
  }

  private async eventsOf(tx: TenantTx, projectId: string): Promise<Array<Omit<RescheduleEventView, 'milestoneCode'>>> {
    const rows = await tx.query<{ id: string; source: 'MILESTONE' | 'REVISION'; milestone_id: string | null; revision_id: string | null; from_date: string; to_date: string; reason: string; recorded_by: string; recorded_at: string }>(
      `select id, source, milestone_id, revision_id, from_date::text as from_date, to_date::text as to_date, reason, recorded_by, ${UTC('recorded_at')} as recorded_at
         from machvon.project_reschedule_event where project_id = $1::uuid order by recorded_at, id`,
      [projectId],
    );
    return rows.map((row) => ({ id: row.id, source: row.source, milestoneId: row.milestone_id, revisionId: row.revision_id, fromDate: row.from_date, toDate: row.to_date, reason: row.reason, recordedBy: row.recorded_by, recordedAt: row.recorded_at }));
  }

  /** Raises one alert to AUD for each subject whose date was moved as many times as the rule says (or updates the count of the one that is open). */
  private async countMoves(tx: TenantTx, projectId: string, actor: string, today: string, effects: GovernanceEffects): Promise<void> {
    const events = await this.eventsOf(tx, projectId);
    const counts = rescheduleCount(events.map((event) => ({ source: event.source, milestoneId: event.milestoneId })));
    const policy = await b1PolicyOf(this.policy, tx, 'BASELINE_DEVIATION', today);
    const subjects: Array<{ kind: 'MILESTONE' | 'PROJECT'; id: string | null; moves: number }> = [
      ...[...counts.perMilestone.entries()].map(([id, moves]) => ({ kind: 'MILESTONE' as const, id, moves })),
      { kind: 'PROJECT' as const, id: null, moves: counts.projectMoves },
    ];
    for (const subject of subjects) {
      if (!rescheduleNeedsAlert(subject.moves, policy.params)) continue;
      const [open] = await tx.query<{ id: string }>(
        `select id from machvon.project_governance_alert where project_id = $1::uuid and alert_type = 'RESCHEDULE_COUNT' and subject_kind = $2 and subject_id is not distinct from $3::uuid and status = 'OPEN'`,
        [projectId, subject.kind, subject.id],
      );
      if (open !== undefined) {
        await tx.query('update machvon.project_governance_alert set move_count = $2, threshold = $3, rule_version = $4, version = version + 1 where id = $1::uuid', [open.id, subject.moves, policy.params.rescheduleAlertCount, policy.version]);
        continue;
      }
      const id = randomUUID();
      await tx.query(
        `insert into machvon.project_governance_alert (tenant_id, id, project_id, alert_type, audience, subject_kind, subject_id, move_count, threshold, rule_version, raised_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, 'RESCHEDULE_COUNT', 'AUD', $3, $4::uuid, $5::int, $6::int, $7, $8::uuid)`,
        [id, projectId, subject.kind, subject.id, subject.moves, policy.params.rescheduleAlertCount, policy.version, actor],
      );
      effects.alertsRaised.push({ id, subjectKind: subject.kind, subjectId: subject.id, moveCount: subject.moves, threshold: policy.params.rescheduleAlertCount, ruleVersion: policy.version });
    }
  }

  /**
   * Looks at the deviation from version 0 and opens the one request to appraise again when it is over a threshold. A request that was decided is not asked again for a deviation that is no worse than the one
   * it was decided on: only a deviation that grew opens a new one.
   */
  private async evaluate(tx: TenantTx, project: { id: string }, actor: string, trigger: 'REVISION' | 'MILESTONE', today: string, effects: GovernanceEffects): Promise<void> {
    const [v0] = await tx.query<BaselineSql>(`select ${BASELINE_COLUMNS} from machvon.project_baseline b where b.project_id = $1::uuid and b.version = 0`, [project.id]);
    if (v0 === undefined) return;
    const facts = await loadProjectFacts(tx, project.id);
    const events = await this.eventsOf(tx, project.id);
    const counts = rescheduleCount(events.map((event) => ({ source: event.source, milestoneId: event.milestoneId })));
    const deviation = baselineDeviation({
      v0: { totalInvestmentVnd: v0.total_investment_vnd, bacVnd: v0.bac_vnd, plannedStart: v0.planned_start, plannedFinish: v0.planned_finish },
      currentTotalInvestmentVnd: facts.totalInvestmentVnd,
      currentBacVnd: firstLevelTotal(facts.components),
      milestones: facts.milestones.map((milestone) => ({ ...milestone, moves: counts.perMilestone.get(milestone.id) ?? 0 })),
    });
    const policy = await b1PolicyOf(this.policy, tx, 'BASELINE_DEVIATION', today);
    const reasons = reappraisalReasons(deviation, policy.params);
    if (reasons.length === 0) return;
    const [open] = await tx.query<{ id: string }>("select id from machvon.project_reappraisal_request where project_id = $1::uuid and status = 'OPEN'", [project.id]);
    if (open !== undefined) return;
    const [last] = await tx.query<{ cost_pct: string | null; finish_slip_days: number | null }>(
      'select cost_pct::text as cost_pct, finish_slip_days from machvon.project_reappraisal_request where project_id = $1::uuid order by requested_at desc, id desc limit 1',
      [project.id],
    );
    if (last !== undefined && !worse(deviation, last)) return;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.project_reappraisal_request (tenant_id, id, project_id, baseline_id, reasons, cost_pct, finish_slip_days, threshold_cost_pct, threshold_slip_days, rule_version, triggered_by, requested_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::text[], $5::numeric, $6::int, $7::numeric, $8::int, $9, $10, $11::uuid)`,
      [id, project.id, v0.id, reasons, deviation.costPct, deviation.finishSlipDays, policy.params.costPct, policy.params.slipDays, policy.version, trigger, actor],
    );
    effects.reappraisalOpened = { id, reasons, costPct: deviation.costPct, finishSlipDays: deviation.finishSlipDays, ruleVersion: policy.version };
  }

  private async versionsOf(tx: TenantTx, projectId: string): Promise<BaselineVersionView[]> {
    const rows = await tx.query<BaselineSql>(`select ${BASELINE_COLUMNS} from machvon.project_baseline b where b.project_id = $1::uuid order by b.version`, [projectId]);
    if (rows.length === 0) return [];
    const lines = await tx.query<LineSql>(
      `select l.baseline_id, l.component_id, l.code, l.name, l.bac_vnd::text as bac_vnd, l.planned_start::text as planned_start, l.planned_finish::text as planned_finish
         from machvon.project_baseline_line l where l.project_id = $1::uuid order by l.code`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      kind: row.kind,
      basis: row.basis,
      totalInvestmentVnd: row.total_investment_vnd,
      bacVnd: row.bac_vnd,
      plannedStart: row.planned_start,
      plannedFinish: row.planned_finish,
      sourceRevisionId: row.source_revision_id,
      takenBy: row.taken_by,
      takenAt: row.taken_at,
      lines: lines.filter((line) => line.baseline_id === row.id).map((line) => ({ componentId: line.component_id, code: line.code, name: line.name, bacVnd: line.bac_vnd, plannedStart: line.planned_start, plannedFinish: line.planned_finish })),
    }));
  }

  private async alertsOf(tx: TenantTx, projectId: string): Promise<GovernanceAlertView[]> {
    const rows = await tx.query<AlertSql>(`${ALERT_SELECT} where a.project_id = $1::uuid order by a.raised_at desc, a.id`, [projectId]);
    return rows.map(alertOf);
  }

  private async reappraisalsOf(tx: TenantTx, projectId: string): Promise<ReappraisalView[]> {
    const rows = await tx.query<{
      id: string;
      baseline_id: string;
      status: ReappraisalView['status'];
      reasons: ReappraisalReason[];
      cost_pct: string | null;
      finish_slip_days: number | null;
      threshold_cost_pct: string;
      threshold_slip_days: number;
      rule_version: string;
      triggered_by: ReappraisalView['triggeredBy'];
      requested_by: string;
      requested_at: string;
      decided_by: string | null;
      decided_at: string | null;
      decision_reason: string | null;
      version: string;
    }>(
      `select id, baseline_id, status, reasons, cost_pct::text as cost_pct, finish_slip_days, threshold_cost_pct::text as threshold_cost_pct, threshold_slip_days, rule_version, triggered_by, requested_by,
              ${UTC('requested_at')} as requested_at, decided_by, ${UTC('decided_at')} as decided_at, decision_reason, version::text as version
         from machvon.project_reappraisal_request where project_id = $1::uuid order by requested_at desc, id`,
      [projectId],
    );
    return rows.map((row) => ({
      id: row.id,
      baselineId: row.baseline_id,
      status: row.status,
      reasons: row.reasons,
      costPct: row.cost_pct,
      finishSlipDays: row.finish_slip_days,
      thresholdCostPct: row.threshold_cost_pct,
      thresholdSlipDays: row.threshold_slip_days,
      ruleVersion: row.rule_version,
      triggeredBy: row.triggered_by,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      decisionReason: row.decision_reason,
      version: Number(row.version),
    }));
  }
}

interface AlertSql {
  id: string;
  project_id: string;
  project_code: string;
  alert_type: 'RESCHEDULE_COUNT';
  audience: 'AUD';
  subject_kind: 'MILESTONE' | 'PROJECT';
  subject_id: string | null;
  subject_code: string | null;
  move_count: number;
  threshold: number;
  rule_version: string;
  status: 'OPEN' | 'ACKNOWLEDGED';
  raised_by: string;
  raised_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  acknowledge_note: string | null;
  version: string;
}

const ALERT_SELECT = `select a.id, a.project_id, p.code as project_code, a.alert_type, a.audience, a.subject_kind, a.subject_id, m.code as subject_code, a.move_count, a.threshold, a.rule_version, a.status, a.raised_by,
       ${UTC('a.raised_at')} as raised_at, a.acknowledged_by, ${UTC('a.acknowledged_at')} as acknowledged_at, a.acknowledge_note, a.version::text as version
  from machvon.project_governance_alert a
  join machvon.project p on p.tenant_id = a.tenant_id and p.id = a.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
  left join machvon.project_milestone m on m.tenant_id = a.tenant_id and m.id = a.subject_id`;

const alertOf = (row: AlertSql): GovernanceAlertView => ({
  id: row.id,
  projectId: row.project_id,
  projectCode: row.project_code,
  alertType: row.alert_type,
  audience: row.audience,
  subjectKind: row.subject_kind,
  subjectId: row.subject_id,
  subjectCode: row.subject_code,
  moveCount: row.move_count,
  threshold: row.threshold,
  ruleVersion: row.rule_version,
  status: row.status,
  raisedBy: row.raised_by,
  raisedAt: row.raised_at,
  acknowledgedBy: row.acknowledged_by,
  acknowledgedAt: row.acknowledged_at,
  acknowledgeNote: row.acknowledge_note,
  version: Number(row.version),
});

/** The planned value of the first-level components that are still in force, added up. */
export function firstLevelTotal(components: readonly ComponentFact[]): string {
  return components.filter((component) => component.parentId === null && component.validUntil === null).reduce((sum, component) => sum + BigInt(component.plannedValueVnd), 0n).toString();
}

/** Whether a deviation is worse than the one a request was made on: the investment total moved further, or the finish slipped further. */
function worse(deviation: Pick<Deviation, 'costPct' | 'finishSlipDays'>, previous: { cost_pct: string | null; finish_slip_days: number | null }): boolean {
  const abs = (value: bigint): bigint => (value < 0n ? -value : value);
  const costNow = deviation.costPct === null ? 0n : abs(scaledOf(deviation.costPct));
  const costThen = previous.cost_pct === null ? 0n : abs(scaledOf(previous.cost_pct));
  const slipNow = deviation.finishSlipDays ?? 0;
  const slipThen = previous.finish_slip_days ?? 0;
  return costNow > costThen || slipNow > slipThen;
}
