import { DomainError, EFFECT_CALENDAR_RULE_TYPE, EFFECT_POLICY_RULE_CODE, EFFECT_POLICY_RULE_TYPE, EFFECT_PROJECT_GROUPS, assertAssessment, assertAssessmentDecider, assertAssessmentDecision, assertBasis, assertFixer, assertIndicators, assertMeasurement, assertProjectStatus, assertReason, asUuid, calendarRuleCode, calendarState, computeVariance, daysLate, deriveCalendar, microText, parseCalendarRule, parseEffectPolicy, suggestConclusion, toMicro, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { AnchorDays, CalendarState, EffectAnchor, EffectAssessmentKind, EffectBand, EffectConclusion, EffectDirection, EffectEvaluationKind, EffectPolicy, EffectProjectGroup, Variance } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { idOf } from './prj-accountability-support.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ProjectClassification } from './prj-project-store.ts';
import { lockProject, usableDocumentId } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The post-investment effectiveness of a project (MR-1, MR.03 merged with G4-7): the target indicators drafted by one person and fixed by another when the investment is approved, the actual values measured after the
 * commissioning (append-only; a correction is a later row), the variance between them computed by the kernel, the calendar of evaluations of Articles 76 and 77 (a rule flagged not verified) and the assessment record
 * decided by someone other than the one who submitted it. Every command locks the project in the scope of its own permission (a project the caller can read but not act on is 403 `SCOPE_DENIED`, one out of sight is 404);
 * every threshold and every month comes from a governance rule.
 */

export const EFFECT_TARGET_RESOURCE = 'effect_target_set';
export const EFFECT_MEASUREMENT_RESOURCE = 'effect_measurement';
export const EFFECT_ASSESSMENT_RESOURCE = 'effect_assessment';
export const EFFECT_CALENDAR_RESOURCE = 'effect_calendar_entry';
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const TZ = "'Asia/Ho_Chi_Minh'";
const TS = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const HISTORY_LIMIT = 60;
const ASSESSMENT_LIMIT = 30;

export interface PolicyView {
  policy: EffectPolicy;
  version: string;
  unverified: boolean;
  formula: string | null;
  source: string | null;
  asOf: string | null;
}

export interface SetChange {
  id: string;
  projectId: string;
  projectCode: string;
  classification: ProjectClassification;
  versionNo: number;
  status: 'DRAFT' | 'FIXED' | 'SUPERSEDED';
  rowVersion: number;
  indicatorCount: number;
  supersededId: string | null;
}

export interface MeasurementChange {
  id: string;
  projectId: string;
  projectCode: string;
  classification: ProjectClassification;
  indicatorCode: string;
  measuredOn: string;
  value: string;
  correctsId: string | null;
}

export interface AssessmentChange {
  id: string;
  projectId: string;
  projectCode: string;
  classification: ProjectClassification;
  kind: EffectAssessmentKind;
  status: 'SUBMITTED' | 'APPROVED' | 'RETURNED';
  conclusion: EffectConclusion;
  rowVersion: number;
  calendarEntryId: string | null;
  closedCalendar: boolean;
}

export interface CalendarChange {
  projectId: string;
  projectCode: string;
  classification: ProjectClassification;
  created: Array<{ id: string; kind: EffectEvaluationKind; dueOn: string; anchor: EffectAnchor; anchorOn: string }>;
  waiting: Array<{ kind: EffectEvaluationKind; anchor: EffectAnchor }>;
  existing: EffectEvaluationKind[];
  ruleCode: string;
  ruleVersion: string;
  ruleUnverified: boolean;
}

export interface IndicatorLine {
  id: string;
  code: string;
  name: string;
  unit: string;
  direction: EffectDirection;
  baselineValue: string | null;
  baselineOn: string | null;
  targetValue: string;
  measureAfterMonths: number | null;
  dataSource: string;
  formula: string;
  actual: { measurementId: string; value: string; measuredOn: string; methodNote: string; evidenceDocumentId: string | null; recordedAt: string } | null;
  variance: Variance;
}

export interface TargetSetView {
  id: string;
  versionNo: number;
  status: 'DRAFT' | 'FIXED' | 'SUPERSEDED';
  basis: string;
  basisDocumentId: string | null;
  supersedesId: string | null;
  supersedeReason: string | null;
  draftedBy: { membershipId: string; displayName: string | null };
  draftedAt: string;
  fixedBy: { membershipId: string; displayName: string | null } | null;
  fixedAt: string | null;
  fixedOn: string | null;
  rowVersion: number;
  indicators: IndicatorLine[];
}

export interface MeasurementRow {
  id: string;
  indicatorCode: string;
  measuredOn: string;
  value: string;
  methodNote: string;
  evidenceDocumentId: string | null;
  correctsId: string | null;
  correctionReason: string | null;
  corrected: boolean;
  recordedBy: { membershipId: string; displayName: string | null };
  recordedAt: string;
}

export interface CalendarRow {
  id: string;
  kind: EffectEvaluationKind;
  anchor: EffectAnchor;
  anchorOn: string;
  months: number;
  dueOn: string;
  required: boolean;
  status: 'PLANNED' | 'DONE';
  state: CalendarState;
  daysLate: number;
  assessmentId: string | null;
  ruleCode: string;
  ruleVersion: string;
  ruleUnverified: boolean;
}

export interface AssessmentRow {
  id: string;
  kind: EffectAssessmentKind;
  status: 'SUBMITTED' | 'APPROVED' | 'RETURNED';
  asOf: string;
  conclusion: EffectConclusion;
  summary: string;
  lines: unknown[];
  policyVersion: string;
  policyUnverified: boolean;
  calendarEntryId: string | null;
  submittedBy: { membershipId: string; displayName: string | null };
  submittedAt: string;
  decidedBy: { membershipId: string; displayName: string | null } | null;
  decidedAt: string | null;
  decisionReason: string | null;
  rowVersion: number;
}

export interface EffectivenessView {
  project: { id: string; code: string; name: string; status: string; projectGroup: string | null };
  policy: PolicyView;
  fixed: TargetSetView | null;
  draft: TargetSetView | null;
  superseded: Array<{ id: string; versionNo: number; fixedOn: string | null }>;
  measurements: MeasurementRow[];
  calendar: CalendarRow[];
  assessments: AssessmentRow[];
  /** What the screen may offer to this reader: the server decides (the commands judge again). */
  suggestedConclusion: EffectConclusion | null;
  asOf: string;
}

interface SetSql {
  id: string;
  project_id: string;
  version_no: number;
  status: 'DRAFT' | 'FIXED' | 'SUPERSEDED';
  basis: string;
  basis_document_id: string | null;
  supersedes_id: string | null;
  supersede_reason: string | null;
  drafted_by: string;
  drafted_name: string | null;
  drafted_at: string;
  fixed_by: string | null;
  fixed_name: string | null;
  fixed_at: string | null;
  fixed_on: string | null;
  row_version: string;
}

const SET_SELECT = `select s.id, s.project_id, s.version_no, s.status, s.basis, s.basis_document_id, s.supersedes_id, s.supersede_reason, s.drafted_by, dd.display_name as drafted_name, ${TS('s.drafted_at')} as drafted_at,
    s.fixed_by, fd.display_name as fixed_name, ${TS('s.fixed_at')} as fixed_at, s.fixed_on::text as fixed_on, s.row_version::text as row_version
  from machvon.effect_target_set s
  left join machvon.tenant_user_directory dd on dd.tenant_id = s.tenant_id and dd.membership_id = s.drafted_by
  left join machvon.tenant_user_directory fd on fd.tenant_id = s.tenant_id and fd.membership_id = s.fixed_by`;

interface IndicatorSql {
  id: string;
  target_set_id: string;
  code: string;
  name: string;
  unit: string;
  direction: EffectDirection;
  baseline_value: string | null;
  baseline_on: string | null;
  target_value: string;
  measure_after_months: number | null;
  data_source: string;
  formula: string;
}

const INDICATOR_COLUMNS = `i.id, i.target_set_id, i.code, i.name, i.unit, i.direction, i.baseline_value::text as baseline_value, i.baseline_on::text as baseline_on, i.target_value::text as target_value, i.measure_after_months, i.data_source, i.formula`;

/** A numeric(24,6) as the shortest decimal text (`1500000.500000` is `1500000.5`), so the same number is written the same way by every channel. */
const decimalText = (value: string): string => microText(toMicro(value, 'value'));

interface LatestSql {
  id: string;
  indicator_code: string;
  measured_on: string;
  value: string;
  method_note: string;
  evidence_document_id: string | null;
  recorded_at: string;
}

export class EffectStore {
  private readonly policies = new GovernancePolicyPort();

  // ---- the rules ---------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The policy in force on the day (a rule the tenant approved, else the starting value flagged not verified). */
  async policyOf(tx: TenantTx, today: string): Promise<PolicyView> {
    const found = await this.policies.require(tx, EFFECT_POLICY_RULE_TYPE, EFFECT_POLICY_RULE_CODE, today);
    return {
      policy: parseEffectPolicy(found.params),
      version: found.source === 'DEFAULT' ? 'built-in:1' : String(found.version),
      unverified: found.unverified,
      formula: found.provenance?.formula ?? null,
      source: found.provenance?.source ?? null,
      asOf: found.provenance?.asOf ?? null,
    };
  }

  // ---- the targets -------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Writes the draft of the target indicators of a project (a new draft, or the whole list of the draft that its author wrote before). While a set stands FIXED a new draft has to say which set it replaces and why
   * (`supersede_reason`); only its author rewrites a draft (409 `EFFECT_TARGET_STATE_INVALID` otherwise).
   */
  async saveDraft(tx: TenantTx, request: { projectId: string; body: Record<string, unknown>; actor: string; scopes: StageScopes; now: Date }): Promise<SetChange> {
    const project = await lockProject(tx, idOf(request.projectId, 'id'), request.scopes);
    const today = vietnamDateOf(request.now);
    const { policy } = await this.policyOf(tx, today);
    assertProjectStatus(project.status, policy.draftStatuses);
    const basis = assertBasis(request.body.basis);
    const indicators = assertIndicators(request.body.indicators);
    const basisDocument = request.body.basis_document_id === undefined || request.body.basis_document_id === null ? null : await usableDocumentId(tx, String(request.body.basis_document_id), 'basis_document_id');
    const sets = await tx.query<{ id: string; status: string; drafted_by: string; row_version: string; version_no: number }>('select id, status, drafted_by, row_version::text as row_version, version_no from machvon.effect_target_set where project_id = $1::uuid order by version_no desc for update', [project.id]);
    const fixed = sets.find((one) => one.status === 'FIXED');
    const draft = sets.find((one) => one.status === 'DRAFT');
    let setId: string;
    let rowVersion: number;
    let versionNo: number;
    if (draft !== undefined) {
      if (draft.drafted_by.toLowerCase() !== request.actor.toLowerCase()) throw new DomainError('EFFECT_TARGET_STATE_INVALID', 409, 'status', { extensions: { status: 'DRAFT', reason: 'NOT_THE_AUTHOR' } });
      const reason = fixed === undefined ? null : assertReason(request.body.supersede_reason, 'supersede_reason');
      await tx.query('delete from machvon.effect_indicator where target_set_id = $1::uuid', [draft.id]);
      const done = await tx.query<{ row_version: string }>(
        `update machvon.effect_target_set set basis = $2, basis_document_id = $3::uuid, supersede_reason = coalesce($4, supersede_reason), updated_at = now(), row_version = row_version + 1 where id = $1::uuid returning row_version::text as row_version`,
        [draft.id, basis, basisDocument, reason],
      );
      setId = draft.id;
      rowVersion = Number(done[0]?.row_version ?? 0);
      versionNo = draft.version_no;
    } else {
      const reason = fixed === undefined ? null : assertReason(request.body.supersede_reason, 'supersede_reason');
      versionNo = (sets[0]?.version_no ?? 0) + 1;
      const made = await tx.query<{ id: string }>(
        `insert into machvon.effect_target_set (tenant_id, project_id, version_no, status, basis, basis_document_id, supersedes_id, supersede_reason, drafted_by)
         values (${TENANT}, $1::uuid, $2, 'DRAFT', $3, $4::uuid, $5::uuid, $6, $7::uuid) returning id`,
        [project.id, versionNo, basis, basisDocument, fixed?.id ?? null, reason, request.actor],
      );
      setId = made[0]?.id ?? '';
      rowVersion = 1;
    }
    let order = 0;
    for (const one of indicators) {
      order += 1;
      await tx.query(
        `insert into machvon.effect_indicator (tenant_id, target_set_id, project_id, code, name, unit, direction, baseline_value, baseline_on, target_value, measure_after_months, data_source, formula, sort_order)
         values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5, $6, $7::numeric, $8::date, $9::numeric, $10, $11, $12, $13)`,
        [setId, project.id, one.code, one.name, one.unit, one.direction, one.baselineValue, one.baselineOn, one.targetValue, one.measureAfterMonths, one.dataSource, one.formula, order],
      );
    }
    return { id: setId, projectId: project.id, projectCode: project.code, classification: project.classification, versionNo, status: 'DRAFT', rowVersion, indicatorCount: indicators.length, supersededId: null };
  }

  /** Fixes a draft by someone other than its author: the targets the investment was approved on. The set it replaced, if any, becomes SUPERSEDED. */
  async fix(tx: TenantTx, request: { setId: string; expectedVersion: number; actor: string; scopes: StageScopes; now: Date }): Promise<SetChange> {
    const setId = idOf(request.setId, 'id');
    const found = await tx.query<{ project_id: string }>('select project_id from machvon.effect_target_set where id = $1::uuid', [setId]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, found[0].project_id, request.scopes);
    const rows = await tx.query<{ id: string; status: string; drafted_by: string; row_version: string; version_no: number; supersedes_id: string | null }>(
      'select id, status, drafted_by, row_version::text as row_version, version_no, supersedes_id from machvon.effect_target_set where id = $1::uuid for update',
      [setId],
    );
    const held = rows[0];
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(held.row_version) !== request.expectedVersion) throw versionConflict(Number(held.row_version));
    if (held.status !== 'DRAFT') throw new DomainError('EFFECT_TARGET_STATE_INVALID', 409, 'status', { extensions: { status: held.status } });
    const today = vietnamDateOf(request.now);
    const { policy } = await this.policyOf(tx, today);
    assertProjectStatus(project.status, policy.fixStatuses);
    assertFixer(request.actor, held.drafted_by);
    const count = await tx.query<{ count: string }>('select count(*)::text as count from machvon.effect_indicator where target_set_id = $1::uuid', [setId]);
    if (Number(count[0]?.count ?? 0) < 1) throw new DomainError('VALIDATION_FAILED', 422, 'indicators');
    if (held.supersedes_id !== null) await tx.query(`update machvon.effect_target_set set status = 'SUPERSEDED', updated_at = now(), row_version = row_version + 1 where id = $1::uuid and status = 'FIXED'`, [held.supersedes_id]);
    const done = await tx.query<{ row_version: string }>(
      `update machvon.effect_target_set set status = 'FIXED', fixed_by = $2::uuid, fixed_at = now(), fixed_on = $3::date, updated_at = now(), row_version = row_version + 1 where id = $1::uuid returning row_version::text as row_version`,
      [setId, request.actor, today],
    );
    return { id: setId, projectId: project.id, projectCode: project.code, classification: project.classification, versionNo: held.version_no, status: 'FIXED', rowVersion: Number(done[0]?.row_version ?? 0), indicatorCount: Number(count[0]?.count ?? 0), supersededId: held.supersedes_id };
  }

  // ---- the measurements --------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Records the actual value of an indicator of the targets that stand FIXED, on a day, after the commissioning. A second measurement of the same indicator on the same day is not written (409
   * `EFFECT_MEASUREMENT_DUPLICATE`): a wrong one is corrected by a later row that names it and says why.
   */
  async measure(tx: TenantTx, request: { projectId: string; body: Record<string, unknown>; actor: string; scopes: StageScopes; now: Date }): Promise<MeasurementChange> {
    const project = await lockProject(tx, idOf(request.projectId, 'id'), request.scopes);
    const today = vietnamDateOf(request.now);
    const { policy } = await this.policyOf(tx, today);
    assertProjectStatus(project.status, policy.measureStatuses);
    const input = assertMeasurement(request.body, today, asUuid);
    const fixed = await this.fixedSetOf(tx, project.id);
    if (fixed === undefined) throw new DomainError('EFFECT_TARGETS_NOT_FIXED', 409, 'project_id');
    const indicator = await tx.query<{ id: string }>('select id from machvon.effect_indicator where target_set_id = $1::uuid and code = $2', [fixed, input.indicatorCode]);
    if (indicator[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'indicator_code');
    if (input.correctsId !== null) {
      const target = await tx.query<{ id: string }>('select id from machvon.effect_measurement where id = $1::uuid and project_id = $2::uuid and indicator_code = $3', [input.correctsId, project.id, input.indicatorCode]);
      if (target[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'corrects_id');
    }
    const evidence = input.evidenceDocumentId === null ? null : await usableDocumentId(tx, input.evidenceDocumentId, 'evidence_document_id');
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.effect_measurement (tenant_id, project_id, target_set_id, indicator_code, measured_on, value, method_note, evidence_document_id, corrects_id, correction_reason, recorded_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4::date, $5::numeric, $6, $7::uuid, $8::uuid, $9, $10::uuid) on conflict do nothing returning id`,
      [project.id, fixed, input.indicatorCode, input.measuredOn, input.value, input.methodNote, evidence, input.correctsId, input.correctionReason, request.actor],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('EFFECT_MEASUREMENT_DUPLICATE', 409, input.correctsId === null ? 'measured_on' : 'corrects_id');
    return { id: row.id, projectId: project.id, projectCode: project.code, classification: project.classification, indicatorCode: input.indicatorCode, measuredOn: input.measuredOn, value: decimalText(input.value), correctsId: input.correctsId };
  }

  private async fixedSetOf(tx: TenantTx, projectId: string): Promise<string | undefined> {
    const rows = await tx.query<{ id: string }>(`select id from machvon.effect_target_set where project_id = $1::uuid and status = 'FIXED'`, [projectId]);
    return rows[0]?.id;
  }

  // ---- the calendar ------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The days the anchors of the calendar fell on for a project: the stage history (the first move into IMPLEMENTATION and into COMPLETED) and the earliest accepted handover. */
  async anchorsOf(tx: TenantTx, projectId: string): Promise<AnchorDays> {
    const stages = await tx.query<{ to_stage: string; day: string }>(
      `select to_stage, min(coalesce(effective_date, (occurred_at at time zone ${TZ})::date))::text as day from machvon.project_stage_change where project_id = $1::uuid and to_stage in ('IMPLEMENTATION', 'COMPLETED') group by to_stage`,
      [projectId],
    );
    const handover = await tx.query<{ day: string | null }>(`select min((accepted_at at time zone ${TZ})::date)::text as day from machvon.handover where project_id = $1::uuid and status = 'ACCEPTED' and accepted_at is not null`, [projectId]);
    const anchors: AnchorDays = {};
    for (const row of stages) {
      if (row.to_stage === 'IMPLEMENTATION') anchors.IMPLEMENTATION_START = { on: row.day, source: 'STAGE_HISTORY' };
      if (row.to_stage === 'COMPLETED') anchors.COMPLETION = { on: row.day, source: 'STAGE_HISTORY' };
    }
    const accepted = handover[0]?.day ?? null;
    if (accepted !== null) anchors.HANDOVER = { on: accepted, source: 'HANDOVER_ACCEPTANCE' };
    return anchors;
  }

  /** The calendar rule of the group of a project in force on the day, with the version that decided. */
  async calendarRuleOf(tx: TenantTx, group: EffectProjectGroup, today: string): Promise<{ rule: ReturnType<typeof parseCalendarRule>; code: string; version: string; unverified: boolean }> {
    const code = calendarRuleCode(group);
    const found = await this.policies.require(tx, EFFECT_CALENDAR_RULE_TYPE, code, today);
    return { rule: parseCalendarRule(found.params), code, version: found.source === 'DEFAULT' ? 'built-in:1' : String(found.version), unverified: found.unverified };
  }

  /**
   * Makes the entries of the calendar of evaluations for a project from the rule of its group and the days the anchors fell on: an entry is made once (a second call makes none that exists), and one whose anchor day is
   * not known yet is returned as waiting. A project that has no group yet has no calendar (422 `VALIDATION_FAILED` on `project_group`).
   */
  async generateCalendar(tx: TenantTx, request: { projectId: string; actor: string; scopes: StageScopes; now: Date }): Promise<CalendarChange> {
    const project = await lockProject(tx, idOf(request.projectId, 'id'), request.scopes);
    const group = EFFECT_PROJECT_GROUPS.find((candidate) => candidate === project.projectGroup);
    if (group === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_group');
    const today = vietnamDateOf(request.now);
    const resolved = await this.calendarRuleOf(tx, group, today);
    const anchors = await this.anchorsOf(tx, project.id);
    const held = await tx.query<{ kind: EffectEvaluationKind }>('select kind from machvon.effect_calendar_entry where project_id = $1::uuid', [project.id]);
    const derived = deriveCalendar(resolved.rule, anchors, new Set(held.map((row) => row.kind)));
    const created: CalendarChange['created'] = [];
    for (const entry of derived.entries) {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.effect_calendar_entry (tenant_id, project_id, kind, anchor, anchor_on, anchor_source, months, due_on, required, rule_code, rule_version, rule_unverified, created_by)
         values (${TENANT}, $1::uuid, $2, $3, $4::date, $5, $6, $7::date, $8, $9, $10, $11, $12::uuid) on conflict do nothing returning id`,
        [project.id, entry.kind, entry.anchor, entry.anchorOn, entry.anchorSource, entry.months, entry.dueOn, entry.required, resolved.code, resolved.version, resolved.unverified, request.actor],
      );
      if (rows[0] !== undefined) {
        created.push({ id: rows[0].id, kind: entry.kind, dueOn: entry.dueOn, anchor: entry.anchor, anchorOn: entry.anchorOn });
        await this.reconcile(tx, project.id, rows[0].id, entry.kind);
      }
    }
    return { projectId: project.id, projectCode: project.code, classification: project.classification, created, waiting: derived.waiting, existing: held.map((row) => row.kind), ruleCode: resolved.code, ruleVersion: resolved.version, ruleUnverified: resolved.unverified };
  }

  /**
   * An assessment of a kind may have been submitted or approved before the calendar was generated: the new entry takes it up, so that nothing stays outstanding that was answered. A submitted one is linked (its approval
   * will close the entry); an approved one closes the entry now.
   */
  private async reconcile(tx: TenantTx, projectId: string, entryId: string, kind: EffectEvaluationKind): Promise<void> {
    const approved = await tx.query<{ id: string }>(`select id from machvon.effect_assessment where project_id = $1::uuid and kind = $2 and status = 'APPROVED' order by submitted_at desc limit 1`, [projectId, kind]);
    if (approved[0] !== undefined) {
      await tx.query(`update machvon.effect_calendar_entry set status = 'DONE', assessment_id = $2::uuid, closed_at = now(), row_version = row_version + 1 where id = $1::uuid and status = 'PLANNED'`, [entryId, approved[0].id]);
      return;
    }
    await tx.query(`update machvon.effect_assessment set calendar_entry_id = $2::uuid where project_id = $1::uuid and kind = $3 and status = 'SUBMITTED' and calendar_entry_id is null`, [projectId, entryId, kind]);
  }

  // ---- the assessments ---------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The lines of the targets that stand FIXED with the latest measurement of each indicator, as they are on the day: what an assessment freezes and what the screen shows. */
  private async linesOf(tx: TenantTx, setId: string, projectId: string, policy: EffectPolicy): Promise<IndicatorLine[]> {
    const indicators = await tx.query<IndicatorSql>(`select ${INDICATOR_COLUMNS} from machvon.effect_indicator i where i.target_set_id = $1::uuid order by i.sort_order, i.code`, [setId]);
    const latest = await tx.query<LatestSql>(
      `select distinct on (m.indicator_code) m.id, m.indicator_code, m.measured_on::text as measured_on, m.value::text as value, m.method_note, m.evidence_document_id, ${TS('m.recorded_at')} as recorded_at
         from machvon.effect_measurement m
        where m.project_id = $1::uuid and not exists (select 1 from machvon.effect_measurement c where c.tenant_id = m.tenant_id and c.corrects_id = m.id)
        order by m.indicator_code, m.measured_on desc, m.recorded_at desc`,
      [projectId],
    );
    const byCode = new Map(latest.map((row) => [row.indicator_code, row]));
    return indicators.map((row) => {
      const actual = byCode.get(row.code);
      const baseline = row.baseline_value === null ? null : decimalText(row.baseline_value);
      const target = decimalText(row.target_value);
      const value = actual === undefined ? null : decimalText(actual.value);
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        unit: row.unit,
        direction: row.direction,
        baselineValue: baseline,
        baselineOn: row.baseline_on,
        targetValue: target,
        measureAfterMonths: row.measure_after_months,
        dataSource: row.data_source,
        formula: row.formula,
        actual: actual === undefined ? null : { measurementId: actual.id, value: value ?? '', measuredOn: actual.measured_on, methodNote: actual.method_note, evidenceDocumentId: actual.evidence_document_id, recordedAt: actual.recorded_at },
        variance: computeVariance({ direction: row.direction, baselineValue: baseline, targetValue: target, actualValue: value }, policy),
      };
    });
  }

  /**
   * Submits the assessment of a kind: the variance of every indicator on the day is frozen on the record with the conclusion and the summary. The calendar entry of its kind (when there is one) is the one it will close.
   * A FINAL or an IMPACT assessment needs at least one measured indicator. A kind that has an assessment waiting for a decision, or an approved one, is not submitted again (409 `EFFECT_ASSESSMENT_STATE_INVALID`).
   */
  async submitAssessment(tx: TenantTx, request: { projectId: string; body: Record<string, unknown>; actor: string; scopes: StageScopes; now: Date }): Promise<AssessmentChange> {
    const project = await lockProject(tx, idOf(request.projectId, 'id'), request.scopes);
    const today = vietnamDateOf(request.now);
    const { policy, version, unverified } = await this.policyOf(tx, today);
    assertProjectStatus(project.status, [...policy.fixStatuses, ...policy.measureStatuses]);
    const input = assertAssessment(request.body);
    const fixed = await this.fixedSetOf(tx, project.id);
    if (fixed === undefined) throw new DomainError('EFFECT_TARGETS_NOT_FIXED', 409, 'project_id');
    if (input.kind !== 'AD_HOC') {
      const approved = await tx.query<{ id: string }>(`select id from machvon.effect_assessment where project_id = $1::uuid and kind = $2 and status = 'APPROVED'`, [project.id, input.kind]);
      if (approved[0] !== undefined) throw new DomainError('EFFECT_ASSESSMENT_STATE_INVALID', 409, 'kind', { extensions: { kind: input.kind, reason: 'ALREADY_APPROVED' } });
    }
    const lines = await this.linesOf(tx, fixed, project.id, policy);
    if ((input.kind === 'FINAL' || input.kind === 'IMPACT') && lines.every((line) => line.actual === null)) throw new DomainError('VALIDATION_FAILED', 422, 'kind', { extensions: { reason: 'NO_MEASUREMENT' } });
    const entry = input.kind === 'AD_HOC' ? [] : await tx.query<{ id: string }>(`select id from machvon.effect_calendar_entry where project_id = $1::uuid and kind = $2 and status = 'PLANNED'`, [project.id, input.kind]);
    const frozen = lines.map((line) => ({
      code: line.code,
      name: line.name,
      unit: line.unit,
      direction: line.direction,
      baseline_value: line.baselineValue,
      target_value: line.targetValue,
      actual_value: line.actual?.value ?? null,
      measured_on: line.actual?.measuredOn ?? null,
      variance_value: line.variance.varianceValue,
      variance_pct: line.variance.variancePct,
      achievement_pct: line.variance.achievementPct,
      basis: line.variance.basis,
      band: line.variance.band,
    }));
    const rows = await tx.query<{ id: string; row_version: string }>(
      `insert into machvon.effect_assessment (tenant_id, project_id, kind, target_set_id, as_of, conclusion, summary, lines, policy_version, policy_unverified, calendar_entry_id, submitted_by)
       values (${TENANT}, $1::uuid, $2, $3::uuid, $4::date, $5, $6, $7::jsonb, $8, $9, $10::uuid, $11::uuid) on conflict do nothing returning id, row_version::text as row_version`,
      [project.id, input.kind, fixed, today, input.conclusion, input.summary, JSON.stringify(frozen), version, unverified, entry[0]?.id ?? null, request.actor],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('EFFECT_ASSESSMENT_STATE_INVALID', 409, 'kind', { extensions: { kind: input.kind } });
    return { id: row.id, projectId: project.id, projectCode: project.code, classification: project.classification, kind: input.kind, status: 'SUBMITTED', conclusion: input.conclusion, rowVersion: Number(row.row_version), calendarEntryId: entry[0]?.id ?? null, closedCalendar: false };
  }

  /** Approves or returns a submitted assessment, by someone other than the one who submitted it; an approval closes the calendar entry it answered. */
  async decideAssessment(tx: TenantTx, request: { assessmentId: string; expectedVersion: number; body: Record<string, unknown>; actor: string; scopes: StageScopes }): Promise<AssessmentChange> {
    const assessmentId = idOf(request.assessmentId, 'id');
    const found = await tx.query<{ project_id: string }>('select project_id from machvon.effect_assessment where id = $1::uuid', [assessmentId]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, found[0].project_id, request.scopes);
    const rows = await tx.query<{ id: string; kind: EffectAssessmentKind; status: string; submitted_by: string; row_version: string; calendar_entry_id: string | null; conclusion: EffectConclusion }>(
      'select id, kind, status, submitted_by, row_version::text as row_version, calendar_entry_id, conclusion from machvon.effect_assessment where id = $1::uuid for update',
      [assessmentId],
    );
    const held = rows[0];
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const decision = assertAssessmentDecision(request.body);
    if (Number(held.row_version) !== request.expectedVersion) throw versionConflict(Number(held.row_version));
    if (held.status !== 'SUBMITTED') throw new DomainError('EFFECT_ASSESSMENT_STATE_INVALID', 409, 'status', { extensions: { status: held.status } });
    assertAssessmentDecider(request.actor, held.submitted_by);
    const status = decision.decision === 'APPROVE' ? 'APPROVED' : 'RETURNED';
    const done = await tx.query<{ row_version: string }>(
      `update machvon.effect_assessment set status = $2, decided_by = $3::uuid, decided_at = now(), decision_reason = $4, row_version = row_version + 1 where id = $1::uuid returning row_version::text as row_version`,
      [assessmentId, status, request.actor, decision.reason],
    );
    const version = Number(done[0]?.row_version ?? 0);
    let closed = false;
    if (status === 'APPROVED' && held.calendar_entry_id !== null) {
      const done = await tx.query<{ id: string }>(`update machvon.effect_calendar_entry set status = 'DONE', assessment_id = $2::uuid, closed_at = now(), row_version = row_version + 1 where id = $1::uuid and status = 'PLANNED' returning id`, [held.calendar_entry_id, assessmentId]);
      closed = done[0] !== undefined;
    }
    return { id: assessmentId, projectId: project.id, projectCode: project.code, classification: project.classification, kind: held.kind, status, conclusion: held.conclusion, rowVersion: version, calendarEntryId: held.calendar_entry_id, closedCalendar: closed };
  }

  // ---- the read ----------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Everything the screen of a project shows, in the scope of the caller: the targets that stand, the draft, the actuals and their variance, the calendar and the assessments. A project out of sight is not found. */
  async view(tx: TenantTx, scope: ScopeBuilder, projectId: string, now: Date): Promise<EffectivenessView & { classification: ProjectClassification }> {
    const predicate = scope(2);
    const found = await tx.query<{ id: string; code: string; name: string; status: string; project_group: string | null; classification: ProjectClassification }>(
      `select p.id, p.code, p.name, p.status, p.project_group, p.classification from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`,
      [projectId, ...predicate.params],
    );
    const project = found[0];
    if (project === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const today = vietnamDateOf(now);
    const policy = await this.policyOf(tx, today);
    const sets = await tx.query<SetSql>(`${SET_SELECT} where s.project_id = $1::uuid order by s.version_no desc`, [project.id]);
    const fixedRow = sets.find((one) => one.status === 'FIXED');
    const draftRow = sets.find((one) => one.status === 'DRAFT');
    const fixed = fixedRow === undefined ? null : await this.setViewOf(tx, fixedRow, project.id, policy.policy);
    const draft = draftRow === undefined ? null : await this.setViewOf(tx, draftRow, project.id, policy.policy);
    const measurements = await tx.query<{
      id: string;
      indicator_code: string;
      measured_on: string;
      value: string;
      method_note: string;
      evidence_document_id: string | null;
      corrects_id: string | null;
      correction_reason: string | null;
      corrected: boolean;
      recorded_by: string;
      recorded_name: string | null;
      recorded_at: string;
    }>(
      `select m.id, m.indicator_code, m.measured_on::text as measured_on, m.value::text as value, m.method_note, m.evidence_document_id, m.corrects_id, m.correction_reason,
              exists (select 1 from machvon.effect_measurement c where c.tenant_id = m.tenant_id and c.corrects_id = m.id) as corrected, m.recorded_by, d.display_name as recorded_name, ${TS('m.recorded_at')} as recorded_at
         from machvon.effect_measurement m left join machvon.tenant_user_directory d on d.tenant_id = m.tenant_id and d.membership_id = m.recorded_by
        where m.project_id = $1::uuid order by m.measured_on desc, m.recorded_at desc, m.id limit ${HISTORY_LIMIT}`,
      [project.id],
    );
    const calendar = await tx.query<{
      id: string;
      kind: EffectEvaluationKind;
      anchor: EffectAnchor;
      anchor_on: string;
      months: number;
      due_on: string;
      required: boolean;
      status: 'PLANNED' | 'DONE';
      assessment_id: string | null;
      rule_code: string;
      rule_version: string;
      rule_unverified: boolean;
    }>(
      `select id, kind, anchor, anchor_on::text as anchor_on, months, due_on::text as due_on, required, status, assessment_id, rule_code, rule_version, rule_unverified
         from machvon.effect_calendar_entry where project_id = $1::uuid order by due_on, kind`,
      [project.id],
    );
    const assessments = await tx.query<{
      id: string;
      kind: EffectAssessmentKind;
      status: 'SUBMITTED' | 'APPROVED' | 'RETURNED';
      as_of: string;
      conclusion: EffectConclusion;
      summary: string;
      lines: unknown[];
      policy_version: string;
      policy_unverified: boolean;
      calendar_entry_id: string | null;
      submitted_by: string;
      submitted_name: string | null;
      submitted_at: string;
      decided_by: string | null;
      decided_name: string | null;
      decided_at: string | null;
      decision_reason: string | null;
      row_version: string;
    }>(
      `select a.id, a.kind, a.status, a.as_of::text as as_of, a.conclusion, a.summary, a.lines, a.policy_version, a.policy_unverified, a.calendar_entry_id, a.submitted_by, sd.display_name as submitted_name,
              ${TS('a.submitted_at')} as submitted_at, a.decided_by, dd.display_name as decided_name, ${TS('a.decided_at')} as decided_at, a.decision_reason, a.row_version::text as row_version
         from machvon.effect_assessment a
         left join machvon.tenant_user_directory sd on sd.tenant_id = a.tenant_id and sd.membership_id = a.submitted_by
         left join machvon.tenant_user_directory dd on dd.tenant_id = a.tenant_id and dd.membership_id = a.decided_by
        where a.project_id = $1::uuid order by a.submitted_at desc, a.id desc limit ${ASSESSMENT_LIMIT}`,
      [project.id],
    );
    return {
      project: { id: project.id, code: project.code, name: project.name, status: project.status, projectGroup: project.project_group },
      policy,
      fixed,
      draft,
      superseded: sets.filter((one) => one.status === 'SUPERSEDED').map((one) => ({ id: one.id, versionNo: one.version_no, fixedOn: one.fixed_on })),
      measurements: measurements.map((row) => ({
        id: row.id,
        indicatorCode: row.indicator_code,
        measuredOn: row.measured_on,
        value: decimalText(row.value),
        methodNote: row.method_note,
        evidenceDocumentId: row.evidence_document_id,
        correctsId: row.corrects_id,
        correctionReason: row.correction_reason,
        corrected: row.corrected,
        recordedBy: { membershipId: row.recorded_by, displayName: row.recorded_name },
        recordedAt: row.recorded_at,
      })),
      calendar: calendar.map((row) => ({
        id: row.id,
        kind: row.kind,
        anchor: row.anchor,
        anchorOn: row.anchor_on,
        months: row.months,
        dueOn: row.due_on,
        required: row.required,
        status: row.status,
        state: calendarState({ status: row.status, dueOn: row.due_on }, today),
        daysLate: row.status === 'DONE' ? 0 : daysLate(row.due_on, today),
        assessmentId: row.assessment_id,
        ruleCode: row.rule_code,
        ruleVersion: row.rule_version,
        ruleUnverified: row.rule_unverified,
      })),
      assessments: assessments.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        asOf: row.as_of,
        conclusion: row.conclusion,
        summary: row.summary,
        lines: row.lines,
        policyVersion: row.policy_version,
        policyUnverified: row.policy_unverified,
        calendarEntryId: row.calendar_entry_id,
        submittedBy: { membershipId: row.submitted_by, displayName: row.submitted_name },
        submittedAt: row.submitted_at,
        decidedBy: row.decided_by === null ? null : { membershipId: row.decided_by, displayName: row.decided_name },
        decidedAt: row.decided_at,
        decisionReason: row.decision_reason,
        rowVersion: Number(row.row_version),
      })),
      suggestedConclusion: fixed === null ? null : suggestConclusion(fixed.indicators.map((line): EffectBand => line.variance.band)),
      asOf: today,
      classification: project.classification,
    };
  }

  private async setViewOf(tx: TenantTx, row: SetSql, projectId: string, policy: EffectPolicy): Promise<TargetSetView> {
    const base = {
      id: row.id,
      versionNo: row.version_no,
      status: row.status,
      basis: row.basis,
      basisDocumentId: row.basis_document_id,
      supersedesId: row.supersedes_id,
      supersedeReason: row.supersede_reason,
      draftedBy: { membershipId: row.drafted_by, displayName: row.drafted_name },
      draftedAt: row.drafted_at,
      fixedBy: row.fixed_by === null ? null : { membershipId: row.fixed_by, displayName: row.fixed_name },
      fixedAt: row.fixed_at,
      fixedOn: row.fixed_on,
      rowVersion: Number(row.row_version),
    };
    return { ...base, indicators: await this.linesOf(tx, row.id, projectId, policy) };
  }
}
