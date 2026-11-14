import { DomainError, isWorkingDay, vietnamDateOf } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { bandResolver } from './pwf-workflow-reads.ts';
import type { BandResolver, BandView } from './pwf-workflow-reads.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The deadline board of the whole portfolio, its month calendar, the milestones of the next days and the load by person (PWF-07, R35, BR-PWF-18, 29, 23): read straight from `project_task` through the indexes
 * (tenant, status, committed finish) and (tenant, person, finish), in pages, with the exact totals counted by one grouped query of their own, so a page that is cut never changes the number it says it shows. Only the OFFICIAL colour is ever
 * shown here (R40); the load by person is shown, never levelled. The day a task is listed, counted and coloured by is its OFFICIAL deadline (`committed_finish`, the schedule last released by a decision, R49): a recomputation of the
 * forecast never takes a late task off the board; the forecast is told beside it when it differs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const OPEN = `t.tracked and not t.excluded and t.status not in ('DONE', 'CANCELLED')`;
const CALENDAR_CAP = 500;
const MILESTONE_CAP = 200;
const WORKLOAD_ROWS_CAP = 50_000;
const FAR_DAY = '9999-12-31';
const BANDS = ['NONE', 'GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface BoardFilter {
  unitId?: string | undefined;
  projectId?: string | undefined;
  band?: string | undefined;
  phase?: string | undefined;
  assigneeId?: string | undefined;
  status?: string | undefined;
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
}

type Counts = Record<(typeof BANDS)[number], number>;
const emptyCounts = (): Counts => ({ NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 });
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface Where {
  sql: string;
  params: unknown[];
}

function conditionsOf(scope: ScopeBuilder, filter: BoardFilter, today: string, extra: string[] = []): Where {
  const predicate = scope(1);
  const params: unknown[] = [...predicate.params];
  const parts = [predicate.sql, OPEN, ...extra];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter.unitId !== undefined) {
    if (!UUID.test(filter.unitId)) throw invalid('unit_id');
    parts.push(`exists (select 1 from machvon.organization_unit un where un.id = ${bind(filter.unitId.toLowerCase())}::uuid and starts_with(ou.path, un.path))`);
  }
  if (filter.projectId !== undefined) {
    if (!UUID.test(filter.projectId)) throw invalid('project_id');
    parts.push(`p.id = ${bind(filter.projectId.toLowerCase())}::uuid`);
  }
  if (filter.phase !== undefined) parts.push(`t.phase_code = ${bind(filter.phase)}`);
  if (filter.status !== undefined) parts.push(`t.status = ${bind(filter.status)}`);
  if (filter.assigneeId !== undefined) {
    if (!UUID.test(filter.assigneeId)) throw invalid('assignee_id');
    const member = bind(filter.assigneeId.toLowerCase());
    const day = bind(today);
    parts.push(`exists (select 1 from machvon.project_task_assignment a where a.tenant_id = t.tenant_id and a.task_id = t.id and a.role = 'RESPONSIBLE' and a.membership_id = ${member}::uuid and a.valid_from <= ${day}::date and (a.valid_to is null or a.valid_to >= ${day}::date))`);
  }
  if (filter.dueFrom !== undefined) {
    if (!DAY.test(filter.dueFrom)) throw invalid('due_from');
    parts.push(`t.committed_finish >= ${bind(filter.dueFrom)}::date`);
  }
  if (filter.dueTo !== undefined) {
    if (!DAY.test(filter.dueTo)) throw invalid('due_to');
    parts.push(`t.committed_finish <= ${bind(filter.dueTo)}::date`);
  }
  return { sql: parts.join(' and '), params };
}

interface GroupSql {
  d: string | null;
  /** The schedule could not compute the days of these tasks: a year has no published calendar. */
  u: boolean;
  kind: 'TASK' | 'MILESTONE';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  phase_code: string;
  unit_path: string | null;
  n: string;
}

export class PwfDeadlineReads {
  private readonly calendars: HomeWorkCalendars;

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.calendars = calendars;
  }

  private bandOfGroup(resolver: BandResolver, group: GroupSql): BandView {
    return resolver.of({ status: 'IN_PROGRESS', excluded: false, tracked: true, dueOn: group.d, kind: group.kind, priority: group.priority, phaseCode: group.phase_code, calendarUnavailable: group.u === true }, group.unit_path);
  }

  /** The tasks of the portfolio that are not over, by official colour, nearest finish first; the totals are exact counts and do not depend on the page. */
  async board(tx: TenantTx, scope: ScopeBuilder, filter: BoardFilter, page: { limit: number; after?: { code: string; id: string } | undefined }, now: Date): Promise<Record<string, unknown>> {
    if (filter.band !== undefined && !(BANDS as readonly string[]).includes(filter.band)) throw invalid('band');
    const resolver = await bandResolver(tx, this.calendars, now);
    const where = conditionsOf(scope, filter, vietnamDateOf(now));
    const groups = await tx.query<GroupSql>(
      `select t.committed_finish::text as d, (t.state = 'CALENDAR_UNAVAILABLE') as u, t.kind, t.priority, t.phase_code, ou.path as unit_path, count(*)::text as n from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${where.sql} group by t.committed_finish, (t.state = 'CALENDAR_UNAVAILABLE'), t.kind, t.priority, t.phase_code, ou.path`,
      where.params,
    );
    const counts = emptyCounts();
    const wanted: GroupSql[] = [];
    for (const group of groups) {
      const band = this.bandOfGroup(resolver, group).band;
      counts[band] += Number(group.n);
      if (filter.band === undefined || filter.band === band) wanted.push(group);
    }
    const total = filter.band === undefined ? BANDS.reduce((sum, band) => sum + counts[band], 0) : counts[filter.band as keyof Counts];
    const dated = wanted.filter((group) => group.d !== null);
    const params = [...where.params];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const parts = [where.sql];
    if (filter.band !== undefined) {
      const keys = `(t.committed_finish::text, t.kind, t.priority, t.phase_code, coalesce(ou.path, '')) in (select * from unnest(${bind(dated.map((one) => one.d))}::text[], ${bind(dated.map((one) => one.kind))}::text[], ${bind(dated.map((one) => one.priority))}::text[], ${bind(dated.map((one) => one.phase_code))}::text[], ${bind(dated.map((one) => one.unit_path ?? ''))}::text[]))`;
      // The tasks with no day have no colour either way, under any unit: they are kept whenever the filter keeps one of the groups without a day.
      parts.push(wanted.some((group) => group.d === null) ? `(${keys} or t.committed_finish is null)` : keys);
    }
    const after = page.after;
    if (after !== undefined) {
      if (!DAY.test(after.code)) throw invalid('cursor');
      parts.push(`(coalesce(t.committed_finish, ${bind(FAR_DAY)}::date), t.id) > (${bind(after.code)}::date, ${bind(after.id)}::uuid)`);
    }
    const rows = await tx.query<{ id: string; task_code: string; name: string; project_id: string; project_code: string; project_name: string; phase_code: string; kind: 'TASK' | 'MILESTONE'; priority: GroupSql['priority']; status: string; due_date: string | null; forecast_finish: string | null; critical: boolean; sort_day: string; unit_path: string | null }>(
      `select t.id, t.task_code, t.name, p.id as project_id, p.code as project_code, p.name as project_name, t.phase_code, t.kind, t.priority, t.status, (t.state = 'CALENDAR_UNAVAILABLE') as u, t.committed_finish::text as due_date, case when t.planned_finish is distinct from t.committed_finish then t.planned_finish::text end as forecast_finish, t.critical, coalesce(t.committed_finish, date '${FAR_DAY}')::text as sort_day, ou.path as unit_path
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${parts.join(' and ')} order by coalesce(t.committed_finish, date '${FAR_DAY}'), t.id limit ${bind(page.limit + 1)}`,
      params,
    );
    const shown = rows.slice(0, page.limit);
    const assignees = await this.assignees(tx, shown.map((row) => row.id), vietnamDateOf(now));
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => ({
        task_id: row.id,
        task_code: row.task_code,
        name: row.name,
        project_id: row.project_id,
        project_code: row.project_code,
        project_name: row.project_name,
        phase_code: row.phase_code,
        kind: row.kind,
        status: row.status,
        due_date: row.due_date,
        forecast_finish: row.forecast_finish,
        band: resolver.of({ status: row.status as never, excluded: false, tracked: true, dueOn: row.due_date, kind: row.kind, priority: row.priority, phaseCode: row.phase_code, calendarUnavailable: (row as { u?: boolean }).u === true }, row.unit_path),
        critical: row.critical,
        assignee: assignees.get(row.id) ?? null,
      })),
      next: rows.length > shown.length && last !== undefined ? { code: last.sort_day, id: last.id } : null,
      shown: shown.length,
      total,
      truncated: total > shown.length,
      counts_by_band: counts,
      official_only: true,
      as_of: now.toISOString(),
    };
  }

  private async assignees(tx: TenantTx, taskIds: readonly string[], today: string): Promise<Map<string, { membership_id: string; display_name: string }>> {
    if (taskIds.length === 0) return new Map();
    const rows = await tx.query<{ task_id: string; membership_id: string; display_name: string | null }>(
      `select distinct on (a.task_id) a.task_id, a.membership_id, u.display_name from machvon.project_task_assignment a left join machvon.tenant_user_directory u on u.tenant_id = a.tenant_id and u.membership_id = a.membership_id
        where a.task_id = any($1::uuid[]) and a.role = 'RESPONSIBLE' and a.valid_from <= $2::date and (a.valid_to is null or a.valid_to >= $2::date) order by a.task_id, a.valid_from desc, a.id`,
      [[...taskIds], today],
    );
    return new Map(rows.map((row) => [row.task_id, { membership_id: row.membership_id, display_name: row.display_name ?? row.membership_id }]));
  }

  /** The tasks that finish in a month, day by day, with the exact count of each day by colour and the first tasks of the month (the list is capped, the counts are not). */
  async calendar(tx: TenantTx, scope: ScopeBuilder, filter: Pick<BoardFilter, 'unitId' | 'projectId' | 'assigneeId'>, month: string, now: Date): Promise<Record<string, unknown>> {
    const parsed = MONTH.exec(month);
    if (parsed === null) throw invalid('month');
    const from = `${month}-01`;
    const to = addDays(`${parsed[2] === '12' ? Number(parsed[1]) + 1 : parsed[1]}-${parsed[2] === '12' ? '01' : String(Number(parsed[2]) + 1).padStart(2, '0')}-01`, -1);
    const resolver = await bandResolver(tx, this.calendars, now);
    const where = conditionsOf(scope, { ...filter, dueFrom: from, dueTo: to }, vietnamDateOf(now));
    const groups = await tx.query<GroupSql>(
      `select t.committed_finish::text as d, (t.state = 'CALENDAR_UNAVAILABLE') as u, t.kind, t.priority, t.phase_code, ou.path as unit_path, count(*)::text as n from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${where.sql} group by t.committed_finish, (t.state = 'CALENDAR_UNAVAILABLE'), t.kind, t.priority, t.phase_code, ou.path`,
      where.params,
    );
    const days = new Map<string, { total: number; counts: Counts }>();
    for (const group of groups) {
      const entry = days.get(group.d as string) ?? { total: 0, counts: emptyCounts() };
      entry.total += Number(group.n);
      entry.counts[this.bandOfGroup(resolver, group).band] += Number(group.n);
      days.set(group.d as string, entry);
    }
    const rows = await tx.query<{ id: string; task_code: string; name: string; project_id: string; project_code: string; due_date: string; kind: 'TASK' | 'MILESTONE'; priority: GroupSql['priority']; phase_code: string; unit_path: string | null }>(
      `select t.id, t.task_code, t.name, p.id as project_id, p.code as project_code, t.committed_finish::text as due_date, t.kind, t.priority, t.phase_code, ou.path as unit_path from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
        where ${where.sql} order by t.committed_finish, t.id limit ${CALENDAR_CAP}`,
      where.params,
    );
    const total = [...days.values()].reduce((sum, one) => sum + one.total, 0);
    return {
      month,
      days: [...days.entries()]
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([date, entry]) => ({
          date,
          total: entry.total,
          counts_by_band: entry.counts,
          tasks: rows.filter((row) => row.due_date === date).map((row) => ({ task_id: row.id, task_code: row.task_code, name: row.name, project_id: row.project_id, project_code: row.project_code, band: resolver.of({ status: 'IN_PROGRESS', excluded: false, tracked: true, dueOn: row.due_date, kind: row.kind, priority: row.priority, phaseCode: row.phase_code }, row.unit_path).band })),
        })),
      shown: rows.length,
      total,
      truncated: total > rows.length,
      as_of: now.toISOString(),
    };
  }

  /** The milestones whose official day falls in the next days (30 by default): that day (the schedule last released, R49), the day of the first baseline, the day the forecast gives now and how far it has slipped from the baseline, and whether they are at risk (BR-PWF-25). */
  async milestones(tx: TenantTx, scope: ScopeBuilder, filter: Pick<BoardFilter, 'unitId' | 'projectId'>, days: number, now: Date): Promise<Record<string, unknown>> {
    if (!Number.isInteger(days) || days < 1 || days > 366) throw invalid('days');
    const today = vietnamDateOf(now);
    const to = addDays(today, days);
    const resolver = await bandResolver(tx, this.calendars, now);
    const where = conditionsOf(scope, { ...filter, dueFrom: today, dueTo: to }, today, [`t.kind = 'MILESTONE'`]);
    const rows = await tx.query<{ id: string; milestone_id: string | null; task_code: string; name: string; project_id: string; project_code: string; planned_date: string; baseline_date: string | null; forecast_date: string | null; slip: number | null; critical: boolean; total_float: number | null; priority: GroupSql['priority']; phase_code: string; status: string; unit_path: string | null }>(
      `select t.id, t.milestone_id, t.task_code, t.name, p.id as project_id, p.code as project_code, t.committed_finish::text as planned_date, t.baseline_finish::text as baseline_date, t.planned_finish::text as forecast_date, (t.planned_finish - t.baseline_finish) as slip, t.critical, t.total_float, t.priority, t.phase_code, t.status, ou.path as unit_path
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id where ${where.sql} order by t.committed_finish, t.id limit ${MILESTONE_CAP}`,
      where.params,
    );
    const counted = await tx.query<{ n: string }>(`select count(*)::text as n from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id where ${where.sql}`, where.params);
    return {
      from: today,
      to,
      items: rows.map((row) => ({
        task_id: row.id,
        milestone_id: row.milestone_id,
        task_code: row.task_code,
        name: row.name,
        project_id: row.project_id,
        project_code: row.project_code,
        planned_date: row.planned_date,
        baseline_date: row.baseline_date,
        forecast_date: row.forecast_date,
        forecast_slip_days: row.slip,
        at_risk: (row.slip ?? 0) > 0 || (row.forecast_date !== null && row.forecast_date > row.planned_date) || (row.critical && (row.total_float ?? 0) < 0),
        band: resolver.of({ status: row.status as never, excluded: false, tracked: true, dueOn: row.planned_date, kind: 'MILESTONE', priority: row.priority, phaseCode: row.phase_code }, row.unit_path),
      })),
      total: Number(counted[0]?.n ?? 0),
      as_of: now.toISOString(),
    };
  }

  /** The open tasks and the planned working days of each person for each week, shared by the share of the assignment (BR-PWF-18): shown, never levelled. */
  async workload(tx: TenantTx, scope: ScopeBuilder, filter: Pick<BoardFilter, 'unitId'>, range: { from?: string | undefined; weeks?: number | undefined }, now: Date): Promise<Record<string, unknown>> {
    const weeksCount = range.weeks ?? 8;
    if (!Number.isInteger(weeksCount) || weeksCount < 1 || weeksCount > 26) throw invalid('weeks');
    const today = vietnamDateOf(now);
    const given = range.from ?? today;
    if (!DAY.test(given)) throw invalid('from');
    const monday = addDays(given, -((new Date(`${given}T00:00:00Z`).getUTCDay() + 6) % 7));
    const weeks = Array.from({ length: weeksCount }, (_, index) => addDays(monday, index * 7));
    const where = conditionsOf(scope, filter, today);
    const end = addDays(weeks[weeks.length - 1] as string, 6);
    const params = [...where.params, monday, end];
    const rows = await tx.query<{ membership_id: string; display_name: string | null; task_id: string; planned_start: string | null; planned_finish: string | null; share_pct: number; valid_from: string; valid_to: string | null }>(
      `select a.membership_id, u.display_name, t.id as task_id, t.planned_start::text as planned_start, t.planned_finish::text as planned_finish, a.share_pct, a.valid_from::text as valid_from, a.valid_to::text as valid_to
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id
         join machvon.project_task_assignment a on a.tenant_id = t.tenant_id and a.task_id = t.id and a.role = 'RESPONSIBLE' and a.valid_from <= $${params.length}::date and (a.valid_to is null or a.valid_to >= $${params.length - 1}::date)
         left join machvon.tenant_user_directory u on u.tenant_id = a.tenant_id and u.membership_id = a.membership_id
        where ${where.sql} order by a.membership_id, t.id limit ${WORKLOAD_ROWS_CAP}`,
      params,
    );
    const calendarSource = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const working = (day: string): boolean => {
      const content = calendarSource?.forYear(Number(day.slice(0, 4)));
      return content === undefined ? ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) : isWorkingDay(content, day);
    };
    const people = new Map<string, { membership_id: string; display_name: string; open: Set<string>; weekly: number[] }>();
    for (const row of rows) {
      const person = people.get(row.membership_id) ?? { membership_id: row.membership_id, display_name: row.display_name ?? row.membership_id, open: new Set<string>(), weekly: weeks.map(() => 0) };
      person.open.add(row.task_id);
      if (row.planned_start !== null && row.planned_finish !== null) {
        weeks.forEach((week, index) => {
          // Only the days on which the person holds the task: the window of the task, the week and the period of the assignment.
          const from = [row.planned_start!, week, row.valid_from].reduce((latest, day) => (day > latest ? day : latest));
          const toDay = [row.planned_finish!, addDays(week, 6), ...(row.valid_to === null ? [] : [row.valid_to])].reduce((earliest, day) => (day < earliest ? day : earliest));
          for (let day = from; day <= toDay; day = addDays(day, 1)) if (working(day)) person.weekly[index] = (person.weekly[index] as number) + row.share_pct / 100;
        });
      }
      people.set(row.membership_id, person);
    }
    return {
      weeks,
      people: [...people.values()].map((one) => ({ membership_id: one.membership_id, display_name: one.display_name, open_tasks: one.open.size, weekly_planned_working_days: one.weekly.map((value) => Math.round(value * 100) / 100) })),
      display_only: true,
      as_of: now.toISOString(),
    };
  }
}

