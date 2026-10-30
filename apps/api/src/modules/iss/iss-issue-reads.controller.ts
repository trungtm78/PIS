import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ISSUE_STATUSES, IssEscalationStore, IssIssueStore, IssWeeklyStore, LAND_HOUSEHOLD_PERMISSION, TenantDatabase, emptyStatusCounts, issueScope } from '@machvon/db';
import type { IssueFilter, IssueMatrixRow, IssueStatus } from '@machvon/db';
import { DomainError, asUuid, effectivePermissions, holdsPermission, isoWeekRange } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { issueDetailView, issueEventView, issueLineView } from './issue-view';

const READ_PERMISSION = PERMISSIONS.get_resources_issue;
const ESCALATE_PERMISSION = PERMISSIONS.escalateIssue;
const MATRIX_PERMISSION = PERMISSIONS.getIssueWeeklyMatrix;
const DAY_MS = 86_400_000;

function idFilter(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/** The narrowing of the list that the cells of the weekly matrix open: a unit, a group, a status, and the week the status is read at the end of (the moment is the end of the week, or now while the week runs). */
function filterOf(query: { owner_unit_id?: unknown; category_version_id?: unknown; status?: unknown; week?: unknown; open?: unknown }, now: Date): IssueFilter {
  const status = query.status === undefined ? undefined : ISSUE_STATUSES.find((candidate) => candidate === query.status);
  if (query.status !== undefined && status === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  if (query.open !== undefined && query.open !== 'true') throw new DomainError('VALIDATION_FAILED', 422, 'open');
  const week = query.week === undefined ? undefined : isoWeekRange(query.week);
  const end = week === undefined ? undefined : new Date(Date.parse(`${week.to}T00:00:00+07:00`) + DAY_MS);
  return {
    ownerUnitId: idFilter(query.owner_unit_id, 'owner_unit_id'),
    categoryVersionId: idFilter(query.category_version_id, 'category_version_id'),
    status: status as IssueStatus | undefined,
    open: query.open === 'true' ? true : undefined,
    // A week that has not begun has no issue in it: the moment is before every issue, so the list is empty as the matrix is.
    week: week === undefined || end === undefined ? undefined : { at: Date.parse(`${week.from}T00:00:00+07:00`) > now.getTime() ? new Date(0).toISOString() : new Date(Math.min(end.getTime(), now.getTime() + 1)).toISOString() },
  };
}

/**
 * The issues in the scope of the caller (ISS-01) and the workspace of one issue with its timeline (ISS-03): a DTO allowlist filtered by the
 * unit tree, the project and the contract of the caller's grants, and by the person who reported the issue. An issue outside the scope, or
 * of another tenant, does not exist for the caller (404). What a reader sees of an issue depends on who they are: staff or a guest
 * contractor, and whether they may read the households a land complaint names.
 */
@Controller('resources/issue')
export class IssIssueReadsController {
  private readonly issues = new IssIssueStore();
  private readonly escalations = new IssEscalationStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_issue')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('owner_unit_id') ownerUnitId?: unknown,
    @Query('category_version_id') categoryVersionId?: unknown,
    @Query('status') status?: unknown,
    @Query('week') week?: unknown,
    @Query('open') open?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const filter = filterOf({ owner_unit_id: ownerUnitId, category_version_id: categoryVersionId, status, week, open }, now);
    const reads = issueScope(access, READ_PERMISSION, now, { reporter: tenant.membershipId });
    const { lines, overdue, guest } = await this.database.withTenant(tenant, async (tx) => {
      const found = await this.issues.list(tx, reads, { limit: request.limit + 1, after: request.after, filter });
      const shown = found.slice(0, request.limit);
      return { lines: found, overdue: await this.issues.overdueDays(tx, shown, now), guest: await this.issues.isGuest(tx, tenant.membershipId) };
    });
    const shown = lines.slice(0, request.limit);
    const last = shown[shown.length - 1];
    const viewer = { membershipId: tenant.membershipId, guest };
    return {
      items: shown.map((line, index) => issueLineView(line, overdue[index] ?? null, viewer)),
      next_cursor: lines.length > request.limit && last !== undefined ? encodeCursor({ code: last.codeKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  /** The issue with its timeline, the oldest event first; `limit` and `cursor` page the timeline and `next_cursor` is the cursor of its next page. */
  @Get(':id')
  @OperationId('get_resources_issue_id')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const reads = issueScope(access, READ_PERMISSION, now, { reporter: tenant.membershipId });
    const found = await this.database.withTenant(tenant, async (tx) => {
      const detail = await this.issues.find(tx, id, reads);
      if (detail === undefined) return undefined;
      const [overdue] = await this.issues.overdueDays(tx, [detail], now);
      const events = await this.issues.events(tx, id, { limit: request.limit + 1, after: request.after });
      const escalationRows = await this.escalations.forIssue(tx, id);
      // The task force that could be offered for a manual escalation to level 3 is told to a reader who may escalate.
      const mayEscalate = holdsPermission(effectivePermissions(access, now, detail.place), ESCALATE_PERMISSION);
      const taskForce = mayEscalate ? await this.escalations.activeTaskForceOf(tx, { projectId: detail.projectId, ownerUnitPath: detail.place.ownerUnitPath }, now) : undefined;
      return { detail, overdue: overdue ?? null, events, escalationRows, taskForce, guest: await this.issues.isGuest(tx, tenant.membershipId) };
    });
    // An issue in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const viewer = { membershipId: tenant.membershipId, guest: found.guest };
    const rights = { land: holdsPermission(effectivePermissions(access, now, found.detail.place), LAND_HOUSEHOLD_PERMISSION) };
    const shown = found.events.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      ...issueDetailView(found.detail, found.overdue, viewer, rights, { escalations: found.escalationRows, taskForce: found.taskForce }),
      events: shown.map((event) => issueEventView(event, viewer, rights, found.detail.sourceModule)),
      next_cursor: found.events.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }
}


interface Totals {
  opening: number;
  opened: number;
  resolved: number;
  closing: number;
  overdue: number;
  by_status: Record<IssueStatus, number>;
}

const zero = (): Totals => ({ opening: 0, opened: 0, resolved: 0, closing: 0, overdue: 0, by_status: emptyStatusCounts() });

function add(total: Totals, row: IssueMatrixRow): void {
  total.opening += row.opening;
  total.opened += row.opened;
  total.resolved += row.resolved;
  total.closing += row.closing;
  total.overdue += row.overdue;
  for (const status of ISSUE_STATUSES) total.by_status[status] += row.byStatus[status];
}

/**
 * The weekly matrix of the issues (ISS-06, ISS-08, ISS 3.1, BR-ISS-08, UAT-PLAN-25): by the unit that owns them and the group they belong to, what stood open when the ISO week began, what became open in it, what was closed, what
 * stood open when it ended, how many of those were overdue, and the issues counted by the status they had when the week ended. Never for a guest contractor. The cells open the list of issues with the same unit, group, status and week.
 */
@Controller('issues/weekly-matrix')
export class IssWeeklyMatrixController {
  private readonly issues = new IssIssueStore();
  private readonly weekly = new IssWeeklyStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('getIssueWeeklyMatrix')
  async matrix(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('week') week?: unknown, @Query('unit_id') unitId?: unknown): Promise<Record<string, unknown>> {
    const range = isoWeekRange(week);
    const unit = idFilter(unitId, 'unit_id');
    const now = new Date();
    const reads = issueScope(access, MATRIX_PERMISSION, now, { reporter: tenant.membershipId });
    const rows = await this.database.withTenant(tenant, async (tx) => {
      if (await this.issues.isGuest(tx, tenant.membershipId)) throw new DomainError('SCOPE_DENIED', 403);
      return this.weekly.matrix(tx, reads, range, unit, now);
    });
    const totals = zero();
    const units = new Map<string, { unit: { id: string; code: string; name: string }; total: Totals }>();
    for (const row of rows) {
      add(totals, row);
      const entry = units.get(row.unitId) ?? { unit: { id: row.unitId, code: row.unitCode, name: row.unitName }, total: zero() };
      add(entry.total, row);
      units.set(row.unitId, entry);
    }
    return {
      week: range.week,
      from: range.from,
      to: range.to,
      statuses: [...ISSUE_STATUSES],
      rows: rows.map((row) => ({
        unit: { id: row.unitId, code: row.unitCode, name: row.unitName },
        category: { version_id: row.categoryVersionId, code: row.categoryCode, label: row.categoryLabel },
        opening: row.opening,
        opened: row.opened,
        resolved: row.resolved,
        closing: row.closing,
        overdue: row.overdue,
        by_status: row.byStatus,
      })),
      units: [...units.values()].map((entry) => ({ unit: entry.unit, ...entry.total })),
      totals,
      as_of: now.toISOString(),
    };
  }
}
