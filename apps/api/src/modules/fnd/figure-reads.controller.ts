import { Controller, Get, Inject, Optional, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { FndFigureStore, TenantDatabase, projectScope } from '@machvon/db';
import type { FigureFilter } from '@machvon/db';
import {
  DomainError,
  asUuid,
  assertClassAndTier,
  assertFigurePlanYear,
  assertOrdinal,
  figuresOfProject,
  indicatorsOf,
  isFigureGrain,
  isFigureView,
  isStoredFigureKind,
  moneyIndicatorsOf,
  monthOfDay,
  vietnamDateOf,
} from '@machvon/kernel';
import type { EffectiveAccess, FigureGrain, FigureQuery, FigureView, FundingMeasure, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { packCodeOf } from './figure.controller';
import { FUNDING_PACK_CODE } from './tokens';
import { batchDto, cellDto, figureActions, historyEntryDto, moneyDto, pendingDto, periodDto, rateDto, taxonomyDto } from './figure-view';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['DRAFT', 'SUBMITTED', 'ACCEPTED', 'SUPERSEDED', 'WITHDRAWN'] as const;
const MAX_PROJECTS = 200;

/** A query value that must be one string or absent (`?a=1&a=2` and `?a[x]=1` are refused). */
function text(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(field);
  return value;
}

function whole(value: unknown, field: string): number | undefined {
  const raw = text(value, field);
  if (raw === undefined) return undefined;
  if (!/^-?[0-9]{1,6}$/.test(raw)) throw invalid(field);
  return Number(raw);
}

function day(value: unknown, field: string): string | undefined {
  const raw = text(value, field);
  if (raw !== undefined && (!DAY.test(raw) || new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw)) throw invalid(field);
  return raw;
}

function uuid(value: unknown, field: string): string | undefined {
  const raw = text(value, field);
  if (raw === undefined) return undefined;
  const id = asUuid(raw);
  if (id === undefined) throw invalid(field);
  return id.toLowerCase();
}

function grain(value: unknown): FigureGrain | undefined {
  const raw = text(value, 'period_grain');
  if (raw !== undefined && !isFigureGrain(raw)) throw invalid('period_grain');
  return raw as FigureGrain | undefined;
}

/**
 * The reads of the funding model (FND-1, DIS-27 to DIS-29): the pack in force, the board of figures and indicators of a period (each number with its formula code, its numerator and denominator, its basis and the day it is
 * as of), the batches that wait for a person or were settled, and the transition history of a period. Every read is scoped by the projects the caller reaches; the figures are derived from the stored figures and the
 * year plans of CAP by the kernel engine, never stored twice.
 */
@Controller()
export class FundingFigureReadsController {
  private readonly store = new FndFigureStore();
  private readonly packCode: string;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(FUNDING_PACK_CODE) packCode?: string,
  ) {
    this.packCode = packCodeOf(packCode);
  }

  @Get('funding-figures/taxonomy')
  @OperationId('getFundingTaxonomy')
  async taxonomy(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    return this.database.withTenant(tenant, async (tx) => {
      const resolved = await this.store.resolvePack(tx, this.packCode, today);
      return taxonomyDto(resolved, resolved.provenance, today, figureActions(access, now));
    });
  }

  @Get('funding-figures/board')
  @OperationId('getFundingFigureBoard')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const today = vietnamDateOf(now);
    const asOf = day(query.as_of, 'as_of') ?? today;
    const planYear = whole(query.plan_year, 'plan_year') ?? monthOfDay(asOf).planYear;
    assertFigurePlanYear(planYear);
    const periodGrain = grain(query.period_grain) ?? 'MONTH';
    const ordinal = whole(query.period_ordinal, 'period_ordinal') ?? (periodGrain === 'YEAR' ? 0 : periodGrain === 'QUARTER' ? Math.ceil(monthOfDay(asOf).ordinal / 3) : monthOfDay(asOf).ordinal);
    assertOrdinal(periodGrain, ordinal);
    const viewText = text(query.view, 'view') ?? 'AS_REPORTED';
    if (!isFigureView(viewText)) throw invalid('view');
    const view: FigureView = viewText;
    const limit = whole(query.limit, 'limit') ?? 50;
    if (limit < 1 || limit > MAX_PROJECTS) throw invalid('limit');
    const projectId = uuid(query.project_id, 'project_id');
    return this.database.withTenant(tenant, async (tx) => {
      const resolved = await this.store.resolvePack(tx, this.packCode, asOf);
      if (!resolved.pack.periodGrains.includes(periodGrain)) throw invalid('period_grain');
      const measureText = text(query.measure, 'measure') ?? (resolved.pack.measures[0] as string);
      if (!(resolved.pack.measures as readonly string[]).includes(measureText)) throw invalid('measure');
      const measure = measureText as FundingMeasure;
      const scope = projectScope(access, PERMISSIONS.getFundingFigureBoard, now);
      const projects = await this.store.projects(tx, this.packCode, planYear, scope, limit + 1, projectId);
      if (projectId !== undefined && projects.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const shown = projects.slice(0, limit);
      const books = await this.store.loadBooks(tx, shown.map((one) => one.id), resolved);
      const figureQuery: FigureQuery = { period: { grain: periodGrain, planYear, ordinal }, asOf, measure, view };
      const figures = shown.map((one) => figuresOfProject(books.get(one.id) as NonNullable<ReturnType<typeof books.get>>, one.id, figureQuery));
      return {
        pack_code: resolved.pack.packCode,
        version: resolved.version,
        unverified: resolved.unverified,
        plan_year: planYear,
        period: periodDto(figureQuery.period),
        as_of: asOf,
        measure,
        view,
        totals: {
          money: moneyIndicatorsOf(resolved.pack, figures, figureQuery).map(moneyDto),
          by_class: resolved.pack.classes.map((one) => ({ class_code: one.code, money: moneyIndicatorsOf(resolved.pack, figures, figureQuery, one.code).map(moneyDto) })),
          rates: indicatorsOf(resolved.pack, figures, figureQuery).map(rateDto),
        },
        projects: shown.map((one, index) => {
          const own = figures[index] as NonNullable<(typeof figures)[number]>;
          return {
            project_id: one.id,
            project_code: one.code,
            project_name: one.name,
            tmdt_in_force_vnd: own.tmdtInForce,
            cells: own.cells.map(cellDto),
            money: moneyIndicatorsOf(resolved.pack, [own], figureQuery).map(moneyDto),
            rates: indicatorsOf(resolved.pack, [own], figureQuery).map(rateDto),
          };
        }),
        truncated: projects.length > limit,
        actions: figureActions(access, now),
      };
    });
  }

  @Get('funding-figures/batches')
  @OperationId('listFundingFigureBatches')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const status = text(query.status, 'status');
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) throw invalid('status');
    const kind = text(query.figure_kind, 'figure_kind');
    if (kind !== undefined && !isStoredFigureKind(kind)) throw invalid('figure_kind');
    const planYear = whole(query.plan_year, 'plan_year');
    if (planYear !== undefined) assertFigurePlanYear(planYear);
    const measure = text(query.measure, 'measure');
    if (measure !== undefined && measure !== 'DISBURSED' && measure !== 'EXECUTED') throw invalid('measure');
    const limit = whole(query.limit, 'limit') ?? 50;
    if (limit < 1 || limit > MAX_PROJECTS) throw invalid('limit');
    const filter: FigureFilter = { projectId: uuid(query.project_id, 'project_id'), status: status as FigureFilter['status'], kind: kind as FigureFilter['kind'], planYear, measure: measure as FigureFilter['measure'] };
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.store.list(tx, filter, projectScope(access, PERMISSIONS.listFundingFigureBatches, now), limit + 1);
      const can = figureActions(access, now);
      return { items: rows.slice(0, limit).map((batch) => batchDto(batch, tenant.membershipId, can)), truncated: rows.length > limit, as_of: now.toISOString() };
    });
  }

  @Get('funding-figures/batches/:batch_id')
  @OperationId('getFundingFigureBatch')
  async batch(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('batch_id', ParseUUIDPipe) batchId: string): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.store.find(tx, batchId, projectScope(access, PERMISSIONS.getFundingFigureBatch, now));
      if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return batchDto(found, tenant.membershipId, figureActions(access, now));
    });
  }

  @Get('funding-figures/history')
  @OperationId('getFundingFigureHistory')
  async history(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const projectId = uuid(query.project_id, 'project_id');
    const classCode = text(query.class_code, 'class_code');
    const tierCode = text(query.tier_code, 'tier_code');
    const measure = text(query.measure, 'measure');
    const periodGrain = grain(query.period_grain);
    const planYear = whole(query.plan_year, 'plan_year');
    const ordinal = whole(query.period_ordinal, 'period_ordinal');
    if (projectId === undefined || classCode === undefined || tierCode === undefined || measure === undefined || periodGrain === undefined || planYear === undefined || ordinal === undefined) throw invalid('project_id');
    if (measure !== 'DISBURSED' && measure !== 'EXECUTED') throw invalid('measure');
    assertFigurePlanYear(planYear);
    assertOrdinal(periodGrain, ordinal);
    return this.database.withTenant(tenant, async (tx) => {
      const resolved = await this.store.resolvePack(tx, this.packCode, vietnamDateOf(now));
      assertClassAndTier(resolved.pack, classCode, tierCode);
      const found = await this.store.history(tx, { projectId, classCode, tierCode, measure, grain: periodGrain, planYear, ordinal, packCode: resolved.pack.packCode }, projectScope(access, PERMISSIONS.getFundingFigureHistory, now));
      return {
        project_id: projectId,
        project_code: found.projectCode,
        class_code: classCode,
        tier_code: tierCode,
        measure,
        period_grain: periodGrain,
        plan_year: planYear,
        period_ordinal: ordinal,
        history: found.history.map(historyEntryDto),
        pending: found.pending.map(pendingDto),
        as_of: now.toISOString(),
      };
    });
  }
}
