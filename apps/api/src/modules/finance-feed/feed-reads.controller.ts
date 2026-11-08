import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, FeedConnectionStore, FeedDifferenceStore, FeedMappingStore, FileImportStore, FinanceFeedFactsReader as ProvinceFactsReader, TenantDatabase } from '@machvon/db';
import type { ProvinceFactsFilter } from '@machvon/db';
import {
  DomainError,
  FEED_CHANNELS,
  FEED_MAPPING_STATUSES,
  FEED_SOURCE_SYSTEM,
  FEED_LAYOUT_VERSIONS,
  effectivePermissions,
  feedAlertsFor,
  feedGroupByOf,
  feedKindOf,
  holdsPermission,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, FeedChannel, TenantContext } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { CurrentAccess } from '../../current-access.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { differenceDto, factsDto, healthDto, layoutsDto, mappingDto, pendingExternalDto, projectFactDto, qualityDto, rowErrorDto, runDto } from './feed-view';

const LAST_RUNS = 5;
const HISTORY = 10;
const ERROR_CAP = 500;
const UNMAPPED_LIMIT = 200;
const PROJECT_PAGE_CAP = 200;

/** A query value that must be one non-empty string or absent. */
function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return parsed;
}

function day(value: unknown, field: string): string | undefined {
  const given = text(value, field, 10);
  if (given === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(given) || new Date(`${given}T00:00:00Z`).toISOString().slice(0, 10) !== given) throw new DomainError('VALIDATION_FAILED', 422, field);
  return given;
}

/** The reporting month the screens open on: the month before today in the fiscal year of today (December of the year before in January). */
function reportingPeriod(today: string): { fiscalYear: number; month: number } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? { fiscalYear: year - 1, month: 12 } : { fiscalYear: year, month: month - 1 };
}

/**
 * The reads of the feed of the Finance Department (FEED-01 to FEED-05 and the province facts). Every read spans the whole tenant (a record is not owned by one unit), so each is judged on a grant over the whole
 * tenant. A read never writes: a tenant that never used the connection sees it as it will be created. The facts are read through `ProvinceFactsReader`, which no adapter reaches.
 */
@Controller()
export class FeedReadsController {
  private readonly connections = new FeedConnectionStore();
  private readonly mappings = new FeedMappingStore();
  private readonly differences = new FeedDifferenceStore();
  private readonly imports = new FileImportStore();
  private readonly people = new BidWorkflowReads();
  private readonly reader = new ProvinceFactsReader();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  @Get('finance-feed/connection')
  @OperationId('getFinanceFeedConnection')
  async connection(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getFinanceFeedConnection);
    const now = new Date();
    const today = vietnamDateOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const current = await this.connections.current(tx);
      const health = await this.connections.health(tx, now, current);
      const positions = await this.connections.positions(tx);
      const runs = await this.connections.lastRuns(tx, LAST_RUNS);
      const recordCounts = await this.connections.recordCounts(tx, current.generatorEpoch);
      const mappingCounts = await this.mappings.counts(tx);
      const events = await this.connections.events(tx, HISTORY);
      const period = typeof current.generatorParams?.fiscal_year === 'number' && typeof current.generatorParams?.current_month === 'number' ? { fiscalYear: current.generatorParams.fiscal_year, month: current.generatorParams.current_month } : reportingPeriod(today);
      const differenceCounts = await this.differences.counts(tx, period.fiscalYear);
      const quality = await this.reader.quality(tx, { ...period, today, policy: health.policy.params });
      const largeOpen = await this.differences.openLarge(tx, 20);
      const alerts = feedAlertsFor({ enabled: current.enabled, health: health.health, lateUnits: quality.lateUnits.map((unit) => unit.investorCode), largeOpenDifferences: largeOpen.map((row) => `${row.feedProjectCode}|${row.fiscalYear}|${row.field}`) });
      const findings = await this.reader.findings(tx, period.fiscalYear);
      const names = await this.people.names(tx, [current.stateChangedBy, ...runs.map((run) => run.importedBy), ...events.map((event) => event.actorId)]);
      const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));
      return {
        connector_code: current.connectorCode,
        registered: current.id !== null,
        enabled: current.enabled,
        state_reason: current.stateReason,
        state_changed_at: current.stateChangedAt,
        state_changed_by_name: nameOf(current.stateChangedBy),
        layout_version: current.layoutVersion,
        supported_layouts: [...FEED_LAYOUT_VERSIONS],
        acceptance: health.health.acceptance,
        version: current.version,
        channels: [
          { channel: 'FILE', adapter_status: 'PROPOSED', opens_network: false },
          { channel: 'API_PUSH', adapter_status: 'MISSING', opens_network: false, reason: 'MACHINE_ACCOUNT_PENDING' },
          { channel: 'GENERATOR', adapter_status: 'MOCK', opens_network: false },
        ],
        health: healthDto(health),
        pending_external: pendingExternalDto(),
        positions: positions.map((position) => ({ kind: position.kind, connector_code: position.connectorCode, cursor_status: position.cursorStatus, last_success_at: position.lastSuccessAt, last_error_code: position.lastErrorCode, last_file_sha256: position.lastFileSha256 })),
        layouts: layoutsDto(),
        generator: { state: current.generatorState, epoch: current.generatorEpoch, parameters: current.generatorParams === null ? null : { ...current.generatorParams, anchors: undefined, anchor_count: Array.isArray(current.generatorParams.anchors) ? current.generatorParams.anchors.length : 0 } },
        last_runs: runs.map((run) => runDto(run, names)),
        record_counts: recordCounts,
        mapping_counts: mappingCounts,
        difference_counts: { open: differenceCounts.open, open_large: differenceCounts.openLarge, resolved: differenceCounts.resolved },
        quality: qualityDto(quality, findings, now.toISOString()),
        alerts: alerts.map((alert) => ({ code: alert.code, severity: alert.severity, subject: alert.subject })),
        history: events.map((event) => ({ id: event.id, action: event.action, reason: event.reason, detail: event.detail, actor_name: nameOf(event.actorId), version: event.version, occurred_at: event.occurredAt })),
        actions: {
          set_state: holdsOnWholeTenant(access, PERMISSIONS.setFinanceFeedConnectionState),
          control_generator: holdsOnWholeTenant(access, PERMISSIONS.controlFinanceFeedGenerator),
          preview: holdsOnWholeTenant(access, PERMISSIONS.previewFinanceFeedFile),
          apply: holdsOnWholeTenant(access, PERMISSIONS.importFinanceFeedFile),
          propose_mapping: holdsOnWholeTenant(access, PERMISSIONS.proposeFinanceFeedMapping),
          decide_mapping: holdsOnWholeTenant(access, PERMISSIONS.decideFinanceFeedMapping),
          reconcile: holdsOnWholeTenant(access, PERMISSIONS.runFinanceFeedReconciliation),
          resolve: holdsOnWholeTenant(access, PERMISSIONS.resolveFinanceFeedDifference),
        },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('finance-feed/runs')
  @OperationId('listFinanceFeedRuns')
  async listRuns(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.listFinanceFeedRuns);
    const now = new Date();
    const channelText = text(query.channel, 'channel', 20);
    if (channelText !== undefined && !(FEED_CHANNELS as readonly string[]).includes(channelText)) throw new DomainError('VALIDATION_FAILED', 422, 'channel');
    const kindText = text(query.kind, 'kind', 20);
    const kind = kindText === undefined ? undefined : feedKindOf(kindText);
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.connections.listRuns(tx, { channel: channelText as FeedChannel | undefined, kind, limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await this.people.names(tx, shown.map((run) => run.importedBy));
      return { items: shown.map((run) => runDto(run, names)), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null, as_of: now.toISOString() };
    });
  }

  @Get('finance-feed/runs/:id')
  @OperationId('getFinanceFeedRun')
  async run(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getFinanceFeedRun);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const run = await this.connections.findRun(tx, id);
      if (run === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const refused = run.fileImportId === null ? [] : await this.imports.quarantined(tx, run.fileImportId, ERROR_CAP + 1);
      const names = await this.people.names(tx, [run.importedBy]);
      return { run: runDto(run, names), errors: refused.slice(0, ERROR_CAP).map(rowErrorDto), errors_truncated: refused.length > ERROR_CAP, as_of: now.toISOString() };
    });
  }

  @Get('finance-feed/mappings')
  @OperationId('listFinanceFeedMappings')
  async listMappings(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.listFinanceFeedMappings);
    const now = new Date();
    const status = text(query.status, 'status', 20);
    if (status !== undefined && !(FEED_MAPPING_STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const q = text(query.q, 'q');
    const request = parsePageRequest(query.limit, query.cursor);
    const caller = { membershipId: tenant.membershipId, mayDecide: holdsOnWholeTenant(access, PERMISSIONS.decideFinanceFeedMapping), mayRetire: holdsOnWholeTenant(access, PERMISSIONS.retireFinanceFeedMapping) };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.mappings.list(tx, { status: status as (typeof FEED_MAPPING_STATUSES)[number] | undefined, q }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await this.people.names(tx, shown.flatMap((row) => [row.proposedBy, row.approvedBy, row.retiredBy]));
      return {
        items: shown.map((row) => mappingDto(row, names, caller)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
        counts: await this.mappings.counts(tx),
        source_system: FEED_SOURCE_SYSTEM,
        as_of: now.toISOString(),
      };
    });
  }

  @Get('finance-feed/unmapped')
  @OperationId('listFinanceFeedUnmapped')
  async unmapped(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.listFinanceFeedUnmapped);
    const now = new Date();
    const limit = integer(query.limit, 'limit', 1, UNMAPPED_LIMIT) ?? 50;
    return this.database.withTenant(tenant, async (tx) => {
      const epoch = (await this.connections.current(tx)).generatorEpoch;
      const found = await this.mappings.unmapped(tx, epoch, limit);
      return { items: found.items.map((item) => ({ feed_project_code: item.feedProjectCode, project_name: item.projectName, investor_code: item.investorCode, our_code_hint: item.ourCodeHint, as_of_statement: item.asOf })), total: found.total, as_of: now.toISOString() };
    });
  }

  @Get('finance-feed/differences')
  @OperationId('listFinanceFeedDifferences')
  async listDifferences(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.listFinanceFeedDifferences);
    const now = new Date();
    const state = text(query.state, 'state', 10);
    if (state !== undefined && state !== 'OPEN' && state !== 'RESOLVED') throw new DomainError('VALIDATION_FAILED', 422, 'state');
    const largeText = text(query.large, 'large', 5);
    if (largeText !== undefined && largeText !== 'true' && largeText !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'large');
    const q = text(query.q, 'q');
    const fiscalYear = integer(query.fiscal_year, 'fiscal_year', 2000, 2100);
    const request = parsePageRequest(query.limit, query.cursor);
    const held = effectivePermissions(access, now);
    const caller = { membershipId: tenant.membershipId, mayResolve: holdsPermission(held, PERMISSIONS.resolveFinanceFeedDifference) };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.differences.list(tx, { state: state as 'OPEN' | 'RESOLVED' | undefined, large: largeText === undefined ? undefined : largeText === 'true', q, fiscalYear }, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await this.people.names(tx, shown.flatMap((row) => [row.ownerId, row.resolvedBy]));
      const counts = await this.differences.counts(tx, fiscalYear);
      return {
        items: shown.map((row) => differenceDto(row, names, caller)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.openedAtKey, id: last.id }) : null,
        counts: { open: counts.open, open_large: counts.openLarge, resolved: counts.resolved, figures_compared: counts.comparedLatest },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('finance-feed/quality')
  @OperationId('getFinanceFeedQuality')
  async quality(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getFinanceFeedQuality);
    const now = new Date();
    const today = vietnamDateOf(now);
    const defaults = reportingPeriod(today);
    const fiscalYear = integer(query.fiscal_year, 'fiscal_year', 2000, 2100) ?? defaults.fiscalYear;
    const month = integer(query.month, 'month', 1, 12) ?? (fiscalYear === defaults.fiscalYear ? defaults.month : 12);
    return this.database.withTenant(tenant, async (tx) => {
      const { policy } = await this.connections.rules(tx, now);
      const quality = await this.reader.quality(tx, { fiscalYear, month, today, policy: policy.params });
      const findings = await this.reader.findings(tx, fiscalYear);
      return qualityDto(quality, findings, now.toISOString());
    });
  }

  private filterOf(query: Record<string, unknown>): ProvinceFactsFilter {
    const fiscalYear = integer(query.fiscal_year, 'fiscal_year', 2000, 2100);
    if (fiscalYear === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'fiscal_year');
    return { fiscalYear, asOf: day(query.as_of, 'as_of'), sector: text(query.sector, 'sector', 30), district: text(query.district, 'district', 30), investor: text(query.investor, 'investor', 30), fund: text(query.fund, 'fund', 30) };
  }

  /** The province-wide facts by sector, district, investor, fund or month: the one read the dashboard of the head of the committee builds on. */
  @Get('finance-feed/facts')
  @OperationId('getFinanceFeedFacts')
  async facts(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.getFinanceFeedFacts);
    const now = new Date();
    const filter = this.filterOf(query);
    const groupBy = feedGroupByOf(query.group_by);
    return this.database.withTenant(tenant, async (tx) => {
      const facts = await this.reader.facts(tx, filter, groupBy);
      const health = await this.connections.health(tx, now, await this.connections.current(tx));
      return { ...factsDto(facts, now.toISOString()), freshness: { status: health.health.status, age_hours: health.health.ageHours, last_run_at: health.lastRunAt, figures_blocked: health.health.figuresBlocked }, acceptance: health.health.acceptance };
    });
  }

  @Get('finance-feed/projects')
  @OperationId('listFinanceFeedProjects')
  async projects(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.whole(access, PERMISSIONS.listFinanceFeedProjects);
    const now = new Date();
    const filter = this.filterOf(query);
    const limit = Math.min(integer(query.limit, 'limit', 1, PROJECT_PAGE_CAP) ?? 50, PROJECT_PAGE_CAP);
    const cursor = text(query.cursor, 'cursor', 120);
    return this.database.withTenant(tenant, async (tx) => {
      const all = await this.reader.projects(tx, filter);
      const at = cursor === undefined ? -1 : all.findIndex((fact) => `${fact.feedProjectCode}|${fact.channel}` === cursor);
      if (cursor !== undefined && at < 0) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
      const rest = all.slice(at + 1);
      const shown = rest.slice(0, limit);
      const last = shown[shown.length - 1];
      return { items: shown.map(projectFactDto), total: all.length, next_cursor: rest.length > limit && last !== undefined ? `${last.feedProjectCode}|${last.channel}` : null, as_of: now.toISOString() };
    });
  }
}

