import { DomainError, HUB_KPI_CODES, HUB_POLICY_RULE_CODE, HUB_POLICY_RULE_TYPE, HUB_POLICY_DEFAULTS, CONNECTOR_FRESHNESS_RULE_TYPE, agentHealthOf, assertMappingShape, assertRunLayoutKnown, connectorDescriptor, connectorFreshnessParams, connectorHealth, consecutiveFailuresOf, hubFreshnessOf, hubPolicyOf, hubReasonOf, hubStateMove, incidentKindOfAlert, incidentMove, isConnectorCode, kpiDefinitionOf, manualIncidentOf, snapshotBucketOf, summarizeHub, versionConflict } from '@machvon/kernel';
import type { AgentHealth, AgentRegistration, ConnectorDescriptor, ConnectorHealth, EtlRun, FieldMapping, HubConnectorFact, HubFreshnessParams, HubPolicy, HubRunRecord, HubSeverity, HubSummary, IncidentAction, IncidentKind, IncidentMove, IncidentState, KpiDefinition, MappingVersion, PipelineSpec, ResolvedGovernanceRule, RunKind, RunOutcome } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { hubStateAdapterOf } from './hub-adapters.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string): string => `to_char((${column}) at time zone 'UTC', ${ISO})`;
const WEEK_MS = 7 * 24 * 3_600_000;
const RECENT_RUNS = 50;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Readings: what the hub knows about one connector now.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface HubRuleInfo {
  source: 'RULE' | 'DEFAULT' | 'DESCRIPTOR';
  version: number;
  unverified: boolean;
  formula: string | null;
  sourceText: string | null;
  asOf: string | null;
  params: HubFreshnessParams;
}

export interface HubConnectorReading {
  descriptor: ConnectorDescriptor;
  enabled: boolean;
  /** The version of the switch (the connector's own, or the hub's); 1 for a switch nobody ever moved. */
  stateVersion: number;
  stateReason: string | null;
  stateChangedAt: string | null;
  stateOwner: 'CONNECTOR' | 'HUB';
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastRunOutcome: RunOutcome | null;
  health: ConnectorHealth;
  failedRuns7d: number;
  discrepancyBacklog: number;
  pendingMappings: number;
  rule: HubRuleInfo | null;
}

export interface HubRunView {
  id: string;
  origin: 'FILE_IMPORT' | 'HUB';
  kind: RunKind;
  outcome: RunOutcome;
  startedAt: string;
  startedAtKey: string;
  finishedAt: string | null;
  layoutVersion: string | null;
  position: string | null;
  pipelineCode: string | null;
  rowsTotal: number;
  rowsApplied: number;
  rowsRejected: number;
  errorCode: string | null;
  sourceRef: string | null;
  dryRun: boolean;
}

interface RunSql {
  id: string;
  origin: 'FILE_IMPORT' | 'HUB';
  kind: RunKind;
  outcome: RunOutcome;
  started_at: string;
  started_at_key: string;
  finished_at: string | null;
  layout_version: string | null;
  position: string | null;
  pipeline_code: string | null;
  rows_total: number;
  rows_applied: number;
  rows_rejected: number;
  error_code: string | null;
  source_ref: string | null;
  dry_run: boolean;
}

const runOf = (row: RunSql): HubRunView => ({
  id: row.id,
  origin: row.origin,
  kind: row.kind,
  outcome: row.outcome,
  startedAt: row.started_at,
  startedAtKey: row.started_at_key,
  finishedAt: row.finished_at,
  layoutVersion: row.layout_version,
  position: row.position,
  pipelineCode: row.pipeline_code,
  rowsTotal: row.rows_total,
  rowsApplied: row.rows_applied,
  rowsRejected: row.rows_rejected,
  errorCode: row.error_code,
  sourceRef: row.source_ref,
  dryRun: row.dry_run,
});

/** The runs of a connector from both sources: the file import framework (one row per file taken) and the hub's own run log, newest first. `$1` the positions, `$2` the connector code. */
const RUNS_UNION = `
  select i.id, 'FILE_IMPORT'::text as origin, 'IMPORT'::text as kind,
         (case i.status when 'APPLIED' then (case when i.rows_quarantined > 0 then 'PARTIAL' else 'SUCCEEDED' end) when 'FAILED' then 'FAILED' else 'RUNNING' end)::text as outcome,
         i.created_at as started_at, i.completed_at as finished_at, i.format_version as layout_version, i.connector_code as position, null::text as pipeline_code,
         i.rows_total, i.rows_applied, (i.rows_quarantined + i.rows_conflict) as rows_rejected, i.error_code, i.file_sha256::text as source_ref, false as dry_run
    from machvon.file_import i where i.connector_code = any($1::text[])
  union all
  select r.id, 'HUB'::text, r.run_kind, r.outcome, r.started_at, r.finished_at, r.layout_version, null::text, r.pipeline_code, r.rows_total, r.rows_applied, r.rows_rejected, r.error_code, r.source_ref, r.dry_run
    from machvon.hub_run_log r where r.connector_code = $2`;

export interface HubIncidentRow {
  id: string;
  connectorCode: string | null;
  kind: IncidentKind;
  severity: HubSeverity;
  state: IncidentState;
  summary: string | null;
  openedBy: string | null;
  openedAt: string;
  openedAtKey: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  sourceRunId: string | null;
  version: number;
}

interface IncidentSql {
  id: string;
  connector_code: string | null;
  kind: IncidentKind;
  severity: HubSeverity;
  state: IncidentState;
  summary: string | null;
  opened_by: string | null;
  opened_at: string;
  opened_at_key: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  source_run_id: string | null;
  version: string;
}

const INCIDENT_SELECT = `select id, connector_code, kind, severity, state, summary, opened_by, ${iso('opened_at')} as opened_at, ${timestampKey('opened_at')} as opened_at_key, acknowledged_by, ${iso('acknowledged_at')} as acknowledged_at,
  resolved_by, ${iso('resolved_at')} as resolved_at, resolution, source_run_id, version::text as version from machvon.hub_incident`;

const incidentOf = (row: IncidentSql): HubIncidentRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  kind: row.kind,
  severity: row.severity,
  state: row.state,
  summary: row.summary,
  openedBy: row.opened_by,
  openedAt: row.opened_at,
  openedAtKey: row.opened_at_key,
  acknowledgedBy: row.acknowledged_by,
  acknowledgedAt: row.acknowledged_at,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  resolution: row.resolution,
  sourceRunId: row.source_run_id,
  version: Number(row.version),
});

export interface HubSweepChange {
  opened: HubIncidentRow[];
  autoResolved: HubIncidentRow[];
}

export interface HubSnapshotRow {
  at: string;
  connectorCode: string | null;
  status: string | null;
  ageHours: number | null;
  failedRuns7d: number;
  discrepancyBacklog: number;
  pendingMappings: number;
  summary: Record<string, unknown> | null;
}

export interface HubMappingRow {
  id: string;
  connectorCode: string;
  pipelineCode: string;
  mappingVersion: string;
  fields: FieldMapping[];
  state: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'RETIRED';
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

interface MappingSql {
  id: string;
  connector_code: string;
  pipeline_code: string;
  mapping_version: string;
  fields: FieldMapping[];
  state: HubMappingRow['state'];
  proposed_by: string;
  proposed_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  version: string;
}

const MAPPING_SELECT = `select id, connector_code, pipeline_code, mapping_version, fields, state, proposed_by, ${iso('proposed_at')} as proposed_at, decided_by, ${iso('decided_at')} as decided_at, decision_reason, version::text as version from machvon.hub_pipeline_mapping`;

const mappingOf = (row: MappingSql): HubMappingRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  pipelineCode: row.pipeline_code,
  mappingVersion: row.mapping_version,
  fields: row.fields,
  state: row.state,
  proposedBy: row.proposed_by,
  proposedAt: row.proposed_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  version: Number(row.version),
});

export interface HubRejectRow {
  id: string;
  connectorCode: string;
  pipelineCode: string;
  runId: string;
  stage: 'VALIDATE' | 'TRANSFORM' | 'LOAD';
  rejectCode: string;
  field: string | null;
  sourceRef: string;
  recordKey: string;
  line: number | null;
  record: Record<string, unknown>;
  state: 'OPEN' | 'REPROCESSED' | 'DISCARDED';
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  version: number;
  createdAt: string;
  createdAtKey: string;
}

interface RejectSql {
  id: string;
  connector_code: string;
  pipeline_code: string;
  run_id: string;
  stage: HubRejectRow['stage'];
  reject_code: string;
  field: string | null;
  source_ref: string;
  record_key: string;
  line: number | null;
  record: Record<string, unknown>;
  state: HubRejectRow['state'];
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  version: string;
  created_at: string;
  created_at_key: string;
}

const REJECT_SELECT = `select id, connector_code, pipeline_code, run_id, stage, reject_code, field, source_ref, record_key, line, record, state, resolved_by, ${iso('resolved_at')} as resolved_at, resolution, version::text as version,
  ${iso('created_at')} as created_at, ${timestampKey('created_at')} as created_at_key from machvon.hub_pipeline_reject`;

const rejectOf = (row: RejectSql): HubRejectRow => ({
  id: row.id,
  connectorCode: row.connector_code,
  pipelineCode: row.pipeline_code,
  runId: row.run_id,
  stage: row.stage,
  rejectCode: row.reject_code,
  field: row.field,
  sourceRef: row.source_ref,
  recordKey: row.record_key,
  line: row.line,
  record: row.record,
  state: row.state,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  resolution: row.resolution,
  version: Number(row.version),
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

export interface HubAgentRow {
  id: string;
  agentCode: string;
  os: string;
  cpuArch: string;
  agentVersion: string;
  connectors: string[];
  spoolDepth: number;
  lastHeartbeatAt: string | null;
  state: 'ACTIVE' | 'RETIRED';
  health: AgentHealth;
  version: number;
  registeredAt: string;
}

interface AgentSql {
  id: string;
  agent_code: string;
  os: string;
  cpu_arch: string;
  agent_version: string;
  connectors: string[];
  spool_depth: number;
  last_heartbeat_at: string | null;
  last_heartbeat_ms: string | null;
  state: 'ACTIVE' | 'RETIRED';
  version: string;
  registered_at: string;
}

const AGENT_SELECT = `select id, agent_code, os, cpu_arch, agent_version, connectors, spool_depth, ${iso('last_heartbeat_at')} as last_heartbeat_at, (extract(epoch from last_heartbeat_at) * 1000)::bigint::text as last_heartbeat_ms, state,
  version::text as version, ${iso('registered_at')} as registered_at from machvon.hub_collector_agent`;

const agentOf = (row: AgentSql, now: Date, staleAfterMinutes: number): HubAgentRow => ({
  id: row.id,
  agentCode: row.agent_code,
  os: row.os,
  cpuArch: row.cpu_arch,
  agentVersion: row.agent_version,
  connectors: row.connectors,
  spoolDepth: row.spool_depth,
  lastHeartbeatAt: row.last_heartbeat_at,
  state: row.state,
  health: agentHealthOf({ state: row.state, lastHeartbeatAt: row.last_heartbeat_ms === null ? null : new Date(Number(row.last_heartbeat_ms)), now, staleAfterMinutes }),
  version: Number(row.version),
  registeredAt: row.registered_at,
});

export interface HubKpiReading {
  code: string;
  definition: KpiDefinition;
  value: number | null;
}

const descriptorOrThrow = (code: string): ConnectorDescriptor => {
  const found = connectorDescriptor(code);
  if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'connector');
  return found;
};

/**
 * The read model and the append-only logs of the Integration Hub (HUB-1). It reads the tables of the connectors through their descriptors (the file import framework, the crosswalk, the connector's own switch through
 * an adapter) and keeps only what the hub owns: the switch of connectors that have none, the run log, incidents, health snapshots, the mapping versions, the watermarks, the dead-letter list, the lineage and the
 * collector agents. Every query runs inside the tenant transaction of the caller (row-level security). Nothing here opens a connection.
 */
export class HubStore {
  private readonly policyPort = new GovernancePolicyPort();

  // ---- rules ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The policy of the hub in force today (a tenant rule, else the built-in default). */
  async policy(tx: TenantTx, now: Date): Promise<{ policy: HubPolicy; rule: ResolvedGovernanceRule | undefined }> {
    const rule = await this.policyPort.get(tx, HUB_POLICY_RULE_TYPE, HUB_POLICY_RULE_CODE, now);
    return { policy: rule === undefined ? HUB_POLICY_DEFAULTS : hubPolicyOf(rule.params as unknown as Readonly<Record<string, unknown>>), rule };
  }

  /** The freshness rule of a connector: the tenant's rule or the built-in default for its code, else the defaults of the descriptor itself (flagged: the numbers come from the connector, nobody registered them as a rule). */
  async freshness(tx: TenantTx, descriptor: ConnectorDescriptor, now: Date): Promise<HubRuleInfo | null> {
    if (descriptor.freshness === null) return null;
    const rule = await this.policyPort.get(tx, CONNECTOR_FRESHNESS_RULE_TYPE, descriptor.freshness.ruleCode, now);
    if (rule === undefined) {
      const params = hubFreshnessOf(connectorFreshnessParams(descriptor.freshness));
      return { source: 'DESCRIPTOR', version: 0, unverified: true, formula: null, sourceText: null, asOf: null, params };
    }
    return {
      source: rule.source,
      version: rule.version,
      unverified: rule.unverified,
      formula: rule.provenance?.formula ?? null,
      sourceText: rule.provenance?.source ?? null,
      asOf: rule.provenance?.asOf ?? null,
      params: hubFreshnessOf(rule.params as unknown as Readonly<Record<string, unknown>>),
    };
  }

  // ---- the switch ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async stateOf(tx: TenantTx, descriptor: ConnectorDescriptor): Promise<{ enabled: boolean; version: number; reason: string | null; changedAt: string | null }> {
    const adapter = descriptor.ledger.stateOwner === 'CONNECTOR' ? hubStateAdapterOf(descriptor.code) : undefined;
    if (adapter !== undefined) return adapter.read(tx);
    const rows = await tx.query<{ enabled: boolean; version: string; state_reason: string | null; changed_at: string | null }>(
      `select enabled, version::text as version, state_reason, ${iso('state_changed_at')} as changed_at from machvon.hub_connector_state where connector_code = $1`,
      [descriptor.code],
    );
    const row = rows[0];
    return row === undefined ? { enabled: true, version: 1, reason: null, changedAt: null } : { enabled: row.enabled, version: Number(row.version), reason: row.state_reason, changedAt: row.changed_at };
  }

  /**
   * Switches a connector on or off (a versioned command). A connector with a switch of its own is moved through its adapter (the connector's own store and history); any other is moved in the hub's
   * state table. Both need a reason, a stale version is 409 VERSION_CONFLICT and a move to the state it is already in is 422. The decision is also written to the hub's own history.
   */
  async setState(tx: TenantTx, code: string, expectedVersion: number, move: { enabled: unknown; reason: unknown }, actor: string): Promise<{ before: { enabled: boolean; version: number }; after: { enabled: boolean; version: number; reason: string | null; changedAt: string | null }; delegated: boolean }> {
    const descriptor = descriptorOrThrow(code);
    const adapter = descriptor.ledger.stateOwner === 'CONNECTOR' ? hubStateAdapterOf(code) : undefined;
    let outcome: { before: { enabled: boolean; version: number }; after: { enabled: boolean; version: number; reason: string | null; changedAt: string | null } };
    if (adapter !== undefined) outcome = await adapter.set(tx, expectedVersion, move, actor);
    else {
      await tx.query(
        `insert into machvon.hub_connector_state (tenant_id, id, connector_code, enabled, version, created_by, updated_by) values (${TENANT}, gen_random_uuid(), $1, true, 1, $2::uuid, $2::uuid) on conflict (tenant_id, connector_code) do nothing`,
        [code, actor],
      );
      const locked = await tx.query<{ id: string; enabled: boolean; version: string }>('select id, enabled, version::text as version from machvon.hub_connector_state where connector_code = $1 for update', [code]);
      const before = locked[0] as { id: string; enabled: boolean; version: string };
      if (Number(before.version) !== expectedVersion) throw versionConflict(Number(before.version));
      const decided = hubStateMove(before, move);
      await tx.query(
        `update machvon.hub_connector_state set enabled = $2, state_reason = $3, state_changed_by = $4::uuid, state_changed_at = clock_timestamp(), version = version + 1, updated_at = clock_timestamp(), updated_by = $4::uuid where id = $1::uuid`,
        [before.id, decided.enabled, decided.reason, actor],
      );
      outcome = { before: { enabled: before.enabled, version: Number(before.version) }, after: { ...(await this.stateOf(tx, descriptor)) } };
    }
    await tx.query(
      `insert into machvon.hub_connector_event (tenant_id, id, connector_code, action, reason, actor_id, state_version) values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::uuid, $5::bigint)`,
      [code, outcome.after.enabled ? 'ENABLED' : 'DISABLED', outcome.after.reason ?? hubReasonOf(move.reason), actor, outcome.after.version],
    );
    return { ...outcome, delegated: adapter !== undefined };
  }

  /** The newest events of the hub's history of a switch. */
  async stateEvents(tx: TenantTx, code: string, limit: number): Promise<Array<{ id: string; action: string; reason: string; actorId: string; version: number; occurredAt: string }>> {
    const rows = await tx.query<{ id: string; action: string; reason: string; actor_id: string; state_version: string; occurred_at: string }>(
      `select id, action, reason, actor_id, state_version::text as state_version, ${iso('occurred_at')} as occurred_at from machvon.hub_connector_event where connector_code = $1 order by occurred_at desc, id desc limit $2`,
      [code, limit],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, reason: row.reason, actorId: row.actor_id, version: Number(row.state_version), occurredAt: row.occurred_at }));
  }

  // ---- readings ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Everything the hub knows about a connector at `now`: the switch, the runs, the freshness rule, the health and the counts. A read never writes. */
  async reading(tx: TenantTx, descriptor: ConnectorDescriptor, now: Date, policy?: HubPolicy): Promise<HubConnectorReading> {
    const hubPolicy = policy ?? (await this.policy(tx, now)).policy;
    const state = await this.stateOf(tx, descriptor);
    const positions = [...descriptor.ledger.positions];
    const runs = await tx.query<{ outcome: RunOutcome; at: string; at_ms: string }>(
      `select outcome, ${iso('at')} as at, (extract(epoch from at) * 1000)::bigint::text as at_ms from (
         select (case i.status when 'APPLIED' then (case when i.rows_quarantined > 0 then 'PARTIAL' else 'SUCCEEDED' end) when 'FAILED' then 'FAILED' else 'RUNNING' end)::text as outcome, coalesce(i.completed_at, i.created_at) as at
           from machvon.file_import i where i.connector_code = any($1::text[])
         union all
         select r.outcome, coalesce(r.finished_at, r.started_at) from machvon.hub_run_log r where r.connector_code = $2 and r.dry_run = false
       ) u order by at desc limit ${RECENT_RUNS}`,
      [positions, descriptor.code],
    );
    const success = await tx.query<{ at: string | null; at_ms: string | null }>(
      `select ${iso('max(at)')} as at, (extract(epoch from max(at)) * 1000)::bigint::text as at_ms from (
         select coalesce(i.completed_at, i.created_at) as at from machvon.file_import i where i.connector_code = any($1::text[]) and i.status = 'APPLIED'
         union all
         select coalesce(r.finished_at, r.started_at) from machvon.hub_run_log r where r.connector_code = $2 and r.dry_run = false and r.outcome in ('SUCCEEDED', 'PARTIAL')
       ) s`,
      [positions, descriptor.code],
    );
    const failed = await tx.query<{ n: string }>(
      `select count(*)::text as n from (
         select coalesce(i.completed_at, i.created_at) as at from machvon.file_import i where i.connector_code = any($1::text[]) and i.status = 'FAILED'
         union all
         select r.started_at from machvon.hub_run_log r where r.connector_code = $2 and r.dry_run = false and r.outcome = 'FAILED'
       ) f where at >= $3::timestamptz`,
      [positions, descriptor.code, new Date(now.getTime() - WEEK_MS).toISOString()],
    );
    const backlog =
      positions.length === 0 ? 0 : Number((await tx.query<{ n: string }>("select count(*)::text as n from machvon.file_import_reconciliation_item where connector_code = any($1::text[]) and status = 'OPEN'", [positions]))[0]?.n ?? 0);
    const pending =
      descriptor.ledger.sourceSystems.length === 0
        ? 0
        : Number((await tx.query<{ n: string }>("select count(*)::text as n from machvon.master_crosswalk where source_system = any($1::text[]) and status = 'PROPOSED'", [[...descriptor.ledger.sourceSystems]]))[0]?.n ?? 0);
    const rule = await this.freshness(tx, descriptor, now);
    const lastSuccessAt = success[0]?.at_ms == null ? null : new Date(Number(success[0].at_ms));
    const newest = runs[0];
    const health = connectorHealth({
      descriptor,
      enabled: state.enabled,
      lastSuccessAt,
      lastRun: newest === undefined ? null : { outcome: newest.outcome, at: new Date(Number(newest.at_ms)) },
      consecutiveFailures: consecutiveFailuresOf(runs.map((run) => run.outcome)),
      now,
      freshness: rule === null ? null : rule.params,
      policy: hubPolicy,
    });
    return {
      descriptor,
      enabled: state.enabled,
      stateVersion: state.version,
      stateReason: state.reason,
      stateChangedAt: state.changedAt,
      stateOwner: descriptor.ledger.stateOwner,
      lastSuccessAt: success[0]?.at ?? null,
      lastRunAt: newest?.at ?? null,
      lastRunOutcome: newest?.outcome ?? null,
      health,
      failedRuns7d: Number(failed[0]?.n ?? 0),
      discrepancyBacklog: backlog,
      pendingMappings: pending,
      rule,
    };
  }

  /** The readings of the given connectors (every registered one when none are named), in registration order. */
  async readings(tx: TenantTx, descriptors: readonly ConnectorDescriptor[], now: Date): Promise<{ items: HubConnectorReading[]; policy: HubPolicy; summary: HubSummary }> {
    const { policy } = await this.policy(tx, now);
    const items: HubConnectorReading[] = [];
    for (const descriptor of descriptors) items.push(await this.reading(tx, descriptor, now, policy));
    const facts: HubConnectorFact[] = items.map((item) => ({ code: item.descriptor.code, health: item.health, failedRuns7d: item.failedRuns7d, discrepancyBacklog: item.discrepancyBacklog, pendingMappings: item.pendingMappings }));
    return { items, policy, summary: summarizeHub(facts, policy) };
  }

  /** The five KPI definitions of the hub in force today (formula, numerator, denominator, source, as-of, flag) with the value from the summary. */
  async kpis(tx: TenantTx, summary: HubSummary, now: Date): Promise<HubKpiReading[]> {
    const values: Record<string, number | null> = {
      HUB_CONNECTORS_HEALTHY_PCT: summary.healthyPercent,
      HUB_OLDEST_DATA_AGE_DAYS: summary.oldestDataAgeHours === null ? null : Math.round((summary.oldestDataAgeHours / 24) * 10) / 10,
      HUB_FAILED_RUNS_7D: summary.failedRuns7d,
      HUB_DISCREPANCY_BACKLOG: summary.discrepancyBacklog,
      HUB_PENDING_MAPPINGS: summary.pendingMappings,
    };
    const readings: HubKpiReading[] = [];
    for (const code of HUB_KPI_CODES) {
      const rule = await this.policyPort.require(tx, 'KPI_DEFINITION', code, now);
      readings.push({ code, definition: kpiDefinitionOf(rule), value: values[code] ?? null });
    }
    return readings;
  }

  // ---- runs ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The runs of a connector from the file import framework and the hub's run log, newest first (keyset by start time and id). */
  async listRuns(tx: TenantTx, descriptor: ConnectorDescriptor, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<HubRunView[]> {
    const rows = await tx.query<RunSql>(
      `select r.id, r.origin, r.kind, r.outcome, ${iso('r.started_at')} as started_at, ${timestampKey('r.started_at')} as started_at_key, ${iso('r.finished_at')} as finished_at, r.layout_version, r.position, r.pipeline_code, r.rows_total,
              r.rows_applied, r.rows_rejected, r.error_code, r.source_ref, r.dry_run
         from (${RUNS_UNION}) r
        where ($3::text is null or (${timestampKey('r.started_at')}, r.id) < ($3::text, $4::uuid))
        order by r.started_at desc, r.id desc limit $5`,
      [[...descriptor.ledger.positions], descriptor.code, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(runOf);
  }

  /**
   * Records a run reported to the hub (a connector without a history of its own, a machine account, a pipeline run). The layout must be one the descriptor declares. A run with a source reference is recorded once:
   * a second report of it returns the first (`duplicate`). Returns the row and whether it is new.
   */
  async recordRun(
    tx: TenantTx,
    code: string,
    run: HubRunRecord,
    actor: string,
    extra: { pipelineCode?: string; dryRun?: boolean; batchSha256?: string; watermarkBefore?: string | null; watermarkAfter?: string | null; stageCounts?: unknown } = {},
  ): Promise<{ id: string; duplicate: boolean }> {
    const descriptor = descriptorOrThrow(code);
    assertRunLayoutKnown(descriptor, run);
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.hub_run_log (tenant_id, id, connector_code, run_kind, outcome, started_at, finished_at, layout_code, layout_version, rows_total, rows_applied, rows_rejected, error_code, source_ref, pipeline_code, dry_run, batch_sha256,
         watermark_before, watermark_after, stage_counts, recorded_by)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::uuid)
       on conflict (tenant_id, connector_code, source_ref) where source_ref is not null do nothing returning id`,
      [
        code,
        run.kind,
        run.outcome,
        run.startedAt.toISOString(),
        run.finishedAt === null ? null : run.finishedAt.toISOString(),
        run.layoutCode,
        run.layoutVersion,
        run.rowsTotal,
        run.rowsApplied,
        run.rowsRejected,
        run.errorCode,
        run.sourceRef,
        extra.pipelineCode ?? null,
        extra.dryRun ?? false,
        extra.batchSha256 ?? null,
        extra.watermarkBefore ?? null,
        extra.watermarkAfter ?? null,
        extra.stageCounts === undefined ? null : JSON.stringify(extra.stageCounts),
        actor,
      ],
    );
    if (inserted[0] !== undefined) return { id: inserted[0].id, duplicate: false };
    const existing = await tx.query<{ id: string }>('select id from machvon.hub_run_log where connector_code = $1 and source_ref = $2', [code, run.sourceRef]);
    return { id: (existing[0] as { id: string }).id, duplicate: true };
  }

  // ---- incidents ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async listIncidents(tx: TenantTx, request: { state?: IncidentState | undefined; connectorCode?: string | undefined; open?: boolean | undefined; limit: number; after: { key: string; id: string } | undefined }): Promise<HubIncidentRow[]> {
    const rows = await tx.query<IncidentSql>(
      `${INCIDENT_SELECT}
        where ($1::text is null or state = $1) and ($2::text is null or connector_code = $2) and ($3::boolean is null or ($3 = (state <> 'RESOLVED')))
          and ($4::text is null or (${timestampKey('opened_at')}, id) < ($4::text, $5::uuid))
        order by opened_at desc, id desc limit $6`,
      [request.state ?? null, request.connectorCode ?? null, request.open ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(incidentOf);
  }

  async findIncident(tx: TenantTx, id: string, lock = false): Promise<HubIncidentRow | undefined> {
    const rows = await tx.query<IncidentSql>(`${INCIDENT_SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : incidentOf(rows[0]);
  }

  async incidentEvents(tx: TenantTx, incidentId: string): Promise<Array<{ id: string; action: IncidentAction; actorId: string | null; reason: string | null; version: number; occurredAt: string }>> {
    const rows = await tx.query<{ id: string; action: IncidentAction; actor_id: string | null; reason: string | null; incident_version: string; occurred_at: string }>(
      `select id, action, actor_id, reason, incident_version::text as incident_version, ${iso('occurred_at')} as occurred_at from machvon.hub_incident_event where incident_id = $1::uuid order by incident_version, occurred_at, id`,
      [incidentId],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, actorId: row.actor_id, reason: row.reason, version: Number(row.incident_version), occurredAt: row.occurred_at }));
  }

  private async openIncident(tx: TenantTx, input: { connectorCode: string | null; kind: IncidentKind; severity: HubSeverity; summary: string | null; openedBy: string | null; sourceRunId?: string | null }): Promise<HubIncidentRow | undefined> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.hub_incident (tenant_id, id, connector_code, kind, severity, summary, opened_by, source_run_id) values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4, $5::uuid, $6::uuid)
       on conflict (tenant_id, (coalesce(connector_code, '*')), kind) where state <> 'RESOLVED' and kind <> 'MANUAL' do nothing returning id`,
      [input.connectorCode, input.kind, input.severity, input.summary, input.openedBy, input.sourceRunId ?? null],
    );
    if (inserted[0] === undefined) return undefined;
    await tx.query(`insert into machvon.hub_incident_event (tenant_id, id, incident_id, action, actor_id, reason, incident_version) values (${TENANT}, gen_random_uuid(), $1::uuid, 'OPENED', $2::uuid, $3, 1)`, [inserted[0].id, input.openedBy, input.summary]);
    return this.findIncident(tx, inserted[0].id);
  }

  /** A person reports an incident on a connector (kind MANUAL): a summary of what was seen. Several may be open at once. */
  async openManual(tx: TenantTx, code: string, body: Readonly<Record<string, unknown>>, actor: string): Promise<HubIncidentRow> {
    descriptorOrThrow(code);
    const manual = manualIncidentOf(body);
    const row = await this.openIncident(tx, { connectorCode: code, kind: 'MANUAL', severity: manual.severity, summary: manual.summary, openedBy: actor });
    return row as HubIncidentRow;
  }

  /** Acknowledges or resolves an incident (a versioned command with a reason). */
  async moveIncident(tx: TenantTx, id: string, expectedVersion: number, step: { move: IncidentMove; reason: unknown }, actor: string): Promise<{ before: HubIncidentRow; row: HubIncidentRow }> {
    const before = await this.findIncident(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = incidentMove(before, step);
    if (decided.to === 'ACKNOWLEDGED') {
      await tx.query(`update machvon.hub_incident set state = 'ACKNOWLEDGED', acknowledged_by = $2::uuid, acknowledged_at = clock_timestamp(), version = version + 1 where id = $1::uuid`, [id, actor]);
    } else {
      await tx.query(`update machvon.hub_incident set state = 'RESOLVED', resolved_by = $2::uuid, resolved_at = clock_timestamp(), resolution = $3, version = version + 1 where id = $1::uuid`, [id, actor, decided.reason]);
    }
    await tx.query(`insert into machvon.hub_incident_event (tenant_id, id, incident_id, action, actor_id, reason, incident_version) values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4, $5::bigint)`, [id, decided.action, actor, decided.reason, before.version + 1]);
    return { before, row: (await this.findIncident(tx, id)) as HubIncidentRow };
  }

  /**
   * The hub's own incidents follow the health it reads: a connector that is FAILING or STALE has one open incident of that kind (opened once, not once per sweep), and an incident whose condition cleared is closed as
   * AUTO_RESOLVED. The hub-wide staleness has one with no connector. Does nothing to MANUAL incidents. With `incident_auto_open` off in the policy nothing is opened (the ones that cleared are still closed).
   */
  async syncIncidents(tx: TenantTx, readings: readonly HubConnectorReading[], summary: HubSummary, policy: HubPolicy): Promise<HubSweepChange> {
    const change: HubSweepChange = { opened: [], autoResolved: [] };
    const wanted = new Map<string, { connectorCode: string | null; kind: IncidentKind; severity: HubSeverity }>();
    for (const reading of readings) {
      const kind = incidentKindOfAlert(reading.health.alert);
      if (kind !== null && reading.health.alert !== null) wanted.set(`${reading.descriptor.code}|${kind}`, { connectorCode: reading.descriptor.code, kind, severity: reading.health.alert.severity });
    }
    const hubKind = incidentKindOfAlert(summary.hubAlert);
    if (hubKind !== null && summary.hubAlert !== null) wanted.set(`*|${hubKind}`, { connectorCode: null, kind: hubKind, severity: summary.hubAlert.severity });
    const open = await tx.query<IncidentSql>(`${INCIDENT_SELECT} where state <> 'RESOLVED' and kind <> 'MANUAL' for update`);
    const known = new Set(readings.map((reading) => reading.descriptor.code));
    for (const row of open.map(incidentOf)) {
      const key = `${row.connectorCode ?? '*'}|${row.kind}`;
      if (wanted.has(key) || (row.connectorCode !== null && !known.has(row.connectorCode))) {
        wanted.delete(key);
        continue;
      }
      await tx.query(`update machvon.hub_incident set state = 'RESOLVED', resolved_at = clock_timestamp(), resolution = 'CONDITION_CLEARED', version = version + 1 where id = $1::uuid`, [row.id]);
      await tx.query(`insert into machvon.hub_incident_event (tenant_id, id, incident_id, action, actor_id, reason, incident_version) values (${TENANT}, gen_random_uuid(), $1::uuid, 'AUTO_RESOLVED', null, 'CONDITION_CLEARED', $2::bigint)`, [row.id, row.version + 1]);
      change.autoResolved.push((await this.findIncident(tx, row.id)) as HubIncidentRow);
    }
    if (!policy.incidentAutoOpen) return change;
    const stillOpen = new Set(open.map(incidentOf).filter((row) => !change.autoResolved.some((closed) => closed.id === row.id)).map((row) => `${row.connectorCode ?? '*'}|${row.kind}`));
    for (const [key, item] of wanted) {
      if (stillOpen.has(key)) continue;
      const row = await this.openIncident(tx, { ...item, summary: null, openedBy: null });
      if (row !== undefined) change.opened.push(row);
    }
    return change;
  }

  // ---- snapshots -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /**
   * A sweep: reads every connector, writes one snapshot per connector and one for the whole hub in the hour of `now` (a repeat in the same hour finds them: nothing new is written), and brings the incidents in line
   * with the health. Returns the readings, the summary, what the incidents did and how many snapshots are new.
   */
  async sweep(tx: TenantTx, descriptors: readonly ConnectorDescriptor[], now: Date, actor: string): Promise<{ items: HubConnectorReading[]; summary: HubSummary; policy: HubPolicy; incidents: HubSweepChange; snapshotsWritten: number; bucket: string }> {
    const { items, summary, policy } = await this.readings(tx, descriptors, now);
    const bucket = snapshotBucketOf(now);
    let written = 0;
    for (const item of items) {
      const inserted = await tx.query(
        `insert into machvon.hub_health_snapshot (tenant_id, id, connector_code, bucket, status, age_hours, failed_runs_7d, discrepancy_backlog, pending_mappings, taken_by)
         values (${TENANT}, gen_random_uuid(), $1, $2::timestamptz, $3, $4::numeric, $5, $6, $7, $8::uuid) on conflict (tenant_id, (coalesce(connector_code, '*')), bucket) do nothing returning id`,
        [item.descriptor.code, bucket, item.health.status, item.health.ageHours, item.failedRuns7d, item.discrepancyBacklog, item.pendingMappings, actor],
      );
      written += inserted.length;
    }
    const hubRow = await tx.query(
      `insert into machvon.hub_health_snapshot (tenant_id, id, connector_code, bucket, failed_runs_7d, discrepancy_backlog, pending_mappings, summary, taken_by)
       values (${TENANT}, gen_random_uuid(), null, $1::timestamptz, $2, $3, $4, $5::jsonb, $6::uuid) on conflict (tenant_id, (coalesce(connector_code, '*')), bucket) do nothing returning id`,
      [bucket, summary.failedRuns7d, summary.discrepancyBacklog, summary.pendingMappings, JSON.stringify(summary), actor],
    );
    written += hubRow.length;
    const incidents = await this.syncIncidents(tx, items, summary, policy);
    return { items, summary, policy, incidents, snapshotsWritten: written, bucket };
  }

  /** The newest snapshots of a connector (or of the whole hub when `code` is null), newest first. */
  async trend(tx: TenantTx, code: string | null, limit: number): Promise<HubSnapshotRow[]> {
    const rows = await tx.query<{ at: string; connector_code: string | null; status: string | null; age_hours: string | null; failed_runs_7d: number; discrepancy_backlog: number; pending_mappings: number; summary: Record<string, unknown> | null }>(
      `select ${iso('bucket')} as at, connector_code, status, age_hours::text as age_hours, failed_runs_7d, discrepancy_backlog, pending_mappings, summary from machvon.hub_health_snapshot
        where connector_code is not distinct from $1::text order by bucket desc limit $2`,
      [code, limit],
    );
    return rows.map((row) => ({ at: row.at, connectorCode: row.connector_code, status: row.status, ageHours: row.age_hours === null ? null : Number(row.age_hours), failedRuns7d: row.failed_runs_7d, discrepancyBacklog: row.discrepancy_backlog, pendingMappings: row.pending_mappings, summary: row.summary }));
  }

  // ---- mappings and watermarks -------------------------------------------------------------------------------------------------------------------------------------------

  async listMappings(tx: TenantTx, code: string, pipelineCode?: string): Promise<HubMappingRow[]> {
    const rows = await tx.query<MappingSql>(`${MAPPING_SELECT} where connector_code = $1 and ($2::text is null or pipeline_code = $2) order by pipeline_code, proposed_at desc, id desc`, [code, pipelineCode ?? null]);
    return rows.map(mappingOf);
  }

  async findMapping(tx: TenantTx, id: string, lock = false): Promise<HubMappingRow | undefined> {
    const rows = await tx.query<MappingSql>(`${MAPPING_SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : mappingOf(rows[0]);
  }

  /** The approved mapping of a pipeline as the runner takes it, or undefined while none is approved. */
  async approvedMapping(tx: TenantTx, code: string, pipelineCode: string): Promise<MappingVersion | undefined> {
    const rows = await tx.query<MappingSql>(`${MAPPING_SELECT} where connector_code = $1 and pipeline_code = $2 and state = 'APPROVED'`, [code, pipelineCode]);
    const row = rows[0];
    return row === undefined ? undefined : { version: row.mapping_version, fields: row.fields, proposedBy: row.proposed_by, approvedBy: row.decided_by, approvedAt: row.decided_at };
  }

  /** A person proposes a version of the mapping of a pipeline of the descriptor (409 `HUB_MAPPING_VERSION_TAKEN` for a version that exists). */
  async proposeMapping(tx: TenantTx, code: string, pipelineCode: string, mappingVersion: string, fields: readonly FieldMapping[], actor: string): Promise<HubMappingRow> {
    const descriptor = descriptorOrThrow(code);
    if (!(descriptor.pipelines ?? []).some((pipeline) => pipeline.code === pipelineCode)) throw new DomainError('VALIDATION_FAILED', 422, 'pipeline_code');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(mappingVersion)) throw new DomainError('VALIDATION_FAILED', 422, 'mapping_version');
    assertMappingShape(fields);
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.hub_pipeline_mapping (tenant_id, id, connector_code, pipeline_code, mapping_version, fields, proposed_by) values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::jsonb, $5::uuid)
       on conflict (tenant_id, connector_code, pipeline_code, mapping_version) do nothing returning id`,
      [code, pipelineCode, mappingVersion, JSON.stringify(fields), actor],
    );
    if (inserted[0] === undefined) throw new DomainError('HUB_MAPPING_VERSION_TAKEN', 409, 'mapping_version');
    return (await this.findMapping(tx, inserted[0].id)) as HubMappingRow;
  }

  /** Another person approves or rejects a proposed version (403 `SELF_APPROVAL_DENIED` for the proposer). Approving retires the version that was in force. */
  async decideMapping(tx: TenantTx, id: string, expectedVersion: number, decision: 'APPROVE' | 'REJECT', reason: unknown, actor: string): Promise<{ before: HubMappingRow; row: HubMappingRow; retired: HubMappingRow | undefined }> {
    const before = await this.findMapping(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.state !== 'PROPOSED') throw new DomainError('HUB_MAPPING_STATE_INVALID', 409, 'state');
    if (before.proposedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
    const text = hubReasonOf(reason);
    let retired: HubMappingRow | undefined;
    if (decision === 'APPROVE') {
      const current = await tx.query<MappingSql>(`${MAPPING_SELECT} where connector_code = $1 and pipeline_code = $2 and state = 'APPROVED' for update`, [before.connectorCode, before.pipelineCode]);
      if (current[0] !== undefined) {
        await tx.query(`update machvon.hub_pipeline_mapping set state = 'RETIRED', decided_by = $2::uuid, decided_at = clock_timestamp(), decision_reason = $3, version = version + 1 where id = $1::uuid`, [current[0].id, actor, `Replaced by ${before.mappingVersion}`]);
        retired = await this.findMapping(tx, current[0].id);
      }
    }
    await tx.query(`update machvon.hub_pipeline_mapping set state = $2, decided_by = $3::uuid, decided_at = clock_timestamp(), decision_reason = $4, version = version + 1 where id = $1::uuid`, [id, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', actor, text]);
    return { before, row: (await this.findMapping(tx, id)) as HubMappingRow, retired };
  }

  async watermark(tx: TenantTx, code: string, pipelineCode: string): Promise<{ watermark: string | null; version: number }> {
    const rows = await tx.query<{ watermark: string | null; version: string }>('select watermark, version::text as version from machvon.hub_pipeline_watermark where connector_code = $1 and pipeline_code = $2', [code, pipelineCode]);
    return rows[0] === undefined ? { watermark: null, version: 0 } : { watermark: rows[0].watermark, version: Number(rows[0].version) };
  }

  /** Moves the watermark from what the run started with to where it ended; a watermark that moved meanwhile is 409 VERSION_CONFLICT (two runs of one pipeline never overwrite each other). */
  private async advanceWatermark(tx: TenantTx, code: string, pipelineCode: string, from: string | null, to: string, actor: string): Promise<void> {
    await tx.query(
      `insert into machvon.hub_pipeline_watermark (tenant_id, id, connector_code, pipeline_code, watermark, version, updated_by) values (${TENANT}, gen_random_uuid(), $1, $2, null, 1, $3::uuid) on conflict (tenant_id, connector_code, pipeline_code) do nothing`,
      [code, pipelineCode, actor],
    );
    const moved = await tx.query<{ id: string }>(
      `update machvon.hub_pipeline_watermark set watermark = $3, version = version + 1, updated_at = clock_timestamp(), updated_by = $4::uuid where connector_code = $1 and pipeline_code = $2 and watermark is not distinct from $5::text returning id`,
      [code, pipelineCode, to, actor, from],
    );
    if (moved[0] === undefined) throw versionConflict((await this.watermark(tx, code, pipelineCode)).version);
  }

  /**
   * Keeps what a pipeline run did: the run (with the stage counts, the hash of the batch, the watermarks), every reject in the dead-letter list, the lineage of every record that was loaded, and the watermark when
   * the run was a real one whose load completed (never for a dry run or a failed load). Returns the id of the run.
   */
  async recordPipelineRun(tx: TenantTx, code: string, spec: Pick<PipelineSpec, 'code' | 'layoutCode' | 'layoutVersion'>, run: EtlRun, window: { startedAt: Date; finishedAt: Date }, actor: string): Promise<{ runId: string; rejects: number; lineage: number; watermarkMoved: boolean }> {
    const outcome: RunOutcome = run.outcome;
    const recorded = await this.recordRun(
      tx,
      code,
      {
        kind: 'IMPORT',
        outcome,
        startedAt: window.startedAt,
        finishedAt: window.finishedAt,
        layoutCode: spec.layoutCode,
        layoutVersion: spec.layoutVersion,
        rowsTotal: run.reconcile.extracted,
        rowsApplied: run.reconcile.applied + run.reconcile.wouldApply + run.reconcile.duplicate,
        rowsRejected: run.reconcile.rejected,
        errorCode: run.failure === null ? null : run.failure.code,
        sourceRef: null,
      },
      actor,
      { pipelineCode: spec.code, dryRun: run.dryRun, batchSha256: run.reconcile.batchSha256, watermarkBefore: run.watermarkBefore, watermarkAfter: run.watermarkAfter, stageCounts: { stages: run.stages, reconcile: run.reconcile } },
    );
    let rejects = 0;
    for (const reject of run.rejects) {
      const inserted = await tx.query(
        `insert into machvon.hub_pipeline_reject (tenant_id, id, connector_code, pipeline_code, run_id, stage, reject_code, field, source_ref, record_key, line, record)
         values (${TENANT}, gen_random_uuid(), $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb) on conflict (tenant_id, run_id, source_ref) do nothing returning id`,
        [code, spec.code, recorded.id, reject.stage, reject.code, reject.field, reject.sourceRef, reject.key, reject.line, JSON.stringify(reject.record)],
      );
      rejects += inserted.length;
    }
    let lineage = 0;
    if (!run.dryRun) {
      for (const entry of run.lineage) {
        if (entry.status === 'WOULD_APPLY') continue;
        const inserted = await tx.query(
          `insert into machvon.hub_lineage (tenant_id, id, connector_code, pipeline_code, run_id, source_ref, record_key, target_ref, status, mapping_version, layout_version, batch_sha256)
           values (${TENANT}, gen_random_uuid(), $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10) on conflict (tenant_id, run_id, source_ref) do nothing returning id`,
          [code, spec.code, recorded.id, entry.sourceRef, entry.key, entry.targetRef, entry.status, entry.mappingVersion, entry.layoutVersion, entry.batchSha256],
        );
        lineage += inserted.length;
      }
    }
    let watermarkMoved = false;
    if (!run.dryRun && run.failure === null && run.watermarkAfter !== null && run.watermarkAfter !== run.watermarkBefore) {
      await this.advanceWatermark(tx, code, spec.code, run.watermarkBefore, run.watermarkAfter, actor);
      watermarkMoved = true;
    }
    return { runId: recorded.id, rejects, lineage, watermarkMoved };
  }

  // ---- rejects -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async listRejects(tx: TenantTx, code: string, request: { state?: HubRejectRow['state'] | undefined; limit: number; after: { key: string; id: string } | undefined }): Promise<HubRejectRow[]> {
    const rows = await tx.query<RejectSql>(
      `${REJECT_SELECT} where connector_code = $1 and ($2::text is null or state = $2) and ($3::text is null or (${timestampKey('created_at')}, id) < ($3::text, $4::uuid)) order by created_at desc, id desc limit $5`,
      [code, request.state ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(rejectOf);
  }

  async findReject(tx: TenantTx, id: string, lock = false): Promise<HubRejectRow | undefined> {
    const rows = await tx.query<RejectSql>(`${REJECT_SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : rejectOf(rows[0]);
  }

  /** Closes a reject: REPROCESSED (it passed) or DISCARDED (a person decided to drop it, with a reason). A closed reject does not change (409 `HUB_REJECT_STATE_INVALID`). */
  async resolveReject(tx: TenantTx, id: string, expectedVersion: number, outcome: 'REPROCESSED' | 'DISCARDED', resolution: unknown, actor: string): Promise<{ before: HubRejectRow; row: HubRejectRow }> {
    const before = await this.findReject(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    if (before.state !== 'OPEN') throw new DomainError('HUB_REJECT_STATE_INVALID', 409, 'state');
    const text = hubReasonOf(resolution, 'resolution');
    await tx.query(`update machvon.hub_pipeline_reject set state = $2, resolved_by = $3::uuid, resolved_at = clock_timestamp(), resolution = $4, version = version + 1 where id = $1::uuid`, [id, outcome, actor, text]);
    return { before, row: (await this.findReject(tx, id)) as HubRejectRow };
  }

  async openRejectCount(tx: TenantTx, code: string): Promise<number> {
    return Number((await tx.query<{ n: string }>("select count(*)::text as n from machvon.hub_pipeline_reject where connector_code = $1 and state = 'OPEN'", [code]))[0]?.n ?? 0);
  }

  /** The newest lineage rows of a connector (source and target of each loaded record). */
  async lineage(tx: TenantTx, code: string, limit: number): Promise<Array<{ sourceRef: string; recordKey: string; targetRef: string | null; status: string; mappingVersion: string; layoutVersion: string; batchSha256: string; at: string }>> {
    const rows = await tx.query<{ source_ref: string; record_key: string; target_ref: string | null; status: string; mapping_version: string; layout_version: string; batch_sha256: string; at: string }>(
      `select source_ref, record_key, target_ref, status, mapping_version, layout_version, batch_sha256, ${iso('created_at')} as at from machvon.hub_lineage where connector_code = $1 order by created_at desc, id desc limit $2`,
      [code, limit],
    );
    return rows.map((row) => ({ sourceRef: row.source_ref, recordKey: row.record_key, targetRef: row.target_ref, status: row.status, mappingVersion: row.mapping_version, layoutVersion: row.layout_version, batchSha256: row.batch_sha256, at: row.at }));
  }

  // ---- collector agents ----------------------------------------------------------------------------------------------------------------------------------------------------------

  async listAgents(tx: TenantTx, request: { connectorCode?: string | undefined; now: Date; staleAfterMinutes: number }): Promise<HubAgentRow[]> {
    const rows = await tx.query<AgentSql>(`${AGENT_SELECT} where ($1::text is null or $1 = any(connectors)) order by state, agent_code`, [request.connectorCode ?? null]);
    return rows.map((row) => agentOf(row, request.now, request.staleAfterMinutes));
  }

  /** Registers an agent (409 `HUB_AGENT_CODE_TAKEN` for a code the tenant has; 422 for a connector code nobody registered). */
  async registerAgent(tx: TenantTx, registration: AgentRegistration, actor: string, now: Date, staleAfterMinutes: number): Promise<HubAgentRow> {
    for (const code of registration.connectors) if (!isConnectorCode(code)) throw new DomainError('VALIDATION_FAILED', 422, 'connectors');
    const inserted = await tx.query<AgentSql>(
      `insert into machvon.hub_collector_agent (tenant_id, id, agent_code, os, cpu_arch, agent_version, connectors, registered_by) values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4, $5::text[], $6::uuid)
       on conflict (tenant_id, agent_code) do nothing returning id`,
      [registration.agentCode, registration.os, registration.cpuArch, registration.agentVersion, registration.connectors, actor],
    );
    if (inserted[0] === undefined) throw new DomainError('HUB_AGENT_CODE_TAKEN', 409, 'agent_code');
    return (await this.findAgent(tx, registration.agentCode, now, staleAfterMinutes)) as HubAgentRow;
  }

  async findAgent(tx: TenantTx, agentCode: string, now: Date, staleAfterMinutes: number): Promise<HubAgentRow | undefined> {
    const rows = await tx.query<AgentSql>(`${AGENT_SELECT} where agent_code = $1`, [agentCode]);
    return rows[0] === undefined ? undefined : agentOf(rows[0], now, staleAfterMinutes);
  }

  /** A heartbeat: the time of it, the version the agent runs and the depth of its spool (409 `HUB_AGENT_RETIRED` for a retired agent). */
  async heartbeat(tx: TenantTx, agentCode: string, beat: { agentVersion: string; spoolDepth: number }, now: Date, staleAfterMinutes: number): Promise<HubAgentRow> {
    const locked = await tx.query<{ id: string; state: string; version: string }>('select id, state, version::text as version from machvon.hub_collector_agent where agent_code = $1 for update', [agentCode]);
    const row = locked[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'agent_code');
    if (row.state === 'RETIRED') throw new DomainError('HUB_AGENT_RETIRED', 409, 'agent_code');
    await tx.query(
      `update machvon.hub_collector_agent set last_heartbeat_at = greatest(coalesce(last_heartbeat_at, $2::timestamptz), $2::timestamptz), agent_version = $3, spool_depth = $4, updated_at = clock_timestamp(), version = version + 1 where id = $1::uuid`,
      [row.id, now.toISOString(), beat.agentVersion, beat.spoolDepth],
    );
    return (await this.findAgent(tx, agentCode, now, staleAfterMinutes)) as HubAgentRow;
  }
}

