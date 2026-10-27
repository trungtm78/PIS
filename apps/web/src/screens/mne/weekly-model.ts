import type { ObligationView, ReportField, ReportView } from './types';

/** The form of the weekly quick report (CV 3665/BTC-PTHT [CXN-11]). */
export const WEEKLY_FORM_CODE = 'CV3665-WEEKLY';

/** The weekly obligations of a year, the latest due date first: what the week picker offers. */
export function weeksOf(items: readonly ObligationView[]): ObligationView[] {
  return items.filter((item) => item.formCode === WEEKLY_FORM_CODE).sort((left, right) => right.dueDate.localeCompare(left.dueDate) || right.periodLabel.localeCompare(left.periodLabel));
}

/** The week the screen opens on: the latest one that is due by today (the one the person is most likely to be writing or reading), the earliest of the year when none is due yet, none without weeks. */
export function defaultWeek(weeks: readonly ObligationView[], today: string): ObligationView | undefined {
  return weeks.find((week) => week.dueDate <= today) ?? weeks[weeks.length - 1];
}

/** The two rates of DIS-19 and the sums they are made of, as the report holds them (null where the report has no figure: a rate is never made zero). */
export interface PairedRates {
  pm: string | null;
  total: string | null;
  plan: string | null;
  disbursed: string | null;
}

const metricOf = (report: Pick<ReportView, 'fields'>, metric: string): string | null => {
  const found = report.fields.find((field) => field.source?.kind === 'SNAPSHOT_METRIC' && field.source.detail === metric);
  return found === undefined || found.value === null ? null : String(found.value);
};

export function pairedRates(report: Pick<ReportView, 'fields'>): PairedRates {
  return { pm: metricOf(report, 'rate_pm_pct'), total: metricOf(report, 'rate_total_pct'), plan: metricOf(report, 'plan_total_vnd'), disbursed: metricOf(report, 'disbursed_treasury_vnd') };
}

/** The slow projects, one line each as the server wrote them; null when the form has no such cell or it holds nothing yet. */
export function slowLines(report: Pick<ReportView, 'fields'>): string[] | null {
  const found = report.fields.find((field) => field.source?.kind === 'SLOW_PROJECTS');
  if (found === undefined || found.value === null || String(found.value).trim() === '') return null;
  return String(found.value)
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/** The report that stands for the week: the latest revision of the chain (a correction supersedes the report the calendar lists, and what it says is what the week reports). Its own id when it is the latest or has no history. */
export function currentRevisionId(report: Pick<ReportView, 'id' | 'history'>): string {
  const latest = report.history.reduce<{ id: string; revision: number } | undefined>((best, entry) => (best === undefined || entry.revision > best.revision ? entry : best), undefined);
  return latest === undefined ? report.id : latest.id;
}

export interface Proposal {
  key: string;
  label: string;
  text: string;
}

/** The text cells that a person writes (the proposals of the week), the empty ones left out. */
export function proposalsOf(report: Pick<ReportView, 'fields'>): Proposal[] {
  return report.fields
    .filter((field: ReportField) => field.kind === 'TEXT' && field.source === null && field.value !== null && String(field.value).trim() !== '')
    .map((field) => ({ key: field.key, label: field.label, text: String(field.value) }));
}
