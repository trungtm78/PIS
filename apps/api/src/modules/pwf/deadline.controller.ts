import { createHash, randomUUID } from 'node:crypto';
import { Controller, Get, Header, Inject, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, PwfDeadlineReads, TenantDatabase, projectScope } from '@machvon/db';
import { DomainError, PWF_BOARD_TEXT, csvOf, vietnamDateOf, xlsxOf } from '@machvon/kernel';
import type { EffectiveAccess, ExportDocument, TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { queryText } from './pwf-support';

const integer = (value: unknown, field: string): number | undefined => {
  const text = queryText(value, field);
  if (text === undefined) return undefined;
  if (!/^\d{1,4}$/.test(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return Number(text);
};

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_TYPE = 'text/csv; charset=utf-8';
/** The rows one read of the board gives the file, and the most a file holds: a list longer than that is narrowed by its filters, never cut in silence (R35). */
const EXPORT_PAGE = 200;
export const EXPORT_MAX_ROWS = 10_000;
const PWF_RESOURCE_DEADLINE_BOARD = 'pwf_deadline_board';
/** The board has no row of its own: the audit row of a file names the tenant-wide board by this fixed id. */
const BOARD_RESOURCE_ID = '00000000-0000-4000-8000-0000000000b7';

interface BoardItem {
  task_code: string;
  name: string;
  project_code: string;
  project_name: string;
  status: keyof typeof PWF_BOARD_TEXT.status;
  due_date: string | null;
  forecast_finish: string | null;
  band: { band: keyof typeof PWF_BOARD_TEXT.band; remaining_days: number | null; overdue: boolean };
  critical: boolean;
  assignee: { display_name: string } | null;
}

interface BoardPage {
  items: BoardItem[];
  next: { code: string; id: string } | null;
  total: number;
}

const dayOf = (day: string | null): string => (day === null ? '' : `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`);

/**
 * The portfolio of deadlines (PWF-07): the board with exact totals and the colour of the rule of the tenant only (R40), the month calendar, the milestones of the next days and the load by person. All of them read straight from
 * `project_task` in the scope of `pwf.read`, in pages, and say how many they show of how many there are (R35).
 */
@Controller()
export class PwfDeadlineReadsController {
  private readonly reads = new PwfDeadlineReads();
  private readonly audit: AuditWriter;

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {
    this.audit = new AuditWriter(database);
  }

  private filterOf(query: Record<string, unknown>): Parameters<PwfDeadlineReads['board']>[2] {
    return {
      unitId: queryText(query.unit_id, 'unit_id'),
      projectId: queryText(query.project_id, 'project_id'),
      band: queryText(query.band, 'band'),
      phase: queryText(query.phase, 'phase'),
      assigneeId: queryText(query.assignee_id, 'assignee_id'),
      status: queryText(query.status, 'status'),
      dueFrom: queryText(query.due_from, 'due_from'),
      dueTo: queryText(query.due_to, 'due_to'),
    };
  }

  /**
   * The board as a file (PWF-07): EVERY task the filters leave, whatever the page the screen shows, read in the scope of the caller with the official colour only (R40). A list longer than `EXPORT_MAX_ROWS` is refused
   * (422, narrow the filters) instead of being cut; the file is written to the audit trail with its rows, its format and its hash, in the transaction of the read. Never cached.
   */
  @Get('pwf/deadlines/export')
  @Header('Cache-Control', 'no-store')
  @OperationId('exportDeadlineBoard')
  async export(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfDeadlineExport']> {
    const now = new Date();
    const format = queryText(query.format, 'format') ?? 'xlsx';
    if (format !== 'xlsx' && format !== 'csv') throw new DomainError('VALIDATION_FAILED', 422, 'format');
    const filter = this.filterOf(query);
    return this.database.withTenant(tenant, async (tx) => {
      const scope = projectScope(access, PERMISSIONS.exportDeadlineBoard, now);
      const items: BoardItem[] = [];
      let after: { code: string; id: string } | undefined;
      for (;;) {
        const page = (await this.reads.board(tx, scope, filter, { limit: EXPORT_PAGE, after }, now)) as unknown as BoardPage;
        if (page.total > EXPORT_MAX_ROWS) throw new DomainError('VALIDATION_FAILED', 422, 'filters', { extensions: { total: page.total, max_rows: EXPORT_MAX_ROWS } });
        items.push(...page.items);
        if (page.next === null) break;
        after = page.next;
      }
      const T = PWF_BOARD_TEXT;
      const applied = Object.entries(filter).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${String(value)}`);
      const document: ExportDocument = {
        title: T.export_title,
        header: [
          { key: 'as_of', label: T.header_as_of, value: dayOf(vietnamDateOf(now)) },
          { key: 'rows', label: T.header_rows, value: String(items.length) },
          { key: 'filters', label: T.header_filters, value: applied.length === 0 ? T.no_filters : applied.join('; ') },
          { key: 'basis', label: T.header_basis, value: T.value_basis },
        ],
        columns: [
          { key: 'project_code', label: T.column_project_code, numeric: false },
          { key: 'project', label: T.column_project, numeric: false },
          { key: 'task', label: T.column_task, numeric: false },
          { key: 'task_code', label: T.column_task_code, numeric: false },
          { key: 'person', label: T.column_person, numeric: false },
          { key: 'status', label: T.column_status, numeric: false },
          { key: 'due', label: T.column_due, numeric: false },
          { key: 'forecast', label: T.column_forecast, numeric: false },
          { key: 'band', label: T.column_band, numeric: false },
          { key: 'remaining', label: T.column_remaining, numeric: true },
          { key: 'critical', label: T.column_critical, numeric: false },
        ],
        rows: items.map((row) => [
          row.project_code,
          row.project_name,
          row.name,
          row.task_code,
          row.assignee?.display_name ?? T.unassigned,
          T.status[row.status] ?? row.status,
          dayOf(row.due_date),
          dayOf(row.forecast_finish ?? null),
          `${T.band[row.band.band] ?? row.band.band}${row.band.overdue ? `, ${T.overdue}` : ''}`,
          row.band.remaining_days === null ? '' : String(row.band.remaining_days),
          row.critical ? T.yes : T.no,
        ]),
        notice: null,
      };
      const bytes = format === 'csv' ? Buffer.from(csvOf(document), 'utf8') : Buffer.from(xlsxOf(document));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await this.audit.recordInTx(tx, tenant.membershipId, {
        action: 'pwf.deadlines_exported',
        resourceType: PWF_RESOURCE_DEADLINE_BOARD,
        resourceId: BOARD_RESOURCE_ID,
        classification: 'INTERNAL',
        diff: { rows: items.length, format, sha256, size_bytes: bytes.length, filters: applied },
        correlationId: randomUUID(),
        requestId: randomUUID(),
      });
      return {
        file_name: `bang-deadline-${vietnamDateOf(now)}.${format}`,
        content_type: format === 'csv' ? CSV_TYPE : XLSX_TYPE,
        size_bytes: bytes.length,
        sha256,
        content_base64: bytes.toString('base64'),
        row_count: items.length,
        as_of: now.toISOString(),
      };
    });
  }

  @Get('pwf/deadlines')
  @OperationId('getDeadlineBoard')
  async board(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfDeadlineBoard']> {
    const now = new Date();
    const page = parsePageRequest(query.limit, query.cursor);
    const found = await this.database.withTenant(tenant, (tx) =>
      this.reads.board(tx, projectScope(access, PERMISSIONS.getDeadlineBoard, now), this.filterOf(query), { limit: page.limit, after: page.after }, now),
    );
    const { next, ...rest } = found as { next: { code: string; id: string } | null } & Record<string, unknown>;
    return { ...rest, next_cursor: next === null ? null : encodeCursor(next) } as unknown as Schemas['PwfDeadlineBoard'];
  }

  @Get('pwf/deadlines/calendar')
  @OperationId('getDeadlineCalendar')
  async calendar(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfDeadlineCalendar']> {
    const now = new Date();
    const month = queryText(query.month, 'month') ?? new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 7);
    return this.database.withTenant(tenant, (tx) =>
      this.reads.calendar(tx, projectScope(access, PERMISSIONS.getDeadlineCalendar, now), { unitId: queryText(query.unit_id, 'unit_id'), projectId: queryText(query.project_id, 'project_id'), assigneeId: queryText(query.assignee_id, 'assignee_id') }, month, now),
    ) as Promise<Schemas['PwfDeadlineCalendar']>;
  }

  @Get('pwf/milestones/upcoming')
  @OperationId('getUpcomingMilestones')
  async milestones(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfMilestoneList']> {
    const now = new Date();
    return this.database.withTenant(tenant, (tx) =>
      this.reads.milestones(tx, projectScope(access, PERMISSIONS.getUpcomingMilestones, now), { unitId: queryText(query.unit_id, 'unit_id'), projectId: queryText(query.project_id, 'project_id') }, integer(query.days, 'days') ?? 30, now),
    ) as Promise<Schemas['PwfMilestoneList']>;
  }

  @Get('pwf/workload')
  @OperationId('getProjectWorkload')
  async workload(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Schemas['PwfWorkload']> {
    const now = new Date();
    return this.database.withTenant(tenant, (tx) =>
      this.reads.workload(tx, projectScope(access, PERMISSIONS.getProjectWorkload, now), { unitId: queryText(query.unit_id, 'unit_id') }, { from: queryText(query.from, 'from'), weeks: integer(query.weeks, 'weeks') }, now),
    ) as Promise<Schemas['PwfWorkload']>;
  }
}
