import { DomainError, pwfDeadlineBand, vietnamDateOf } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { PwfBandPolicies } from './pwf-band-policies.ts';
import { PwfDeadlinePreferenceStore, hasPersonalLadder, personalThresholdsOf } from './pwf-deadline-preference.ts';
import { bandColumnsOf, bandExplanationOf, bandKeyOf, bandKeyValues, durationColumnsOf, durationViewOf, officialTaskBand, officialTaskLadder, stepLadderOf } from './pwf-task-band.ts';
import type { TaskBandColumns, TaskDurationColumns } from './pwf-task-band.ts';
import { bandViewOf } from './pwf-workflow-reads.ts';
import { receivingColumnsOf, receivingUnitIdsOf, receivingViewOf, responsibleHeldSql, unitNamesOf } from './pwf-task-claim.ts';
import type { TaskReceivingColumns } from './pwf-task-claim.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * "My tasks" by deadline (MOB-80, PWF-15; R40): the open tasks the ledger of assignments hands to the caller, each with the OFFICIAL colour and, only when the person set a ladder of their own that differs from it, the colour of THAT ladder, beside
 * the real day of the deadline (the OFFICIAL one: the finish of the schedule last released by a decision, R49; the forecast is told beside it when it differs). The official colour is always there and is the one that counts; the personal one is only ever earlier. A personal ladder the official rule has since passed is read as the official line (the preference names what was
 * raised), and one that cannot be merged into a valid ladder is left out rather than shown wrong. Bounded (R35): the page is cut by the database (cursor on the day and the id) and the total is the exact count of what the filters leave, from a grouped count of its own.
 *
 * R51: asked for `DONE`, the read lists what the person FINISHED lately instead: the done tasks the ledger gave them (responsible or accountable) on the day each was finished, inside the last `DONE_WINDOW_DAYS` days, newest
 * first, in pages, with the day of the finish. A finished task has no colour (nothing is left to count down), and the window keeps the list bounded however long a person has worked.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BANDS = ['NONE', 'GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD'] as const;
const DONE = 'DONE';
/** How far back the list of what a person finished goes (R51). */
export const DONE_WINDOW_DAYS = 90;
const FAR_DAY = '9999-12-31';
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface MyTaskFilter {
  band?: string | undefined;
  status?: string | undefined;
  dueBefore?: string | undefined;
}

interface MyTaskSql extends TaskBandColumns, TaskDurationColumns, TaskReceivingColumns {
  /** Somebody is responsible for the task today (the person reads the tasks they answer for too). */
  responsible_held: boolean;
  id: string;
  task_code: string;
  name: string;
  project_id: string;
  project_code: string;
  status: (typeof STATUSES)[number] | typeof DONE;
  due_date: string | null;
  forecast_finish: string | null;
  kind: 'TASK' | 'MILESTONE';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  phase_code: string;
  critical: boolean;
  version: number;
  unit_path: string | null;
  sort_day: string;
}

const viewOf = bandViewOf;

export class PwfMyTaskReads {
  private readonly policies = new PwfBandPolicies();
  private readonly preferences = new PwfDeadlinePreferenceStore();
  private readonly calendars: HomeWorkCalendars;

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.calendars = calendars;
  }

  async list(tx: TenantTx, scope: ScopeBuilder, membershipId: string, filter: MyTaskFilter, page: { limit: number; after?: { code: string; id: string } | undefined }, now: Date): Promise<Record<string, unknown>> {
    if (filter.band !== undefined && !(BANDS as readonly string[]).includes(filter.band)) throw invalid('band');
    if (filter.status !== undefined && filter.status !== DONE && !(STATUSES as readonly string[]).includes(filter.status)) throw invalid('status');
    if (filter.dueBefore !== undefined && !DAY.test(filter.dueBefore)) throw invalid('due_before');
    if (page.after !== undefined && (!DAY.test(page.after.code) || !UUID.test(page.after.id))) throw invalid('cursor');
    if (filter.status === DONE) {
      // A finished task has no colour: a colour filter on the done list is a mistake of the caller, not an empty answer.
      if (filter.band !== undefined) throw invalid('band');
      return this.listDone(tx, scope, membershipId, filter, page, now);
    }
    const today = vietnamDateOf(now);
    const predicate = scope(1);
    const params: unknown[] = [...predicate.params];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const me = bind(membershipId.toLowerCase());
    const day = bind(today);
    const where = [
      predicate.sql,
      `t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD')`,
      `exists (select 1 from machvon.project_task_assignment a where a.tenant_id = t.tenant_id and a.task_id = t.id and a.role in ('RESPONSIBLE', 'ACCOUNTABLE') and a.membership_id = ${me}::uuid and a.valid_from <= ${day}::date and (a.valid_to is null or a.valid_to >= ${day}::date))`,
    ];
    if (filter.status !== undefined) where.push(`t.status = ${bind(filter.status)}`);
    if (filter.dueBefore !== undefined) where.push(`t.committed_finish <= ${bind(filter.dueBefore)}::date`);
    const set = await this.policies.load(tx, today);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    // R73: the official colour is the one resolution of `pwf-task-band.ts` (the ladder of the task itself, then the policy in force), for the counts, the colour filter and each row alike.
    const subjectOf = (row: Pick<MyTaskSql, 'kind' | 'priority' | 'phase_code' | 'unit_path'> & TaskBandColumns): Parameters<typeof officialTaskLadder>[1] => ({ kind: row.kind, priority: row.priority, phaseCode: row.phase_code, unitPath: row.unit_path, step: stepLadderOf(row) });
    // The exact total (and the groups the colour filter keeps) come from one grouped count of their own, so a page never changes the number it says there are; the page is cut by the database, nothing is read past it.
    const groups = await tx.query<{ d: string | null; kind: MyTaskSql['kind']; priority: MyTaskSql['priority']; phase_code: string; unit_path: string | null; n: string } & TaskBandColumns>(
      `select t.committed_finish::text as d, t.kind, t.priority, t.phase_code, ou.path as unit_path, ${bandColumnsOf('t')}, count(*)::text as n
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${where.join(' and ')} group by t.committed_finish, t.kind, t.priority, t.phase_code, ou.path, ${bandColumnsOf('t')}`,
      params,
    );
    let total = 0;
    // The exact count of the person's open tasks by OFFICIAL colour, whatever the colour filter and the page: what the block "tasks by deadline" of a home screen shows from one small read (limit 3 gives the three nearest and these counts).
    const counts: Record<(typeof BANDS)[number], number> = { NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 };
    let overdueCount = 0;
    const kept: typeof groups = [];
    for (const group of groups) {
      const judged = officialTaskBand(set, subjectOf(group), group.d, { today, calendars }).result;
      counts[judged.band] += Number(group.n);
      if (judged.overdue) overdueCount += Number(group.n);
      if (filter.band === undefined || judged.band === filter.band) kept.push(group);
    }
    for (const group of kept) total += Number(group.n);
    const pageParams = [...params];
    const pageBind = (value: unknown): string => {
      pageParams.push(value);
      return `$${pageParams.length}`;
    };
    const conditions = [...where];
    if (filter.band !== undefined) {
      if (kept.length === 0) conditions.push('false');
      else {
        const ladders = kept.map(bandKeyValues);
        const keys = `(coalesce(t.committed_finish::text, ''), t.kind, t.priority, t.phase_code, coalesce(ou.path, ''), ${bandKeyOf('t')}) in (select * from unnest(${pageBind(kept.map((one) => one.d ?? ''))}::text[], ${pageBind(kept.map((one) => one.kind))}::text[], ${pageBind(kept.map((one) => one.priority))}::text[], ${pageBind(kept.map((one) => one.phase_code))}::text[], ${pageBind(kept.map((one) => one.unit_path ?? ''))}::text[], ${pageBind(ladders.map((one) => one[0]))}::int[], ${pageBind(ladders.map((one) => one[1]))}::int[], ${pageBind(ladders.map((one) => one[2]))}::int[]))`;
        conditions.push(keys);
      }
    }
    if (page.after !== undefined) conditions.push(`(coalesce(t.committed_finish, date '${FAR_DAY}'), t.id) > (${pageBind(page.after.code)}::date, ${pageBind(page.after.id)}::uuid)`);
    const rows = await tx.query<MyTaskSql>(
      `select t.id, t.task_code, t.name, p.id as project_id, p.code as project_code, t.status, t.committed_finish::text as due_date, case when t.planned_finish is distinct from t.committed_finish then t.planned_finish::text end as forecast_finish, t.kind, t.priority, t.phase_code, t.critical, t.version, ou.path as unit_path, ${bandColumnsOf('t')}, ${durationColumnsOf('t')}, ${receivingColumnsOf('t')}, ${responsibleHeldSql('t', day)} as responsible_held,
              coalesce(t.committed_finish, date '${FAR_DAY}')::text as sort_day
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${conditions.join(' and ')} order by coalesce(t.committed_finish, date '${FAR_DAY}'), t.id limit ${pageBind(page.limit + 1)}`,
      pageParams,
    );
    const stored = await this.preferences.stored(tx, membershipId);
    const personal = hasPersonalLadder(stored) ? personalThresholdsOf(stored) : null;
    const listed = rows.slice(0, page.limit).map((row) => {
      const ladder = officialTaskLadder(set, subjectOf(row));
      const context = { taskKind: row.kind, priority: row.priority, phase: row.phase_code };
      const due = { dueOn: row.due_date, today, unit: ladder.policy.unit, calendars };
      // The official ladder is handed to the kernel as the tier it cannot be overruled from; the person's own ladder is merged into it and can only warn earlier (R40), whichever tier gave it.
      const official = { system: ladder.thresholds };
      let resolved: pwfDeadlineBand.ResolvedBand;
      try {
        resolved = pwfDeadlineBand.resolveBand({ ...official, personal }, context, due);
      } catch (error) {
        // A personal ladder that cannot be merged into a valid one with the official ladder of this task is not shown; the official colour still is.
        if (!(error instanceof DomainError) || error.code !== 'DEADLINE_BAND_THRESHOLDS_INVALID') throw error;
        resolved = pwfDeadlineBand.resolveBand(official, context, due);
      }
      return { row, ladder, official: viewOf(resolved.official), personal: resolved.personal !== null && resolved.personalApplied ? viewOf(resolved.personal) : null };
    });
    const shown = listed;
    const unitNames = await unitNamesOf(tx, receivingUnitIdsOf(shown.map((one) => one.row)));
    const last = shown[shown.length - 1];
    return {
      items: shown.map(({ row, ladder, official, personal: own }) => ({
        task_id: row.id,
        task_code: row.task_code,
        name: row.name,
        project_id: row.project_id,
        project_code: row.project_code,
        status: row.status,
        due_date: row.due_date,
        forecast_finish: row.forecast_finish,
        official_band: official,
        personal_band: own,
        ...bandExplanationOf(ladder),
        ...durationViewOf(row),
        ...receivingViewOf({ ...row, excluded: false }, unitNames, row.responsible_held),
        critical: row.critical,
        version: row.version,
        finished_on: null,
      })),
      next: rows.length > page.limit && last !== undefined ? { code: last.row.sort_day, id: last.row.id } : null,
      total,
      counts_by_band: counts,
      overdue_count: overdueCount,
      as_of: now.toISOString(),
    };
  }

  /** What the person finished in the last `DONE_WINDOW_DAYS` days (R51), newest first; the cursor is the day of the finish and the id of the last row. */
  private async listDone(tx: TenantTx, scope: ScopeBuilder, membershipId: string, filter: MyTaskFilter, page: { limit: number; after?: { code: string; id: string } | undefined }, now: Date): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(now);
    const predicate = scope(1);
    const params: unknown[] = [...predicate.params];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const me = bind(membershipId.toLowerCase());
    const day = bind(today);
    const where = [
      predicate.sql,
      `t.tracked and not t.excluded and t.status = 'DONE' and t.actual_finish is not null and t.actual_finish > ${day}::date - ${bind(DONE_WINDOW_DAYS)}::int and t.actual_finish <= ${day}::date`,
      // The task is the person's when the ledger gave it to them on the day it was finished: one handed over before that belongs to who finished it.
      `exists (select 1 from machvon.project_task_assignment a where a.tenant_id = t.tenant_id and a.task_id = t.id and a.role in ('RESPONSIBLE', 'ACCOUNTABLE') and a.membership_id = ${me}::uuid and a.valid_from <= t.actual_finish and (a.valid_to is null or a.valid_to >= t.actual_finish))`,
    ];
    if (filter.dueBefore !== undefined) where.push(`t.committed_finish <= ${bind(filter.dueBefore)}::date`);
    const counted = await tx.query<{ n: string }>(`select count(*)::text as n from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id where ${where.join(' and ')}`, params);
    const conditions = [...where];
    if (page.after !== undefined) conditions.push(`(t.actual_finish, t.id) < (${bind(page.after.code)}::date, ${bind(page.after.id)}::uuid)`);
    const rows = await tx.query<MyTaskSql & { finished_on: string }>(
      `select t.id, t.task_code, t.name, p.id as project_id, p.code as project_code, t.status, t.committed_finish::text as due_date, null::text as forecast_finish, t.kind, t.priority, t.phase_code, t.critical, t.version, ou.path as unit_path, ${bandColumnsOf('t')}, ${durationColumnsOf('t')}, ${receivingColumnsOf('t')}, true as responsible_held,
              t.actual_finish::text as sort_day, t.actual_finish::text as finished_on
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${conditions.join(' and ')} order by t.actual_finish desc, t.id desc limit ${bind(page.limit + 1)}`,
      params,
    );
    const set = await this.policies.load(tx, today);
    const shown = rows.slice(0, page.limit);
    const unitNames = await unitNamesOf(tx, receivingUnitIdsOf(shown));
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => ({
        task_id: row.id,
        task_code: row.task_code,
        name: row.name,
        project_id: row.project_id,
        project_code: row.project_code,
        status: row.status,
        due_date: row.due_date,
        forecast_finish: null,
        official_band: { band: 'NONE', remaining_days: null, unit: set.forUnitPath(row.unit_path).unit, overdue: false, reason: null, due_today: false },
        personal_band: null,
        ...bandExplanationOf(officialTaskLadder(set, { kind: row.kind, priority: row.priority, phaseCode: row.phase_code, unitPath: row.unit_path, step: stepLadderOf(row) })),
        ...durationViewOf(row),
        // A finished task is never "unclaimed"; the unit that received it is still told.
        ...receivingViewOf({ ...row, excluded: false }, unitNames, true),
        critical: row.critical,
        version: row.version,
        finished_on: row.finished_on,
      })),
      next: rows.length > page.limit && last !== undefined ? { code: last.sort_day, id: last.id } : null,
      total: Number(counted[0]?.n ?? 0),
      counts_by_band: { NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 },
      overdue_count: 0,
      done_window_days: DONE_WINDOW_DAYS,
      as_of: now.toISOString(),
    };
  }
}
