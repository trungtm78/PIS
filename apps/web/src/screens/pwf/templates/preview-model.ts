import { dayText } from '../model';
import type { SchedulePreview } from '../model';
import type { GanttRow } from '../workflow/model';
import { linesOf } from './table-model';
import type { Template } from './template-model';

/**
 * The diagram of PWF-02 is the server's answer to "what would this procedure look like on a sample start day" (R56, R74): the browser only draws it. This file turns that answer into the rows of the Gantt the
 * project screens already use, in the order of the table, and into the notes that say how far the dates can be trusted (a draft calendar, a year without one). It never counts a date.
 */

export interface DiagramWords {
  /** "tạm tính" at the end of a bar whose dates lean on a draft calendar. */
  provisional: string;
  /** Why a row has no bar: the first year that has no calendar. */
  missingYear: (year: number) => string;
  /** A branch the sample facts leave out of the project. */
  notInProject: string;
}

export interface Diagram {
  rows: GanttRow[];
  phases: { code: string; name: string; order: number }[];
  /** The line of the deadline of the whole file: the day the marked row finishes; absent when the template marks none or the row is not dated. */
  overall: { day: string; row: string } | undefined;
  /** Years the dates rest on a draft calendar for, each with the version used. */
  provisionalYears: { year: number; version: number }[];
  /** Years that have no calendar at all: the rows that need them have no bar. */
  missingYears: number[];
  /** The preview was asked to count on draft calendars and at least one date did. */
  provisional: boolean;
}

export function diagramOf(preview: SchedulePreview, template: Template, words: DiagramWords): Diagram {
  const byCode = new Map(preview.tasks.map((task) => [task.task_code, task]));
  const lines = linesOf(template).flatMap((line) => line.taskIndexes.map((index) => ({ line, task: template.tasks[index] })));
  const rows: GanttRow[] = [];
  const years = new Set<number>();
  let overall: Diagram['overall'];
  for (const { line, task } of lines) {
    if (task === undefined) continue;
    const found = byCode.get(task.code);
    if (found === undefined) continue;
    const dated = found.state !== 'CALENDAR_UNAVAILABLE' && found.start !== null && found.finish !== null;
    const reason = found.undated_reason ?? undefined;
    if (reason?.code === 'CALENDAR_MISSING' && typeof reason.year === 'number') years.add(reason.year);
    if (found.missing_year !== null && found.missing_year !== undefined) years.add(found.missing_year);
    const zones = found.band_zones ?? null;
    const row: GanttRow = {
      code: found.task_code,
      name: found.name,
      phase: found.phase_code,
      milestone: found.kind === 'MILESTONE',
      critical: found.critical,
      done: false,
      actual: dated ? { from: found.start as string, to: found.finish as string } : null,
      baseline: null,
      variance: null,
      zones: zones === null ? null : { green: zones.green_from, yellow: zones.yellow_from, red: zones.red_from },
      caption: line.number,
      ...(dated ? { due: `${dayText(found.finish)}${found.provisional === true ? ` · ${words.provisional}` : ''}` } : {}),
      ...(!dated && reason !== undefined ? { undated: reason.code === 'CALENDAR_MISSING' ? words.missingYear(reason.year ?? found.missing_year ?? 0) : words.notInProject } : {}),
      ...(found.is_overall_deadline === true ? { overall: true } : {}),
    };
    rows.push(row);
    if (found.is_overall_deadline === true && dated) overall = { day: found.finish as string, row: found.task_code };
  }
  if (overall === undefined && preview.overall_deadline?.finish !== null && preview.overall_deadline?.finish !== undefined) overall = { day: preview.overall_deadline.finish, row: preview.overall_deadline.task_code };
  const phases = template.phases.map((phase, order) => ({ code: phase.code, name: phase.name === '' ? phase.code : phase.name, order }));
  const provisionalYears = (preview.calendars ?? []).filter((calendar) => calendar.status === 'DRAFT').map((calendar) => ({ year: calendar.year, version: calendar.version }));
  return { rows, phases, overall, provisionalYears, missingYears: [...years].sort((a, b) => a - b), provisional: preview.provisional === true || provisionalYears.length > 0 };
}
