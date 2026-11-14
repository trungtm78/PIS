import { createHash } from 'node:crypto';
import { Controller, Get, Header, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, PwfScoreReads, TenantDatabase, projectScope, scoreUnitsOf } from '@machvon/db';
import type { StaffScoreLineSummary } from '@machvon/db';
import { DomainError, PWF_SCORE_TEXT, csvOf, vietnamDateOf, xlsxOf } from '@machvon/kernel';
import type { EffectiveAccess, ExportDocument, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { queryText } from './pwf-support';
import { PWF_RESOURCE_SCORE_LINE, PWF_RESOURCE_SCORE_PERIOD, READ_HR_PERMISSION, auditView, intersectUnits, lineDto, periodDto, reachOf } from './score-support';
import type { ScoreReach } from './score-support';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_TYPE = 'text/csv; charset=utf-8';

const summaryDto = (line: StaffScoreLineSummary): Schemas['StaffScoreLinePage']['items'][number] => ({
  id: line.id,
  period_id: line.periodId,
  membership_id: line.membershipId,
  display_name: line.displayName,
  unit_id_at_period: line.unitIdAtPeriod,
  unit_code_at_period: line.unitCode,
  unit_name_at_period: line.unitName,
  score_computed: line.scoreComputed,
  score_adjusted: line.scoreAdjusted,
  rating: line.rating,
  state: line.state,
  rated_task_count: line.ratedTaskCount,
  effective_weight: line.effectiveWeight,
  has_adjustment: line.hasAdjustment,
  has_open_response: line.hasOpenResponse,
});

/**
 * The reads of the scores of staff (PWF-3, docs PWF 7, R33). The score of a person is shown by the database only to the person, to the units whose manager asks and to the whole tenant for the human resources;
 * what is read here goes through `enterScoreScope` first, so a row out of the reach of the caller is not read at all and is answered as if it did not exist (404). Every view of the score of another person and
 * every file is written to the audit trail (ADM-11) in the transaction of the read, with who, which period, how many rows and the hash of the file, never a score or a name. The answers are never cached.
 */
@Controller()
export class StaffScoreReadsController {
  private readonly reads = new PwfScoreReads();
  private readonly audit: AuditWriter;

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {
    this.audit = new AuditWriter(database);
  }

  private viewerOf(tenant: TenantContext, reach: ScoreReach, today: string): Parameters<PwfScoreReads['line']>[1] {
    return { membershipId: tenant.membershipId, readUnits: reach.read, adjustUnits: reach.adjust, reviewUnits: reach.review, today };
  }

  @Get('staff-score-periods')
  @Header('Cache-Control', 'no-store')
  @OperationId('listStaffScorePeriods')
  async listPeriods(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['StaffScorePeriodPage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    const found = await this.database.withTenant(tenant, async (tx) => {
      const reach = await reachOf(tx, access, now);
      return this.reads.periods(tx, { units: reach.read, subject: '' }, { scopeUnitId: queryText(query.scope_unit_id, 'scope_unit_id'), status: queryText(query.status, 'status') }, { limit: page.limit, after: page.after });
    });
    return { items: found.items.map((one) => periodDto(one, now)), next_cursor: found.next === null ? null : encodeCursor(found.next), total: found.total, as_of: now.toISOString() } as unknown as Schemas['StaffScorePeriodPage'];
  }

  @Get('staff-score-periods/:id')
  @Header('Cache-Control', 'no-store')
  @OperationId('getStaffScorePeriod')
  async getPeriod(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['StaffScorePeriod']> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const reach = await reachOf(tx, access, now);
      return periodDto(await this.reads.period(tx, { units: reach.read, subject: '' }, id.toLowerCase()), now);
    });
  }

  @Get('staff-score-periods/:id/lines')
  @Header('Cache-Control', 'no-store')
  @OperationId('listStaffScoreLines')
  async listLines(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>): Promise<Schemas['StaffScoreLinePage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const reach = await reachOf(tx, access, now);
      const found = await this.reads.lines(tx, { units: reach.read, subject: '' }, id.toLowerCase(), { state: queryText(query.state, 'state'), unitId: queryText(query.unit_id, 'unit_id') }, { limit: page.limit, after: page.after });
      await auditView(this.audit, tx, tenant, {
        action: 'score.lines_viewed',
        resourceType: PWF_RESOURCE_SCORE_PERIOD,
        resourceId: id.toLowerCase(),
        diff: { rows: found.items.length, total: found.total, state: queryText(query.state, 'state') ?? null, unit_id: queryText(query.unit_id, 'unit_id') ?? null, whole_tenant: reach.read === '*' },
      });
      return { items: found.items.map(summaryDto), next_cursor: found.next === null ? null : encodeCursor(found.next), total: found.total, as_of: now.toISOString() } as unknown as Schemas['StaffScoreLinePage'];
    });
  }

  @Get('me/staff-scores')
  @Header('Cache-Control', 'no-store')
  @OperationId('getMyStaffScore')
  async mine(@CurrentTenant() tenant: TenantContext, @Query() query: Record<string, unknown>): Promise<Schemas['MyStaffScorePage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.reads.mine(tx, tenant.membershipId, { limit: page.limit, after: page.after });
      const viewer = { membershipId: tenant.membershipId, readUnits: '', adjustUnits: '', reviewUnits: '', today: vietnamDateOf(now) };
      const items = [];
      for (const one of found.items) {
        const line = await this.reads.line(tx, viewer, one.line.id, () => ({ sql: 'true', params: [] }));
        items.push({ period: periodDto({ ...one.period, lineCount: 1, openResponseCount: line.responses.filter((response) => response.status === 'OPEN').length }, now), line: lineDto(line, now) });
      }
      return { items, next_cursor: found.next === null ? null : encodeCursor(found.next), as_of: now.toISOString() } as unknown as Schemas['MyStaffScorePage'];
    });
  }

  @Get('staff-score-lines/compare')
  @Header('Cache-Control', 'no-store')
  @OperationId('compareStaffScoreLines')
  async compare(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['StaffScoreComparison']> {
    const now = new Date();
    const member = (queryText(query.membership_id, 'membership_id') ?? tenant.membershipId).toLowerCase();
    return this.database.withTenant(tenant, async (tx) => {
      const reach = await reachOf(tx, access, now);
      const found = await this.reads.compare(tx, this.viewerOf(tenant, reach, vietnamDateOf(now)), member, { from: queryText(query.from, 'from'), to: queryText(query.to, 'to') });
      if (member !== tenant.membershipId) await auditView(this.audit, tx, tenant, { action: 'score.comparison_viewed', resourceType: PWF_RESOURCE_SCORE_LINE, resourceId: member, diff: { subject_membership_id: member, periods: found.points.length } });
      return {
        membership_id: found.membershipId,
        points: found.points.map((one) => ({
          period_id: one.periodId,
          period_from: one.periodFrom,
          period_to: one.periodTo,
          period_status: one.periodStatus,
          score_computed: one.scoreComputed,
          score_adjusted: one.scoreAdjusted,
          rating: one.rating,
          state: one.state,
          rated_task_count: one.ratedTaskCount,
          effective_weight: one.effectiveWeight,
        })),
        sample_sizes_differ: found.samplesDiffer,
        as_of: now.toISOString(),
      } as unknown as Schemas['StaffScoreComparison'];
    });
  }

  @Get('staff-score-lines/:id')
  @Header('Cache-Control', 'no-store')
  @OperationId('getStaffScoreLine')
  async getLine(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['StaffScoreLine']> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const reach = await reachOf(tx, access, now);
      const line = await this.reads.line(tx, this.viewerOf(tenant, reach, vietnamDateOf(now)), id.toLowerCase(), projectScope(access, PERMISSIONS.getProjectWorkflow, now));
      if (!line.isSubject) {
        await auditView(this.audit, tx, tenant, { action: 'score.line_viewed', resourceType: PWF_RESOURCE_SCORE_LINE, resourceId: line.id, diff: { period_id: line.periodId, subject_membership_id: line.membershipId, unit_id_at_period: line.unitIdAtPeriod } });
      }
      return lineDto(line, now);
    });
  }

  @Get('staff-score-periods/:id/signals')
  @Header('Cache-Control', 'no-store')
  @OperationId('listStaffScoreSignals')
  async signals(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>): Promise<Schemas['StaffScoreSignalPage']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    return this.database.withTenant(tenant, async (tx) => {
      const reach = await reachOf(tx, access, now);
      const found = await this.reads.signals(tx, reach.review, tenant.membershipId, id.toLowerCase(), { limit: page.limit, after: page.after });
      await auditView(this.audit, tx, tenant, { action: 'score.signals_viewed', resourceType: PWF_RESOURCE_SCORE_PERIOD, resourceId: id.toLowerCase(), diff: { rows: found.items.length } });
      return {
        items: found.items.map((one) => ({ membership_id: one.membershipId, display_name: one.displayName, flags: one.flags.map((flag) => ({ code: flag.code, task_codes: flag.taskCodes })) })),
        next_cursor: found.next === null ? null : encodeCursor(found.next),
        as_of: now.toISOString(),
      } as unknown as Schemas['StaffScoreSignalPage'];
    });
  }

  @Get('staff-score-periods/:id/overview')
  @Header('Cache-Control', 'no-store')
  @OperationId('getStaffScoreOverview')
  async overview(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['StaffScoreOverview']> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      // The overview is the human resources' own: a grant of `staff_score.read_hr` over the whole tenant, never a unit.
      if ((await scoreUnitsOf(tx, access, [READ_HR_PERMISSION], now)) !== '*') throw new DomainError('SCOPE_DENIED', 403);
      const units = await this.reads.overview(tx, { units: '*', subject: '' }, id.toLowerCase());
      await auditView(this.audit, tx, tenant, { action: 'score.overview_viewed', resourceType: PWF_RESOURCE_SCORE_PERIOD, resourceId: id.toLowerCase(), diff: { units: units.length, permission: READ_HR_PERMISSION } });
      return {
        period_id: id.toLowerCase(),
        units: units.map((one) => ({ unit_id: one.unitId, unit_code: one.unitCode, unit_name: one.unitName, people: one.people, rated: one.rated, small_sample: one.smallSample, not_rated: one.notRated, mean_score: one.meanScore, adjusted_count: one.adjustedCount, open_response_count: one.openResponseCount })),
        as_of: now.toISOString(),
      } as unknown as Schemas['StaffScoreOverview'];
    });
  }

  @Get('staff-score-periods/:id/export')
  @Header('Cache-Control', 'no-store')
  @OperationId('exportStaffScorePeriod')
  async export(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>): Promise<Schemas['StaffScorePeriodExport']> {
    const now = new Date();
    const format = queryText(query.format, 'format') ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') throw new DomainError('VALIDATION_FAILED', 422, 'format');
    return this.database.withTenant(tenant, async (tx) => {
      const reach = await reachOf(tx, access, now);
      // A file is made only of what the caller may export AND read, judged again here on the units of each line (the source of the figures), and never of what the period list showed.
      const units = intersectUnits(reach.exportFiles, reach.read);
      if (units === '') throw new DomainError('SCOPE_DENIED', 403);
      const found = await this.reads.exportRows(tx, { units, subject: '' }, id.toLowerCase());
      if (found.period.status === 'DRAFT') throw new DomainError('VALIDATION_FAILED', 422, 'status');
      const yes = PWF_SCORE_TEXT.yes;
      const no = PWF_SCORE_TEXT.no;
      const document: ExportDocument = {
        title: PWF_SCORE_TEXT.export_title,
        header: [
          { key: 'period', label: PWF_SCORE_TEXT.header_period, value: `${found.period.periodFrom} - ${found.period.periodTo}` },
          { key: 'status', label: PWF_SCORE_TEXT.header_status, value: found.period.status },
          { key: 'policy', label: PWF_SCORE_TEXT.header_policy, value: `${found.period.policyCode} v${found.period.policyVersion}` },
          { key: 'hash', label: PWF_SCORE_TEXT.header_hash, value: found.period.snapshotHash ?? '' },
          { key: 'as_of', label: PWF_SCORE_TEXT.header_as_of, value: vietnamDateOf(now) },
          { key: 'basis', label: PWF_SCORE_TEXT.header_basis, value: PWF_SCORE_TEXT.value_basis },
        ],
        columns: [
          { key: 'unit', label: PWF_SCORE_TEXT.column_unit, numeric: false },
          { key: 'person', label: PWF_SCORE_TEXT.column_person, numeric: false },
          { key: 'computed', label: PWF_SCORE_TEXT.column_computed, numeric: true },
          { key: 'adjusted', label: PWF_SCORE_TEXT.column_adjusted, numeric: true },
          { key: 'rating', label: PWF_SCORE_TEXT.column_rating, numeric: false },
          { key: 'state', label: PWF_SCORE_TEXT.column_state, numeric: false },
          { key: 'rated_tasks', label: PWF_SCORE_TEXT.column_rated_tasks, numeric: true },
          { key: 'weight', label: PWF_SCORE_TEXT.column_weight, numeric: true },
          { key: 'adjustment', label: PWF_SCORE_TEXT.column_adjustment, numeric: false },
          { key: 'response', label: PWF_SCORE_TEXT.column_response, numeric: false },
        ],
        rows: found.rows.map((row) => [row.unitCode, row.displayName, row.scoreComputed === null ? '' : String(row.scoreComputed), row.scoreAdjusted === null ? '' : String(row.scoreAdjusted), row.rating ?? '', row.state, String(row.ratedTaskCount), String(row.effectiveWeight), row.hasAdjustment ? yes : no, row.hasOpenResponse ? yes : no]),
        notice: PWF_SCORE_TEXT.notice,
      };
      const bytes = format === 'csv' ? Buffer.from(csvOf(document), 'utf8') : Buffer.from(xlsxOf(document));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await auditView(this.audit, tx, tenant, { action: 'score.period_exported', resourceType: PWF_RESOURCE_SCORE_PERIOD, resourceId: found.period.id, diff: { rows: found.rows.length, format, sha256, size_bytes: bytes.length, whole_tenant: units === '*' } });
      return {
        file_name: `diem-danh-gia-${found.period.periodFrom}-${found.period.periodTo}.${format}`,
        content_type: format === 'csv' ? CSV_TYPE : XLSX_TYPE,
        size_bytes: bytes.length,
        sha256,
        content_base64: bytes.toString('base64'),
        as_of: now.toISOString(),
      };
    });
  }
}
