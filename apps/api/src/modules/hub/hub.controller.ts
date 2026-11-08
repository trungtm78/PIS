import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { HubStore } from '@machvon/db';
import {
  DomainError,
  agentHeartbeatOf,
  agentRegistrationOf,
  connectorDescriptor,
  connectorDescriptors,
  hubReasonOf,
  hubRunOf,
  reprocessRejects,
} from '@machvon/kernel';
import type { ConnectorDescriptor, EffectiveAccess, FieldMapping, IncidentMove, SourceRecord } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { connectorResourceId } from './hub-view';
import { HUB_CLOCK, HUB_PIPELINE_EXECUTORS } from './tokens';
import type { HubPipelinePorts } from './tokens';

const CLASSIFICATION = 'INTERNAL';

const descriptorOf = (code: string): ConnectorDescriptor => {
  const found = connectorDescriptor(code);
  if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'connector');
  return found;
};

/**
 * The commands of the Integration Hub. A connector is switched on or off with a reason (through the connector's own command when it has one), runs are reported by the connector or a machine account, a sweep takes
 * the hourly snapshots and brings the incidents in line with the health, people report, acknowledge and resolve incidents, a mapping version is proposed by one person and decided by another, a reject is reprocessed
 * after correction or discarded with a reason, and collector agents register and send heartbeats. Every command is audited and announced in the outbox with ids, codes and counts, never the words of a person
 * or a record of the other side. The hub spans the whole tenant, so every command needs the permission over the whole tenant.
 */
@Controller()
export class HubController {
  private readonly hub = new HubStore();
  private readonly clock: () => Date;

  constructor(
    @Optional() @Inject(HUB_CLOCK) clock?: () => Date,
    @Optional() @Inject(HUB_PIPELINE_EXECUTORS) private readonly executors?: ReadonlyMap<string, HubPipelinePorts>,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  private assertWhole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Post('integration-hub/connectors/:code/state')
  @HttpCode(200)
  @OperationId('setHubConnectorState')
  @Command({ operation: 'setHubConnectorState', versioned: true })
  async setState(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string, @Body() body: Schemas['HubConnectorStateRequest']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.setHubConnectorState);
    descriptorOf(code);
    const done = await this.hub.setState(scope.tx, code, scope.expectedVersion ?? 0, { enabled: body.enabled, reason: body.reason }, scope.tenant.membershipId);
    await scope.audit({
      action: 'hub.connector_switched',
      resourceType: 'hub_connector',
      resourceId: connectorResourceId(scope.tenant.tenantId, code),
      classification: CLASSIFICATION,
      reason: done.after.reason ?? body.reason,
      diff: { connector_code: code, from_enabled: done.before.enabled, to_enabled: done.after.enabled, delegated_to_connector: done.delegated },
    });
    await scope.emit({
      aggregateType: 'hub_connector',
      aggregateId: connectorResourceId(scope.tenant.tenantId, code),
      aggregateVersion: done.after.version,
      type: 'hub.connector.state_changed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, connector_code: code, enabled: done.after.enabled, version: done.after.version, delegated: done.delegated, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `hub_connector:${code}:${done.after.version}:${done.after.enabled ? 'on' : 'off'}`,
    });
    return commandResult(scope, done.after.enabled ? 'ENABLED' : 'DISABLED', done.after.version, connectorResourceId(scope.tenant.tenantId, code));
  }

  @Post('integration-hub/connectors/:code/runs')
  @HttpCode(200)
  @OperationId('recordHubRun')
  @Command({ operation: 'recordHubRun' })
  async recordRun(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string, @Body() body: Schemas['HubRunRequest']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.recordHubRun);
    descriptorOf(code);
    const now = this.clock();
    const run = hubRunOf(body as unknown as Record<string, unknown>, now);
    const recorded = await this.hub.recordRun(scope.tx, code, run, scope.tenant.membershipId);
    // The hub's incidents follow the health this run changed: a failed run opens the incident of the connector, a good one closes it.
    const { items, summary, policy } = await this.hub.readings(scope.tx, connectorDescriptors(), now);
    const change = await this.hub.syncIncidents(scope.tx, items, summary, policy);
    await scope.audit({
      action: recorded.duplicate ? 'hub.run_repeated' : 'hub.run_recorded',
      resourceType: 'hub_run',
      resourceId: recorded.id,
      classification: CLASSIFICATION,
      diff: { connector_code: code, kind: run.kind, outcome: run.outcome, rows_total: run.rowsTotal, rows_applied: run.rowsApplied, rows_rejected: run.rowsRejected, error_code: run.errorCode, incidents_opened: change.opened.length, incidents_auto_resolved: change.autoResolved.length },
    });
    if (!recorded.duplicate) {
      await scope.emit({
        aggregateType: 'hub_run',
        aggregateId: recorded.id,
        aggregateVersion: 1,
        type: 'hub.run.recorded.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, run_id: recorded.id, connector_code: code, outcome: run.outcome, error_code: run.errorCode, rows_total: run.rowsTotal, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `hub_run:${recorded.id}`,
      });
    }
    await this.announceIncidents(scope, change, now);
    return commandResult(scope, recorded.duplicate ? 'ALREADY_RECORDED' : 'RECORDED', 1, recorded.id);
  }

  private async announceIncidents(scope: CommandScope, change: { opened: Array<{ id: string; connectorCode: string | null; kind: string; severity: string; version: number }>; autoResolved: Array<{ id: string; connectorCode: string | null; kind: string; version: number }> }, now: Date): Promise<void> {
    for (const row of change.opened) {
      await scope.audit({ action: 'hub.incident_opened', resourceType: 'hub_incident', resourceId: row.id, classification: CLASSIFICATION, diff: { connector_code: row.connectorCode, kind: row.kind, severity: row.severity } });
      await scope.emit({
        aggregateType: 'hub_incident',
        aggregateId: row.id,
        aggregateVersion: row.version,
        type: 'hub.incident.opened.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, incident_id: row.id, connector_code: row.connectorCode, kind: row.kind, severity: row.severity, occurred_at: now.toISOString() },
        eventKey: `hub_incident:${row.id}:${row.version}`,
      });
    }
    for (const row of change.autoResolved) {
      await scope.audit({ action: 'hub.incident_auto_resolved', resourceType: 'hub_incident', resourceId: row.id, classification: CLASSIFICATION, diff: { connector_code: row.connectorCode, kind: row.kind } });
      await scope.emit({
        aggregateType: 'hub_incident',
        aggregateId: row.id,
        aggregateVersion: row.version,
        type: 'hub.incident.auto_resolved.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, incident_id: row.id, connector_code: row.connectorCode, kind: row.kind, occurred_at: now.toISOString() },
        eventKey: `hub_incident:${row.id}:${row.version}`,
      });
    }
  }

  @Post('integration-hub/incidents')
  @HttpCode(200)
  @OperationId('openHubIncident')
  @Command({ operation: 'openHubIncident' })
  async openIncident(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['HubIncidentRequest']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.openHubIncident);
    const row = await this.hub.openManual(scope.tx, body.connector_code, { summary: body.summary, ...(body.severity === undefined ? {} : { severity: body.severity }) }, scope.tenant.membershipId);
    await scope.audit({ action: 'hub.incident_reported', resourceType: 'hub_incident', resourceId: row.id, classification: CLASSIFICATION, reason: body.summary, diff: { connector_code: row.connectorCode, kind: row.kind, severity: row.severity } });
    await scope.emit({
      aggregateType: 'hub_incident',
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hub.incident.opened.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, incident_id: row.id, connector_code: row.connectorCode, kind: row.kind, severity: row.severity, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `hub_incident:${row.id}:${row.version}`,
    });
    return commandResult(scope, 'OPENED', row.version, row.id);
  }

  @Post('integration-hub/incidents/:id/decision')
  @HttpCode(200)
  @OperationId('decideHubIncident')
  @Command({ operation: 'decideHubIncident', versioned: true })
  async decideIncident(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['HubIncidentDecision']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.decideHubIncident);
    const move: IncidentMove = body.decision;
    const done = await this.hub.moveIncident(scope.tx, id, scope.expectedVersion ?? 0, { move, reason: body.reason }, scope.tenant.membershipId);
    const type = done.row.state === 'RESOLVED' ? 'hub.incident.resolved.v1' : 'hub.incident.acknowledged.v1';
    await scope.audit({ action: done.row.state === 'RESOLVED' ? 'hub.incident_resolved' : 'hub.incident_acknowledged', resourceType: 'hub_incident', resourceId: id, classification: CLASSIFICATION, reason: body.reason, diff: { connector_code: done.row.connectorCode, kind: done.row.kind, from_state: done.before.state, to_state: done.row.state } });
    await scope.emit({
      aggregateType: 'hub_incident',
      aggregateId: id,
      aggregateVersion: done.row.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, incident_id: id, connector_code: done.row.connectorCode, kind: done.row.kind, state: done.row.state, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `hub_incident:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('integration-hub/snapshots')
  @HttpCode(200)
  @OperationId('captureHubSnapshot')
  @Command({ operation: 'captureHubSnapshot' })
  async capture(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() _body: Schemas['HubSnapshotRequest']): Promise<Schemas['HubSnapshotResult']> {
    this.assertWhole(access, PERMISSIONS.captureHubSnapshot);
    const now = this.clock();
    const swept = await this.hub.sweep(scope.tx, connectorDescriptors(), now, scope.tenant.membershipId);
    await scope.audit({
      action: 'hub.snapshot_captured',
      resourceType: 'hub_snapshot',
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { bucket: swept.bucket, snapshots_written: swept.snapshotsWritten, incidents_opened: swept.incidents.opened.length, incidents_auto_resolved: swept.incidents.autoResolved.length, healthy: swept.summary.healthy, monitored: swept.summary.monitored },
    });
    if (swept.snapshotsWritten > 0) {
      await scope.emit({
        aggregateType: 'hub_snapshot',
        aggregateId: scope.tenant.tenantId,
        aggregateVersion: 1,
        type: 'hub.snapshot.captured.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, bucket: swept.bucket, snapshots_written: swept.snapshotsWritten, healthy: swept.summary.healthy, monitored: swept.summary.monitored, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `hub_snapshot:${scope.tenant.tenantId}:${swept.bucket}`,
      });
    }
    await this.announceIncidents(scope, swept.incidents, now);
    return {
      bucket: swept.bucket,
      snapshots_written: swept.snapshotsWritten,
      incidents_opened: swept.incidents.opened.length,
      incidents_auto_resolved: swept.incidents.autoResolved.length,
      summary: {
        total: swept.summary.total,
        monitored: swept.summary.monitored,
        healthy: swept.summary.healthy,
        counts: { ...swept.summary.counts },
        healthy_percent: swept.summary.healthyPercent,
        oldest_data_age_hours: swept.summary.oldestDataAgeHours,
        oldest_data_connector: swept.summary.oldestDataConnector,
        failed_runs_7d: swept.summary.failedRuns7d,
        discrepancy_backlog: swept.summary.discrepancyBacklog,
        pending_mappings: swept.summary.pendingMappings,
        hub_alert: swept.summary.hubAlert === null ? null : { code: swept.summary.hubAlert.code, severity: swept.summary.hubAlert.severity },
      },
    };
  }

  @Post('integration-hub/connectors/:code/mappings')
  @HttpCode(200)
  @OperationId('proposeHubMapping')
  @Command({ operation: 'proposeHubMapping' })
  async proposeMapping(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string, @Body() body: Schemas['HubMappingRequest']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.proposeHubMapping);
    descriptorOf(code);
    const row = await this.hub.proposeMapping(scope.tx, code, body.pipeline_code, body.mapping_version, body.fields as unknown as FieldMapping[], scope.tenant.membershipId);
    await scope.audit({ action: 'hub.mapping_proposed', resourceType: 'hub_mapping', resourceId: row.id, classification: CLASSIFICATION, diff: { connector_code: code, pipeline_code: row.pipelineCode, mapping_version: row.mappingVersion, field_count: row.fields.length } });
    await scope.emit({
      aggregateType: 'hub_mapping',
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hub.mapping.proposed.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, mapping_id: row.id, connector_code: code, pipeline_code: row.pipelineCode, mapping_version: row.mappingVersion, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `hub_mapping:${row.id}:${row.version}`,
    });
    return commandResult(scope, 'PROPOSED', row.version, row.id);
  }

  @Post('integration-hub/mappings/:id/decision')
  @HttpCode(200)
  @OperationId('decideHubMapping')
  @Command({ operation: 'decideHubMapping', versioned: true })
  async decideMapping(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['HubMappingDecision']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.decideHubMapping);
    const done = await this.hub.decideMapping(scope.tx, id, scope.expectedVersion ?? 0, body.decision, body.reason, scope.tenant.membershipId);
    const approved = done.row.state === 'APPROVED';
    await scope.audit({
      action: approved ? 'hub.mapping_approved' : 'hub.mapping_rejected',
      resourceType: 'hub_mapping',
      resourceId: id,
      classification: CLASSIFICATION,
      reason: body.reason,
      diff: { connector_code: done.row.connectorCode, pipeline_code: done.row.pipelineCode, mapping_version: done.row.mappingVersion, retired_version: done.retired?.mappingVersion ?? null },
    });
    await scope.emit({
      aggregateType: 'hub_mapping',
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: approved ? 'hub.mapping.approved.v1' : 'hub.mapping.rejected.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, mapping_id: id, connector_code: done.row.connectorCode, pipeline_code: done.row.pipelineCode, mapping_version: done.row.mappingVersion, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `hub_mapping:${id}:${done.row.version}`,
    });
    return commandResult(scope, done.row.state, done.row.version, id);
  }

  @Post('integration-hub/rejects/:id/decision')
  @HttpCode(200)
  @OperationId('decideHubReject')
  @Command({ operation: 'decideHubReject', versioned: true })
  async decideReject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['HubRejectDecision']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.decideHubReject);
    const reason = hubReasonOf(body.reason);
    const reject = await this.hub.findReject(scope.tx, id);
    if (reject === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (reject.state !== 'OPEN') throw new DomainError('HUB_REJECT_STATE_INVALID', 409, 'state');
    let outcome: 'REPROCESSED' | 'DISCARDED' = 'DISCARDED';
    if (body.decision === 'REPROCESS') {
      const descriptor = descriptorOf(reject.connectorCode);
      const spec = (descriptor.pipelines ?? []).find((pipeline) => pipeline.code === reject.pipelineCode);
      const ports = this.executors?.get(reject.connectorCode);
      if (spec === undefined || ports === undefined) throw new DomainError('HUB_PIPELINE_NOT_WIRED', 409, 'pipeline_code');
      const mapping = await this.hub.approvedMapping(scope.tx, reject.connectorCode, reject.pipelineCode);
      if (mapping === undefined) throw new DomainError('HUB_MAPPING_NOT_APPROVED', 409, 'mapping');
      const result = await reprocessRejects({
        spec,
        mapping,
        ports: ports(scope.tx, reject.pipelineCode),
        rejects: [{ stage: reject.stage, code: reject.rejectCode, field: reject.field, sourceRef: reject.sourceRef, key: reject.recordKey, line: reject.line, record: reject.record as unknown as SourceRecord }],
        corrections: { [reject.sourceRef]: (body.corrections ?? {}) as Record<string, string | number | boolean | null> },
      });
      const still = result.stillRejected[0];
      if (result.failure !== null) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'load');
      if (still !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'corrections', { extensions: { reject_code: still.code, stage: still.stage } });
      const entry = result.resolved[0]?.lineage;
      if (entry !== undefined && (entry.status === 'APPLIED' || entry.status === 'DUPLICATE')) {
        await this.hub.addLineage(scope.tx, reject.connectorCode, reject.pipelineCode, reject.runId, { sourceRef: entry.sourceRef, key: entry.key, targetRef: entry.targetRef, status: entry.status, mappingVersion: entry.mappingVersion, layoutVersion: entry.layoutVersion, batchSha256: entry.batchSha256 });
      }
      outcome = 'REPROCESSED';
    }
    const done = await this.hub.resolveReject(scope.tx, id, scope.expectedVersion ?? 0, outcome, reason, scope.tenant.membershipId);
    await scope.audit({ action: outcome === 'REPROCESSED' ? 'hub.reject_reprocessed' : 'hub.reject_discarded', resourceType: 'hub_reject', resourceId: id, classification: CLASSIFICATION, reason, diff: { connector_code: done.row.connectorCode, pipeline_code: done.row.pipelineCode, stage: done.row.stage, reject_code: done.row.rejectCode } });
    await scope.emit({
      aggregateType: 'hub_reject',
      aggregateId: id,
      aggregateVersion: done.row.version,
      type: outcome === 'REPROCESSED' ? 'hub.reject.reprocessed.v1' : 'hub.reject.discarded.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, reject_id: id, connector_code: done.row.connectorCode, pipeline_code: done.row.pipelineCode, reject_code: done.row.rejectCode, actor_id: scope.tenant.membershipId, occurred_at: this.clock().toISOString() },
      eventKey: `hub_reject:${id}:${done.row.version}`,
    });
    return commandResult(scope, outcome, done.row.version, id);
  }

  @Post('integration-hub/agents')
  @HttpCode(200)
  @OperationId('registerHubAgent')
  @Command({ operation: 'registerHubAgent' })
  async registerAgent(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['HubAgentRequest']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.registerHubAgent);
    const registration = agentRegistrationOf(body as unknown as Record<string, unknown>);
    const now = this.clock();
    const { policy } = await this.hub.policy(scope.tx, now);
    const row = await this.hub.registerAgent(scope.tx, registration, scope.tenant.membershipId, now, policy.agentStaleAfterMinutes);
    await scope.audit({ action: 'hub.agent_registered', resourceType: 'hub_agent', resourceId: row.id, classification: CLASSIFICATION, diff: { agent_code: row.agentCode, platform: `${row.os}/${row.cpuArch}`, agent_version: row.agentVersion, connectors: row.connectors } });
    await scope.emit({
      aggregateType: 'hub_agent',
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hub.agent.registered.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, agent_id: row.id, agent_code: row.agentCode, os: row.os, cpu_arch: row.cpuArch, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `hub_agent:${row.id}:${row.version}`,
    });
    return commandResult(scope, 'REGISTERED', row.version, row.id);
  }

  @Post('integration-hub/agents/:code/heartbeat')
  @HttpCode(200)
  @OperationId('heartbeatHubAgent')
  @Command({ operation: 'heartbeatHubAgent' })
  async heartbeat(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string, @Body() body: Schemas['HubAgentHeartbeat']): Promise<CommandResult> {
    this.assertWhole(access, PERMISSIONS.heartbeatHubAgent);
    const beat = agentHeartbeatOf(body as unknown as Record<string, unknown>);
    const now = this.clock();
    const { policy } = await this.hub.policy(scope.tx, now);
    const row = await this.hub.heartbeat(scope.tx, code, beat, now, policy.agentStaleAfterMinutes);
    await scope.audit({ action: 'hub.agent_heartbeat', resourceType: 'hub_agent', resourceId: row.id, classification: CLASSIFICATION, diff: { agent_code: row.agentCode, agent_version: row.agentVersion, spool_depth: row.spoolDepth } });
    await scope.emit({
      aggregateType: 'hub_agent',
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'hub.agent.heartbeat.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, agent_id: row.id, agent_code: row.agentCode, spool_depth: row.spoolDepth, occurred_at: now.toISOString() },
      eventKey: `hub_agent:${row.id}:${row.version}`,
    });
    return commandResult(scope, 'RECEIVED', row.version, row.id);
  }
}
