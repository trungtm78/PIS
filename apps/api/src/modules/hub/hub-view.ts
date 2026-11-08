import { createHash } from 'node:crypto';
import { GovernancePolicyPort } from '@machvon/db';
import type { HubAgentRow, HubConnectorReading, HubIncidentRow, HubMappingRow, HubRejectRow, HubRunView, HubSnapshotRow, TenantTx } from '@machvon/db';
import { connectorAlertTypes, connectorScreenRoute, nextRunAt, protocolDefinition } from '@machvon/kernel';
import type { ConnectorDescriptor, HubPolicy, HubSummary, PipelineSpec } from '@machvon/kernel';
import { vietnamDateOf } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';

const policyPort = new GovernancePolicyPort();

/** Working days for the schedule shown on the screen: Monday to Friday on the Vietnam calendar (the calendar of ADM refines it when a schedule runs for real). */
export const isWorkingDay = (day: string): boolean => {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};

export const alertDto = (alert: { code: string; severity: string } | null): Schemas['HubAlert'] | null => (alert === null ? null : { code: alert.code, severity: alert.severity as Schemas['HubAlert']['severity'] });

export function connectorSummaryDto(reading: HubConnectorReading): Schemas['HubConnectorSummary'] {
  const { descriptor, health } = reading;
  return {
    code: descriptor.code,
    name: descriptor.name,
    direction: descriptor.direction,
    protocols: [...descriptor.protocols],
    planned_protocols: [...(descriptor.plannedProtocols ?? [])],
    acceptance: health.acceptance,
    status: health.status,
    freshness: health.freshness,
    age_hours: health.ageHours,
    enabled: reading.enabled,
    last_success_at: reading.lastSuccessAt,
    last_run_at: reading.lastRunAt,
    last_run_outcome: reading.lastRunOutcome,
    alert: alertDto(health.alert),
    figures_blocked: health.figuresBlocked,
    failed_runs_7d: reading.failedRuns7d,
    discrepancy_backlog: reading.discrepancyBacklog,
    pending_mappings: reading.pendingMappings,
    consumers: [...descriptor.consumers],
    owner_role: descriptor.ownerRole,
    egress_policy: descriptor.egress.policy,
    screens: descriptor.screens.map((code) => ({ code, route: connectorScreenRoute(code) })),
  };
}

export const summaryDto = (summary: HubSummary): Schemas['HubSummary'] => ({
  total: summary.total,
  monitored: summary.monitored,
  healthy: summary.healthy,
  counts: { ...summary.counts },
  healthy_percent: summary.healthyPercent,
  oldest_data_age_hours: summary.oldestDataAgeHours,
  oldest_data_connector: summary.oldestDataConnector,
  failed_runs_7d: summary.failedRuns7d,
  discrepancy_backlog: summary.discrepancyBacklog,
  pending_mappings: summary.pendingMappings,
  hub_alert: alertDto(summary.hubAlert),
});

export const policyDto = (policy: HubPolicy, source: 'RULE' | 'DEFAULT', unverified: boolean): Schemas['HubPolicyView'] => ({
  failing_after_runs: policy.failingAfterRuns,
  failing_severity: policy.failingSeverity,
  hub_stale_ratio_percent: policy.hubStaleRatioPercent,
  hub_stale_min_connectors: policy.hubStaleMinConnectors,
  hub_stale_severity: policy.hubStaleSeverity,
  incident_auto_open: policy.incidentAutoOpen,
  snapshot_retention_days: policy.snapshotRetentionDays,
  agent_stale_after_minutes: policy.agentStaleAfterMinutes,
  source,
  unverified,
});

export function runDto(run: HubRunView): Schemas['HubRun'] {
  return {
    id: run.id,
    origin: run.origin,
    kind: run.kind,
    outcome: run.outcome,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    layout_version: run.layoutVersion,
    position: run.position,
    pipeline_code: run.pipelineCode,
    rows_total: run.rowsTotal,
    rows_applied: run.rowsApplied,
    rows_rejected: run.rowsRejected,
    error_code: run.errorCode,
    source_ref: run.sourceRef,
    dry_run: run.dryRun,
    stage_counts: null,
  };
}

export const trendDto = (point: HubSnapshotRow): Schemas['HubTrendPoint'] => ({
  at: point.at,
  status: point.status,
  age_hours: point.ageHours,
  failed_runs_7d: point.failedRuns7d,
  discrepancy_backlog: point.discrepancyBacklog,
  pending_mappings: point.pendingMappings,
  summary: point.summary,
});

export const mappingDto = (row: HubMappingRow): Schemas['HubMapping'] => ({
  id: row.id,
  pipeline_code: row.pipelineCode,
  mapping_version: row.mappingVersion,
  fields: row.fields as unknown as Array<Record<string, unknown>>,
  state: row.state,
  proposed_by: row.proposedBy,
  proposed_at: row.proposedAt,
  decided_by: row.decidedBy,
  decided_at: row.decidedAt,
  decision_reason: row.decisionReason,
  version: row.version,
});

export const rejectDto = (row: HubRejectRow): Schemas['HubReject'] => ({
  id: row.id,
  pipeline_code: row.pipelineCode,
  run_id: row.runId,
  stage: row.stage,
  reject_code: row.rejectCode,
  field: row.field,
  source_ref: row.sourceRef,
  record_key: row.recordKey,
  line: row.line,
  record: row.record,
  state: row.state,
  resolved_by: row.resolvedBy,
  resolved_at: row.resolvedAt,
  resolution: row.resolution,
  version: row.version,
  created_at: row.createdAt,
});

export const agentDto = (row: HubAgentRow): Schemas['HubAgent'] => ({
  id: row.id,
  agent_code: row.agentCode,
  os: row.os,
  cpu_arch: row.cpuArch,
  platform: `${row.os}/${row.cpuArch}`,
  agent_version: row.agentVersion,
  connectors: row.connectors,
  spool_depth: row.spoolDepth,
  last_heartbeat_at: row.lastHeartbeatAt,
  state: row.state,
  health: row.health,
  version: row.version,
});

/** The ALERT_TYPE of a code as a person sees it: owner, expected action, consequence (the governance rule in force, else the built-in default). */
export async function alertTypeDto(tx: TenantTx, code: string, now: Date): Promise<Schemas['HubAlertType']> {
  const rule = await policyPort.get(tx, 'ALERT_TYPE', code, now);
  const params = (rule?.params ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    code,
    owner: text(params.owner),
    expected_action: text(params.expected_action),
    consequence: text(params.consequence),
    response_hours: typeof params.response_hours === 'number' ? params.response_hours : null,
    default_severity: text(params.default_severity),
  };
}

export const alertTypesOf = (tx: TenantTx, descriptor: ConnectorDescriptor, now: Date): Promise<Array<Schemas['HubAlertType']>> => Promise.all(connectorAlertTypes(descriptor).map((code) => alertTypeDto(tx, code, now)));

export function incidentDto(row: HubIncidentRow, alert: Schemas['HubAlertType'] | null): Schemas['HubIncident'] {
  return {
    id: row.id,
    connector_code: row.connectorCode,
    kind: row.kind,
    severity: row.severity,
    state: row.state,
    summary: row.summary,
    opened_by: row.openedBy,
    opened_at: row.openedAt,
    acknowledged_by: row.acknowledgedBy,
    acknowledged_at: row.acknowledgedAt,
    resolved_by: row.resolvedBy,
    resolved_at: row.resolvedAt,
    resolution: row.resolution,
    version: row.version,
    alert,
  };
}

/** The alert type that describes an incident kind (a manual incident has none). */
export const alertCodeOfIncident = (kind: HubIncidentRow['kind']): string | null => (kind === 'FAILING' ? 'CONNECTOR_FAILING' : kind === 'STALE' ? 'CONNECTOR_STALE' : kind === 'HUB_STALE' ? 'CONNECTOR_HUB_STALE' : null);

export function protocolViews(descriptor: ConnectorDescriptor): Array<Schemas['HubProtocolView']> {
  const views: Array<Schemas['HubProtocolView']> = [];
  const add = (code: string, status: 'ACTIVE' | 'PLANNED'): void => {
    const definition = protocolDefinition(code);
    if (definition === undefined) return;
    views.push({
      code,
      name: definition.name,
      status,
      egress: definition.egress,
      auth: [...definition.security.auth],
      tls: definition.security.tls,
      signature: definition.security.signature,
      implementation: definition.implementation,
      retry: definition.failure.retry,
      delivery: definition.failure.delivery,
      formats: [...definition.formats],
    });
  };
  for (const code of descriptor.protocols) add(code, 'ACTIVE');
  for (const code of descriptor.plannedProtocols ?? []) add(code, 'PLANNED');
  return views;
}

export function scheduleDto(spec: PipelineSpec, lastStartedAt: Date | null, now: Date): Schemas['HubPipelineSchedule'] {
  const when = spec.schedule.when;
  const next = nextRunAt(spec.schedule, lastStartedAt ?? now, isWorkingDay);
  return {
    kind: when.kind,
    hours: when.kind === 'EVERY_HOURS' ? when.hours : null,
    at: when.kind === 'DAILY' ? when.at : null,
    working_days_only: when.kind === 'MANUAL' ? false : when.workingDaysOnly,
    backfill_window_days: spec.schedule.backfillWindowDays,
    max_concurrency: spec.schedule.maxConcurrency,
    rate_per_minute: spec.schedule.ratePerMinute,
    next_run_at: next === null ? null : next.toISOString(),
  };
}

export const todayOf = (now: Date): string => vietnamDateOf(now);

/** The id of a connector for the audit trail and the outbox, which key on a uuid: the same tenant and code always give the same id (a name-based uuid), and no other tenant gives it. */
export function connectorResourceId(tenantId: string, code: string): string {
  const hex = createHash('sha256').update(`hub_connector:${tenantId}:${code}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
