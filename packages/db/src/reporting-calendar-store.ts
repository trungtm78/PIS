import { REPORTABLE_PROJECT_STATUSES, SUBMITTED_STATUSES } from '@machvon/kernel';
import type { ScheduleCode, ScheduleReminderKind, ScheduleStepKind, UnitPeriodFacts } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** A period the schedule applies to, as the table keeps it. */
export interface CalendarPeriodRow {
  id: string;
  code: string;
  periodType: 'MONTH' | 'QUARTER' | 'YEAR';
  fiscalYear: number;
  startDate: string;
  endDate: string;
  deadlineAt: string;
  status: 'OPEN' | 'SOFT_CLOSED' | 'LOCKED';
  lockedAt: string | null;
}

export interface CalendarMeetingRow {
  id: string;
  code: string;
  meetingDate: string;
  meetingType: string;
  title: string;
  unitId: string;
  unitName: string;
}

export interface UnitFactsRow extends UnitPeriodFacts {
  unitPath: string;
}

interface PeriodSql {
  id: string;
  code: string;
  period_type: CalendarPeriodRow['periodType'];
  fiscal_year: number;
  start_date: string;
  end_date: string;
  deadline_at: string;
  status: CalendarPeriodRow['status'];
  locked_at: string | null;
}

interface FactsSql {
  unit_id: string;
  unit_code: string;
  unit_name: string;
  unit_path: string;
  projects: number;
  entered: number;
  entered_at: string | null;
  approved: number;
  approved_at: string | null;
}

export interface ScheduleReminderRecord {
  itemKind: 'REPORT_PERIOD' | 'PLAN_ADJUSTMENT' | 'MEETING';
  itemKey: string;
  scheduleCode: ScheduleCode;
  unitId: string | null;
  step: ScheduleStepKind;
  kind: ScheduleReminderKind;
  ordinal: number;
  alertType: string;
  dueAt: string;
  ruleVersion: number;
}

/** The scope of a pass that no person runs (a job): every project of the tenant. */
export const WHOLE_TENANT: ScopeBuilder = () => ({ sql: 'true', params: [] });

/** The grain, the year and the ordinal under which a period's figures are kept in `plan_figure_revision` (`YEAR` has ordinal 0). */
export function figureKeyOf(period: Pick<CalendarPeriodRow, 'periodType' | 'fiscalYear' | 'endDate'>): { grain: string; year: number; ordinal: number } {
  const month = Number(period.endDate.slice(5, 7));
  if (period.periodType === 'QUARTER') return { grain: 'QUARTER', year: period.fiscalYear, ordinal: Math.ceil(month / 3) };
  if (period.periodType === 'YEAR') return { grain: 'YEAR', year: period.fiscalYear, ordinal: 0 };
  return { grain: 'MONTH', year: period.fiscalYear, ordinal: month };
}

const toPeriod = (row: PeriodSql): CalendarPeriodRow => ({
  id: row.id,
  code: row.code,
  periodType: row.period_type,
  fiscalYear: row.fiscal_year,
  startDate: row.start_date,
  endDate: row.end_date,
  deadlineAt: row.deadline_at,
  status: row.status,
  lockedAt: row.locked_at,
});

const PERIOD_SELECT = `select p.id, p.code, p.period_type, p.fiscal_year, p.start_date::text as start_date, p.end_date::text as end_date,
       to_char(p.deadline_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as deadline_at, p.status,
       case when p.locked_at is null then null else to_char(p.locked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end as locked_at
  from machvon.reporting_period p`;

/**
 * The reads and the one write of the reporting calendar (QT.02, ENT-4c): the periods of the schedule kinds that were generated, the input points (units) with what they handed in and had approved in a period, the steering
 * meetings of a year, and the record of every reminder made. A reminder row is appended and never changed; the series key makes it unique.
 */
export class ReportingCalendarStore {
  /** The generated periods of a month, quarter or year type whose fiscal year is one of `years`, in the order of their days. */
  async periods(tx: TenantTx, years: readonly number[]): Promise<CalendarPeriodRow[]> {
    const rows = await tx.query<PeriodSql>(`${PERIOD_SELECT} where p.fiscal_year = any($1::int[]) and p.period_type in ('MONTH', 'QUARTER', 'YEAR') order by p.start_date, p.period_type, p.id`, [[...years]]);
    return rows.map(toPeriod);
  }

  async period(tx: TenantTx, id: string): Promise<CalendarPeriodRow | undefined> {
    const rows = await tx.query<PeriodSql>(`${PERIOD_SELECT} where p.id = $1::uuid and p.period_type in ('MONTH', 'QUARTER', 'YEAR')`, [id]);
    return rows[0] === undefined ? undefined : toPeriod(rows[0]);
  }

  /**
   * For every unit that has a project to report in the period, how many of its projects handed their figures in and had them approved, and when the last one did. A project handed in when a report of the period was sent
   * (statuses of DIS 3 F1) or an actual of the period's grain was submitted or accepted (FND-1); it was approved when the report is accepted or the actual is.
   */
  async unitFacts(tx: TenantTx, scope: ScopeBuilder, period: CalendarPeriodRow): Promise<UnitFactsRow[]> {
    const key = figureKeyOf(period);
    const visible = scope(7);
    const rows = await tx.query<FactsSql>(
      `select ou.id as unit_id, ou.code as unit_code, ou.name as unit_name, ou.path as unit_path, count(*)::int as projects,
              (count(*) filter (where coalesce(rep.entered, false) or coalesce(fig.entered, false)))::int as entered,
              to_char(max(greatest(rep.entered_at, fig.entered_at)) filter (where coalesce(rep.entered, false) or coalesce(fig.entered, false)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as entered_at,
              (count(*) filter (where coalesce(rep.approved, false) or coalesce(fig.approved, false)))::int as approved,
              to_char(max(greatest(rep.approved_at, fig.approved_at)) filter (where coalesce(rep.approved, false) or coalesce(fig.approved, false)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as approved_at
         from ${SCOPE_FROM}
         left join lateral (
           select bool_or(r.status = any($2::text[])) as entered, max(r.submitted_at) filter (where r.status = any($2::text[])) as entered_at,
                  bool_or(r.status = 'ACCEPTED') as approved, max(r.accepted_at) filter (where r.status = 'ACCEPTED') as approved_at
             from machvon.report_revision r
            where r.tenant_id = p.tenant_id and r.project_id = p.id and r.period_id = $1::uuid and r.deleted_at is null) rep on true
         left join lateral (
           select true as entered, max(f.created_at) as entered_at, bool_or(f.status = 'ACCEPTED') as approved, max(f.approved_at) filter (where f.status = 'ACCEPTED') as approved_at
             from machvon.plan_figure_revision f
            where f.tenant_id = p.tenant_id and f.project_id = p.id and f.figure_kind = 'ACTUAL' and f.status in ('SUBMITTED', 'ACCEPTED')
              and f.period_grain = $3::text and f.plan_year = $4::int and f.period_ordinal = $5::smallint
           having count(*) > 0) fig on true
        where p.status = any($6::text[]) and ${visible.sql}
        group by ou.id, ou.code, ou.name, ou.path
        order by ou.name, ou.code, ou.id`,
      [period.id, [...SUBMITTED_STATUSES], key.grain, key.year, key.ordinal, [...REPORTABLE_PROJECT_STATUSES], ...visible.params],
    );
    return rows.map((row) => ({
      unitId: row.unit_id,
      unitCode: row.unit_code,
      unitName: row.unit_name,
      unitPath: row.unit_path,
      projects: row.projects,
      entered: row.entered,
      enteredAt: row.entered_at,
      approved: row.approved,
      approvedAt: row.approved_at,
    }));
  }

  /** The steering meetings of a year that the scope reaches, in the order of their days. */
  async meetings(tx: TenantTx, scope: (first: number) => { sql: string; params: unknown[] }, year: number): Promise<CalendarMeetingRow[]> {
    const visible = scope(2);
    const rows = await tx.query<{ id: string; code: string; meeting_date: string; meeting_type: string; title: string; unit_id: string; unit_name: string }>(
      `select m.id, m.code, m.meeting_date::text as meeting_date, m.meeting_type, m.title, m.unit_id, mu.name as unit_name
         from machvon.steering_meeting m
         join machvon.organization_unit mu on mu.tenant_id = m.tenant_id and mu.id = m.unit_id
        where m.meeting_year = $1::int and ${visible.sql}
        order by m.meeting_date, m.id`,
      [year, ...visible.params],
    );
    return rows.map((row) => ({ id: row.id, code: row.code, meetingDate: row.meeting_date, meetingType: row.meeting_type, title: row.title, unitId: row.unit_id, unitName: row.unit_name }));
  }

  /** The unit at the top of the organization: where a step of the period as a whole is reminded (the roles of the notification workflow decide who). */
  async rootUnit(tx: TenantTx): Promise<{ id: string; path: string } | undefined> {
    const rows = await tx.query<{ id: string; path: string }>(`select id, path from machvon.organization_unit order by char_length(path), path, id limit 1`);
    return rows[0];
  }

  /** The series keys of the reminders already made for these items. */
  async sentSeries(tx: TenantTx, itemKeys: readonly string[]): Promise<Set<string>> {
    if (itemKeys.length === 0) return new Set();
    const rows = await tx.query<{ series_key: string }>(`select series_key from machvon.reporting_reminder where item_key = any($1::text[])`, [[...itemKeys]]);
    return new Set(rows.map((row) => row.series_key));
  }

  /** Records a reminder; `created` is false when the series already had it (a pass run twice, or by two processes). */
  async record(tx: TenantTx, reminder: ScheduleReminderRecord): Promise<{ id: string; created: boolean }> {
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.reporting_reminder (tenant_id, item_kind, item_key, schedule_code, unit_id, step, kind, ordinal, series_key, alert_type, due_at, rule_version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4::uuid, $5, $6, $7::int, $8, $9, $10::timestamptz, $11::int)
       on conflict (tenant_id, series_key) do nothing returning id`,
      [reminder.itemKind, reminder.itemKey, reminder.scheduleCode, reminder.unitId, reminder.step, reminder.kind, reminder.ordinal, seriesKeyOf(reminder), reminder.alertType, reminder.dueAt, reminder.ruleVersion],
    );
    if (inserted[0] !== undefined) return { id: inserted[0].id, created: true };
    const existing = await tx.query<{ id: string }>(`select id from machvon.reporting_reminder where series_key = $1`, [seriesKeyOf(reminder)]);
    return { id: (existing[0] as { id: string }).id, created: false };
  }

  /** The latest reminders, newest first: what the board shows next to a step. */
  async recent(tx: TenantTx, itemKey: string, limit: number): Promise<Array<{ id: string; unitId: string | null; step: ScheduleStepKind; kind: ScheduleReminderKind; ordinal: number; dueAt: string; createdAt: string }>> {
    const rows = await tx.query<{ id: string; unit_id: string | null; step: ScheduleStepKind; kind: ScheduleReminderKind; ordinal: number; due_at: string; created_at: string }>(
      `select id, unit_id, step, kind, ordinal, to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as due_at, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
         from machvon.reporting_reminder where item_key = $1 order by created_at desc, id desc limit $2::int`,
      [itemKey, limit],
    );
    return rows.map((row) => ({ id: row.id, unitId: row.unit_id, step: row.step, kind: row.kind, ordinal: row.ordinal, dueAt: row.due_at, createdAt: row.created_at }));
  }
}

/** The key that makes one reminder of a series unique: the item, the unit, the step, the kind and the number. */
export const seriesKeyOf = (reminder: Pick<ScheduleReminderRecord, 'itemKey' | 'unitId' | 'step' | 'kind' | 'ordinal'>): string =>
  `${reminder.itemKey}|${reminder.unitId ?? '-'}|${reminder.step}|${reminder.kind}|${reminder.ordinal}`;
