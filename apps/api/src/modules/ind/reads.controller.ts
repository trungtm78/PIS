import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidWorkflowReads, FileImportStore, IndDictionaryStore, IndEntryRuleStore, IndFigureStore, IndImportReads, IndMappingStore, TenantDatabase, projectScope } from '@machvon/db';
import {
  DATA_ENTRY_CHECKS,
  DomainError,
  ENTRY_SURFACES,
  INDICATOR_CATEGORIES,
  INDICATOR_VALUE_KINDS,
  dictionaryFindings,
  isIndicatorCategory,
  isRuleCode,
  mappingProblems,
  vietnamDateOf,
} from '@machvon/kernel';
import type { DictionaryFilter, EffectiveAccess, IndicatorValueKind, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { differenceDto, entryRuleDto, figureDto, indicatorDto, mappingDto, rowErrorDto, runDto, versionDto, versionPeople } from './ind-view';

/** The most figures a list answers with and the most rows of an import it shows: the screen asks for what it can use. */
const FIGURE_CAP = 500;
const ROW_CAP = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A query value that must be one non-empty string or absent. */
function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function uuid(value: unknown, field: string): string | undefined {
  const given = text(value, field, 40);
  if (given !== undefined && !UUID.test(given)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return given?.toLowerCase();
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

/**
 * The reads of IND-1: the dictionary, the entry rules, the import mappings, the figures and the history of the imports. The dictionary, the rules and the mappings are definitions of the tenant that anyone
 * who may read IND sees; the figures and the history of one are read in the scope of their project (a project outside the scope of the caller is not there). A read never writes.
 */
@Controller()
export class IndReadsController {
  private readonly dictionary = new IndDictionaryStore();
  private readonly entryRules = new IndEntryRuleStore();
  private readonly mappings = new IndMappingStore();
  private readonly figures = new IndFigureStore();
  private readonly runs = new IndImportReads();
  private readonly imports = new FileImportStore();
  private readonly people = new BidWorkflowReads();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('indicators')
  @OperationId('listIndicators')
  async listIndicators(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const filter: DictionaryFilter = {};
    const category = text(query.category, 'category', 20);
    if (category !== undefined) {
      if (!isIndicatorCategory(category)) throw new DomainError('VALIDATION_FAILED', 422, 'category');
      filter.category = category;
    }
    const kind = text(query.value_kind, 'value_kind', 20);
    if (kind !== undefined) {
      if (!(INDICATOR_VALUE_KINDS as readonly string[]).includes(kind)) throw new DomainError('VALIDATION_FAILED', 422, 'value_kind');
      filter.valueKind = kind as IndicatorValueKind;
    }
    const enterable = text(query.enterable, 'enterable', 5);
    if (enterable !== undefined && enterable !== 'true' && enterable !== 'false') throw new DomainError('VALIDATION_FAILED', 422, 'enterable');
    if (enterable === 'true') filter.enterable = true;
    filter.text = text(query.q, 'q', 120);
    return this.database.withTenant(tenant, async (tx) => {
      const day = vietnamDateOf(now);
      const all = await this.dictionary.list(tx, day);
      const shown = await this.dictionary.list(tx, day, filter);
      return { items: shown.map(indicatorDto), findings: dictionaryFindings(all), categories: [...INDICATOR_CATEGORIES], as_of: now.toISOString() };
    });
  }

  @Get('indicators/detail')
  @OperationId('getIndicator')
  async getIndicator(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const code = required(text(query.code, 'code', 64), 'code');
    if (!isRuleCode(code)) throw new DomainError('VALIDATION_FAILED', 422, 'code');
    return this.database.withTenant(tenant, async (tx) => {
      const day = vietnamDateOf(now);
      const indicator = await this.dictionary.find(tx, code, day);
      if (indicator === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const versions = await this.dictionary.versions(tx, code);
      const names = await this.people.names(tx, versionPeople(versions));
      const usage = await this.dictionary.usage(tx, indicator, day);
      return { indicator: indicatorDto(indicator), versions: versions.map((row) => versionDto(row, names)), usage, as_of: now.toISOString() };
    });
  }

  @Get('indicator-entry-rules')
  @OperationId('listIndicatorEntryRules')
  async listEntryRules(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const catalogue = await this.entryRules.catalogue(tx, vietnamDateOf(now));
      return { items: catalogue.map(entryRuleDto), surfaces: [...ENTRY_SURFACES], checks: [...DATA_ENTRY_CHECKS], as_of: now.toISOString() };
    });
  }

  @Get('indicator-import-mappings')
  @OperationId('listIndicatorImportMappings')
  async listMappings(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const day = vietnamDateOf(now);
      const indicators = await this.dictionary.list(tx, day);
      const catalogue = await this.mappings.catalogue(tx, day);
      return { items: catalogue.map((view) => mappingDto(view.mapping, view, mappingProblems(view.mapping, indicators))), as_of: now.toISOString() };
    });
  }

  @Get('indicator-import-mappings/detail')
  @OperationId('getIndicatorImportMapping')
  async getMapping(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const code = required(text(query.code, 'code', 64), 'code');
    if (!isRuleCode(code)) throw new DomainError('VALIDATION_FAILED', 422, 'code');
    return this.database.withTenant(tenant, async (tx) => {
      const day = vietnamDateOf(now);
      const view = await this.mappings.find(tx, code, day);
      if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const indicators = await this.dictionary.list(tx, day);
      const versions = await this.mappings.versions(tx, code);
      const names = await this.people.names(tx, versionPeople(versions));
      return { mapping: mappingDto(view.mapping, view, mappingProblems(view.mapping, indicators)), versions: versions.map((row) => versionDto(row, names)), as_of: now.toISOString() };
    });
  }

  @Get('indicator-figures')
  @OperationId('listIndicatorFigures')
  async listFigures(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const filter = { projectId: uuid(query.project_id, 'project_id'), periodId: uuid(query.period_id, 'period_id'), indicatorCode: text(query.indicator_code, 'indicator_code', 64) };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.figures.list(tx, filter, projectScope(access, PERMISSIONS.listIndicatorFigures, now), FIGURE_CAP);
      const names = await this.people.names(tx, rows.map((row) => row.enteredBy));
      return { items: rows.map((row) => figureDto(row, names)), as_of: now.toISOString() };
    });
  }

  @Get('indicator-figures/history')
  @OperationId('listIndicatorFigureHistory')
  async history(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const projectId = required(uuid(query.project_id, 'project_id'), 'project_id');
    const periodId = required(uuid(query.period_id, 'period_id'), 'period_id');
    const code = required(text(query.indicator_code, 'indicator_code', 64), 'indicator_code');
    const seen = projectScope(access, PERMISSIONS.listIndicatorFigureHistory, now);
    return this.database.withTenant(tenant, async (tx) => {
      // The project of the caller's scope: one outside it does not exist for them.
      await this.figures.project(tx, projectId, seen, seen);
      const rows = await this.figures.history(tx, projectId, periodId, code);
      if (rows.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const names = await this.people.names(tx, rows.map((row) => row.enteredBy));
      return { items: rows.map((row) => figureDto(row, names)), as_of: now.toISOString() };
    });
  }

  @Get('indicator-imports')
  @OperationId('listIndicatorImports')
  async listImports(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const request = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.runs.runs(tx, { limit: request.limit + 1, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } });
      const shown = rows.slice(0, request.limit);
      const last = shown[shown.length - 1];
      const names = await this.people.names(tx, shown.map((run) => run.importedBy));
      return { items: shown.map((run) => runDto(run, names)), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null, as_of: now.toISOString() };
    });
  }

  @Get('indicator-imports/rows')
  @OperationId('listIndicatorImportRows')
  async importRows(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const importId = required(uuid(query.import_id, 'import_id'), 'import_id');
    return this.database.withTenant(tenant, async (tx) => {
      const run = await this.runs.run(tx, importId);
      if (run === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const refused = await this.imports.quarantined(tx, importId, ROW_CAP + 1);
      const differences = await this.runs.differences(tx, importId, ROW_CAP);
      const names = await this.people.names(tx, differences.map((row) => row.ownerId));
      return {
        import_id: importId,
        errors: refused.slice(0, ROW_CAP).map(rowErrorDto),
        errors_truncated: refused.length > ROW_CAP,
        differences: differences.map((row) => differenceDto(row, names)),
        as_of: now.toISOString(),
      };
    });
  }
}
