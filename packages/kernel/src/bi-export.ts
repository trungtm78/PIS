import { DomainError } from './errors.ts';
import { message, messagesUnder } from './messages.ts';
import type { ExportColumn, ExportDocument, ExportHeaderEntry } from './dis-export.ts';

/** The most rows (groups) one export holds: a larger answer is refused, never cut (BI.md BR-BI-09, an assumption of the first release). */
export const BI_EXPORT_ROW_CAP = 100_000;
/** A file of an export is offered for this many days, and then the job is EXPIRED. */
export const BI_EXPORT_TTL_DAYS = 7;
/** The link that is given to download a file lives this long (the files service never gives a longer one). */
export const BI_EXPORT_LINK_SECONDS = 300;
export const BI_EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export type BiExportFormat = (typeof BI_EXPORT_FORMATS)[number];
export const BI_SCHEDULE_FORMATS = ['CSV', 'XLSX', 'PDF', 'LINK_ONLY'] as const;
export type BiScheduleFormat = (typeof BI_SCHEDULE_FORMATS)[number];
export const BI_SCHEDULE_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const BI_SCHEDULE_MAX_RECIPIENTS = 500;

/** The name of a dimension in the header of a file (the screens name them in their own language files). */
export const BI_DIMENSION_LABELS: Readonly<Record<string, string>> = messagesUnder('bi.export.dimension');

// ---- the cron of a schedule ---------------------------------------------------------------------------------------------------------------

interface Field {
  name: string;
  min: number;
  max: number;
}

const FIELDS: readonly Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
];

export interface Cron {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Whether the day of the month and the weekday were both written: then a day matches when either does, as in cron. */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const invalid = (detail: string): DomainError => new DomainError('CRON_INVALID', 409, detail);
const WHOLE = /^\d{1,2}$/;

function expand(text: string, field: Field): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', step, extra] = part.split('/');
    if (extra !== undefined || range === '' || (step !== undefined && !WHOLE.test(step))) throw invalid(field.name);
    const stride = step === undefined ? 1 : Number(step);
    if (stride < 1) throw invalid(field.name);
    let from: number;
    let to: number;
    if (range === '*') {
      from = field.min;
      to = field.name === 'weekday' ? 6 : field.max;
    } else {
      const [low = '', high, more] = range.split('-');
      if (more !== undefined || !WHOLE.test(low) || (high !== undefined && !WHOLE.test(high))) throw invalid(field.name);
      from = Number(low);
      to = high === undefined ? (step === undefined ? from : field.max) : Number(high);
    }
    if (from < field.min || to > field.max || from > to) throw invalid(field.name);
    for (let value = from; value <= to; value += stride) values.add(field.name === 'weekday' && value === 7 ? 0 : value);
  }
  return values;
}

/** The five fields of a cron (minute, hour, day of the month, month, weekday), with lists, ranges and steps; anything else is 409 `CRON_INVALID` naming the field. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) throw invalid('expression');
  const sets = parts.map((part, index) => expand(part, FIELDS[index] as Field));
  return {
    minutes: sets[0] as Set<number>,
    hours: sets[1] as Set<number>,
    days: sets[2] as Set<number>,
    months: sets[3] as Set<number>,
    weekdays: sets[4] as Set<number>,
    // A field that begins with a star is a wildcard, with or without a step (`*/2`): only a field written otherwise narrows the days.
    dayRestricted: !(parts[2] as string).startsWith('*'),
    weekdayRestricted: !(parts[4] as string).startsWith('*'),
  };
}

interface Local {
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Whether a name is a time zone this process knows. */
export function knownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function localOf(instant: Date, formatter: Intl.DateTimeFormat): Local {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return { month: Number(parts.month), day: Number(parts.day), weekday: WEEKDAYS[parts.weekday as string] as number, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

const MINUTE = 60_000;
/** A schedule that names a day that never comes (the 31st of February) has no next time: the search stops after this many years. */
const SEARCH_YEARS = 5;

/** The first minute after `after` the cron fires, in the zone given; none within five years is undefined. */
export function nextFire(cron: Cron, after: Date, timezone: string = BI_SCHEDULE_TIMEZONE): Date | undefined {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric' });
  let at = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE;
  const stop = at + SEARCH_YEARS * 366 * 24 * 60 * MINUTE;
  while (at < stop) {
    const local = localOf(new Date(at), formatter);
    const dayMatches = cron.dayRestricted && cron.weekdayRestricted ? cron.days.has(local.day) || cron.weekdays.has(local.weekday) : cron.days.has(local.day) && cron.weekdays.has(local.weekday);
    if (!cron.months.has(local.month) || !dayMatches) {
      // Not a day of the schedule: on to the start of the next local day.
      at += (24 * 60 - local.hour * 60 - local.minute) * MINUTE;
    } else if (!cron.hours.has(local.hour)) {
      at += (60 - local.minute) * MINUTE;
    } else if (!cron.minutes.has(local.minute)) {
      at += MINUTE;
    } else {
      return new Date(at);
    }
  }
  return undefined;
}

/** Whether a schedule that last ran at `lastRun` (or was made then) is due at `now`: its next time after that has come. */
export function scheduleDue(cron: Cron, lastRun: Date, now: Date, timezone: string = BI_SCHEDULE_TIMEZONE): boolean {
  const next = nextFire(cron, lastRun, timezone);
  return next !== undefined && next.getTime() <= now.getTime();
}

// ---- the file ------------------------------------------------------------------------------------------------------------------------

export interface BiExportInput {
  metricCode: string;
  metricRevision: number;
  unit: string;
  /** The dimension the answer is cut by, with its label; none for a single figure. */
  dimension: { code: string; label: string } | undefined;
  asOfPeriod: string;
  datasetVersionId: string;
  scopeDescription: string;
  generatedAt: Date;
  rows: ReadonlyArray<{ key: string | null; label: string | null; value: string | null; numerator: string | null; denominator: string | null; nullReason: string | null }>;
  total: { value: string | null; numerator: string | null; denominator: string | null; nullReason: string | null };
}

const COLUMNS = (dimensionLabel: string): readonly ExportColumn[] => [
  { key: 'group_key', label: message('bi.export.column.group_key'), numeric: false },
  { key: 'group_label', label: dimensionLabel, numeric: false },
  { key: 'value', label: message('bi.export.column.value'), numeric: true },
  { key: 'numerator', label: message('bi.export.column.numerator'), numeric: true },
  { key: 'denominator', label: message('bi.export.column.denominator'), numeric: true },
  { key: 'null_reason', label: message('bi.export.column.null_reason'), numeric: false },
];

/**
 * The file of an export: a header that says what the figures are (the scope the reader was given, the period, the version of the dataset, the metric by its revision, when), then the groups of the answer and the total.
 * A figure that cannot be given is empty with its reason, never zero. A cell that begins like a formula is quoted when the file is made (CSV).
 */
export function buildBiExportDocument(input: BiExportInput): ExportDocument {
  const header: ExportHeaderEntry[] = [
    { key: 'metric', label: message('bi.export.header.metric'), value: message('bi.export.header.metric_value', { code: input.metricCode, revision: input.metricRevision, unit: input.unit }) },
    { key: 'scope', label: message('bi.export.header.scope'), value: input.scopeDescription },
    { key: 'as_of_period', label: message('bi.export.header.as_of_period'), value: input.asOfPeriod },
    { key: 'snapshot', label: 'Snapshot', value: input.datasetVersionId },
    ...(input.dimension === undefined ? [] : [{ key: 'dimension', label: message('bi.export.header.dimension'), value: input.dimension.label }]),
    { key: 'generated_at', label: message('bi.export.header.generated_at'), value: input.generatedAt.toISOString() },
  ];
  const cells = (key: string, label: string, figure: { value: string | null; numerator: string | null; denominator: string | null; nullReason: string | null }): string[] => [
    key,
    label,
    figure.value ?? '',
    figure.numerator ?? '',
    figure.denominator ?? '',
    figure.nullReason ?? '',
  ];
  const rows = input.rows.map((row) => cells(row.key ?? '', row.label ?? row.key ?? message('bi.export.row.unclassified'), row));
  rows.push(cells('', message('bi.export.row.total'), input.total));
  return { title: message('bi.export.title', { code: input.metricCode }), header, columns: COLUMNS(input.dimension?.label ?? message('bi.export.default_dimension')), rows, notice: null };
}
