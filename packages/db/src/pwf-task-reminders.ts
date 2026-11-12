import { pwfDeadlineBand, vietnamDateOf } from '@machvon/kernel';
import type { WorkCalendarSource } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { severityOf } from './home-work-rules.ts';
import type { WorkSeverity } from './home-work-rules.ts';
import { addDays } from './home-work-sources.ts';
import { PwfBandPolicies } from './pwf-band-policies.ts';
import type { BandPolicySet } from './pwf-band-policies.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The reminders of the tasks of a workflow, at several points (BR-PWF-24, R30): the days left at which the rule `DEADLINE_BAND_POLICY` of the source says to remind (5, 2, 0 and the day after, by default), and the extra days each person asked
 * for themselves (their own, never later than the last official one). Each point fires ONCE for each task and version of its schedule (`project_task_reminder`, the key that makes a pass that runs twice, or two that run at once, remind once);
 * a task whose days move is a new version and has its points again. A point crossed together with a nearer one (the job was late, or the task was moved to a nearer day) is recorded and not sent: the person is told once, of the nearest.
 * The reminder itself is a row of the alert centre (`work_reminder`, written by the job through the engine that already counts, caps and delivers reminders by the profile of the person); the official points go to the people the ledger of assignments
 * names as responsible, the personal ones to the person who set them.
 */

export interface PwfReminderNotice {
  taskId: string;
  /** The identity of the item in the alert centre: the task and the version of its schedule. */
  sourceId: string;
  scheduleVersion: number;
  recipient: string;
  audience: 'OFFICIAL' | 'PERSONAL';
  /** The days left the reminder is for, and how many there were when it was seen. */
  point: number;
  remaining: number;
  /** Which of the points of the list it is (the personal ones count from 101). */
  ordinal: number;
  severity: WorkSeverity;
  dueOn: string;
  policyVersion: string;
}

/** Whether a person may be told of a task: an active membership that still reads the project (the caller knows access; the store knows the tasks). */
export type RecipientEligibility = (membershipId: string, projectId: string) => Promise<boolean>;

interface TaskSql {
  id: string;
  project_id: string;
  schedule_version: number;
  kind: 'TASK' | 'MILESTONE';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  phase_code: string;
  due_on: string;
  unit_path: string | null;
}

interface AssigneeSql {
  task_id: string;
  membership_id: string;
  personal: number[] | null;
}

interface FiredSql {
  task_id: string;
  schedule_version: number;
  reminder_day: number;
  membership_id: string | null;
}

/** How far back a point that was crossed is still worth telling (a task that is more than this overdue has had its last point long ago). */
const LOOK_BACK_DAYS = 40;
/** How many tasks a pass reads at a time, and the most pages it reads in one pass (the rest of a very large window is reached by the next pass, which skips what already fired). */
const PAGE_SIZE = 5_000;
const MAX_PAGES = 40;

const firedKey = (task: string, version: number, point: number, member: string | null): string => `${task}:${version}:${point}:${member ?? ''}`;

export class PwfTaskReminders {
  private readonly policies = new PwfBandPolicies();
  private readonly calendars: HomeWorkCalendars;
  private readonly pageSize: number;

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars(), pageSize: number = PAGE_SIZE) {
    this.calendars = calendars;
    this.pageSize = pageSize;
  }

  /**
   * Records every reminder point that has been crossed since the last pass and returns the notices to deliver (the nearest point of each task and person). It writes only `project_task_reminder`; the caller turns each notice into a reminder of
   * the alert centre in the same transaction.
   */
  async fire(tx: TenantTx, now: Date, eligible: RecipientEligibility = () => Promise.resolve(true)): Promise<PwfReminderNotice[]> {
    const today = vietnamDateOf(now);
    const set = await this.policies.load(tx, today);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    const widest = await this.widestPoint(tx, set.widestReminderDays);
    const window = [addDays(today, -LOOK_BACK_DAYS), addDays(today, Math.ceil(widest * 1.5) + 21)];
    const notices: PwfReminderNotice[] = [];
    let after: { day: string; id: string } | null = null;
    // The tasks of the window are read a page at a time, in the order of their days, so that a tenant with many of them is reached to the end and not only at its first rows.
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const tasks: Array<TaskSql & { sort_day: string }> = await tx.query<TaskSql & { sort_day: string }>(
        `select t.id, t.project_id, t.schedule_version, t.kind, t.priority, t.phase_code, t.planned_finish::text as due_on, t.planned_finish::text as sort_day, ou.path as unit_path
           from machvon.project_task t
           join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id and w.status = 'ACTIVE'
           join machvon.project p on p.tenant_id = t.tenant_id and p.id = t.project_id
           left join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
          where t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS') and t.planned_finish between $1::date and $2::date
            and ($3::date is null or (t.planned_finish, t.id) > ($3::date, $4::uuid))
          order by t.planned_finish, t.id limit ${this.pageSize}`,
        [window[0], window[1], after?.day ?? null, after?.id ?? null],
      );
      notices.push(...(await this.firePage(tx, tasks, { today, set, calendars, eligible })));
      const last = tasks[tasks.length - 1];
      if (tasks.length < this.pageSize || last === undefined) break;
      after = { day: last.sort_day, id: last.id };
    }
    return notices;
  }

  /** One page of the window: the points its tasks crossed, recorded, and the notices they make. */
  private async firePage(tx: TenantTx, tasks: readonly TaskSql[], context: { today: string; set: BandPolicySet; calendars: WorkCalendarSource | undefined; eligible: RecipientEligibility }): Promise<PwfReminderNotice[]> {
    const { today, set, calendars, eligible } = context;
    if (tasks.length === 0) return [];
    const ids = tasks.map((task) => task.id);
    const assignees = await tx.query<AssigneeSql>(
      `select a.task_id, a.membership_id, p.personal_reminder_days as personal
         from machvon.project_task_assignment a left join machvon.alert_notification_profile p on p.tenant_id = a.tenant_id and p.membership_id = a.membership_id
        where a.task_id = any($1::uuid[]) and a.role = 'RESPONSIBLE' and a.valid_from <= $2::date and (a.valid_to is null or a.valid_to >= $2::date)`,
      [ids, today],
    );
    const fired = await tx.query<FiredSql>('select task_id, schedule_version, reminder_day, membership_id from machvon.project_task_reminder where task_id = any($1::uuid[])', [ids]);
    const known = new Set(fired.map((row) => firedKey(row.task_id, row.schedule_version, row.reminder_day, row.membership_id)));
    const holders = new Map<string, AssigneeSql[]>();
    for (const row of assignees) holders.set(row.task_id, [...(holders.get(row.task_id) ?? []), row]);

    /** What was crossed for one task since the last pass: the points of the rule (for everybody who holds the task) and, for each holder, the points they added. */
    interface Fresh {
      task: TaskSql;
      remaining: number;
      severity: WorkSeverity;
      policyVersion: string;
      listed: readonly number[];
      official: number[];
      holders: Array<{ member: string; personal: number[]; listed: readonly number[]; nearest: number }>;
    }
    const fresh: Fresh[] = [];
    for (const task of tasks) {
      const policy = set.forUnitPath(task.unit_path);
      const remaining = pwfDeadlineBand.remainingDays({ dueOn: task.due_on, today, unit: policy.unit, calendars });
      // The days cannot be counted without the calendar of the year: no reminder is made up.
      if (remaining === null) continue;
      const thresholds = pwfDeadlineBand.thresholdsFor(policy, { taskKind: task.kind, priority: task.priority, phase: task.phase_code });
      const band = pwfDeadlineBand.bandOf(remaining, thresholds);
      const severity = severityOf('PROJECT_TASK', remaining < 0 ? 'OVERDUE' : band === 'NONE' ? 'GREEN' : band);
      const own = holders.get(task.id) ?? [];
      if (own.length === 0) continue;
      const official = pwfDeadlineBand.dueReminders({ previousRemaining: null, remaining, reminderDays: policy.reminder_days }).filter((point) => !known.has(firedKey(task.id, task.schedule_version, point, null)));
      const people: Fresh['holders'] = [];
      for (const holder of own) {
        // Somebody who is no longer an active member, or who no longer reads the project, is not told of its tasks, and the point is not spent on them.
        if (!(await eligible(holder.membership_id, task.project_id))) continue;
        const personalDays = (holder.personal ?? []).filter((point) => !policy.reminder_days.includes(point));
        const personal = pwfDeadlineBand.dueReminders({ previousRemaining: null, remaining, reminderDays: personalDays }).filter((point) => !known.has(firedKey(task.id, task.schedule_version, point, holder.membership_id)));
        // A person is told once, of the nearest point crossed of the two lists together (the rule's and their own).
        const crossed = [...official, ...personal];
        if (crossed.length > 0) people.push({ member: holder.membership_id, personal, listed: holder.personal ?? [], nearest: Math.min(...crossed) });
      }
      if (people.length > 0) fresh.push({ task, remaining, severity, policyVersion: set.versionForUnitPath(task.unit_path), listed: policy.reminder_days, official, holders: people });
    }
    if (fresh.length === 0) return [];
    const rows: Array<{ entry: Fresh; point: number; member: string | null; notified: boolean }> = [];
    for (const entry of fresh) {
      for (const point of entry.official) rows.push({ entry, point, member: null, notified: entry.holders.some((holder) => holder.nearest === point) });
      for (const holder of entry.holders) for (const point of holder.personal) rows.push({ entry, point, member: holder.member, notified: holder.nearest === point });
    }
    const inserted = await tx.query<{ task_id: string; schedule_version: number; reminder_day: number; membership_id: string | null }>(
      `insert into machvon.project_task_reminder (tenant_id, task_id, schedule_version, reminder_day, audience, membership_id, remaining_days, fired_on, notified)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, x.task_id, x.version, x.point, case when x.member is null then 'OFFICIAL' else 'PERSONAL' end, x.member, x.remaining, $7::date, x.notified
         from unnest($1::uuid[], $2::int[], $3::int[], $4::uuid[], $5::int[], $6::boolean[]) as x(task_id, version, point, member, remaining, notified)
       on conflict do nothing
       returning task_id, schedule_version, reminder_day, membership_id`,
      [rows.map(({ entry }) => entry.task.id), rows.map(({ entry }) => entry.task.schedule_version), rows.map(({ point }) => point), rows.map(({ member }) => member), rows.map(({ entry }) => entry.remaining), rows.map(({ notified }) => notified), today],
    );
    const written = new Set(inserted.map((row) => firedKey(row.task_id, row.schedule_version, row.reminder_day, row.membership_id)));
    const notices: PwfReminderNotice[] = [];
    for (const entry of fresh) {
      for (const holder of entry.holders) {
        const ofRule = entry.official.includes(holder.nearest);
        // Another pass recorded the point first: it tells the person, not this one.
        if (!written.has(firedKey(entry.task.id, entry.task.schedule_version, holder.nearest, ofRule ? null : holder.member))) continue;
        notices.push({
          taskId: entry.task.id,
          sourceId: `${entry.task.id}:${entry.task.schedule_version}`,
          scheduleVersion: entry.task.schedule_version,
          recipient: holder.member,
          audience: ofRule ? 'OFFICIAL' : 'PERSONAL',
          point: holder.nearest,
          remaining: entry.remaining,
          ordinal: ofRule ? entry.listed.indexOf(holder.nearest) + 1 : 100 + holder.listed.indexOf(holder.nearest) + 1,
          severity: entry.severity,
          dueOn: entry.task.due_on,
          policyVersion: entry.policyVersion,
        });
      }
    }
    return notices;
  }

  /** The farthest point (days left) any rule or person asks to be reminded at: it bounds how far ahead the tasks are read. */
  private async widestPoint(tx: TenantTx, official: number): Promise<number> {
    const rows = await tx.query<{ widest: number | null }>('select max(d) as widest from machvon.alert_notification_profile p, unnest(p.personal_reminder_days) as d where p.personal_reminder_days is not null');
    return Math.max(official, rows[0]?.widest ?? 0, 0);
  }
}
