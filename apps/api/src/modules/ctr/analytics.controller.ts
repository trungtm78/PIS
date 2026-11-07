import { createHash, randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { AuditWriter, BidContractorStore, CtrFactStore, FACT_SORTS, GovernancePolicyPort, TenantDatabase, contractScope, projectScope } from '@machvon/db';
import type { FactCursor, FactFilters, FactQuery, FactSnapshotRow, ScopeBuilder, TenantTx } from '@machvon/db';
import {
  BI_EXPORT_ROW_CAP,
  BREAKDOWN_KEYS,
  CTR_INDICATORS,
  CTR_REPORT_CODES,
  DomainError,
  PDF_ROW_CAP,
  REPORT_CATALOGUE,
  REPORT_COLUMNS,
  asUuid,
  concentrationDefaults,
  concentrationDocumentOf,
  concentrationReport,
  contractorLoadOf,
  csvOf,
  hasControlChar,
  isCalendarDate,
  isCtrReportCode,
  paymentClockDefaults,
  paymentClockParams,
  reportDocumentOf,
  reportFilterText,
  reportRowOf,
  reportScopeDescription,
  totalsOfSums,
  vietnamDateOf,
  xlsxOf,
} from '@machvon/kernel';
import type { ConcentrationParams, ContractFact, CtrReportCode, CtrReportTotals, EffectiveAccess, PaymentClockParams, ReportRow, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { pdfOf } from '../dis/export-pdf';

const READ_PERMISSION = 'contract.read';
const ANALYTICS_PERMISSION = 'contract.analytics.read';
const LEDGER_PERMISSION = 'ledger.read';
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const FORMATS = ['xlsx', 'csv', 'pdf'] as const;
type Format = (typeof FORMATS)[number];
const MEDIA_TYPE: Readonly<Record<Format, string>> = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', pdf: 'application/pdf' };
const AUDIT_RESOURCE = 'contract_report';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

type Raw = Record<string, unknown>;

/** A list the query carries as `a,b,c`: absent is absent, an empty or oversized one is refused naming the parameter. */
function list(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw bad(field);
  const items = value.split(',');
  if (items.length > 200 || items.some((item) => item === '' || item !== item.trim())) throw bad(field);
  return items;
}

export interface AnalyticsRequest {
  filters: FactFilters;
  asOf: string | undefined;
  snapshotId: string | undefined;
  period: string | undefined;
  sort: string;
  direction: 'asc' | 'desc';
  limit: number;
  cursor: FactCursor | undefined;
}

/** The query of the portfolio and the reports, judged: every list, the day, the snapshot, the sort and the page; anything outside what a query takes names the field. */
export function analyticsRequestOf(raw: Raw, today: string, defaults: { sort: string } = { sort: 'code' }): AnalyticsRequest {
  const text = (value: unknown, field: string, max = 100): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '' || value.length > max || hasControlChar(value)) throw bad(field);
    return value;
  };
  const unit = list(raw.unit, 'unit');
  const project = list(raw.project, 'project');
  const contractor = list(raw.contractor, 'contractor');
  const status = list(raw.status, 'status');
  const type = list(raw.type, 'type');
  const fund = list(raw.fund, 'fund');
  const filters: FactFilters = { unit, project, contractor, status, type, fund, text: text(raw.q, 'q') };
  const asOf = text(raw.as_of, 'as_of', 10);
  if (asOf !== undefined && (!isCalendarDate(asOf) || asOf > today)) throw bad('as_of');
  const snapshotId = text(raw.snapshot_id, 'snapshot_id', 36);
  if (snapshotId !== undefined && !UUID.test(snapshotId)) throw bad('snapshot_id');
  const period = text(raw.period, 'period', 20);
  if (snapshotId !== undefined && period !== undefined) throw bad('period');
  if ((snapshotId !== undefined || period !== undefined) && asOf !== undefined) throw bad('as_of');
  const sort = text(raw.sort, 'sort', 40) ?? defaults.sort;
  if (FACT_SORTS[sort] === undefined) throw bad('sort');
  const dir = raw.dir === undefined ? 'asc' : raw.dir;
  if (dir !== 'asc' && dir !== 'desc') throw bad('dir');
  let limit = DEFAULT_PAGE;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(raw.limit) || Number(raw.limit) > MAX_PAGE) throw bad('limit');
    limit = Number(raw.limit);
  }
  return { filters, asOf, snapshotId: snapshotId?.toLowerCase(), period, sort, direction: dir, limit, cursor: raw.cursor === undefined ? undefined : decodeCursor(raw.cursor, sort, dir) };
}

export function encodeFactCursor(cursor: FactCursor): string {
  return Buffer.from(JSON.stringify({ s: cursor.sort, d: cursor.direction, v: cursor.value, i: cursor.id }), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown, sort: string, direction: 'asc' | 'desc'): FactCursor {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 600) throw bad('cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw bad('cursor');
  }
  const record = parsed as { s?: unknown; d?: unknown; v?: unknown; i?: unknown } | null;
  if (typeof record !== 'object' || record === null || typeof record.s !== 'string' || typeof record.v !== 'string' || asUuid(record.i) === undefined || (record.d !== 'asc' && record.d !== 'desc')) throw bad('cursor');
  // A cursor belongs to the sort it was made for: it is not carried over to another.
  if (record.s !== sort || record.d !== direction) throw bad('cursor');
  const cursor: FactCursor = { sort: record.s, direction: record.d, value: record.v, id: asUuid(record.i) as string };
  if (encodeFactCursor(cursor) !== value) throw bad('cursor');
  return cursor;
}

const snapshotView = (snapshot: FactSnapshotRow): Record<string, unknown> => ({
  id: snapshot.id,
  period_snapshot_id: snapshot.periodSnapshotId,
  period_code: snapshot.periodCode,
  revision: snapshot.revision,
  latest_revision: snapshot.latestRevision,
  stale: snapshot.stale,
  supersedes_id: snapshot.supersedesId,
  cutoff_date: snapshot.cutoffDate,
  as_of_date: snapshot.asOfDate,
  contract_count: snapshot.contractCount,
  row_count: snapshot.rowCount,
  payload_sha256: snapshot.payloadSha256,
  built_at: snapshot.builtAt,
});

const rowView = (row: ReportRow): Record<string, unknown> => ({
  contract_id: row.id,
  cells: row.cells,
  na: row.na,
  ...(row.health === undefined ? {} : { health: { level: row.health.level, drivers: row.health.drivers, rule_code: row.health.ruleCode, readings: row.health.readings } }),
});

const totalsView = (totals: CtrReportTotals): Record<string, unknown> => ({
  rows: totals.rows,
  ledger_rows: totals.ledgerRows,
  cells: totals.cells,
  na: totals.na,
  indicators: totals.indicators.map((one) => ({ code: one.code, value: one.value, status: one.status, reason: one.reason, numerator: one.numerator, denominator: one.denominator })),
});

const definitionView = (code: keyof typeof CTR_INDICATORS): Record<string, unknown> => {
  const one = CTR_INDICATORS[code];
  return { code: one.code, name: one.name, formula: one.formula, numerator: one.numerator, denominator: one.denominator, unit: one.unit, source_tables: one.sourceTables, null_policy: one.nullPolicy };
};

interface Prepared {
  request: AnalyticsRequest;
  query: FactQuery;
  snapshot: FactSnapshotRow | undefined;
  latest: FactSnapshotRow | undefined;
  today: string;
  province: boolean;
  /** The scope of the reader over the projects (the pending awards are of the projects, not of a contract). */
  projects: ScopeBuilder;
}

/**
 * The portfolio and the reports of the contracts (CA-1, part 2): the figures of `contract_fact` read in the scope of the caller (`contract.read` over the contracts, `ledger.read` over the money of the ledger), filtered,
 * sorted and paged on the server, with the totals computed on the server from the same rows. A guest contractor is not a reader of the portfolio (403). A reading is of the live fact on a day, or of the fact frozen
 * with a period: the frozen one says which revision it is and whether the period has a newer one (stale, R17). A source that fails is an error, never an empty table.
 */
@Controller('contracts/analytics')
export class ContractAnalyticsController {
  private readonly facts = new CtrFactStore();
  private readonly contractors = new BidContractorStore();
  private readonly policy = new GovernancePolicyPort();
  private readonly audit: AuditWriter;

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {
    this.audit = new AuditWriter(database);
  }

  private async prepare(tx: TenantTx, tenant: TenantContext, access: EffectiveAccess, request: AnalyticsRequest, permission: string, now: Date): Promise<Prepared> {
    // A guest contractor reads its own contracts through the register, not through the analytics of the portfolio.
    if ((await this.contractors.callerOf(tx, tenant.membershipId)).guest) throw new DomainError('SCOPE_DENIED', 403);
    const today = vietnamDateOf(now);
    const scope = contractScope(access, permission, now);
    let snapshot: FactSnapshotRow | undefined;
    if (request.snapshotId !== undefined || request.period !== undefined) {
      snapshot = await this.facts.snapshot(tx, { id: request.snapshotId, periodCode: request.period });
      if (snapshot === undefined) throw new DomainError('SNAPSHOT_NOT_FOUND', 422, request.snapshotId === undefined ? 'period' : 'snapshot_id');
    }
    const latest = await this.facts.latest(tx);
    const query: FactQuery = {
      asOf: snapshot?.asOfDate ?? request.asOf ?? today,
      snapshotId: snapshot?.id,
      scope,
      ledgerScope: contractScope(access, LEDGER_PERMISSION, now),
      filters: request.filters,
    };
    return { request, query, snapshot, latest, today, province: scope(1).sql === 'true', projects: projectScope(access, permission, now) };
  }

  private contextOf(prepared: Prepared, totals: CtrReportTotals | null): Record<string, unknown> {
    const { snapshot, latest, query } = prepared;
    return {
      scope: prepared.province ? 'PROVINCE' : 'GRANTED',
      as_of: query.asOf,
      cutoff_date: snapshot?.cutoffDate ?? null,
      currency_unit: 'VND',
      freshness: {
        kind: snapshot === undefined ? 'LIVE' : 'SNAPSHOT',
        stale: snapshot?.stale ?? false,
        snapshot: snapshot === undefined ? null : snapshotView(snapshot),
        latest_snapshot: latest === undefined ? null : snapshotView(latest),
      },
      rows: totals?.rows ?? null,
      ledger_rows: totals?.ledgerRows ?? null,
    };
  }

  private async clockOf(tx: TenantTx, today: string): Promise<PaymentClockParams> {
    const rule = await this.policy.get(tx, 'CONTRACT_PAYMENT_CLOCK', 'DEFAULT', today);
    return rule === undefined ? paymentClockDefaults() : paymentClockParams(rule.params);
  }

  /** The portfolio (CTR-01 and CTR-28): one page of the contracts and the totals of all of them that match, both made on the server. */
  @Get('portfolio')
  @OperationId('getContractPortfolio')
  async portfolio(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() raw: Raw): Promise<Record<string, unknown>> {
    const now = new Date();
    const request = analyticsRequestOf(raw, vietnamDateOf(now));
    return this.database.withTenant(tenant, async (tx) => {
      const prepared = await this.prepare(tx, tenant, access, request, READ_PERMISSION, now);
      return this.reportBody(tx, prepared, 'portfolio-status', now);
    });
  }

  /** A report of the catalogue: R1 to R7 over the contracts, R14 over the contractors. */
  @Get('reports/:code')
  @OperationId('getContractReport')
  async report(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('code') code: string, @Query() raw: Raw): Promise<Record<string, unknown>> {
    if (!isCtrReportCode(code)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const now = new Date();
    const request = analyticsRequestOf(raw, vietnamDateOf(now));
    return this.database.withTenant(tenant, async (tx) => {
      const prepared = await this.prepare(tx, tenant, access, request, ANALYTICS_PERMISSION, now);
      return code === 'contractor-concentration' ? this.concentrationBody(tx, prepared, now) : this.reportBody(tx, prepared, code, now);
    });
  }

  /** The frozen contract facts of the tenant, newest period first, with the lineage (which revision replaced which): what the period selector and the freshness pill of the screens read. */
  @Get('snapshots')
  @OperationId('listContractFactSnapshots')
  async snapshots(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('period') period?: unknown): Promise<Record<string, unknown>> {
    if (period !== undefined && (typeof period !== 'string' || period.length < 4 || period.length > 20)) throw bad('period');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      await this.prepare(tx, tenant, access, analyticsRequestOf({}, vietnamDateOf(now)), ANALYTICS_PERMISSION, now);
      const items = await this.facts.recent(tx, period as string | undefined, 60);
      return { items: items.map(snapshotView), as_of: now.toISOString() };
    });
  }

  /** The file of a report in the format asked: xlsx, csv or pdf. The header of the file says the scope, the period, the cut-off day and whether the snapshot is the newest; a file larger than the cap of its format is refused, never cut. */
  @Get('reports/:code/export')
  @OperationId('exportContractReport')
  async export(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('code') code: string,
    @Query('format') format: unknown,
    @Query() raw: Raw,
  ): Promise<Record<string, unknown>> {
    if (!isCtrReportCode(code)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (typeof format !== 'string' || !(FORMATS as readonly string[]).includes(format)) throw bad('format');
    const chosen = format as Format;
    const now = new Date();
    const request = analyticsRequestOf({ ...raw, format: undefined, limit: undefined, cursor: undefined }, vietnamDateOf(now));
    const cap = chosen === 'pdf' ? PDF_ROW_CAP : BI_EXPORT_ROW_CAP;
    return this.database.withTenant(tenant, async (tx) => {
      const prepared = await this.prepare(tx, tenant, access, request, ANALYTICS_PERMISSION, now);
      const scopeText = reportScopeDescription(prepared.province);
      const filterText = reportFilterText({ ...request.filters, sort: `${request.sort} ${request.direction}` });
      const header = {
        scopeDescription: scopeText,
        periodLabel: prepared.snapshot?.periodCode ?? prepared.query.asOf,
        asOf: prepared.query.asOf,
        cutoffDate: prepared.snapshot?.cutoffDate ?? '',
        snapshotId: prepared.snapshot?.id ?? '',
        snapshotRevision: prepared.snapshot === undefined ? '' : String(prepared.snapshot.revision),
        stale: prepared.snapshot?.stale ?? false,
        generatedAt: now,
        filterText,
      };
      let document;
      let rowCount: number;
      if (code === 'contractor-concentration') {
        const found = await this.concentrationOf(tx, prepared);
        const names = await this.facts.namesOf(tx, found.report.dimensions.flatMap((dimension) => dimension.groups.map((group) => group.key)));
        document = concentrationDocumentOf(found.report, header, names);
        rowCount = document.rows.length;
      } else {
        const clock = await this.clockOf(tx, prepared.today);
        const page = await this.facts.page(tx, prepared.query, { sort: request.sort, direction: request.direction, limit: cap + 1 });
        // Over the cap the file is refused, never cut: the BI export of the series over DS-CTR (BiExportRunner) is the road for what is larger.
        if (page.facts.length > cap) throw new DomainError('EXPORT_ROW_CAP_EXCEEDED', 422, 'rows', { extensions: { cap, format: chosen } });
        const rows = page.facts.map((fact) => reportRowOf(code, fact, { asOf: prepared.query.asOf, clock }));
        const sums = await this.facts.reportSums(tx, prepared.query, code);
        const totals = totalsOfSums(code, sums.total);
        document = reportDocumentOf({ ...header, code, columns: REPORT_COLUMNS[code], rows, totals });
        rowCount = rows.length;
      }
      const bytes: Uint8Array = chosen === 'csv' ? new Uint8Array(Buffer.from(csvOf(document), 'utf8')) : chosen === 'xlsx' ? xlsxOf(document) : await pdfOf(document, { stamp: now, wrap: true });
      const sha = createHash('sha256').update(bytes).digest('hex');
      await this.audit.recordInTx(tx, tenant.membershipId, {
        action: 'contract.report_exported',
        resourceType: AUDIT_RESOURCE,
        resourceId: prepared.snapshot?.id ?? NIL_ID,
        classification: 'CONFIDENTIAL',
        diff: { report: code, format: chosen, rows: rowCount, as_of: prepared.query.asOf, snapshot_id: prepared.snapshot?.id ?? null, stale: prepared.snapshot?.stale ?? false, file_sha256: sha },
        correlationId: randomUUID(),
        requestId: randomUUID(),
      });
      return {
        report: code,
        format: chosen,
        file_name: `${code}-${prepared.snapshot?.periodCode ?? prepared.query.asOf}.${chosen}`,
        media_type: MEDIA_TYPE[chosen],
        size_bytes: bytes.length,
        file_sha256: sha,
        row_count: rowCount,
        stale: prepared.snapshot?.stale ?? false,
        context: this.contextOf(prepared, null),
        content_base64: Buffer.from(bytes).toString('base64'),
      };
    });
  }

  private async reportBody(tx: TenantTx, prepared: Prepared, code: Exclude<CtrReportCode, 'contractor-concentration'>, now: Date): Promise<Record<string, unknown>> {
    const { request, query } = prepared;
    const clock = code === 'payment-three-way' ? await this.clockOf(tx, prepared.today) : paymentClockDefaults();
    const page = await this.facts.page(tx, query, { sort: request.sort, direction: request.direction, limit: request.limit + 1, after: request.cursor });
    const shown = page.facts.slice(0, request.limit);
    const catalogue = REPORT_CATALOGUE[code];
    const sums = await this.facts.reportSums(tx, query, code, catalogue.breakdown ?? undefined);
    const totals = totalsOfSums(code, sums.total);
    const last = page.cursors[shown.length - 1];
    const order = catalogue.breakdown === null ? [] : (BREAKDOWN_KEYS[catalogue.breakdown] ?? []);
    const groups = sums.groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return {
      code,
      ref: catalogue.ref,
      as_of: now.toISOString(),
      context: this.contextOf(prepared, totals),
      columns: REPORT_COLUMNS[code].map((column) => ({ key: column.key, kind: column.kind, ledger: column.ledger, indicator: column.indicator, total: column.total })),
      items: shown.map((fact: ContractFact) => rowView(reportRowOf(code, fact, { asOf: query.asOf, clock }))),
      totals: totalsView(totals),
      breakdown: catalogue.breakdown === null ? null : { dimension: catalogue.breakdown, groups: groups.map((group) => ({ key: group.key, totals: totalsView(totalsOfSums(code, group.sums)) })) },
      definitions: catalogue.indicators.map((indicator) => definitionView(indicator)),
      next_cursor: page.facts.length > request.limit && last !== undefined ? encodeFactCursor({ sort: request.sort, direction: request.direction, value: last.value, id: last.id }) : null,
      // The earned value and the S-curve of lane B1 are not read into this report yet: the slot is typed so that wiring them is an addition, not a change of shape.
      ...(code === 'schedule-delay' ? { evm: { status: 'UNAVAILABLE', reason: 'NOT_WIRED' } } : {}),
      ...(code === 'payment-three-way' ? { payment_clock: { acceptance_to_request_days: clock.acceptance_to_request_days, request_to_treasury_days: clock.request_to_treasury_days } } : {}),
    };
  }

  private async concentrationOf(
    tx: TenantTx,
    prepared: Prepared,
  ): Promise<{ report: ReturnType<typeof concentrationReport>; version: number; source: string; unverified: boolean; inputs: Awaited<ReturnType<CtrFactStore['concentrationInputs']>> }> {
    const rule = await this.policy.get(tx, 'CONTRACT_CONCENTRATION', 'DEFAULT', prepared.today);
    const params: ConcentrationParams = rule === undefined ? concentrationDefaults() : (rule.params as unknown as ConcentrationParams);
    const inputs = await this.facts.concentrationInputs(tx, prepared.query);
    return { report: concentrationReport(inputs, params), version: rule?.version ?? 0, source: rule?.source ?? 'DEFAULT', unverified: rule?.unverified ?? true, inputs };
  }

  private async concentrationBody(tx: TenantTx, prepared: Prepared, now: Date): Promise<Record<string, unknown>> {
    const found = await this.concentrationOf(tx, prepared);
    const pending = await this.facts.pendingAwards(tx, prepared.projects);
    const loads = contractorLoadOf(found.inputs, pending);
    const names = await this.facts.namesOf(tx, [...found.report.dimensions.flatMap((dimension) => dimension.groups.map((group) => group.key)), ...loads.map((load) => load.contractorId)]);
    const nameOf = (key: string): string | null => names.get(key) ?? null;
    return {
      code: 'contractor-concentration',
      ref: REPORT_CATALOGUE['contractor-concentration'].ref,
      as_of: now.toISOString(),
      context: this.contextOf(prepared, null),
      rule: { type: 'CONTRACT_CONCENTRATION', version: found.version, source: found.source, unverified: found.unverified, params: found.report.params },
      active_contracts: found.report.activeContracts,
      active_value_vnd: found.report.activeValueVnd,
      dimensions: found.report.dimensions.map((dimension) => ({
        dimension: dimension.dimension,
        top_n: dimension.topN,
        total_vnd: dimension.totalVnd,
        level: dimension.level,
        top_share: { value: dimension.top.value, status: dimension.top.status, reason: dimension.top.reason, numerator: dimension.top.numerator, denominator: dimension.top.denominator },
        hhi: { value: dimension.hhi.value, status: dimension.hhi.status, reason: dimension.hhi.reason, numerator: dimension.hhi.numerator, denominator: dimension.hhi.denominator },
        share_anomalies: dimension.shareAnomalies,
        groups: dimension.groups.map((group) => ({ key: group.key, name: nameOf(group.key), value_vnd: group.valueVnd, share_pct: group.sharePct })),
      })),
      single_bidder: { value: found.report.singleBidder.value, status: found.report.singleBidder.status, reason: found.report.singleBidder.reason, numerator: found.report.singleBidder.numerator, denominator: found.report.singleBidder.denominator, level: found.report.singleBidderLevel },
      contractors: loads.map((load) => ({ contractor_id: load.contractorId, name: nameOf(load.contractorId), active_contracts: load.activeContracts, active_value_vnd: load.activeValueVnd, share_pct: load.sharePct, pending_award_vnd: load.pendingAwardVnd })),
      definitions: REPORT_CATALOGUE['contractor-concentration'].indicators.map((indicator) => definitionView(indicator)),
      next_cursor: null,
    };
  }
}

const NIL_ID = '00000000-0000-4000-8000-000000000000';
/** The reports of the catalogue, for the screens and the tests. */
export const REPORT_CODES = CTR_REPORT_CODES;
