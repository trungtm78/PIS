import { pwfSchedule, pwfWorkflow } from '@machvon/kernel';
import type { pwfDeadlineBand } from '@machvon/kernel';
import { WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { dateOf } from './prj-stage-support.ts';
import { PwfBandPolicies } from './pwf-band-policies.ts';
import { MAX_CALENDAR_YEARS, effectiveWorkingDaysOf } from './pwf-schedule-support.ts';
import type { PinnedCalendar } from './pwf-schedule-support.ts';
import { bandExplanationOf, officialTaskLadder } from './pwf-task-band.ts';
import type { BandExplanation, DurationView } from './pwf-task-band.ts';
import { PwfWorkflowStore } from './pwf-workflow-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Everything the chart of the screen that writes a workflow template draws (PWF section 22, R56, R66, R74): the server is the one owner of the dates, so the preview answers, beside the schedule, the limit and the working days
 * of each task, the ladder of its three colours with the tier that gave it and the days on which each colour starts, why a task has no date, the deadline of the whole file, the span of each step, and which calendar each year
 * was counted on.
 *
 * THE ONLY PLACE THAT READS A DRAFT CALENDAR. A preview in the mode `PROVISIONAL` counts a year nobody published yet on the latest draft of that year, and says so on everything it touches. Nothing here is ever stored, and no
 * command of a real project comes through this file: starting, adopting, rescheduling, progress and the recomputation when a year is published pin their calendars with `pinPublishedCalendars` (pwf-schedule-support.ts) alone.
 * A test reads the sources of the package and fails when another file names `pinProvisionalCalendars`.
 */

export const CALENDAR_MODES = ['PUBLISHED', 'PROVISIONAL'] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];
export type CalendarProvenance = 'PUBLISHED' | 'DRAFT';

export interface UsedCalendar {
  year: number;
  version: number;
  status: CalendarProvenance;
}

interface CalendarSql {
  year: number;
  revision: number;
  status: 'Published' | 'Draft';
  working_days: number[];
  holidays: Array<{ date: string; name?: string }>;
  compensated_workdays: string[] | null;
  legal_basis_ref: string;
}

const CALENDAR_COLUMNS = 'year, revision, status, working_days, holidays, compensated_workdays, legal_basis_ref';
const toPinned = (row: CalendarSql): PinnedCalendar => ({
  year: row.year,
  version: row.revision,
  content: { calendar_code: WORK_CALENDAR_CODE, year: row.year, working_days: row.working_days, holidays: row.holidays as never, compensated_workdays: row.compensated_workdays ?? [], legal_basis_ref: row.legal_basis_ref },
});

interface PreviewCalendars {
  /** The calendars of the line of working days: the years from the year of the start on, consecutive (a gap ends the list). */
  line: PinnedCalendar[];
  /** The calendar of the year before the start, when there is one: only the zones of the colours can reach back into it. */
  before: PinnedCalendar | null;
  status: Map<number, CalendarProvenance>;
}

/**
 * The calendars of a PROVISIONAL preview: for each year the published version when there is one, else the latest draft of that year (the highest revision still in the state `Draft`), else nothing. A superseded version is
 * never used.
 */
export async function pinProvisionalCalendars(tx: TenantTx, fromYear: number): Promise<PreviewCalendars> {
  const rows = await tx.query<CalendarSql>(
    `select distinct on (year) ${CALENDAR_COLUMNS}
       from machvon.work_calendar_version
      where calendar_code = $1 and status in ('Published', 'Draft') and year between $2::int and $3::int
      order by year, (status = 'Published') desc, revision desc`,
    [WORK_CALENDAR_CODE, fromYear - 1, fromYear + MAX_CALENDAR_YEARS],
  );
  const line: PinnedCalendar[] = [];
  let before: PinnedCalendar | null = null;
  const status = new Map<number, CalendarProvenance>();
  for (const row of rows) {
    if (row.year === fromYear - 1) before = toPinned(row);
    else if (row.year === fromYear + line.length) line.push(toPinned(row));
    else break;
    status.set(row.year, row.status === 'Published' ? 'PUBLISHED' : 'DRAFT');
  }
  return { line, before, status };
}

/** The calendars of a PUBLISHED preview beside the ones the schedule was laid on: the published calendar of the year before the start, for the zones alone. */
async function publishedBefore(tx: TenantTx, fromYear: number): Promise<PinnedCalendar | null> {
  const rows = await tx.query<CalendarSql>(`select ${CALENDAR_COLUMNS} from machvon.work_calendar_version where calendar_code = $1 and status = 'Published' and year = $2::int`, [WORK_CALENDAR_CODE, fromYear - 1]);
  return rows[0] === undefined ? null : toPinned(rows[0]);
}

export interface BandZonesView {
  green_from: string | null;
  yellow_from: string;
  red_from: string;
}

export type UndatedReason = { code: 'CALENDAR_MISSING'; year: number } | { code: 'NOT_IN_PROJECT' };

export interface PreviewTaskExtras extends BandExplanation {
  duration: DurationView | null;
  effective_working_days: number | null;
  provisional: boolean;
  band_zones: BandZonesView | null;
  undated_reason: UndatedReason | null;
  is_overall_deadline: boolean;
}

export interface PreviewStep {
  step_code: string;
  phase_code: string;
  name: string;
  start: string | null;
  finish: string | null;
  working_days: number | null;
  task_count: number;
  provisional: boolean;
  undated_reason: UndatedReason | null;
}

export interface PreviewOverallDeadline {
  task_code: string;
  finish: string | null;
  state: pwfSchedule.ScheduledState;
  provisional: boolean;
  band_zones: BandZonesView | null;
}

export interface TemplatePreview {
  result: pwfSchedule.ScheduleResult;
  excluded: string[];
  calendarMode: CalendarMode;
  /** At least one year the dates rely on was counted on a draft calendar. */
  provisional: boolean;
  /** Every year the dates and the zones rely on, with the version and whether it is published. */
  calendars: UsedCalendar[];
  tasks: Record<string, PreviewTaskExtras>;
  steps: PreviewStep[];
  overallDeadline: PreviewOverallDeadline | null;
}

const yearOf = (day: string): number => Number(day.slice(0, 4));
const zonesView = (zones: pwfSchedule.BandZones | null): BandZonesView | null => (zones === null ? null : { green_from: zones.greenFrom, yellow_from: zones.yellowFrom, red_from: zones.redFrom });

/**
 * The preview of a template for a project that would start on a day with these facts. In the mode `PUBLISHED` the schedule is the one `PwfWorkflowStore.previewTemplate` gives (the published calendars, what a real start would
 * be laid on); in `PROVISIONAL` a year without a published calendar is counted on its latest draft. The ladder of each task is resolved by the ONE resolution of the official colour (`officialTaskLadder`): the `bands` of the
 * task in the template being previewed (STEP), else the policy in force today for the whole tenant (POLICY_OVERRIDE, POLICY; a preview has no project, so no unit of its own), else the default of the source (SYSTEM).
 */
export async function previewWorkflowTemplate(
  tx: TenantTx,
  template: pwfWorkflow.ProjectWorkflowTemplate,
  plannedStart: string,
  facts: pwfWorkflow.ProjectFacts,
  mode: CalendarMode,
  today: string,
): Promise<TemplatePreview> {
  const day = dateOf(plannedStart, 'planned_start_date');
  const fromYear = yearOf(day);
  let result: pwfSchedule.ScheduleResult;
  let excluded: string[];
  let pinned: PreviewCalendars;
  if (mode === 'PROVISIONAL') {
    pinned = await pinProvisionalCalendars(tx, fromYear);
    result = pwfSchedule.scheduleProject({ tasks: pwfSchedule.tasksFromTemplate(template, facts), plannedStart: day, calendars: pinned.line });
    excluded = pwfWorkflow.activeTasks(template, facts).excluded;
  } else {
    // The very path a real start is laid on: the published calendars and nothing else.
    const planned = await new PwfWorkflowStore().previewTemplate(tx, template, day, facts);
    result = planned.result;
    excluded = planned.excluded;
    const before = await publishedBefore(tx, fromYear);
    pinned = { line: planned.calendars, before, status: new Map([...(before === null ? [] : [before]), ...planned.calendars].map((one) => [one.year, 'PUBLISHED'] as const)) };
  }
  const { status } = pinned;
  const calendars = [...(pinned.before === null ? [] : [pinned.before]), ...pinned.line];

  // The first draft year of the line of working days: every date laid in or after it was counted across a draft, so it is provisional (a date in a published year AFTER a draft year depends on the draft as much).
  const draftYears = [...status.entries()].filter(([, state]) => state === 'DRAFT').map(([year]) => year);
  const firstDraftOnLine = Math.min(...draftYears.filter((year) => year >= fromYear), Number.POSITIVE_INFINITY);
  const usedYears = new Set<number>();
  const touchesDraft = (days: ReadonlyArray<string | null>): boolean => {
    let found = false;
    for (const one of days) {
      if (one === null) continue;
      const year = yearOf(one);
      if (status.has(year)) usedYears.add(year);
      if (year >= firstDraftOnLine || status.get(year) === 'DRAFT') found = true;
    }
    return found;
  };

  const policies = await new PwfBandPolicies().load(tx, today);
  const byCode = new Map(template.tasks.map((one) => [one.code, one] as const));
  const overallCode = template.overallDeadlineTask ?? null;
  const tasks: Record<string, PreviewTaskExtras> = {};
  const zonesOf = new Map<string, { zones: BandZonesView | null; provisional: boolean }>();
  for (const scheduled of result.tasks) {
    const source = byCode.get(scheduled.code) as pwfWorkflow.TemplateTask;
    const ladder = officialTaskLadder(policies, { kind: source.kind, priority: source.priority, phaseCode: source.phase, unitPath: null, step: (source.bands ?? null) as pwfDeadlineBand.BandThresholds | null });
    const zones = scheduled.finish === null || scheduled.state === 'PASS_THROUGH' ? null : zonesView(pwfSchedule.bandZonesOf(scheduled.finish, ladder.thresholds, calendars));
    // A zone starts by counting working days back from the finish: every day between its earliest line and the finish was read.
    const earliest = zones === null ? null : [zones.green_from, zones.yellow_from, zones.red_from].filter((one): one is string => one !== null).sort()[0] ?? null;
    const provisional = touchesDraft([scheduled.start, scheduled.finish, earliest]);
    zonesOf.set(scheduled.code, { zones, provisional });
    tasks[scheduled.code] = {
      duration: source.duration === undefined || source.duration === null ? null : { value: source.duration.value, unit: source.duration.unit, roll_to_working_day: source.duration.rollToWorkingDay },
      effective_working_days: effectiveWorkingDaysOf(scheduled),
      provisional,
      ...bandExplanationOf(ladder),
      band_zones: zones,
      undated_reason: scheduled.state === 'PASS_THROUGH' ? { code: 'NOT_IN_PROJECT' } : scheduled.state === 'CALENDAR_UNAVAILABLE' ? { code: 'CALENDAR_MISSING', year: scheduled.missingYear ?? fromYear } : null,
      is_overall_deadline: scheduled.code === overallCode,
    };
  }

  const scheduledByCode = new Map(result.tasks.map((one) => [one.code, one] as const));
  const spans = pwfWorkflow.stepSpans(
    template,
    result.tasks.map((one) => ({ code: one.code, start: one.start, finish: one.finish, startSlot: one.startSlot, endSlot: one.endSlot, passThrough: one.state === 'PASS_THROUGH' })),
  );
  const names = new Map(pwfWorkflow.stepsOf(template).map((step) => [`${step.phase}\u0000${step.code}`, step.name] as const));
  const steps = spans.map((span): PreviewStep => {
    const mine = template.tasks.filter((task) => pwfWorkflow.stepCodeOf(template, task) === span.step && task.phase === span.phase).map((task) => scheduledByCode.get(task.code)).filter((one): one is pwfSchedule.ScheduledTask => one !== undefined && one.state !== 'PASS_THROUGH');
    // A step one of whose tasks has no calendar has no finish and no length: the part that could be dated is not the step (R32, never half a date).
    const missing = mine.find((one) => one.state === 'CALENDAR_UNAVAILABLE');
    return {
      step_code: span.step,
      phase_code: span.phase,
      name: names.get(`${span.phase}\u0000${span.step}`) ?? span.step,
      start: span.start,
      finish: missing === undefined ? span.finish : null,
      working_days: mine.length === 0 || missing !== undefined ? null : span.durationWorkingDays,
      task_count: span.taskCount,
      provisional: mine.some((one) => tasks[one.code]?.provisional === true),
      undated_reason: mine.length === 0 ? { code: 'NOT_IN_PROJECT' } : missing === undefined ? null : { code: 'CALENDAR_MISSING', year: missing.missingYear ?? fromYear },
    };
  });

  const overall = pwfSchedule.overallDeadlineOf(template, result.tasks);
  const overallDeadline: PreviewOverallDeadline | null =
    overall === null ? null : { task_code: overall.task, finish: overall.finish, state: overall.state, provisional: zonesOf.get(overall.task)?.provisional ?? false, band_zones: zonesOf.get(overall.task)?.zones ?? null };

  for (const one of result.calendarVersions) usedYears.add(one.year);
  const used = calendars.filter((one) => usedYears.has(one.year)).map((one): UsedCalendar => ({ year: one.year, version: one.version, status: status.get(one.year) ?? 'PUBLISHED' }));
  return { result, excluded, calendarMode: mode, provisional: used.some((one) => one.status === 'DRAFT'), calendars: used, tasks, steps, overallDeadline };
}
