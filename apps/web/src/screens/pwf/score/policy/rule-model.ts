/** What the two rule editors of the scoring (the KPI set, PWF-09, and the scoring policy, PWF-10) share: the problems a form can have, by the path of the field. */

export type RuleProblemKind = 'required' | 'pattern' | 'integer' | 'number' | 'range' | 'duplicate' | 'order' | 'listSize' | 'unknownRef' | 'sameValue' | 'lastBand';

export interface RuleProblem {
  path: string;
  kind: RuleProblemKind;
  min?: number;
  max?: number;
}

export type RuleProblems = readonly RuleProblem[];

export const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const WHOLE = /^-?\d{1,9}$/;
const DECIMAL = /^-?\d{1,9}(\.\d{1,4})?$/;

export const problemAt = (problems: RuleProblems, path: string): RuleProblem | undefined => problems.find((one) => one.path === path);

export function codeProblem(path: string, value: string, optional = false): RuleProblem | undefined {
  const text = value.trim();
  if (text === '') return optional ? undefined : { path, kind: 'required' };
  return CODE.test(text) ? undefined : { path, kind: 'pattern' };
}

/** A whole number in a range; empty is `required` unless optional. */
export function wholeProblem(path: string, value: string, min: number, max: number, optional = false): RuleProblem | undefined {
  const text = value.trim();
  if (text === '') return optional ? undefined : { path, kind: 'required' };
  if (!WHOLE.test(text)) return { path, kind: 'integer' };
  const number = Number(text);
  return number < min || number > max ? { path, kind: 'range', min, max } : undefined;
}

/** A decimal number (comma or point) in a range. */
export function numberProblem(path: string, value: string, min: number, max: number, optional = false): RuleProblem | undefined {
  const text = value.trim().replace(',', '.');
  if (text === '') return optional ? undefined : { path, kind: 'required' };
  if (!DECIMAL.test(text)) return { path, kind: 'number' };
  const number = Number(text);
  return number < min || number > max ? { path, kind: 'range', min, max } : undefined;
}

/** The number a text says; the empty text is no number (NaN), never a silent zero. */
export function numberOf(value: string): number {
  const text = value.trim().replace(',', '.');
  return text === '' ? Number.NaN : Number(text);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
export const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const numberText = (value: unknown): string => (typeof value === 'number' ? String(value) : '');
export const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
export const oneOf = <T extends string>(options: readonly T[], value: unknown, fallback: T): T => options.find((option) => option === value) ?? fallback;
export const codeList = (text: string): string[] => text.split(/[\s,;]+/).filter((item) => item !== '');
export const stringsOf = (value: unknown): string => arrayOf(value).filter((item): item is string => typeof item === 'string').join(', ');
