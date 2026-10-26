import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisPeriodStore, DisReportStore, REPORT_RESOURCE, TenantDatabase, projectScope } from '@machvon/db';
import type { FundingLineRow, ReportFilter, RevisionDetail, RevisionHead, RevisionLine } from '@machvon/db';
import {
  DomainError,
  REPORT_TYPES,
  REVISION_STATUSES,
  assertReportableStage,
  asUuid,
  draftHash,
  fundingCells,
  fundingTotals,
  negativeDeltaExplanation,
} from '@machvon/kernel';
import type { EffectiveAccess, FundingInput, ReportType, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DIS_CLOCK } from './tokens';

const READ_PERMISSION = PERMISSIONS.getReportRevision;
const CREATE_PERMISSION = PERMISSIONS.post_reports;
const EDIT_PERMISSION = PERMISSIONS.post_reports_id_revisions;
const LIST_PERMISSION = PERMISSIONS.get_resources_report_revision;
/** A week is reported weekly and a month monthly; the other kinds of period take no report of this kind (DIS 3 F1). */
const PERIOD_TYPE_OF: Readonly<Record<ReportType, string>> = { WEEKLY: 'WEEK', MONTHLY: 'MONTH' };
/** What the report carries beyond its six cells is the story of the volumes and the narrative (ST-DIS-004): until it lands the request refuses them instead of dropping them. */
const LATER_MEMBERS = ['construction_vnd', 'acceptance_vnd', 'treasury_submitted_vnd', 'preparing_dossier_vnd', 'physical_progress_pct', 'narrative'] as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const line = (row: FundingLineRow): Record<string, unknown> => ({
  bucket: row.bucket,
  budget_level: row.budgetLevel,
  allocated_vnd: row.allocatedVnd,
  cumulative_vnd: row.cumulativeVnd,
  ctmtqg_subset_vnd: row.ctmtqgVnd,
  next_month_vnd: row.nextMonthVnd,
  next_month_ctmtqg_subset_vnd: row.nextMonthCtmtqgVnd,
  source_year: row.sourceYear,
  previous_cumulative_vnd: row.previousCumulativeVnd,
  delta_vnd: row.deltaVnd,
});

/**
 * A report as DIS-04 reads it: the revision, the project, the period and the plan version it rests on, the six cells with what the plan allocated and what the period before had reached, and
 * the totals. The total is the sum of the six cumulative cells; the CTMTQG is inside them and is given apart, never added (BR-DIS-01). Money is text, whole dong.
 */
export function reportView(detail: RevisionDetail): Record<string, unknown> {
  const next = fundingTotals(detail.lines);
  return {
    id: detail.id,
    revision: detail.revision,
    status: detail.status,
    is_current: detail.isCurrent,
    version: detail.version,
    report_type: detail.reportType,
    measurement_basis: detail.measurementBasis,
    is_late: detail.isLate,
    payload_hash: detail.payloadHash,
    negative_delta_explanation: detail.negativeDeltaExplanation,
    submitted_at: detail.submittedAt,
    accepted_at: detail.acceptedAt,
    created_at: detail.createdAt,
    created_by: detail.createdBy,
    updated_at: detail.updatedAt,
    project: { id: detail.project.id, code: detail.project.code, name: detail.project.name, status: detail.project.status },
    period: {
      id: detail.period.id,
      code: detail.period.code,
      period_type: detail.period.periodType,
      fiscal_year: detail.period.fiscalYear,
      start_date: detail.period.startDate,
      end_date: detail.period.endDate,
      status: detail.period.status,
    },
    plan_version: { id: detail.plan.id, fiscal_year: detail.plan.fiscalYear, revision: detail.plan.revision, status: detail.plan.status },
    funding_lines: detail.lines.map(line),
    totals: {
      allocated_vnd: detail.totals.allocatedVnd,
      cumulative_vnd: next.cumulativeVnd,
      ctmtqg_vnd: next.ctmtqgVnd,
      next_month_vnd: next.nextMonthVnd,
      next_month_ctmtqg_vnd: next.nextMonthCtmtqgVnd,
    },
    needs_explanation: detail.lines.some((row) => row.deltaVnd !== null && row.deltaVnd.startsWith('-')),
  };
}

/** A report as DIS-01 lists it. */
export function reportLineView(row: RevisionLine): Record<string, unknown> {
  return {
    id: row.id,
    project: { id: row.project.id, code: row.project.code, name: row.project.name },
    period: { id: row.period.id, code: row.period.code, end_date: row.period.endDate, fiscal_year: row.period.fiscalYear, status: row.period.status },
    plan_version_id: row.planVersionId,
    revision: row.revision,
    status: row.status,
    report_type: row.reportType,
    is_late: row.isLate,
    version: row.version,
    cumulative_vnd: row.cumulativeVnd,
    ctmtqg_vnd: row.ctmtqgVnd,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

interface Entries {
  cells: FundingInput[];
  explanation: string | null;
  reportType: ReportType;
}

/** What a request enters, once it is read: the cells, the explanation of a fall and the kind of report; anything the story does not take yet is refused by name. */
function entriesOf(body: Schemas['ReportDraft']): Entries {
  const record = body as unknown as Record<string, unknown>;
  for (const member of LATER_MEMBERS) {
    if (record[member] !== undefined) throw new DomainError('VALIDATION_FAILED', 422, member);
  }
  const reportType: ReportType = body.report_type ?? 'WEEKLY';
  if (!(REPORT_TYPES as readonly string[]).includes(reportType)) throw new DomainError('VALIDATION_FAILED', 422, 'report_type');
  return { cells: fundingCells(body.funding_lines), explanation: negativeDeltaExplanation(body.negative_delta_explanation), reportType };
}

function filterOf(query: Record<string, unknown>): ReportFilter {
  const text = (field: string): string | undefined => {
    const value = query[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value === '') throw new DomainError('VALIDATION_FAILED', 422, field);
    return value;
  };
  const uuid = (field: string): string | undefined => {
    const value = text(field);
    if (value === undefined) return undefined;
    const parsed = asUuid(value);
    if (parsed === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
    return parsed;
  };
  const year = text('fiscal_year');
  if (year !== undefined && !/^\d{4}$/.test(year)) throw new DomainError('VALIDATION_FAILED', 422, 'fiscal_year');
  const status = text('status');
  if (status !== undefined && !(REVISION_STATUSES as readonly string[]).includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  const reportType = text('report_type');
  if (reportType !== undefined && !(REPORT_TYPES as readonly string[]).includes(reportType)) throw new DomainError('VALIDATION_FAILED', 422, 'report_type');
  return {
    fiscalYear: year === undefined ? undefined : Number(year),
    periodId: uuid('period_id'),
    planVersionId: uuid('plan_version_id'),
    planId: uuid('plan_id'),
    projectId: uuid('project_id'),
    status,
    reportType,
  };
}

const isFiltered = (filter: ReportFilter): boolean => Object.values(filter).some((value) => value !== undefined);

/**
 * The commands of the weekly report draft (ST-DIS-003, DIS 3 F1). A maker starts the draft of a project for a period (revision 1, with the plan version in force at the end of the period and what
 * it allocated to each of the six cells) and saves the entries under the version the screen showed. A project is found through its owner and investor unit (404 outside the scope of the
 * caller, 403 when the caller may read it and not act on it); a locked period takes nothing unless a reopening that was approved names the project; what was handed in is not edited. The trail
 * keeps ids, codes and totals, never the words of an explanation.
 */
@Controller()
export class ReportController {
  private readonly reports = new DisReportStore();
  private readonly periods = new DisPeriodStore();
  private readonly clock: () => Date;

  constructor(@Optional() @Inject(DIS_CLOCK) clock?: () => Date) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('reports')
  @HttpCode(200)
  @OperationId('post_reports')
  @Command({ operation: 'post_reports' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ReportDraft']): Promise<CommandResult> {
    const now = this.clock();
    const entries = entriesOf(body);
    const project = await this.reports.project(scope.tx, body.project_id, projectScope(access, READ_PERMISSION, now), projectScope(access, CREATE_PERMISSION, now));
    // A client operation names one report: sent again with the same entries it is answered with the report it made, with other entries it is a mistake of the client.
    const hashFor = (planVersionId: string): string =>
      draftHash({
        projectId: project.id,
        periodId: body.period_id,
        planVersionId,
        reportType: entries.reportType,
        measurementBasis: body.measurement_basis,
        cells: entries.cells,
        negativeDeltaExplanation: entries.explanation,
      });
    if (body.client_operation_id !== undefined) {
      const earlier = await this.reports.byClientOperation(scope.tx, body.client_operation_id);
      if (earlier !== undefined) {
        const hash = hashFor(earlier.planVersionId);
        const planAsked = body.plan_version_id === undefined || body.plan_version_id.toLowerCase() === earlier.planVersionId;
        if (earlier.projectId !== project.id || earlier.periodId !== body.period_id.toLowerCase() || earlier.payloadHash !== hash || !planAsked) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'client_operation_id');
        await scope.audit({ action: 'dis.report_replayed', resourceType: REPORT_RESOURCE, resourceId: earlier.id, diff: { client_operation_id: body.client_operation_id, revision: earlier.revision, payload_hash: hash } });
        return commandResult(scope, earlier.status, earlier.version, earlier.id);
      }
    }
    assertReportableStage(project.status);
    const judged = await this.periods.judge(scope.tx, body.period_id, project.id, now);
    if (PERIOD_TYPE_OF[entries.reportType] !== judged.period.periodType) throw new DomainError('VALIDATION_FAILED', 422, 'report_type');
    const effective = await this.reports.effectivePlan(scope.tx, project.id, judged.period.fiscalYear, judged.period.endDate);
    // The plan version is the one in force at the end of the period; a client that names one names that one.
    if (effective === undefined || (body.plan_version_id !== undefined && effective.id !== body.plan_version_id.toLowerCase())) {
      throw new DomainError('PLAN_VERSION_NOT_EFFECTIVE', 422, 'plan_version_id', { extensions: effective === undefined ? {} : { effective_plan_version_id: effective.id } });
    }
    const hash = hashFor(effective.id);
    const made = await this.reports.createDraft(
      scope.tx,
      {
        projectId: project.id,
        periodId: body.period_id,
        planVersionId: effective.id,
        reportType: entries.reportType,
        measurementBasis: body.measurement_basis,
        cells: entries.cells,
        negativeDeltaExplanation: entries.explanation,
        clientOperationId: body.client_operation_id,
        allocations: await this.reports.allocations(scope.tx, effective.id),
      },
      scope.tenant.membershipId,
    );
    const totals = fundingTotals(entries.cells);
    await scope.audit({
      action: 'dis.report_created',
      resourceType: REPORT_RESOURCE,
      resourceId: made.id,
      diff: {
        project_code: project.code,
        period_code: judged.period.code,
        plan_version_id: effective.id,
        revision: 1,
        report_type: entries.reportType,
        measurement_basis: body.measurement_basis,
        payload_hash: hash,
        cumulative_vnd: totals.cumulativeVnd,
        ctmtqg_vnd: totals.ctmtqgVnd,
        reopened: judged.reopen !== null,
      },
    });
    return commandResult(scope, 'DRAFT', made.version, made.id);
  }

  @Post('reports/:id/revisions')
  @HttpCode(200)
  @OperationId('post_reports_id_revisions')
  @Command({ operation: 'post_reports_id_revisions', versioned: true })
  async save(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['ReportDraft'],
  ): Promise<CommandResult> {
    const now = this.clock();
    const entries = entriesOf(body);
    const head = await this.reports.lock(scope.tx, id, projectScope(access, READ_PERMISSION, now), projectScope(access, EDIT_PERMISSION, now), scope.expectedVersion ?? 0);
    // What was handed in is not edited; the answer does not wait for the period.
    this.reports.assertEditable(head);
    this.assertSame(head, body, entries.reportType);
    await this.periods.judge(scope.tx, head.periodId, head.projectId, now);
    const saved = await this.reports.saveDraft(scope.tx, head, { measurementBasis: body.measurement_basis, cells: entries.cells, negativeDeltaExplanation: entries.explanation }, scope.tenant.membershipId);
    const totals = fundingTotals(entries.cells);
    await scope.audit({
      action: 'dis.report_saved',
      resourceType: REPORT_RESOURCE,
      resourceId: id,
      diff: { revision: head.revision, measurement_basis: body.measurement_basis, payload_hash: saved.payloadHash, cumulative_vnd: totals.cumulativeVnd, ctmtqg_vnd: totals.ctmtqgVnd, version: saved.version },
    });
    return commandResult(scope, 'DRAFT', saved.version, id);
  }

  /** A draft is saved for the project, the period and the plan version it was made for: another is a different report (422 `VALIDATION_FAILED` naming the member). */
  private assertSame(head: RevisionHead, body: Schemas['ReportDraft'], reportType: ReportType): void {
    if (head.projectId !== body.project_id.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    if (head.periodId !== body.period_id.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 422, 'period_id');
    if (body.plan_version_id !== undefined && head.planVersionId !== body.plan_version_id.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 422, 'plan_version_id');
    if (head.reportType !== reportType) throw new DomainError('VALIDATION_FAILED', 422, 'report_type');
  }
}

/** The reads of the reports (DIS-01, DIS-04, DIS-16): all through the project of the report, so a report outside the scope of the caller is not found (404) and not counted. */
@Controller()
export class ReportReadsController {
  private readonly reports = new DisReportStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('reports/:id')
  @OperationId('getReportRevision')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return this.detail(tenant, id, projectScope(access, READ_PERMISSION, new Date()));
  }

  @Get('resources/report_revision/:id')
  @OperationId('get_resources_report_revision_id')
  async getResource(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return this.detail(tenant, id, projectScope(access, LIST_PERMISSION, new Date()));
  }

  /**
   * The list of DIS-01, newest first, with figures that say what they are the total of (SRC-01/02): `summary.filtered` adds up the reports of the filter, `summary.scope` the reports the caller can
   * see at all. The first is the total of the table when the table is filtered, so it can differ from the second without confusion; with no filter they are the same.
   */
  @Get('resources/report_revision')
  @OperationId('get_resources_report_revision')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('fiscal_year') fiscalYear?: unknown,
    @Query('period_id') periodId?: unknown,
    @Query('plan_version_id') planVersionId?: unknown,
    @Query('plan_id') planId?: unknown,
    @Query('project_id') projectId?: unknown,
    @Query('status') status?: unknown,
    @Query('report_type') reportType?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const filter = filterOf({ fiscal_year: fiscalYear, period_id: periodId, plan_version_id: planVersionId, plan_id: planId, project_id: projectId, status, report_type: reportType });
    if (request.after !== undefined && (!TIMESTAMP.test(request.after.code) || Number.isNaN(Date.parse(request.after.code)))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const scope = projectScope(access, LIST_PERMISSION, new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const rows = await this.reports.list(tx, scope, filter, { limit: request.limit + 1, after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id } });
      const filtered = await this.reports.kpi(tx, scope, filter);
      const whole = isFiltered(filter) ? await this.reports.kpi(tx, scope, {}) : filtered;
      return { rows, filtered, whole };
    });
    const shown = found.rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const kpi = (figures: typeof found.filtered): Record<string, unknown> => ({ reports: figures.reports, projects: figures.projects, cumulative_vnd: figures.cumulativeVnd, ctmtqg_vnd: figures.ctmtqgVnd });
    return {
      items: shown.map(reportLineView),
      next_cursor: found.rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      summary: {
        filtered: kpi(found.filtered),
        scope: kpi(found.whole),
        is_filtered: isFiltered(filter),
        filters: {
          fiscal_year: filter.fiscalYear ?? null,
          period_id: filter.periodId ?? null,
          plan_version_id: filter.planVersionId ?? null,
          plan_id: filter.planId ?? null,
          project_id: filter.projectId ?? null,
          status: filter.status ?? null,
          report_type: filter.reportType ?? null,
        },
      },
    };
  }

  private async detail(tenant: TenantContext, id: string, scope: ReturnType<typeof projectScope>): Promise<Record<string, unknown>> {
    const found = await this.database.withTenant(tenant, (tx) => this.reports.find(tx, id, scope));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return reportView(found);
  }
}
