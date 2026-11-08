import { Controller, Get, Inject, Optional, Param, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { HubStore, TenantDatabase } from '@machvon/db';
import type { HubRejectRow } from '@machvon/db';
import { DomainError, INCIDENT_STATES, connectorDescriptor, connectorDescriptors } from '@machvon/kernel';
import type { ConnectorDescriptor, EffectiveAccess, IncidentState, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { HUB_CLOCK } from './tokens';
import { agentDto, alertCodeOfIncident, alertTypeDto, alertTypesOf, connectorSummaryDto, incidentDto, mappingDto, policyDto, protocolViews, rejectDto, runDto, scheduleDto, summaryDto, trendDto } from './hub-view';

const TREND_POINTS = 30;
const EVENTS = 10;
const REJECT_SCAN = 200;

const descriptorOf = (code: string): ConnectorDescriptor => {
  const found = connectorDescriptor(code);
  if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'connector');
  return found;
};

function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/**
 * The reads of the Integration Hub (HUB-01 to HUB-03): the catalogue of connectors with their health, the detail of one connector with the data of every tab, its runs, the rejects of its pipelines, the incident log,
 * the health summary with the KPI set and the registered collector agents. Everything the hub shows spans the whole tenant (a connection belongs to no unit), so every read needs the permission over the whole tenant.
 * A read never writes: a connector nobody used is shown as waiting or never run, never as fine.
 */
@Controller()
export class HubReadsController {
  private readonly hub = new HubStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HUB_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  private assertWhole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Get('integration-hub/connectors')
  @OperationId('listHubConnectors')
  async connectors(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['HubConnectorList']> {
    this.assertWhole(access, PERMISSIONS.listHubConnectors);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const { items, summary } = await this.hub.readings(tx, connectorDescriptors(), now);
      return { items: items.map(connectorSummaryDto), summary: summaryDto(summary), as_of: now.toISOString() };
    });
  }

  @Get('integration-hub/connectors/:code')
  @OperationId('getHubConnector')
  async connector(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string): Promise<Schemas['HubConnectorDetail']> {
    this.assertWhole(access, PERMISSIONS.getHubConnector);
    const descriptor = descriptorOf(code);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const { policy } = await this.hub.policy(tx, now);
      const reading = await this.hub.reading(tx, descriptor, now, policy);
      const mappings = await this.hub.listMappings(tx, code);
      const rejects = await this.hub.listRejects(tx, code, { state: 'OPEN', limit: REJECT_SCAN, after: undefined });
      const recent = await this.hub.listRuns(tx, descriptor, { limit: 50, after: undefined });
      const agents = await this.hub.listAgents(tx, { connectorCode: code, now, staleAfterMinutes: policy.agentStaleAfterMinutes });
      const events = await this.hub.stateEvents(tx, code, EVENTS);
      const trend = await this.hub.trend(tx, code, TREND_POINTS);
      const openIncidents = (await this.hub.listIncidents(tx, { connectorCode: code, open: true, limit: 200, after: undefined })).length;
      const pipelines: Array<Schemas['HubPipelineView']> = [];
      for (const spec of descriptor.pipelines ?? []) {
        const last = recent.find((run) => run.pipelineCode === spec.code);
        const approved = mappings.find((mapping) => mapping.pipelineCode === spec.code && mapping.state === 'APPROVED');
        const marker = await this.hub.watermark(tx, code, spec.code);
        pipelines.push({
          code: spec.code,
          name: spec.name,
          protocol: spec.protocol,
          mode: spec.mode,
          layout_code: spec.layoutCode,
          layout_version: spec.layoutVersion,
          target: spec.target,
          stages: ['EXTRACT', 'VALIDATE', 'TRANSFORM', 'LOAD'],
          schedule: scheduleDto(spec, last === undefined ? null : new Date(last.startedAt), now),
          watermark: marker.watermark,
          approved_mapping_version: approved?.mappingVersion ?? null,
          pending_mapping_proposals: mappings.filter((mapping) => mapping.pipelineCode === spec.code && mapping.state === 'PROPOSED').length,
          open_rejects: rejects.filter((reject: HubRejectRow) => reject.pipelineCode === spec.code).length,
          last_run: last === undefined ? null : runDto(last),
        });
      }
      const rule = reading.rule;
      const freshness = descriptor.freshness;
      return {
        summary: connectorSummaryDto(reading),
        state: { enabled: reading.enabled, version: reading.stateVersion, reason: reading.stateReason, changed_at: reading.stateChangedAt, owner: reading.stateOwner },
        layouts: descriptor.layouts.map((layout) => ({ code: layout.code, version: layout.version, acceptance: layout.acceptance, pending: [...(layout.pending ?? [])] })),
        freshness_rule:
          rule === null || freshness === null
            ? null
            : {
                rule_code: freshness.ruleCode,
                source: rule.source,
                version: rule.version,
                unverified: rule.unverified,
                formula: rule.formula,
                source_text: rule.sourceText,
                as_of: rule.asOf,
                max_age_hours: rule.params.maxAgeHours,
                warn_after_hours: rule.params.warnAfterHours,
                stale_severity: rule.params.staleSeverity,
                figures_blocked_when_stale: rule.params.figuresBlockedWhenStale,
              },
        protocol_details: protocolViews(descriptor),
        credentials: { kind: descriptor.credentials.kind, scopes: [...(descriptor.credentials.scopes ?? [])], secret_store: 'VAULT' },
        egress: descriptor.egress.policy === 'NONE' ? { policy: 'NONE', hosts: [], reason: null } : { policy: 'DECLARED', hosts: [...descriptor.egress.hosts], reason: descriptor.egress.reason },
        alert_types: await alertTypesOf(tx, descriptor, now),
        pipelines,
        mappings: mappings.map(mappingDto),
        agents: agents.map(agentDto),
        state_events: events.map((event) => ({ id: event.id, action: event.action as 'ENABLED' | 'DISABLED', reason: event.reason, actor_id: event.actorId, version: event.version, occurred_at: event.occurredAt })),
        trend: trend.map(trendDto),
        open_incidents: openIncidents,
        as_of: now.toISOString(),
      };
    });
  }

  @Get('integration-hub/connectors/:code/runs')
  @OperationId('listHubConnectorRuns')
  async runs(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string, @Query() query: Record<string, unknown>): Promise<Schemas['HubRunPage']> {
    this.assertWhole(access, PERMISSIONS.listHubConnectorRuns);
    const descriptor = descriptorOf(code);
    const page = parsePageRequest(query.limit, query.cursor);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.hub.listRuns(tx, descriptor, { limit: page.limit + 1, after: page.after === undefined ? undefined : { key: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return { items: shown.map(runDto), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.startedAtKey, id: last.id }) : null, as_of: now.toISOString() };
    });
  }

  @Get('integration-hub/connectors/:code/rejects')
  @OperationId('listHubRejects')
  async rejects(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string, @Query() query: Record<string, unknown>): Promise<Schemas['HubRejectPage']> {
    this.assertWhole(access, PERMISSIONS.listHubRejects);
    descriptorOf(code);
    const state = text(query.state, 'state', 20);
    if (state !== undefined && !['OPEN', 'REPROCESSED', 'DISCARDED'].includes(state)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const page = parsePageRequest(query.limit, query.cursor);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.hub.listRejects(tx, code, { state: state as HubRejectRow['state'] | undefined, limit: page.limit + 1, after: page.after === undefined ? undefined : { key: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return {
        items: shown.map(rejectDto),
        next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
        open_count: await this.hub.openRejectCount(tx, code),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('integration-hub/incidents')
  @OperationId('listHubIncidents')
  async incidents(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['HubIncidentPage']> {
    this.assertWhole(access, PERMISSIONS.listHubIncidents);
    const state = text(query.state, 'state', 20);
    if (state !== undefined && !(INCIDENT_STATES as readonly string[]).includes(state)) throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const connectorCode = text(query.connector_code, 'connector_code', 60);
    const page = parsePageRequest(query.limit, query.cursor);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.hub.listIncidents(tx, { state: state as IncidentState | undefined, connectorCode, limit: page.limit + 1, after: page.after === undefined ? undefined : { key: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      const items: Array<Schemas['HubIncident']> = [];
      for (const row of shown) {
        const code = alertCodeOfIncident(row.kind);
        items.push(incidentDto(row, code === null ? null : await alertTypeDto(tx, code, now)));
      }
      return { items, next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.openedAtKey, id: last.id }) : null, as_of: now.toISOString() };
    });
  }

  @Get('integration-hub/health')
  @OperationId('getHubHealthSummary')
  async health(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['HubHealthSummary']> {
    this.assertWhole(access, PERMISSIONS.getHubHealthSummary);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const { summary, policy } = await this.hub.readings(tx, connectorDescriptors(), now);
      const { rule } = await this.hub.policy(tx, now);
      const kpis = await this.hub.kpis(tx, summary, now);
      const trend = await this.hub.trend(tx, null, TREND_POINTS);
      return {
        summary: summaryDto(summary),
        kpis: kpis.map((kpi) => ({
          code: kpi.code,
          name: kpi.definition.name,
          formula: kpi.definition.formula,
          numerator: kpi.definition.numerator,
          denominator: kpi.definition.denominator,
          exclusions: kpi.definition.exclusions,
          source: kpi.definition.source,
          owner: kpi.definition.owner,
          unit: kpi.definition.unit,
          decimals: kpi.definition.decimals,
          value: kpi.value,
          as_of: now.toISOString(),
          unverified: kpi.definition.unverified,
          rule_version: kpi.definition.version,
        })),
        trend: trend.map(trendDto),
        policy: policyDto(policy, rule?.source ?? 'DEFAULT', rule?.unverified ?? true),
        as_of: now.toISOString(),
      };
    });
  }

  @Get('integration-hub/agents')
  @OperationId('listHubAgents')
  async agents(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['HubAgentList']> {
    this.assertWhole(access, PERMISSIONS.listHubAgents);
    const connectorCode = text(query.connector_code, 'connector_code', 60);
    const now = this.clock();
    return this.database.withTenant(tenant, async (tx) => {
      const { policy } = await this.hub.policy(tx, now);
      const rows = await this.hub.listAgents(tx, { connectorCode, now, staleAfterMinutes: policy.agentStaleAfterMinutes });
      return { items: rows.map(agentDto), stale_after_minutes: policy.agentStaleAfterMinutes, as_of: now.toISOString() };
    });
  }
}
