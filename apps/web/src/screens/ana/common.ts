/** Shared readers and formatters of the executive analytics screens (GOV-11b): every read model is parsed from `unknown`, a field that is not what is expected is absent, never a made-up value. */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
export const nullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
// A code such as LAND_CLEARANCE is looked up under the lower-camel key landClearance.
export const codeKey = (code: string): string => code.toLowerCase().replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Whole dong written with dots between the thousands ("1.234.567"); a value that is not a whole number gives the placeholder. */
export function vndText(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+$/.test(value)) return '—';
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/** The thousand million (billion) dong of a whole dong amount, for a chart axis only: the tables say the exact dong. */
export const billionsOf = (value: string): number => Number(value) / 1_000_000_000;

/** A decimal text of the server ("56.7") as the reader of Vietnamese writes it ("56,7"). */
export const commaText = (value: string | null | undefined): string => (value === null || value === undefined ? '—' : value.replace('.', ','));

/** The day `YYYY-MM-DD` as `DD/MM/YYYY`. */
export function dayText(day: string | null | undefined): string {
  if (day === null || day === undefined || !/^\d{4}-\d{2}-\d{2}/.test(day)) return '—';
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** What a figure is read by: the formula, the source and the day it was taken (the "i" of every number), and the version of the rule that decided. */
export interface AnaInfo {
  formula: string;
  source: string;
  asOf: string;
  ruleVersion: string;
  unverified: boolean;
}

export function toInfo(raw: unknown): AnaInfo | undefined {
  if (!isRecord(raw) || text(raw.formula) === '') return undefined;
  return { formula: text(raw.formula), source: text(raw.source), asOf: text(raw.as_of), ruleVersion: text(raw.rule_version), unverified: raw.unverified === true };
}
