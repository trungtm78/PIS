import type { IsoWeek } from '@machvon/kernel';
import { ISSUE_STATUSES, SCOPE_FROM } from './iss-issue-store.ts';
import type { IssueStatus } from './iss-issue-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const FROM = `${SCOPE_FROM} join machvon.master_record_version cv on cv.tenant_id = i.tenant_id and cv.id = i.category_version_id`;

/** The issues of the unit by the status they had at the end of the week, one count for each status: the statuses are a list of the code, not of the caller. */
const STATUS_COUNTS = `jsonb_build_object(${ISSUE_STATUSES.map((status) => `'${status}', (count(*) filter (where s.status_end = '${status}'))`).join(', ')})`;

export type StatusCounts = Readonly<Record<IssueStatus, number>>;

export interface MatrixRow {
  unitId: string;
  unitCode: string;
  unitName: string;
  categoryVersionId: string;
  categoryCode: string;
  categoryLabel: string;
  /** The issues that were open when the week began. */
  opening: number;
  /** The issues that became open in the week: the ones raised, and the ones reopened. */
  opened: number;
  /** The issues closed in the week. */
  resolved: number;
  /** The issues open when the week ended: `opening + opened - resolved`. */
  closing: number;
  /** Of those, the ones whose deadline had passed. */
  overdue: number;
  /** The issues that existed when the week ended, by the status they had then. */
  byStatus: StatusCounts;
}

interface RowSql {
  unit_id: string;
  unit_code: string;
  unit_name: string;
  category_version_id: string;
  category_code: string;
  category_label: string;
  opening: string;
  opened: string;
  resolved: string;
  closing: string;
  overdue: string;
  statuses: Record<string, number>;
}

export const emptyCounts = (): Record<IssueStatus, number> => Object.fromEntries(ISSUE_STATUSES.map((status) => [status, 0])) as Record<IssueStatus, number>;

/**
 * The weekly matrix of the issues (ST-ISS-006, ISS 3.1, BR-ISS-08, UAT-PLAN-25): for each unit that owns issues and each group of issues, what stood open when the week began, what became open in it, what was closed, and what stood open
 * when it ended (`closing = opening + opened - resolved`, and the opening of a week is the closing of the week before it), with the issues of the unit counted by the status they had when the week ended. The state at a moment is read
 * from the history of the issue (its events carry the status they moved it to), so a week that is over reads the same whenever it is asked for; the week that is running reads up to now. An issue belongs to the unit and the group it has today.
 */
export class IssWeeklyStore {
  async matrix(tx: TenantTx, scope: ScopeBuilder, week: IsoWeek, unitId: string | undefined, now: Date): Promise<MatrixRow[]> {
    // A week that has not begun has nothing in it: what exists today is not a result of that week.
    if (Date.parse(`${week.from}T00:00:00+07:00`) > now.getTime()) return [];
    const predicate = scope(5);
    const rows = await tx.query<RowSql>(
      `with bounds as (
         select ($1::date)::timestamp at time zone 'Asia/Ho_Chi_Minh' as week_start,
                (($2::date + 1))::timestamp at time zone 'Asia/Ho_Chi_Minh' as week_end,
                -- The week ends before the Monday after it; the week that is running is read up to now (a millisecond past it, so that what happened at this very instant is in).
                least((($2::date + 1))::timestamp at time zone 'Asia/Ho_Chi_Minh', $4::timestamptz + interval '1 millisecond') as at
       ),
       state as (
         select i.id, i.owner_unit_id, ou.code as unit_code, ou.name as unit_name, i.category_version_id, cv.code as category_code, cv.label as category_label, b.at,
                -- The deadline the issue had at the end of the week: the one an extension after it gave up, or the one the last extension before it gave, or the one it has.
                coalesce(
                  (select (e.payload->>'new_due_at')::timestamptz from machvon.issue_event e where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.event_kind = 'EXTENDED' and e.created_at < b.at order by e.created_at desc, e.id desc limit 1),
                  (select (e.payload->>'previous_due_at')::timestamptz from machvon.issue_event e where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.event_kind = 'EXTENDED' and e.created_at >= b.at order by e.created_at asc, e.id asc limit 1),
                  i.due_at
                ) as due_at,
                -- An issue that was late stays late when its deadline is moved on (BR-ISS-04): the job recorded the breach, or the extension did when it found the old deadline past.
                exists (
                  select 1 from machvon.issue_event e
                   where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.created_at < b.at
                     and ((e.event_kind = 'SLA_BREACHED' and (e.payload->>'overdue_since')::timestamptz < b.at)
                       or (e.event_kind = 'EXTENDED' and (e.payload->>'previous_due_at')::timestamptz < e.created_at and (e.payload->>'previous_due_at')::timestamptz < b.at))
                ) as was_late,
                (select e.to_status from machvon.issue_event e where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.to_status is not null and e.created_at < b.week_start order by e.created_at desc, e.id desc limit 1) as status_start,
                (select e.to_status from machvon.issue_event e where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.to_status is not null and e.created_at < b.at order by e.created_at desc, e.id desc limit 1) as status_end,
                (select count(*) from machvon.issue_event e where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.event_kind in ('CREATED', 'REOPENED') and e.created_at >= b.week_start and e.created_at < b.at) as became_open,
                (select count(*) from machvon.issue_event e where e.tenant_id = i.tenant_id and e.issue_id = i.id and e.event_kind = 'CLOSED' and e.created_at >= b.week_start and e.created_at < b.at) as became_closed
           from ${FROM}, bounds b
          where ($3::uuid is null or i.owner_unit_id = $3::uuid) and ${predicate.sql}
       )
       select s.owner_unit_id as unit_id, s.unit_code, s.unit_name, s.category_version_id, s.category_code, s.category_label,
              (count(*) filter (where s.status_start is not null and s.status_start <> 'CLOSED'))::text as opening,
              (coalesce(sum(s.became_open), 0))::text as opened,
              (coalesce(sum(s.became_closed), 0))::text as resolved,
              (count(*) filter (where s.status_end is not null and s.status_end <> 'CLOSED'))::text as closing,
              (count(*) filter (where s.status_end is not null and s.status_end <> 'CLOSED' and (s.was_late or s.due_at < s.at)))::text as overdue,
              ${STATUS_COUNTS} as statuses
         from state s
        where s.status_end is not null or s.status_start is not null
        group by s.owner_unit_id, s.unit_code, s.unit_name, s.category_version_id, s.category_code, s.category_label
        order by s.unit_code, s.category_code, s.owner_unit_id, s.category_version_id`,
      [week.from, week.to, unitId ?? null, now.toISOString(), ...predicate.params],
    );
    return rows.map((row) => ({
      unitId: row.unit_id,
      unitCode: row.unit_code,
      unitName: row.unit_name,
      categoryVersionId: row.category_version_id,
      categoryCode: row.category_code,
      categoryLabel: row.category_label,
      opening: Number(row.opening),
      opened: Number(row.opened),
      resolved: Number(row.resolved),
      closing: Number(row.closing),
      overdue: Number(row.overdue),
      byStatus: { ...emptyCounts(), ...row.statuses },
    }));
  }
}

