import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { HomeWorkStore, TenantDatabase, projectScope, scopePredicate } from '@machvon/db';
import type { ScopeBuilder, WorkRow } from '@machvon/db';
import { DomainError, WORK_KINDS, compareWork, orderWork, vietnamDateOf, workBucket } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext, WorkItem, WorkKind } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_READ_PERMISSION } from './scope-hash';
import { HOME_CLOCK } from './tokens';

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

/** The place a page stopped at: the kind, the id and the day of the last task, so that the next page goes on from that place whether or not the task is still there. */
const encode = (row: Pick<WorkItem, 'kind' | 'id' | 'dueOn'>): string => Buffer.from(JSON.stringify([row.kind, row.id, row.dueOn]), 'utf8').toString('base64url');
function decode(cursor: unknown): Pick<WorkItem, 'id' | 'kind' | 'dueOn' | 'originalDueOn'> {
  if (typeof cursor !== 'string' || cursor === '' || cursor.length > 200) throw invalid('cursor');
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === 3) {
      const [kind, id, dueOn] = parts as unknown[];
      if ((WORK_KINDS as readonly string[]).includes(kind as string) && typeof id === 'string' && id !== '' && id.length <= 64 && (dueOn === null || (typeof dueOn === 'string' && DAY.test(dueOn)))) {
        return { kind: kind as WorkKind, id, dueOn: dueOn as string | null, originalDueOn: dueOn as string | null };
      }
    }
  } catch {
    // falls through to the refusal below
  }
  throw invalid('cursor');
}

/**
 * The work of the person who asks, in one list (ST-HOME-004, HOME 3 F5, HOME-02): the approvals that wait for them, the explanations they owe and the ones they must conclude, the reports of theirs that came back or are drafts
 * past their period, and the monitoring reports of their unit near their day. The reads are by their membership, so the work of another person never appears, whatever the rights they hold. Ordered as it is looked at:
 * late first (the earliest day first), then near its day (7 days), then the rest. An item says its original day beside the day it is due on (a request that was sent back with a new day is still late by the day it was first
 * asked for), whether it is late, and where it is opened from. `counts` are of the whole list, whatever page is shown; `truncated` says a source had more than it gives (2000), so the counts are a lower bound.
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

  @Get('home/my-work')
  @OperationId('getMyWork')
  async myWork(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Record<string, unknown>> {
    const page = limitOf(limit);
    const from = cursor === undefined ? undefined : decode(cursor);
    const now = this.clock();
    const today = vietnamDateOf(now);
    const unitScope: ScopeBuilder = (first) => scopePredicate(access, HOME_READ_PERMISSION, now, { unitPath: 'u.path', unitId: 'u.id' }, first);
    const { rows, truncated } = await this.database.withTenant(tenant, (tx) => this.work.collect(tx, { membershipId: tenant.membershipId, now, today, unitScope, projectScope: projectScope(access, HOME_READ_PERMISSION, now) }));
    const ordered = orderWork(rows, today);
    // The page goes on after the place the cursor names, which a task done meanwhile does not take away.
    const rest = from === undefined ? ordered : ordered.filter((row) => compareWork(row, from, today) > 0);
    const shown = rest.slice(0, page);
    const last = shown[shown.length - 1];
    const counts: Record<string, number> = { total: ordered.length, overdue: 0 };
    for (const kind of WORK_KINDS) counts[kind] = 0;
    for (const row of ordered) {
      counts[row.kind] = (counts[row.kind] ?? 0) + 1;
      if (workBucket(row, today) === 'OVERDUE') counts.overdue = (counts.overdue ?? 0) + 1;
    }
    const view = (row: WorkRow): Record<string, unknown> => {
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
      };
    };
    return { items: shown.map(view), counts, truncated, next_cursor: rest.length > page && last !== undefined ? encode(last) : null, as_of: now.toISOString() };
  }
}
