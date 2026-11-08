import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, EgpConnectionStore, EgpMappingStore, FileImportStore, TenantDatabase } from '@machvon/db';
import type { EgpMappingFilter } from '@machvon/db';
import { DomainError, EGP_LAYOUT_VERSIONS, EGP_POSITIONS, EGP_SUGGESTION_THRESHOLD, EGP_MAPPING_STATUSES, effectivePermissions, egpKindOf, holdsPermission, isEgpSubjectType } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { CurrentAccess } from '../../current-access.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { SUGGESTION_FORMULA, SUGGESTION_SOURCE, healthDto, layoutsDto, mappingDto, pendingExternalDto, rowErrorDto, runDto } from './egp-view';

/** The most recent runs BID-22 shows beside the status, and the most recent events of the switch. */
const LAST_RUNS = 5;
const HISTORY = 10;
const ERROR_CAP = 500;
const SUGGESTION_LIMIT = 200;

/** A query value that must be one non-empty string or absent. */
function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/**
 * The reads of the connection to the national procurement network (BID-22, BID-23, BID-24). The status and the health of the connection are read by anyone who may read BID; the runs, the mappings and the
 * suggestions span the whole tenant (a file is not owned by one unit), so they are read on a grant over the whole tenant. A read never writes: a tenant that never used the connection sees it as it will be created.
 */
@Controller()
export class EgpReadsController {
  private readonly connections = new EgpConnectionStore();
  private readonly mappings = new EgpMappingStore();
  private readonly imports = new FileImportStore();
  private readonly people = new BidWorkflowReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('egp/connection')
  @OperationId('getEgpConnection')
  async connection(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = new Date();
    const held = effectivePermissions(access, now);
    return this.database.withTenant(tenant, async (tx) => {
      const current = await this.connections.current(tx);
      const health = await this.connections.health(tx, now, current);
      const registry = await this.connections.registryEntry(tx);
      const positions = await this.connections.positions(tx);
      const runs = await this.connections.lastRuns(tx, LAST_RUNS);
      const recordCounts = await this.connections.recordCounts(tx);
      const openDifferences = await this.connections.openDifferences(tx);
      const mappingCounts = await this.mappings.counts(tx);
      const events = await this.connections.events(tx, HISTORY);
      const names = await this.people.names(tx, [current.stateChangedBy, ...runs.map((run) => run.importedBy), ...events.map((event) => event.actorId)]);
      const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));
      return {
        connector_code: current.connectorCode,
        mode: 'FILE_IMPORT',
        adapter_status: health.view.health.adapterStatus,
        registry_status: registry?.status ?? 'Draft',
        registered: current.id !== null,
        enabled: current.enabled,
        state_reason: current.stateReason,
        state_changed_at: current.stateChangedAt,
        state_changed_by_name: nameOf(current.stateChangedBy),
        layout_version: current.layoutVersion,
        supported_layouts: [...EGP_LAYOUT_VERSIONS],
        acceptance: health.view.acceptance,
        version: current.version,
        api_adapter: { status: health.view.apiAdapter.status, reason: health.view.apiAdapter.reason },
        health: healthDto(health),
        pending_external: pendingExternalDto(),
        positions: positions.map((position) => ({
          kind: position.kind,
          connector_code: position.connectorCode,
          cursor_status: position.cursorStatus,
          adapter_status: position.adapterStatus,
          last_success_at: position.lastSuccessAt,
          last_error_code: position.lastErrorCode,
          last_file_sha256: position.lastFileSha256,
        })),
        layouts: layoutsDto(EGP_POSITIONS),
        last_runs: runs.map((run) => runDto(run, names)),
        record_counts: recordCounts,
        open_differences: openDifferences,
        mapping_counts: mappingCounts,
        history: events.map((event) => ({ id: event.id, action: event.action, reason: event.reason, actor_name: nameOf(event.actorId), version: event.version, occurred_at: event.occurredAt })),
        actions: {
          set_state: holdsOnWholeTenant(access, PERMISSIONS.setEgpConnectionState),
          preview: holdsPermission(held, PERMISSIONS.previewEgpFile),
          apply: holdsOnWholeTenant(access, PERMISSIONS.importEgpFile),
          propose_mapping: holdsOnWholeTenant(access, PERMISSIONS.proposeEgpMapping),
          decide_mapping: holdsOnWholeTenant(access, PERMISSIONS.decideEgpMapping),
        },
        as_of: now.toISOString(),
      };
    });
  }

  @Get('egp/imports')
  @OperationId('listEgpImports')
  async listImports(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listEgpImports)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const kindText = text(query.kind, 'kind', 20);
    const kind = kindText === undefined ? undefined : egpKindOf(kindText);
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.connections.listRuns(tx, { kind, limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await this.people.names(tx, shown.map((run) => run.importedBy));
      return { items: shown.map((run) => runDto(run, names)), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null, as_of: now.toISOString() };
    });
  }

  @Get('egp/imports/:id')
  @OperationId('getEgpImport')
  async importDetail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.getEgpImport)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const run = await this.connections.findRun(tx, id);
      if (run === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const refused = await this.imports.quarantined(tx, id, ERROR_CAP + 1);
      const names = await this.people.names(tx, [run.importedBy]);
      return { run: runDto(run, names), errors: refused.slice(0, ERROR_CAP).map(rowErrorDto), errors_truncated: refused.length > ERROR_CAP, as_of: now.toISOString() };
    });
  }

  @Get('egp/mappings')
  @OperationId('listEgpMappings')
  async listMappings(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listEgpMappings)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const subjectType = text(query.subject_type, 'subject_type', 20);
    if (subjectType !== undefined && !isEgpSubjectType(subjectType)) throw new DomainError('VALIDATION_FAILED', 422, 'subject_type');
    const status = text(query.status, 'status', 20);
    if (status !== undefined && !(EGP_MAPPING_STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const q = text(query.q, 'q');
    const request = parsePageRequest(query.limit, query.cursor);
    const filter: EgpMappingFilter = { subjectType: subjectType as EgpMappingFilter['subjectType'], status: status as EgpMappingFilter['status'], q };
    const caller = { membershipId: tenant.membershipId, mayDecide: holdsOnWholeTenant(access, PERMISSIONS.decideEgpMapping), mayRetire: holdsOnWholeTenant(access, PERMISSIONS.retireEgpMapping) };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.mappings.list(tx, filter, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await this.people.names(tx, shown.flatMap((row) => [row.proposedBy, row.approvedBy, row.retiredBy]));
      const counts = await this.mappings.counts(tx);
      return {
        items: shown.map((row) => mappingDto(row, names, caller)),
        next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
        counts,
        as_of: now.toISOString(),
      };
    });
  }

  @Get('egp/mappings/suggestions')
  @OperationId('listEgpMappingSuggestions')
  async suggestions(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.listEgpMappingSuggestions)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.mappings.suggestions(tx, SUGGESTION_LIMIT));
    return {
      items: found.items.map((item) => ({
        external_code: item.externalCode,
        imported_name: item.importedName,
        imported_price_vnd: item.importedPrice,
        plan_code: item.planCode,
        import_id: item.importId,
        candidates: item.candidates.map((candidate) => ({ package_id: candidate.id, code: candidate.code, name: candidate.name, budget_vnd: candidate.budget, confidence: candidate.confidence })),
      })),
      threshold: found.threshold ?? EGP_SUGGESTION_THRESHOLD,
      formula: SUGGESTION_FORMULA,
      source: SUGGESTION_SOURCE,
      legal_status: 'UNVERIFIED',
      as_of: now.toISOString(),
    };
  }
}
