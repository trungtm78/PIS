import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { EFFECT_ASSESSMENT_RESOURCE, EFFECT_CALENDAR_RESOURCE, EFFECT_MEASUREMENT_RESOURCE, EFFECT_TARGET_RESOURCE, EffectStore, TenantDatabase, projectInScope, projectScope } from '@machvon/db';
import type { EffectAssessmentRow, EffectCalendarRow, EffectIndicatorLine, EffectMeasurementRow, EffectTargetSetView, EffectivenessView } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const READ_PERMISSION = PERMISSIONS.getProjectEffectiveness;
const DRAFT_PERMISSION = PERMISSIONS.saveEffectTargetDraft;
const FIX_PERMISSION = PERMISSIONS.fixEffectTargets;
const MEASURE_PERMISSION = PERMISSIONS.recordEffectMeasurement;
const CALENDAR_PERMISSION = PERMISSIONS.generateEffectCalendar;
const ASSESS_PERMISSION = PERMISSIONS.submitEffectAssessment;
const DECIDE_PERMISSION = PERMISSIONS.decideEffectAssessment;

const stages = (access: EffectiveAccess, permission: string, now: Date): { act: ReturnType<typeof projectScope>; read: ReturnType<typeof projectScope> } => ({ act: projectScope(access, permission, now), read: projectScope(access, READ_PERMISSION, now) });
const person = (who: { membershipId: string; displayName: string | null } | null): Record<string, unknown> | null => (who === null ? null : { membership_id: who.membershipId, display_name: who.displayName });

const indicatorView = (line: EffectIndicatorLine): Record<string, unknown> => ({
  id: line.id,
  code: line.code,
  name: line.name,
  unit: line.unit,
  direction: line.direction,
  baseline_value: line.baselineValue,
  baseline_on: line.baselineOn,
  target_value: line.targetValue,
  measure_after_months: line.measureAfterMonths,
  data_source: line.dataSource,
  formula: line.formula,
  actual:
    line.actual === null
      ? null
      : { measurement_id: line.actual.measurementId, value: line.actual.value, measured_on: line.actual.measuredOn, method_note: line.actual.methodNote, evidence_document_id: line.actual.evidenceDocumentId, recorded_at: line.actual.recordedAt },
  variance: { variance_value: line.variance.varianceValue, variance_pct: line.variance.variancePct, achievement_pct: line.variance.achievementPct, basis: line.variance.basis, band: line.variance.band },
});

const setView = (set: EffectTargetSetView): Record<string, unknown> => ({
  id: set.id,
  version_no: set.versionNo,
  status: set.status,
  basis: set.basis,
  basis_document_id: set.basisDocumentId,
  supersedes_id: set.supersedesId,
  supersede_reason: set.supersedeReason,
  drafted_by: person(set.draftedBy),
  drafted_at: set.draftedAt,
  fixed_by: person(set.fixedBy),
  fixed_at: set.fixedAt,
  fixed_on: set.fixedOn,
  version: set.rowVersion,
  indicators: set.indicators.map(indicatorView),
});

const measurementView = (row: EffectMeasurementRow): Record<string, unknown> => ({
  id: row.id,
  indicator_code: row.indicatorCode,
  measured_on: row.measuredOn,
  value: row.value,
  method_note: row.methodNote,
  evidence_document_id: row.evidenceDocumentId,
  corrects_id: row.correctsId,
  correction_reason: row.correctionReason,
  corrected: row.corrected,
  recorded_by: person(row.recordedBy),
  recorded_at: row.recordedAt,
});

const calendarView = (row: EffectCalendarRow): Record<string, unknown> => ({
  id: row.id,
  kind: row.kind,
  anchor: row.anchor,
  anchor_on: row.anchorOn,
  months: row.months,
  due_on: row.dueOn,
  required: row.required,
  status: row.status,
  state: row.state,
  days_late: row.daysLate,
  assessment_id: row.assessmentId,
  rule_code: row.ruleCode,
  rule_version: row.ruleVersion,
  rule_unverified: row.ruleUnverified,
});

const assessmentView = (row: EffectAssessmentRow): Record<string, unknown> => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  as_of: row.asOf,
  conclusion: row.conclusion,
  summary: row.summary,
  lines: row.lines,
  policy_version: row.policyVersion,
  policy_unverified: row.policyUnverified,
  calendar_entry_id: row.calendarEntryId,
  submitted_by: person(row.submittedBy),
  submitted_at: row.submittedAt,
  decided_by: person(row.decidedBy),
  decided_at: row.decidedAt,
  decision_reason: row.decisionReason,
  version: row.rowVersion,
});

/** The effectiveness of a project as openapi.json exposes it (x-exposure dto): an allowlist, so a column added later is not shown until it is listed here. */
export function effectivenessView(view: EffectivenessView, can: Record<string, boolean>): Record<string, unknown> {
  return {
    project: { id: view.project.id, code: view.project.code, name: view.project.name, status: view.project.status, project_group: view.project.projectGroup },
    policy: {
      name: 'EFFECT_POLICY',
      code: 'DEFAULT',
      version: view.policy.version,
      unverified: view.policy.unverified,
      formula: view.policy.formula,
      source: view.policy.source,
      as_of: view.policy.asOf,
      legal_status: view.policy.unverified ? 'UNVERIFIED' : 'VERIFIED',
      owner: 'MNE',
      params: { met_at_pct: view.policy.policy.metAtPct, partly_at_pct: view.policy.policy.partlyAtPct, draft_statuses: view.policy.policy.draftStatuses, fix_statuses: view.policy.policy.fixStatuses, measure_statuses: view.policy.policy.measureStatuses },
    },
    fixed: view.fixed === null ? null : setView(view.fixed),
    draft: view.draft === null ? null : setView(view.draft),
    superseded: view.superseded.map((one) => ({ id: one.id, version_no: one.versionNo, fixed_on: one.fixedOn })),
    measurements: view.measurements.map(measurementView),
    calendar: view.calendar.map(calendarView),
    assessments: view.assessments.map(assessmentView),
    suggested_conclusion: view.suggestedConclusion,
    can,
    as_of: view.asOf,
  };
}

/**
 * The commands of the effectiveness of a project after the investment (MR.03, G4-7): the targets are drafted by one person and fixed by another when the investment is approved, the actuals are recorded after the
 * commissioning, the calendar of Articles 76 and 77 is generated from the rule of the group of the project, and an assessment is submitted with its variance frozen and decided by someone other than who submitted it.
 * Each command is judged in the scope of its own permission over the project and leaves an audit row and an event in its transaction.
 */
@Controller()
export class EffectController {
  private readonly effects = new EffectStore();

  @Post('projects/:id/effect-targets')
  @HttpCode(200)
  @OperationId('saveEffectTargetDraft')
  @Command({ operation: 'saveEffectTargetDraft' })
  async draft(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneEffectTargetDraft']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.effects.saveDraft(scope.tx, { projectId: id.toLowerCase(), body: { ...body }, actor: scope.tenant.membershipId, scopes: stages(access, DRAFT_PERMISSION, now), now });
    await scope.audit({
      action: 'mne.effect_targets_drafted',
      resourceType: EFFECT_TARGET_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      diff: { project_id: change.projectId, code: change.projectCode, version_no: change.versionNo, indicators: change.indicatorCount },
    });
    await scope.emit({
      aggregateType: EFFECT_TARGET_RESOURCE,
      aggregateId: change.id,
      aggregateVersion: change.rowVersion,
      type: 'mne.effect_targets_drafted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: change.projectId, set_id: change.id, version_no: change.versionNo, indicators: change.indicatorCount, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${EFFECT_TARGET_RESOURCE}:${change.id}:${change.rowVersion}`,
    });
    return { ...commandResult(scope, change.status, change.rowVersion, change.id), project_id: change.projectId, version_no: change.versionNo };
  }

  @Post('effect-target-sets/:id/fix')
  @HttpCode(200)
  @OperationId('fixEffectTargets')
  @Command({ operation: 'fixEffectTargets', versioned: true })
  async fix(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.effects.fix(scope.tx, { setId: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, scopes: stages(access, FIX_PERMISSION, now), now });
    await scope.audit({
      action: 'mne.effect_targets_fixed',
      resourceType: EFFECT_TARGET_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      diff: { project_id: change.projectId, code: change.projectCode, version_no: change.versionNo, indicators: change.indicatorCount, superseded_id: change.supersededId },
    });
    await scope.emit({
      aggregateType: EFFECT_TARGET_RESOURCE,
      aggregateId: change.id,
      aggregateVersion: change.rowVersion,
      type: 'mne.effect_targets_fixed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: change.projectId, set_id: change.id, version_no: change.versionNo, superseded_id: change.supersededId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${EFFECT_TARGET_RESOURCE}:${change.id}:${change.rowVersion}`,
    });
    return { ...commandResult(scope, change.status, change.rowVersion, change.id), project_id: change.projectId, version_no: change.versionNo };
  }

  @Post('projects/:id/effect-measurements')
  @HttpCode(200)
  @OperationId('recordEffectMeasurement')
  @Command({ operation: 'recordEffectMeasurement' })
  async measure(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneEffectMeasurement']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.effects.measure(scope.tx, { projectId: id.toLowerCase(), body: { ...body }, actor: scope.tenant.membershipId, scopes: stages(access, MEASURE_PERMISSION, now), now });
    await scope.audit({
      action: 'mne.effect_measured',
      resourceType: EFFECT_MEASUREMENT_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      diff: { project_id: change.projectId, code: change.projectCode, indicator_code: change.indicatorCode, measured_on: change.measuredOn, corrects_id: change.correctsId },
    });
    await scope.emit({
      aggregateType: EFFECT_MEASUREMENT_RESOURCE,
      aggregateId: change.id,
      aggregateVersion: 1,
      type: 'mne.effect_measured.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: change.projectId, measurement_id: change.id, indicator_code: change.indicatorCode, measured_on: change.measuredOn, corrects_id: change.correctsId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${EFFECT_MEASUREMENT_RESOURCE}:${change.id}`,
    });
    return { ...commandResult(scope, 'RECORDED', 1, change.id), project_id: change.projectId, indicator_code: change.indicatorCode, value: change.value };
  }

  @Post('projects/:id/effect-calendar')
  @HttpCode(200)
  @OperationId('generateEffectCalendar')
  @Command({ operation: 'generateEffectCalendar' })
  async calendar(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.effects.generateCalendar(scope.tx, { projectId: id.toLowerCase(), actor: scope.tenant.membershipId, scopes: stages(access, CALENDAR_PERMISSION, now), now });
    const first = change.created[0];
    // A call that makes no entry (they were all made before) leaves no audit row and no event: nothing happened.
    if (first !== undefined) {
      await scope.audit({
        action: 'mne.effect_calendar_generated',
        resourceType: EFFECT_CALENDAR_RESOURCE,
        resourceId: first.id,
        classification: change.classification,
        diff: { project_id: change.projectId, code: change.projectCode, rule_code: change.ruleCode, rule_version: change.ruleVersion, created: change.created.map((entry) => entry.kind), waiting: change.waiting.map((entry) => entry.kind) },
      });
      await scope.emit({
        aggregateType: EFFECT_CALENDAR_RESOURCE,
        aggregateId: first.id,
        aggregateVersion: 1,
        type: 'mne.effect_calendar_generated.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, project_id: change.projectId, rule_code: change.ruleCode, rule_version: change.ruleVersion, rule_unverified: change.ruleUnverified, created: change.created.map((entry) => ({ kind: entry.kind, due_on: entry.dueOn })), actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${EFFECT_CALENDAR_RESOURCE}:${first.id}`,
      });
    }
    return {
      ...commandResult(scope, 'GENERATED', 1, change.projectId),
      project_id: change.projectId,
      created: change.created.map((entry) => ({ id: entry.id, kind: entry.kind, due_on: entry.dueOn, anchor: entry.anchor, anchor_on: entry.anchorOn })),
      waiting: change.waiting.map((entry) => ({ kind: entry.kind, anchor: entry.anchor })),
      rule: { code: change.ruleCode, version: change.ruleVersion, unverified: change.ruleUnverified },
    };
  }

  @Post('projects/:id/effect-assessments')
  @HttpCode(200)
  @OperationId('submitEffectAssessment')
  @Command({ operation: 'submitEffectAssessment' })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneEffectAssessmentSubmit']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.effects.submitAssessment(scope.tx, { projectId: id.toLowerCase(), body: { ...body }, actor: scope.tenant.membershipId, scopes: stages(access, ASSESS_PERMISSION, now), now });
    await scope.audit({
      action: 'mne.effect_assessment_submitted',
      resourceType: EFFECT_ASSESSMENT_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      diff: { project_id: change.projectId, code: change.projectCode, kind: change.kind, conclusion: change.conclusion, calendar_entry_id: change.calendarEntryId },
    });
    await scope.emit({
      aggregateType: EFFECT_ASSESSMENT_RESOURCE,
      aggregateId: change.id,
      aggregateVersion: change.rowVersion,
      type: 'mne.effect_assessment_submitted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: change.projectId, assessment_id: change.id, kind: change.kind, conclusion: change.conclusion, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${EFFECT_ASSESSMENT_RESOURCE}:${change.id}:${change.rowVersion}`,
    });
    return { ...commandResult(scope, change.status, change.rowVersion, change.id), project_id: change.projectId, kind: change.kind };
  }

  @Post('effect-assessments/:id/decision')
  @HttpCode(200)
  @OperationId('decideEffectAssessment')
  @Command({ operation: 'decideEffectAssessment', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneEffectAssessmentDecision']): Promise<CommandResult & Record<string, unknown>> {
    const now = new Date();
    const change = await this.effects.decideAssessment(scope.tx, { assessmentId: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, body: { ...body }, actor: scope.tenant.membershipId, scopes: stages(access, DECIDE_PERMISSION, now) });
    await scope.audit({
      action: 'mne.effect_assessment_decided',
      resourceType: EFFECT_ASSESSMENT_RESOURCE,
      resourceId: change.id,
      classification: change.classification,
      ...(typeof body.reason === 'string' && body.reason !== '' ? { reason: body.reason } : {}),
      diff: { project_id: change.projectId, code: change.projectCode, kind: change.kind, status: change.status, calendar_closed: change.closedCalendar },
    });
    await scope.emit({
      aggregateType: EFFECT_ASSESSMENT_RESOURCE,
      aggregateId: change.id,
      aggregateVersion: change.rowVersion,
      type: 'mne.effect_assessment_decided.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, project_id: change.projectId, assessment_id: change.id, kind: change.kind, status: change.status, calendar_closed: change.closedCalendar, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${EFFECT_ASSESSMENT_RESOURCE}:${change.id}:${change.rowVersion}`,
    });
    return { ...commandResult(scope, change.status, change.rowVersion, change.id), project_id: change.projectId, kind: change.kind };
  }
}

/** The read of MNE-11: the effectiveness of a project in the scope of the caller, with what the caller may do (the commands judge again). */
@Controller()
export class EffectReadsController {
  private readonly effects = new EffectStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('projects/:id/effectiveness')
  @OperationId('getProjectEffectiveness')
  async effectiveness(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const projectId = asUuid(id);
    if (projectId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    return this.database.withTenant(tenant, async (tx) => {
      const view = await this.effects.view(tx, projectScope(access, READ_PERMISSION, now), projectId, now);
      const reaches = (permission: string): Promise<boolean> => projectInScope(tx, projectId, projectScope(access, permission, now));
      const { policy } = view.policy;
      const me = tenant.membershipId.toLowerCase();
      const submitted = view.assessments.some((one) => one.status === 'SUBMITTED' && one.submittedBy.membershipId.toLowerCase() !== me);
      const can = {
        draft: policy.draftStatuses.includes(view.project.status) && (await reaches(DRAFT_PERMISSION)),
        fix: view.draft !== null && view.draft.draftedBy.membershipId.toLowerCase() !== me && policy.fixStatuses.includes(view.project.status) && (await reaches(FIX_PERMISSION)),
        measure: view.fixed !== null && policy.measureStatuses.includes(view.project.status) && (await reaches(MEASURE_PERMISSION)),
        generate_calendar: view.project.projectGroup !== null && (await reaches(CALENDAR_PERMISSION)),
        assess: view.fixed !== null && [...policy.fixStatuses, ...policy.measureStatuses].includes(view.project.status) && (await reaches(ASSESS_PERMISSION)),
        decide: submitted && (await reaches(DECIDE_PERMISSION)),
      };
      return effectivenessView(view, can);
    });
  }
}
