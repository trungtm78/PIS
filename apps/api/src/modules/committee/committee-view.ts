import type { AttentionDecisionRow, CommitteeAlertRow, CommitteeMemberRow, DirectiveTracker } from '@machvon/db';
import type { AggregateRow, AttentionItem, CommitteePolicyReading, CommitteeWorkspace, FeedStatus, OutlookBand, UnitReportingRow } from '@machvon/kernel';
import { COMMITTEE_POLICY_DEFAULTS, builtInDefault, expectedPctOn } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import type { Figure } from '../home/figures';

/** The shapes of the answers of the committee workspace: camelCase of the rules to snake_case of the contract; nothing is rounded or invented here. */

export const outlookDto = (outlook: OutlookBand): Schemas['CommitteeOutlook'] => ({
  low_vnd: outlook.lowVnd,
  high_vnd: outlook.highVnd,
  low_pct: outlook.lowPct,
  high_pct: outlook.highPct,
  methods: outlook.methods.map((method) => ({ method: method.method, vnd: method.vnd, capped: method.capped })),
  thin: outlook.thin,
  reason: outlook.reason,
});

export const rowDto = (row: AggregateRow): Schemas['CommitteeAggregateRow'] => ({
  dimension: row.dimension,
  key: row.key,
  label: row.label,
  projects: row.projects,
  plan_share_pct: row.planSharePct,
  attention_projects: row.attentionProjects,
  plan_vnd: row.planVnd,
  disbursed_vnd: row.disbursedVnd,
  rate_pct: row.ratePct,
  last_year_vnd: row.lastYearVnd,
  last_year_coverage: row.lastYearCoverage,
  change_vs_last_year_vnd: row.changeVsLastYearVnd,
  expected_pct: row.expectedPct,
  gap_points: row.gapPoints,
  rag: row.rag,
  outlook: outlookDto(row.outlook),
  unknown_lines: row.unknownLines,
});

export const decisionDto = (row: AttentionDecisionRow): Schemas['CommitteeDecision'] => ({
  id: row.id,
  project_id: row.projectId,
  decision: row.decision,
  reasons: row.reasons,
  score: row.score,
  as_of: row.asOf,
  note: row.note,
  defer_until: row.deferUntil,
  directive_id: row.directiveId,
  decided_by: row.decidedBy,
  decided_by_name: row.decidedByName,
  decided_at: row.decidedAt,
});

export const attentionDto = (item: AttentionItem & { decision?: AttentionDecisionRow | null }): Schemas['CommitteeAttentionItem'] => ({
  rank: item.rank,
  project_id: item.projectId,
  code: item.code,
  name: item.name,
  sector_code: item.sectorCode,
  sector_name: item.sectorName,
  district_name: item.districtName,
  investor_unit_id: item.investorUnitId,
  investor_name: item.investorName,
  plan_vnd: item.planVnd,
  disbursed_vnd: item.disbursedVnd,
  rate_pct: item.ratePct,
  expected_pct: item.expectedPct,
  exposure_vnd: item.exposureVnd,
  score: item.score,
  signals: item.signals.map((signal) => ({ reason: signal.reason, value: signal.value, threshold: signal.threshold, unit: signal.unit, severity: signal.severity, weight: signal.weight })),
  decision: item.decision === undefined || item.decision === null ? null : decisionDto(item.decision),
});

export const unitDto = (row: UnitReportingRow): Schemas['CommitteeUnitReporting'] => ({
  unit_id: row.unitId,
  unit_name: row.unitName,
  expected: row.expected,
  received: row.received,
  reporting_rate_pct: row.reportingRatePct,
  last_reported_on: row.lastReportedOn,
  days_since_report: row.daysSinceReport,
  not_reporting: row.notReporting,
  reason: row.reason,
});

export type AlertType = { owner: string | null; expectedAction: string | null; consequence: string | null; responseHours: number | null };

export const alertDto = (row: CommitteeAlertRow, types: ReadonlyMap<string, AlertType>): Schemas['CommitteeAlert'] => {
  const type = types.get(row.alertType);
  return {
    id: row.id,
    alert_type: row.alertType,
    subject_kind: row.subjectKind,
    subject_key: row.subjectKey,
    subject_label: row.subjectLabel,
    severity: row.severity,
    value: row.value,
    threshold: row.threshold,
    detail: row.detail,
    fiscal_year: row.fiscalYear,
    status: row.status,
    opened_on: row.openedOn,
    last_seen_on: row.lastSeenOn,
    resolved_on: row.resolvedOn,
    acknowledged_by_name: row.acknowledgedByName,
    acknowledged_at: row.acknowledgedAt,
    acknowledged_note: row.acknowledgedNote,
    owner: type?.owner ?? null,
    expected_action: type?.expectedAction ?? null,
    consequence: type?.consequence ?? null,
    response_hours: type?.responseHours ?? null,
    version: row.version,
  };
};

export const feedDto = (feed: FeedStatus): Schemas['CommitteeFeedInfo'] => ({ basis: feed.basis, reference: feed.reference, last_delivered_at: feed.lastDeliveredAt, empty: feed.empty, projects: feed.projects, lines: feed.lines });

export function policyDto(policy: CommitteePolicyReading, asOf: string): Schemas['CommitteePolicyInfo'] {
  const built = builtInDefault('COMMITTEE_POLICY', 'DEFAULT');
  return {
    code: policy.code,
    version: policy.version,
    source: policy.source,
    unverified: policy.unverified,
    formula: built?.formula ?? '',
    rule_source: built?.source ?? '',
    as_of: built?.asOf ?? '',
    curve: (policy.params.curve ?? COMMITTEE_POLICY_DEFAULTS.curve).map((point) => ({ month: point.month, cumulative_pct: point.cumulativePct })),
    expected_pct: expectedPctOn(policy.params, asOf),
  };
}

export function trackerDto(tracker: DirectiveTracker, asOf: string, escalateAfterDays: number, figures: Figure[]): Schemas['CommitteeDirectiveTracker'] {
  return {
    as_of: asOf,
    units: tracker.units.map((unit) => ({ unit_id: unit.unitId, unit_name: unit.unitName, open: unit.open, overdue: unit.overdue, escalated: unit.escalated, oldest_overdue_days: unit.oldestOverdueDays })),
    directives: tracker.directives.map((row) => ({
      id: row.id,
      code: row.code,
      text: row.text,
      project_id: row.projectId,
      project_code: row.projectCode,
      assignee_unit_id: row.assigneeUnitId,
      assignee_unit_name: row.assigneeUnitName,
      due_on: row.dueOn,
      overdue_days: row.overdueDays,
      phase: row.phase,
      status: row.status,
      extension_count: row.extensionCount,
    })),
    totals: tracker.totals,
    truncated: tracker.truncated,
    escalate_after_days: escalateAfterDays,
    figures: figures.filter((figure) => figure.metric_code === 'COMMITTEE_DIRECTIVES_OVERDUE') as Schemas['CommitteeFigure'][],
  };
}

export const memberDto = (row: CommitteeMemberRow): Schemas['CommitteeMember'] => ({
  id: row.id,
  committee_id: row.committeeId,
  membership_id: row.membershipId,
  display_name: row.displayName,
  committee_role: row.committeeRole,
  agency_code: row.agencyCode,
  agency_name: row.agencyName,
  decision_ref: row.decisionRef,
  valid_from: row.validFrom,
  valid_until: row.validUntil,
  mfa_required: row.mfaRequired,
  status: row.status,
  appointed_at: row.appointedAt,
  ended_at: row.endedAt,
  end_reason: row.endReason,
  role_granted: row.roleGranted,
  version: row.version,
});

export type { CommitteeWorkspace };
