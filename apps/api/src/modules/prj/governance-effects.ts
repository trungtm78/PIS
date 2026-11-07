import type { AuditEntry, GovernanceEffects } from '@machvon/db';
import type { CommandScope } from '../../command-scope';

/**
 * What the governance hooks of lane B1 did inside the transaction of a command that moved a date or approved a revision (a move counted, the next version of the baseline, an alert to AUD, a request to appraise
 * the project again): one audit row and one event for each, in the same transaction, so nothing the rule did is silent. The alert and the request carry the version of the rule that decided.
 */
export async function recordGovernanceEffects(scope: CommandScope, project: { id: string; code: string; classification: NonNullable<AuditEntry["classification"]> }, effects: GovernanceEffects | undefined, now: Date): Promise<void> {
  if (effects === undefined) return;
  const base = { tenant_id: scope.tenant.tenantId, project_id: project.id, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() };
  for (const event of effects.rescheduleEvents) {
    await scope.audit({
      action: 'project.reschedule_recorded',
      resourceType: 'project_reschedule_event',
      resourceId: event.id,
      classification: project.classification,
      diff: { project_id: project.id, code: project.code, source: event.source, milestone_id: event.milestoneId, revision_id: event.revisionId, from_date: event.fromDate, to_date: event.toDate },
    });
    await scope.emit({
      aggregateType: 'project_reschedule_event',
      aggregateId: event.id,
      aggregateVersion: 1,
      type: 'project.reschedule_recorded.v1',
      schemaVersion: 1,
      payload: { ...base, event_id: event.id, source: event.source, milestone_id: event.milestoneId, revision_id: event.revisionId, from_date: event.fromDate, to_date: event.toDate },
      eventKey: `project_reschedule_event:${event.id}`,
    });
  }
  if (effects.baselineVersion !== null) {
    const version = effects.baselineVersion;
    await scope.audit({ action: 'project.baseline_version_added', resourceType: 'project_baseline', resourceId: version.id, classification: project.classification, diff: { project_id: project.id, code: project.code, version: version.version } });
    await scope.emit({
      aggregateType: 'project_baseline',
      aggregateId: version.id,
      aggregateVersion: 1,
      type: 'project.baseline_version_added.v1',
      schemaVersion: 1,
      payload: { ...base, baseline_id: version.id, baseline_version: version.version },
      eventKey: `project_baseline:${version.id}`,
    });
  }
  if (effects.baselineSkipped !== null) {
    await scope.audit({ action: 'project.baseline_version_skipped', resourceType: 'project_baseline', resourceId: project.id, classification: project.classification, diff: { project_id: project.id, code: project.code, components: effects.baselineSkipped } });
  }
  for (const alert of effects.alertsRaised) {
    await scope.audit({
      action: 'project.governance_alert_raised',
      resourceType: 'project_governance_alert',
      resourceId: alert.id,
      classification: project.classification,
      diff: { project_id: project.id, code: project.code, alert_type: 'RESCHEDULE_COUNT', audience: 'AUD', subject_kind: alert.subjectKind, subject_id: alert.subjectId, move_count: alert.moveCount, threshold: alert.threshold, rule_version: alert.ruleVersion },
    });
    await scope.emit({
      aggregateType: 'project_governance_alert',
      aggregateId: alert.id,
      aggregateVersion: 1,
      type: 'project.governance_alert_raised.v1',
      schemaVersion: 1,
      payload: { ...base, alert_id: alert.id, alert_type: 'RESCHEDULE_COUNT', audience: 'AUD', subject_kind: alert.subjectKind, subject_id: alert.subjectId, move_count: alert.moveCount, threshold: alert.threshold, rule_version: alert.ruleVersion },
      eventKey: `project_governance_alert:${alert.id}`,
    });
  }
  if (effects.reappraisalOpened !== null) {
    const request = effects.reappraisalOpened;
    await scope.audit({
      action: 'project.reappraisal_requested',
      resourceType: 'project_reappraisal_request',
      resourceId: request.id,
      classification: project.classification,
      diff: { project_id: project.id, code: project.code, reasons: request.reasons, cost_pct: request.costPct, finish_slip_days: request.finishSlipDays, rule_version: request.ruleVersion },
    });
    await scope.emit({
      aggregateType: 'project_reappraisal_request',
      aggregateId: request.id,
      aggregateVersion: 1,
      type: 'project.reappraisal_requested.v1',
      schemaVersion: 1,
      payload: { ...base, request_id: request.id, reasons: request.reasons, cost_pct: request.costPct, finish_slip_days: request.finishSlipDays, rule_version: request.ruleVersion },
      eventKey: `project_reappraisal_request:${request.id}`,
    });
  }
}
