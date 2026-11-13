import { legalDocument, message, pwfDeadlineBand } from '@machvon/kernel';
import type { WorkCalendarSource, WorkKind } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, addDays, base, reach, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { PwfAssignmentReads } from './pwf-assignment.ts';
import { PwfBandPolicies } from './pwf-band-policies.ts';
import { windowEdge } from './pwf-horizon.ts';
import type { BandPolicySet } from './pwf-band-policies.ts';

/** How many days ahead a milestone at risk is shown. */
const MILESTONE_AHEAD_DAYS = 90;
/** The most chunks of tasks read to fill a list (ten times the limit of a source). */
const MAX_SCAN_CHUNKS = 10;

/**
 * The tasks of the project workflow as a source of the alert centre (PWF-2, R30, BR-PWF-27). The source READS the deadline of a task from `project_task`: there is no `work_clock` for a task, so a task that is moved, paused,
 * cancelled or done changes (or leaves) the list by itself in the same transaction that changed it, and a pass that runs twice records nothing twice. The identity of an item is the task and the version of the schedule its days came from
 * (`<task id>:<schedule version>`), so a task whose days moved is one new item, never two.
 *  - `PWF_TASK_DUE_SOON` / `PWF_TASK_OVERDUE` (owner: the people the ledger of assignments names as responsible or accountable): a task that is waiting or under way, in a workflow that is running, whose official colour has started (green, yellow or red) or that
 *    is past its day. The facet that decides the severity is the official colour (green and yellow are to be watched, red is to be acted on); a task past its day is to be acted on, and urgent from the day the rule says it goes up.
 *  - `PWF_MILESTONE_AT_RISK` (owner: the one who answers for the project): a milestone whose forecast is past its first baseline, or that is critical with its float used up.
 * Only the OFFICIAL colour counts here (R40: nobody sets their own deadline later); what a person sets for themselves changes what they are reminded of and the colour of their own list, not this list. The days are counted on the published working
 * calendar; a task whose year has none is not guessed at (it has no colour and is not listed) and the board says so. The read is bounded (R35): only the tasks within the widest green line of the policies in force are read, and a list that reaches the
 * limit of a source says it is cut.
 */
export class HomePwfSources {
  private readonly policies = new PwfBandPolicies();
  private readonly calendars: HomeWorkCalendars;

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.calendars = calendars;
  }

  async items(context: SourceContext): Promise<SourceRow[]> {
    const due = await this.dueTasks(context);
    const milestones = await this.milestonesAtRisk(context);
    const lapsed = await this.lapsedLegalGrounds(context);
    return [...due, ...milestones, ...lapsed];
  }

  /**
   * `PWF_LEGAL_BASIS_LAPSED` (PWF-4, R45; owner: the one who answers for the project): a running workflow cites, on a step or a task of its frozen template, a document the shared catalogue says has expired or was replaced. One
   * item per workflow and document, whose identity carries the version of the catalogue entry (`<workflow>:<document>:<version>`), so a document that is corrected again is one new item, never two. The catalogue is read first: when
   * no document of it has lapsed nothing is asked of the workflows at all.
   */
  private async lapsedLegalGrounds(context: SourceContext): Promise<SourceRow[]> {
    const catalogue = await new PwfAssignmentReads().legalDocuments(context.tx, context.today);
    const lapsed = [...catalogue.values()].filter((document) => legalDocument.isLapsed(document.state));
    if (lapsed.length === 0) return [];
    const params = new Params();
    const codes = params.add(lapsed.map((document) => document.code));
    const visible = reach(params, context, { source: 'PROJECT_TASK', id: `(w.id::text || ':' || d.code)`, tenant: 'w', responsible: [], unit: false });
    const rows = await context.tx.query<{ workflow_id: string; code: string; project_id: string; project_code: string }>(
      `select w.id as workflow_id, d.code, p.id as project_id, p.code as project_code
         from machvon.project_workflow w
         cross join lateral (
           select distinct cited #>> '{}' as code
             from jsonb_path_query(w.template, '$.steps[*].legal_basis[*].document') as cited
           union
           select distinct cited #>> '{}' as code
             from jsonb_path_query(w.template, '$.tasks[*].legal_basis[*].document') as cited
         ) d
         ${PROJECT_JOINS('w', 'w.project_id')}
        where w.status = 'ACTIVE' and d.code = any(${codes}::text[]) and ${visible}
        order by p.code, d.code limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row): SourceRow => {
      const document = catalogue.get(row.code) as NonNullable<ReturnType<typeof catalogue.get>>;
      const since = document.effectiveTo ?? context.today;
      return {
        ...base('PWF_LEGAL_BASIS_LAPSED'),
        id: `${row.workflow_id}:${row.code}:${document.ruleVersion}`,
        dueOn: since,
        originalDueOn: since,
        title: message('home.source.pwf.legal.title', { document: document.number, project: row.project_code }),
        subtitle:
          document.supersededBy === null
            ? message('home.source.pwf.legal.detail', { number: document.number, date: since })
            : message('home.source.pwf.legal.detail.replaced', { number: document.number, replacement: catalogue.get(document.supersededBy)?.number ?? document.supersededBy }),
        status: 'AT_RISK',
        severity: severityOf('PROJECT_TASK', 'LEGAL_BASIS_LAPSED', context.rules),
        lifecycle: 'NEW',
        consequence: CONSEQUENCES.PWF_LEGAL_BASIS_LAPSED ?? null,
        causeKey: `pwf-legal:${row.workflow_id}:${row.code}`,
        startedAt: null,
        target: { screen: 'PWF-03', id: row.project_id },
      };
    });
  }

  /** The last day a task can be due on and still be within the widest green line: the day before the working day that comes after the line, on the published calendar of the tenant (whatever its weekdays and holidays are). Without a calendar nothing but today can be counted. */
  private horizonOf(set: BandPolicySet, today: string, calendars: WorkCalendarSource | undefined): string | null {
    const widest = set.widestGreenDays;
    if (widest === null) return null;
    return addDays(windowEdge(calendars, today, widest + 1), -1);
  }

  /** One chunk of the tasks in the window of the reader, in the order of their days, after the task a previous chunk ended with. */
  private async chunkAfter(context: SourceContext, horizon: string | null, after: { day: string; id: string } | null): Promise<TaskSql[]> {
    const params = new Params();
    const visible = reach(params, context, {
      source: 'PROJECT_TASK',
      id: `(t.id::text || ':' || t.schedule_version::text)`,
      tenant: 't',
      responsible: [],
      unit: false,
      // The day is a parameter only when the view needs it (a parameter no part of the statement mentions cannot be typed by the database).
      mine: (me) => this.assignedTo(me, params.add(context.today)),
    });
    const until = horizon === null ? '' : `and t.planned_finish <= ${params.add(horizon)}::date`;
    const past = after === null ? '' : `and (t.planned_finish, t.id) > (${params.add(after.day)}::date, ${params.add(after.id)}::uuid)`;
    return context.tx.query<TaskSql>(
      `select t.id, t.schedule_version, t.task_code, t.name, t.phase_code, t.kind, t.priority, t.critical, t.planned_finish::text as due_on, t.baseline_finish::text as baseline_on, p.id as project_id, p.code as project_code, ou.path as unit_path
         from machvon.project_task t
         join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id and w.status = 'ACTIVE'
         ${PROJECT_JOINS('t', 't.project_id')}
        where t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS') and t.planned_finish is not null ${until} ${past} and ${visible}
        order by t.planned_finish, t.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
  }

  private async dueTasks(context: SourceContext): Promise<SourceRow[]> {
    const set = await this.policies.load(context.tx, context.today);
    const calendars = await this.calendars.load(context.tx, WORK_CALENDAR_CODE, context.now);
    const horizon = this.horizonOf(set, context.today, calendars);
    const items: SourceRow[] = [];
    let after: { day: string; id: string } | null = null;
    // The tasks are read in chunks of the limit of a source and the ones that have no colour yet are dropped, so that a chunk full of far tasks never hides the ones behind it, and a list that really has more than the limit says so by being exactly as long as it.
    for (let chunk = 0; chunk < MAX_SCAN_CHUNKS; chunk += 1) {
      const rows: TaskSql[] = await this.chunkAfter(context, horizon, after);
      for (const row of rows) {
        const policy = set.forUnitPath(row.unit_path);
        const result = pwfDeadlineBand.deadlineBand({ dueOn: row.due_on, today: context.today, unit: policy.unit, calendars, thresholds: pwfDeadlineBand.thresholdsFor(policy, { taskKind: row.kind, priority: row.priority, phase: row.phase_code }) });
        // No colour yet (far), or none can be given (the calendar of the year is not published): not a thing to act on today.
        if (result.band === 'NONE' || result.band === 'UNKNOWN' || result.remainingDays === null) continue;
        items.push(this.itemOf(context, row, result.band, result.remainingDays, pwfDeadlineBand.shouldEscalate({ remaining: result.remainingDays, escalateAfterOverdueDays: policy.escalate_after_overdue_days })));
        if (items.length >= SOURCE_LIMIT) return items;
      }
      const last = rows[rows.length - 1];
      if (rows.length < SOURCE_LIMIT || last === undefined) return items;
      after = { day: last.due_on, id: last.id };
    }
    // So many tasks without a colour in the way that the list cannot be said to be complete: the source is named as unavailable (never shown as "no work").
    throw new Error('PROJECT_TASK_SCAN_INCOMPLETE');
  }

  /** The tasks the ledger of assignments hands to the reader today, as the ones who do them or answer for them. */
  private assignedTo(me: string, today: string): string {
    return `exists (select 1 from machvon.project_task_assignment a where a.tenant_id = t.tenant_id and a.task_id = t.id and a.role in ('RESPONSIBLE', 'ACCOUNTABLE') and a.membership_id = ${me}
        and a.valid_from <= ${today}::date and (a.valid_to is null or a.valid_to >= ${today}::date))`;
  }

  private itemOf(context: SourceContext, row: TaskSql, band: pwfDeadlineBand.BandColor, remaining: number, escalated: boolean): SourceRow {
    const overdue = remaining < 0;
    const kind: WorkKind = overdue ? 'PWF_TASK_OVERDUE' : 'PWF_TASK_DUE_SOON';
    const facet = overdue ? (escalated ? 'OVERDUE_ESCALATED' : 'OVERDUE') : band;
    const days = Math.abs(remaining);
    const title = overdue
      ? message(escalated ? 'home.source.pwf.overdue.escalated.title' : 'home.source.pwf.overdue.title', { task: row.name, project: row.project_code, days })
      : remaining === 0
        ? message('home.source.pwf.due_today.title', { task: row.name, project: row.project_code })
        : message('home.source.pwf.due_soon.title', { task: row.name, project: row.project_code, days });
    return {
      ...base(kind),
      id: `${row.id}:${row.schedule_version}`,
      dueOn: row.due_on,
      originalDueOn: row.baseline_on ?? row.due_on,
      title,
      subtitle: message(row.critical ? 'home.source.pwf.detail.critical' : 'home.source.pwf.detail', { code: row.task_code, phase: row.phase_code, date: row.due_on }),
      status: overdue ? 'OVERDUE' : band === 'RED' ? 'DUE_TODAY' : 'DUE_SOON',
      severity: severityOf('PROJECT_TASK', facet, context.rules),
      lifecycle: 'NEW',
      consequence: CONSEQUENCES[kind] ?? null,
      causeKey: `pwf-task:${row.id}`,
      startedAt: overdue ? startOfDay(addDays(row.due_on, 1)) : null,
      target: { screen: 'PWF-04', id: row.id },
    };
  }

  /** The milestones of running workflows whose forecast day is past the day of the first baseline, or that sit on the critical path with their float spent (BR-PWF-25), for the one who answers for the project. */
  private async milestonesAtRisk(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'PROJECT_TASK', id: `(t.id::text || ':' || t.schedule_version::text || ':risk')`, tenant: 't', responsible: [], unit: false });
    const rows = await context.tx.query<TaskSql & { slip: number }>(
      `select t.id, t.schedule_version, t.task_code, t.name, t.phase_code, t.kind, t.priority, t.critical, t.planned_finish::text as due_on, t.baseline_finish::text as baseline_on, p.id as project_id, p.code as project_code, ou.path as unit_path,
              (t.planned_finish - t.baseline_finish) as slip
         from machvon.project_task t
         join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id and w.status = 'ACTIVE'
         ${PROJECT_JOINS('t', 't.project_id')}
        where t.kind = 'MILESTONE' and t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL') and t.planned_finish is not null and t.baseline_finish is not null
          and (t.planned_finish > t.baseline_finish or (t.critical and coalesce(t.total_float, 0) < 0)) and t.planned_finish <= ${today}::date + ${MILESTONE_AHEAD_DAYS} and ${visible}
        order by t.planned_finish, t.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map(
      (row): SourceRow => ({
        ...base('PWF_MILESTONE_AT_RISK'),
        id: `${row.id}:${row.schedule_version}:risk`,
        dueOn: row.due_on,
        originalDueOn: row.baseline_on ?? row.due_on,
        title: message('home.source.pwf.milestone.title', { task: row.name, project: row.project_code, days: Math.max(0, Number(row.slip)) }),
        subtitle: message('home.source.pwf.milestone.detail', { code: row.task_code, baseline: row.baseline_on ?? row.due_on, date: row.due_on }),
        status: 'AT_RISK',
        severity: severityOf('PROJECT_TASK', 'MILESTONE_AT_RISK', context.rules),
        lifecycle: 'NEW',
        consequence: CONSEQUENCES.PWF_MILESTONE_AT_RISK ?? null,
        causeKey: `pwf-milestone:${row.id}`,
        startedAt: null,
        target: { screen: 'PWF-04', id: row.id },
      }),
    );
  }
}

interface TaskSql {
  id: string;
  schedule_version: number;
  task_code: string;
  name: string;
  phase_code: string;
  kind: 'TASK' | 'MILESTONE';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  critical: boolean;
  due_on: string;
  baseline_on: string | null;
  project_id: string;
  project_code: string;
  unit_path: string | null;
}
