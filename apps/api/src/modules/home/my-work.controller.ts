import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { HomeWorkStore, SEVERITY_RANK, TenantDatabase, WORK_SEVERITIES } from '@machvon/db';
import type { WorkCollection, WorkRow, WorkSeverity, WorkView } from '@machvon/db';
import { DomainError, WORK_KINDS, compareWork, vietnamDateOf, workBucket } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext, WorkItem, WorkKind } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_CLOCK } from './tokens';
import { clockFields } from './work-action-view';
import { canReadScope, workScopes } from './work-scope';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = typeof value === 'string' && /^[0-9]{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw invalid('limit');
  return parsed;
}

const days = (value: string): number => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

type Place = Pick<WorkItem, 'id' | 'kind' | 'dueOn' | 'originalDueOn'> & { severity: WorkSeverity };

/** The place a page stopped at: the kind, the id, the day and the severity of the last task, so that the next page goes on from that place whether or not the task is still there. */
const encode = (row: Pick<WorkRow, 'kind' | 'id' | 'dueOn' | 'severity'>): string => Buffer.from(JSON.stringify([row.kind, row.id, row.dueOn, row.severity]), 'utf8').toString('base64url');
function decode(cursor: unknown): Place {
  if (typeof cursor !== 'string' || cursor === '' || cursor.length > 200) throw invalid('cursor');
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    // A cursor of three parts was given before the tasks had a severity: it stands for a task to be acted on.
    if (Array.isArray(parts) && (parts.length === 3 || parts.length === 4)) {
      const [kind, id, dueOn, severity] = parts as unknown[];
      const known = severity === undefined ? 'ACTION' : severity;
      if (
        (WORK_KINDS as readonly string[]).includes(kind as string) &&
        typeof id === 'string' &&
        id !== '' &&
        id.length <= 64 &&
        (dueOn === null || (typeof dueOn === 'string' && DAY.test(dueOn))) &&
        (WORK_SEVERITIES as readonly unknown[]).includes(known)
      ) {
        return { kind: kind as WorkKind, id, dueOn: dueOn as string | null, originalDueOn: dueOn as string | null, severity: known as WorkSeverity };
      }
    }
  } catch {
    // falls through to the refusal below
  }
  throw invalid('cursor');
}

/** Urgent first, then what is late, then what is near its day, then the rest (the order of `compareWork`). */
export const compareAlert = (left: Place, right: Place, today: string): number => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || compareWork(left, right, today);

/** The view asked for: the work of the person (`mine`, the default) or the work inside what they may read (`scope`). */
export function viewOf(value: unknown): WorkView {
  if (value === undefined) return 'mine';
  if (value === 'mine' || value === 'scope') return value;
  throw invalid('view');
}

const SEVERITY_KEY: Readonly<Record<WorkSeverity, 'urgent' | 'action' | 'watch'>> = { URGENT: 'urgent', ACTION: 'action', WATCH: 'watch' };

/**
 * The work of the person who asks, in one list (ST-HOME-004, HOME 3 F5, HOME-02, the alert centre): the approvals that wait for them, the explanations they owe and the ones they must conclude, the reports of theirs that came back or
 * are drafts past their period, the monitoring reports of their unit near their day, and what the other modules raise (the early warnings, the advances that are overdue, the permits and guarantees that end, the recommendations of
 * an audit that are late, the issues that missed the SLA, the diaries that are missing). The reads are by their membership, so the work of another person never appears, whatever the rights they hold; `view=scope` reads the work
 * inside what they may read instead. Ordered as it is looked at: urgent first, then late (the earliest day first), then near its day (7 days), then the rest. An item says its original day beside the day it is due on (a request that
 * was sent back with a new day is still late by the day it was first asked for), whether it is late, how urgent it is, who took it up or was given it, how far up it has gone and where it is opened from. `counts` are of the whole
 * list, whatever page is shown; `truncated` says a source had more than it gives (2000), so the counts are a lower bound; `unavailable_sources` names a source that could not be read (it is never shown as "no work").
 */
@Controller()
export class MyWorkController {
  private readonly work = new HomeWorkStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  /** `scope` is for a reader who has a scope to read (403 SCOPE_DENIED otherwise); every source is judged by what the reader may read, and a source that fails is named, not hidden. */
  private async read(tenant: TenantContext, access: EffectiveAccess, view: WorkView, now: Date, mode: 'rows' | 'count'): Promise<WorkCollection> {
    if (view === 'scope' && !canReadScope(access, now)) throw new DomainError('SCOPE_DENIED', 403);
    const today = vietnamDateOf(now);
    return this.database.withTenant(tenant, (tx) => this.work.collect(tx, { membershipId: tenant.membershipId, now, today, view, mode, ...workScopes(access, now) }));
  }

  @Get('home/my-work')
  @OperationId('getMyWork')
  async myWork(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('view') viewQuery?: unknown,
  ): Promise<Record<string, unknown>> {
    const page = limitOf(limit);
    const from = cursor === undefined ? undefined : decode(cursor);
    const view = viewOf(viewQuery);
    const now = this.clock();
    const today = vietnamDateOf(now);
    const { rows, truncated, unavailableSources, policies } = await this.read(tenant, access, view, now, 'rows');
    const ordered = [...rows].sort((left, right) => compareAlert(left, right, today));
    // The page goes on after the place the cursor names, which a task done meanwhile does not take away.
    const rest = from === undefined ? ordered : ordered.filter((row) => compareAlert(row, from, today) > 0);
    const shown = rest.slice(0, page);
    const last = shown[shown.length - 1];
    const counts: Record<string, number> = { total: ordered.length, overdue: 0, urgent: 0, action: 0, watch: 0, needs_reclaim: 0, snoozed: 0 };
    for (const kind of WORK_KINDS) counts[kind] = 0;
    for (const row of ordered) {
      counts[row.kind] = (counts[row.kind] ?? 0) + 1;
      const key = SEVERITY_KEY[row.severity];
      counts[key] = (counts[key] ?? 0) + 1;
      if (workBucket(row, today) === 'OVERDUE') counts.overdue = (counts.overdue ?? 0) + 1;
      if (row.clocks?.needsReclaim != null) counts.needs_reclaim = (counts.needs_reclaim ?? 0) + 1;
      if (row.snooze !== null) counts.snoozed = (counts.snoozed ?? 0) + 1;
    }
    const item = (row: WorkRow): Record<string, unknown> => {
      const bucket = workBucket(row, today);
      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        subtitle: row.subtitle,
        status: row.status,
        due_on: row.dueOn,
        original_due_on: row.originalDueOn,
        bucket,
        overdue: bucket === 'OVERDUE',
        days_late: bucket === 'OVERDUE' && row.dueOn !== null ? days(today) - days(row.dueOn) : 0,
        target: row.target,
        source: row.source,
        severity: row.severity,
        lifecycle: row.lifecycle,
        claimed_by: row.claimedBy === null ? null : { id: row.claimedBy.id, name: row.claimedBy.name, at: row.claimedBy.at },
        assignee: row.assignee === null ? null : { id: row.assignee.id, name: row.assignee.name, due_on: row.assignee.dueOn },
        escalation: row.escalation === null ? null : { level: row.escalation.level, of: row.escalation.of, next_at: row.escalation.nextAt, chain: row.escalation.chain },
        consequence: row.consequence,
        // G0-3: the alert type of the item in the registry (who owns it, how fast it must be answered, which version of the rule said so).
        alert_type:
          row.alertType === undefined || row.alertType === null
            ? null
            : { code: row.alertType.code, owner: row.alertType.owner, expected_action: row.alertType.expectedAction, response_hours: row.alertType.responseHours, version: row.alertType.version, source: row.alertType.source, review_overdue: row.alertType.reviewOverdue },
        snoozed_until: row.snoozedUntil,
        ...clockFields(row, policies),
      };
    };
    return {
      view,
      items: shown.map(item),
      counts,
      truncated,
      unavailable_sources: unavailableSources,
      next_cursor: rest.length > page && last !== undefined ? encode(last) : null,
      as_of: now.toISOString(),
    };
  }

  /** The number of items by severity, for the bell: the same sources, scope and view as the list, counted without the rows' history (a source cut at its limit makes the counts a lower bound, as it does in the list). */
  @Get('home/my-work/counts')
  @OperationId('getMyWorkCounts')
  async myWorkCounts(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('view') viewQuery?: unknown): Promise<Record<string, unknown>> {
    const view = viewOf(viewQuery);
    const now = this.clock();
    const { rows, unavailableSources } = await this.read(tenant, access, view, now, 'count');
    const counts = { urgent: 0, action: 0, watch: 0, total: rows.length };
    for (const row of rows) counts[SEVERITY_KEY[row.severity]] += 1;
    return { view, counts, unavailable_sources: unavailableSources, as_of: now.toISOString() };
  }
}
