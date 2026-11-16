import { legalDocument, message, pwfDeadlineBand } from '@machvon/kernel';
import type { WorkCalendarSource, WorkKind } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { PROJECT_JOINS, Params, SOURCE_LIMIT, addDays, base, reach, startOfDay } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { PwfAssignmentReads } from './pwf-assignment.ts';
import { PwfBandPolicies } from './pwf-band-policies.ts';
import { windowEdge } from './pwf-horizon.ts';
import { bandColumnsOf, officialTaskBand, stepLadderOf, withinGreenLine } from './pwf-task-band.ts';
import type { TaskBandColumns } from './pwf-task-band.ts';
import type { BandPolicySet } from './pwf-band-policies.ts';
import { responsibleHeldSql, unitGrantSql } from './pwf-task-claim.ts';

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
    const unclaimed = await this.unclaimedTasks(context);
    const overall = await this.overallDeadlines(context);
    return [...due, ...milestones, ...lapsed, ...unclaimed, ...overall];
  }

  /**
   * `PWF_OVERALL_DEADLINE_AT_RISK` (PWF-5, docs PWF 22.2, 22.6; owner: the one who answers for the project, as for a milestone at risk): the deadline of the whole file of a running workflow, which is the committed finish of the
   * task its frozen template marks, has turned yellow or red. The colour is the OFFICIAL colour of that very task, by the one resolution every read uses (`officialTaskBand`: the ladder of the task, then the policy in force), so
   * the alert and the task can never disagree. One item per workflow (`<workflow>:overall`); it is read from the rows as they are, so it leaves the list in the transaction that completes or cancels the task, moves its day
   * back into green, or pauses or ends the workflow. A workflow whose project does not have the marked task (a branch that was cut) has no deadline of the whole file and no item. The workflows are found through the column
   * `project_workflow.overall_deadline_task` and its index (V3063), never by reading the frozen template of every workflow, and only the ones whose task can have a colour today are read, in chunks (R35).
   */
  private async overallDeadlines(context: SourceContext): Promise<SourceRow[]> {
    const any = await context.tx.query(`select 1 from machvon.project_workflow where status = 'ACTIVE' and overall_deadline_task is not null limit 1`);
    if (any.length === 0) return [];
    const set = await this.policies.load(context.tx, context.today);
    const calendars = await this.calendars.load(context.tx, WORK_CALENDAR_CODE, context.now);
    const horizon = this.horizonOf(set, context.today, calendars);
    const items: SourceRow[] = [];
    let after: { day: string; id: string } | null = null;
    for (let chunk = 0; chunk < MAX_SCAN_CHUNKS; chunk += 1) {
      const params = new Params();
      const visible = reach(params, context, { source: 'PROJECT_TASK', id: `(w.id::text || ':overall')`, tenant: 't', responsible: [], unit: false });
      const until = horizon === null ? '' : `and ${withinGreenLine('t', 't.committed_finish', params.add(horizon), params.add(context.today))}`;
      const past: string = after === null ? '' : `and (t.committed_finish, t.id) > (${params.add(after.day)}::date, ${params.add(after.id)}::uuid)`;
      const rows: Array<DueTaskSql & { workflow_id: string }> = await context.tx.query<DueTaskSql & { workflow_id: string }>(
        `select w.id as workflow_id, t.id, t.schedule_version, t.task_code, t.name, t.phase_code, t.kind, t.priority, t.critical, t.committed_finish::text as due_on, t.baseline_finish::text as baseline_on, p.id as project_id, p.code as project_code, p.name as project_name, ou.path as unit_path, ${bandColumnsOf('t')}
           from machvon.project_workflow w
           join machvon.project_task t on t.tenant_id = w.tenant_id and t.workflow_id = w.id and t.task_code = w.overall_deadline_task
           ${PROJECT_JOINS('t', 't.project_id')}
          where w.status = 'ACTIVE' and w.overall_deadline_task is not null and t.tracked and not t.excluded and t.status not in ('DONE', 'CANCELLED') and t.committed_finish is not null ${until} ${past} and ${visible}
          order by t.committed_finish, t.id limit ${SOURCE_LIMIT}`,
        params.values,
      );
      for (const row of rows) {
        const { result, policy } = officialTaskBand(set, { kind: row.kind, priority: row.priority, phaseCode: row.phase_code, unitPath: row.unit_path, step: stepLadderOf(row) }, row.due_on, { today: context.today, calendars });
        if ((result.band !== 'YELLOW' && result.band !== 'RED') || result.remainingDays === null) continue;
        const wording = pwfDeadlineBand.deadlineWording(result);
        const escalated = pwfDeadlineBand.shouldEscalate({ remaining: result.remainingDays, escalateAfterOverdueDays: policy.escalate_after_overdue_days });
        const days = wording.days ?? 0;
        const title =
          wording.kind === 'OVERDUE_DAYS'
            ? message('home.source.pwf.overall.overdue.title', { days })
            : wording.kind === 'OVERDUE'
              ? message('home.source.pwf.overall.overdue_now.title')
              : wording.kind === 'DUE_TODAY'
                ? message('home.source.pwf.overall.due_today.title')
                : wording.kind === 'NO_DAY_LEFT'
                  ? message('home.source.pwf.overall.no_day_left.title')
                  : message('home.source.pwf.overall.due_soon.title', { days });
        items.push({
          ...base('PWF_OVERALL_DEADLINE_AT_RISK'),
          id: `${row.workflow_id}:overall`,
          dueOn: row.due_on,
          originalDueOn: row.baseline_on ?? row.due_on,
          title,
          // Names only: the project, the task that carries the deadline and the day.
          subtitle: message('home.source.pwf.overall.detail', { project: projectNamed(row), task: row.name, date: row.due_on }),
          status: result.overdue ? 'OVERDUE' : result.band === 'RED' ? 'DUE_TODAY' : 'AT_RISK',
          // The house mapping of the colours of a task (YELLOW to watch, RED to act on), and the one of a task past its day.
          severity: severityOf('PROJECT_TASK', result.overdue ? (escalated ? 'OVERDUE_ESCALATED' : 'OVERDUE') : result.band, context.rules),
          lifecycle: 'NEW',
          consequence: CONSEQUENCES.PWF_OVERALL_DEADLINE_AT_RISK ?? null,
          causeKey: `pwf-overall:${row.workflow_id}`,
          startedAt: result.overdue ? startOfDay(addDays(row.due_on, 1)) : null,
          target: { screen: 'PWF-03', id: row.project_id },
        });
        if (items.length >= SOURCE_LIMIT) return items;
      }
      const last = rows[rows.length - 1];
      if (rows.length < SOURCE_LIMIT || last === undefined) return items;
      after = { day: last.due_on, id: last.id };
    }
    throw new Error('PROJECT_TASK_SCAN_INCOMPLETE');
  }

  /**
   * `PWF_TASK_UNCLAIMED` (PWF-5, R71; owner: the people of the unit that receives the task): a task of a running workflow that a unit receives, still open, tracked and in the project, for which the ledger of assignments names
   * nobody responsible today. One item per task (`<task>:unclaimed`); it is read from the rows as they are, so it leaves the list in the very transaction that gives the task to somebody ("Nhận việc" or the ledger), is paused,
   * done or cancelled. To be watched, and to be acted on from the day the task is planned to start (its official start, R49). In the view `mine` it is the work of the people of the receiving unit, by the rule of "Nhận việc"
   * (`unitGrantSql`: a grant in force over that unit or a subtree that contains it, never the whole tenant); as everywhere, only inside the projects the reader may read (being named on a task opens no project). The read is
   * bounded by the limit of a source and uses `project_task_receiving_unit_idx`.
   */
  private async unclaimedTasks(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, {
      source: 'PROJECT_TASK',
      id: `(t.id::text || ':unclaimed')`,
      tenant: 't',
      responsible: [],
      unit: false,
      // The instant is a parameter only when the view needs it (a parameter no part of the statement mentions cannot be typed by the database).
      mine: (me) => unitGrantSql({ me, at: `${params.add(context.now.toISOString())}::timestamptz`, tenant: 't.tenant_id', unitId: 'ru.id', unitPath: 'ru.path' }),
    });
    const rows = await context.tx.query<{ id: string; name: string; starts_on: string | null; unit_name: string; project_id: string; project_code: string; project_name: string | null }>(
      `select t.id, t.name, coalesce(t.committed_start, t.planned_start)::text as starts_on, ru.name as unit_name, p.id as project_id, p.code as project_code, p.name as project_name
         from machvon.project_task t
         join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id and w.status = 'ACTIVE'
         join machvon.organization_unit ru on ru.tenant_id = t.tenant_id and ru.id = t.receiving_unit_id
         ${PROJECT_JOINS('t', 't.project_id')}
        where t.receiving_unit_id is not null and t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD')
          and not ${responsibleHeldSql('t', today)} and ${visible}
        order by coalesce(t.committed_start, t.planned_start) nulls last, t.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row): SourceRow => {
      const started = row.starts_on !== null && row.starts_on <= context.today;
      const day = row.starts_on ?? context.today;
      return {
        ...base('PWF_TASK_UNCLAIMED'),
        id: `${row.id}:unclaimed`,
        dueOn: day,
        originalDueOn: day,
        // Names only: the task, the project and the unit, never a code.
        title: message('home.source.pwf.unclaimed.title', { task: row.name }),
        subtitle: message(started ? 'home.source.pwf.unclaimed.detail.started' : 'home.source.pwf.unclaimed.detail', { project: projectNamed(row), unit: row.unit_name, ...(started ? { date: day } : {}) }),
        status: started ? 'DUE_TODAY' : 'DUE_SOON',
        severity: severityOf('PROJECT_TASK', started ? 'UNCLAIMED_STARTED' : 'UNCLAIMED', context.rules),
        lifecycle: 'NEW',
        consequence: CONSEQUENCES.PWF_TASK_UNCLAIMED ?? null,
        causeKey: `pwf-task-unclaimed:${row.id}`,
        startedAt: started ? startOfDay(day) : null,
        target: { screen: 'PWF-04', id: row.id },
      };
    });
  }

  /**
   * `PWF_LEGAL_BASIS_LAPSED` (PWF-4, R45; owner: the one who answers for the project): a running workflow cites, on a step or a task of its frozen template, a document the shared catalogue says has expired or was replaced. One
   * item per workflow and document (`<workflow>:<document>`, the id the decisions of people name: taking the item up or handing it over keeps it theirs), however many steps and tasks cite the document. The catalogue is read first: when
   * no document of it has lapsed nothing is asked of the workflows at all.
   */
  private async lapsedLegalGrounds(context: SourceContext): Promise<SourceRow[]> {
    const catalogue = await new PwfAssignmentReads().legalDocuments(context.tx, context.today);
    const lapsed = [...catalogue.values()].filter((document) => legalDocument.isLapsed(document.state));
    if (lapsed.length === 0) return [];
    const params = new Params();
    const codes = params.add(lapsed.map((document) => document.code));
    const visible = reach(params, context, { source: 'PROJECT_TASK', id: `(w.id::text || ':' || d.code)`, tenant: 'w', responsible: [], unit: false });
    const rows = await context.tx.query<{ workflow_id: string; code: string; project_id: string; project_code: string; project_name: string | null }>(
      `select w.id as workflow_id, d.code, p.id as project_id, p.code as project_code, p.name as project_name
         from machvon.project_workflow w
         cross join lateral (select distinct cited as code from unnest(w.cited_legal_documents) as cited) d
         ${PROJECT_JOINS('w', 'w.project_id')}
        where w.status = 'ACTIVE' and w.cited_legal_documents && ${codes}::text[] and d.code = any(${codes}::text[]) and ${visible}
        order by p.code, d.code limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map((row): SourceRow => {
      const document = catalogue.get(row.code) as NonNullable<ReturnType<typeof catalogue.get>>;
      const since = document.effectiveTo ?? context.today;
      return {
        ...base('PWF_LEGAL_BASIS_LAPSED'),
        id: `${row.workflow_id}:${row.code}`,
        dueOn: since,
        originalDueOn: since,
        // The words a person reads carry names only (the number of the document, the name of the project): no code of a document or of a project.
        title: message('home.source.pwf.legal.title', { document: document.number }),
        subtitle:
          document.supersededBy === null
            ? message('home.source.pwf.legal.detail', { project: projectNamed(row), date: since })
            : message('home.source.pwf.legal.detail.replaced', { project: projectNamed(row), replacement: catalogue.get(document.supersededBy)?.number ?? document.supersededBy }),
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
  private async chunkAfter(context: SourceContext, horizon: string | null, after: { day: string; id: string } | null): Promise<DueTaskSql[]> {
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
    // A task with a ladder of its own (R73) is bounded by its own green line, not by the widest line of the policies: it may turn green earlier than any of them.
    const until = horizon === null ? '' : `and ${withinGreenLine('t', 't.committed_finish', params.add(horizon), params.add(context.today))}`;
    const past = after === null ? '' : `and (t.committed_finish, t.id) > (${params.add(after.day)}::date, ${params.add(after.id)}::uuid)`;
    return context.tx.query<DueTaskSql>(
      `select t.id, t.schedule_version, t.task_code, t.name, t.phase_code, t.kind, t.priority, t.critical, t.committed_finish::text as due_on, t.baseline_finish::text as baseline_on, p.id as project_id, p.code as project_code, p.name as project_name, ou.path as unit_path, ${bandColumnsOf('t')}
         from machvon.project_task t
         join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id and w.status = 'ACTIVE'
         ${PROJECT_JOINS('t', 't.project_id')}
        where t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS') and t.committed_finish is not null ${until} ${past} and ${OPEN_WORK} and ${visible}
        order by t.committed_finish, t.id limit ${SOURCE_LIMIT}`,
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
      const rows: DueTaskSql[] = await this.chunkAfter(context, horizon, after);
      for (const row of rows) {
        // R73: the one resolution of the official colour (the ladder of the task itself, then the policy in force); when a task goes up for being overdue is still the policy's.
        const { result, policy } = officialTaskBand(set, { kind: row.kind, priority: row.priority, phaseCode: row.phase_code, unitPath: row.unit_path, step: stepLadderOf(row) }, row.due_on, { today: context.today, calendars });
        // No colour yet (far), or none can be given (the calendar of the year is not published): not a thing to act on today.
        if (result.band === 'NONE' || result.band === 'UNKNOWN' || result.remainingDays === null) continue;
        items.push(this.itemOf(context, row, result, pwfDeadlineBand.shouldEscalate({ remaining: result.remainingDays, escalateAfterOverdueDays: policy.escalate_after_overdue_days })));
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

  private itemOf(context: SourceContext, row: TaskSql, result: pwfDeadlineBand.DeadlineBandResult, escalated: boolean): SourceRow {
    // R49: the words follow the one wording of the kernel, so the alert, the board and the phone say the same of the same deadline. Overdue is the day of the deadline having passed, not a count below zero: over a weekend after
    // the deadline no working day of lateness is counted yet, and the task is overdue all the same (never "due today").
    const band = result.band as pwfDeadlineBand.BandColor;
    const wording = pwfDeadlineBand.deadlineWording(result);
    const overdue = result.overdue;
    const kind: WorkKind = overdue ? 'PWF_TASK_OVERDUE' : 'PWF_TASK_DUE_SOON';
    const facet = overdue ? (escalated ? 'OVERDUE_ESCALATED' : 'OVERDUE') : band;
    const days = wording.days ?? 0;
    // A short title a phone shows whole: the NAME of the task and what its deadline says; the project is the second line, by its name. No code of a task, of a phase or of a project is in the words (owner review of 14/11/2026).
    const named = { task: row.name };
    // A milestone that is listed has nothing open before it: it waits to be recorded, and the words say that, not that somebody is late with work.
    const milestone = row.kind === 'MILESTONE';
    const title =
      milestone && wording.kind === 'OVERDUE_DAYS'
        ? message('home.source.pwf.milestone.unrecorded.title', { ...named, days })
        : milestone && wording.kind === 'OVERDUE'
          ? message('home.source.pwf.milestone.unrecorded_now.title', named)
          : wording.kind === 'OVERDUE_DAYS'
        ? message(escalated ? 'home.source.pwf.overdue.escalated.title' : 'home.source.pwf.overdue.title', { ...named, days })
        : wording.kind === 'OVERDUE'
          ? message('home.source.pwf.overdue_now.title', named)
          : wording.kind === 'DUE_TODAY'
            ? message('home.source.pwf.due_today.title', named)
            : wording.kind === 'NO_DAY_LEFT'
              ? message('home.source.pwf.no_day_left.title', named)
              : message('home.source.pwf.due_soon.title', { ...named, days });
    return {
      ...base(kind),
      id: `${row.id}:${row.schedule_version}`,
      dueOn: row.due_on,
      originalDueOn: row.baseline_on ?? row.due_on,
      title,
      subtitle: message(row.critical ? 'home.source.pwf.detail.critical' : 'home.source.pwf.detail', { project: projectNamed(row) }),
      status: overdue ? 'OVERDUE' : band === 'RED' ? 'DUE_TODAY' : 'DUE_SOON',
      severity: severityOf('PROJECT_TASK', facet, context.rules),
      lifecycle: 'NEW',
      consequence: CONSEQUENCES[kind] ?? null,
      causeKey: `pwf-task:${row.id}`,
      startedAt: overdue ? startOfDay(addDays(row.due_on, 1)) : null,
      target: { screen: 'PWF-04', id: row.id },
    };
  }

  /** The milestones of running workflows whose forecast day is past their official day (the schedule last released, R49) or the day of the first baseline, or that sit on the critical path with their float spent (BR-PWF-25), for the one who answers for the project. */
  private async milestonesAtRisk(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const today = params.add(context.today);
    const visible = reach(params, context, { source: 'PROJECT_TASK', id: `(t.id::text || ':' || t.schedule_version::text || ':risk')`, tenant: 't', responsible: [], unit: false });
    const rows = await context.tx.query<TaskSql & { slip: number; forecast_on: string }>(
      `select t.id, t.schedule_version, t.task_code, t.name, t.phase_code, t.kind, t.priority, t.critical, t.committed_finish::text as due_on, t.baseline_finish::text as baseline_on, t.planned_finish::text as forecast_on, p.id as project_id, p.code as project_code, p.name as project_name, ou.path as unit_path,
              (t.planned_finish - t.baseline_finish) as slip
         from machvon.project_task t
         join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id and w.status = 'ACTIVE'
         ${PROJECT_JOINS('t', 't.project_id')}
        where t.kind = 'MILESTONE' and t.tracked and not t.excluded and t.status in ('NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL') and t.planned_finish is not null and t.committed_finish is not null and t.baseline_finish is not null
          and (t.planned_finish > t.baseline_finish or t.planned_finish > t.committed_finish or (t.critical and coalesce(t.total_float, 0) < 0)) and t.committed_finish <= ${today}::date + ${MILESTONE_AHEAD_DAYS} and ${visible}
        order by t.committed_finish, t.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    return rows.map(
      (row): SourceRow => ({
        ...base('PWF_MILESTONE_AT_RISK'),
        id: `${row.id}:${row.schedule_version}:risk`,
        dueOn: row.due_on,
        originalDueOn: row.baseline_on ?? row.due_on,
        title: message('home.source.pwf.milestone.title', { task: row.name, days: Math.max(0, Number(row.slip)) }),
        subtitle: message('home.source.pwf.milestone.detail', { project: projectNamed(row), baseline: row.baseline_on ?? row.due_on, date: row.forecast_on }),
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

/**
 * A milestone is not work somebody does: it is reached when what stands before it is done (lane fix11). While a task before it is still open, that task is the thing to act on and carries the alert; the milestone
 * is not listed beside it as one more overdue task with the same day (its slip is the alert of the one who answers for the project, `PWF_MILESTONE_AT_RISK`). A milestone with nothing open before it only waits to
 * be recorded: it is listed, in its own words. Its day is the committed one, as for a task (R49).
 */
const OPEN_WORK = `(t.kind <> 'MILESTONE' or not exists (
          select 1 from machvon.project_task_dependency dep
            join machvon.project_task before on before.tenant_id = dep.tenant_id and before.id = dep.predecessor_id
           where dep.tenant_id = t.tenant_id and dep.task_id = t.id and before.tracked and not before.excluded and before.status not in ('DONE', 'CANCELLED')))`;

/** A task of the list of due tasks: with the ladder of its own, when the frozen template gave it one (R73). */
type DueTaskSql = TaskSql & TaskBandColumns;

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
  project_name: string | null;
  unit_path: string | null;
}

/** The project as a person names it: its name, and its code only when it has no name to show. */
function projectNamed(row: { project_name: string | null; project_code: string }): string {
  const name = row.project_name?.trim() ?? '';
  return name === '' ? row.project_code : name;
}
