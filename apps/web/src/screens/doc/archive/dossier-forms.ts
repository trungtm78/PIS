import type { FieldProblem } from './rules';
import type { RetentionRule } from './types';

/**
 * The rules of the forms that make a dossier, put a document into it and close it (DOC F11). They repeat the rules of the server (`DocDossierCreate`, `DocDossierItem`, `DocDossierClose`) so that the person is told before sending;
 * the server judges again and a refusal is shown. Days are `YYYY-MM-DD`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY = /^[A-Z][A-Z0-9_]{1,59}$/;
const MODULE = /^[A-Za-z][A-Za-z0-9_]{1,9}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DOSSIER_LIMITS = { code: { min: 3, max: 80 }, title: { min: 3, max: 500 }, year: { min: 2000, max: 2100 } } as const;

export interface DossierCreateForm {
  dossierCode: string;
  year: string;
  title: string;
  unitId: string;
  categoryCode: string;
  subjectModule: string;
  subjectId: string;
}

export const emptyDossierCreate = (year: number): DossierCreateForm => ({ dossierCode: '', year: String(year), title: '', unitId: '', categoryCode: '', subjectModule: '', subjectId: '' });

export type DossierCreateProblems = Partial<Record<keyof DossierCreateForm, FieldProblem>>;

function lengthProblem(value: string, min: number, max: number): FieldProblem | undefined {
  const length = value.trim().length;
  if (length === 0) return 'required';
  if (length < min) return 'tooShort';
  if (length > max) return 'tooLong';
  return undefined;
}

export function validateDossierCreate(form: DossierCreateForm): DossierCreateProblems {
  const year = Number(form.year);
  const subject = form.subjectModule.trim() !== '' || form.subjectId.trim() !== '';
  return {
    dossierCode: lengthProblem(form.dossierCode, DOSSIER_LIMITS.code.min, DOSSIER_LIMITS.code.max),
    year: form.year.trim() === '' ? 'required' : !Number.isInteger(year) || year < DOSSIER_LIMITS.year.min || year > DOSSIER_LIMITS.year.max ? 'invalid' : undefined,
    title: lengthProblem(form.title, DOSSIER_LIMITS.title.min, DOSSIER_LIMITS.title.max),
    unitId: form.unitId === '' ? 'required' : UUID.test(form.unitId) ? undefined : 'invalid',
    categoryCode: form.categoryCode.trim() === '' ? 'required' : CATEGORY.test(form.categoryCode.trim()) ? undefined : 'invalid',
    // The subject is a module and an id together, or neither.
    subjectModule: subject ? (form.subjectModule.trim() === '' ? 'required' : MODULE.test(form.subjectModule.trim()) ? undefined : 'invalid') : undefined,
    subjectId: subject ? (form.subjectId.trim() === '' ? 'required' : UUID.test(form.subjectId.trim()) ? undefined : 'invalid') : undefined,
  };
}

export const dossierCreateHasProblems = (problems: DossierCreateProblems): boolean => Object.values(problems).some((problem) => problem !== undefined);

export function dossierCreateBody(form: DossierCreateForm): Record<string, unknown> {
  const subject = form.subjectModule.trim() !== '';
  return {
    dossier_code: form.dossierCode.trim(),
    year: Number(form.year),
    title: form.title.trim(),
    organization_unit_id: form.unitId,
    category_code: form.categoryCode.trim(),
    ...(subject ? { subject_module: form.subjectModule.trim(), subject_id: form.subjectId.trim().toLowerCase() } : {}),
  };
}

// ---- a document into a dossier ---------------------------------------------------------------------------------------------

export interface ItemForm {
  documentId: string;
  ordinal: string;
}
export const EMPTY_ITEM: ItemForm = { documentId: '', ordinal: '' };
export type ItemProblems = Partial<Record<keyof ItemForm, FieldProblem>>;

export function validateItem(form: ItemForm): ItemProblems {
  const ordinal = Number(form.ordinal);
  return {
    documentId: form.documentId.trim() === '' ? 'required' : UUID.test(form.documentId.trim()) ? undefined : 'invalid',
    ordinal: form.ordinal.trim() === '' ? undefined : !Number.isInteger(ordinal) || ordinal < 1 ? 'invalid' : undefined,
  };
}
export const itemHasProblems = (problems: ItemProblems): boolean => Object.values(problems).some((problem) => problem !== undefined);
export const itemBody = (form: ItemForm): Record<string, unknown> => ({ document_id: form.documentId.trim().toLowerCase(), ...(form.ordinal.trim() === '' ? {} : { ordinal: Number(form.ordinal) }) });

// ---- closing ---------------------------------------------------------------------------------------------------------------

function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

/** The day the settlement of the project closed (optional): a real day that is not after today. */
export function validateSettlement(day: string, today: string): FieldProblem | undefined {
  if (day === '') return undefined;
  if (!isDay(day)) return 'invalid';
  return day > today ? 'invalid' : undefined;
}
export const closeBody = (day: string): Record<string, unknown> => (day === '' ? {} : { settlement_closed_on: day });

const SET_ORDER: readonly string[] = ['TT74_2025_BTC', 'TT10_2022_BNV', 'TENANT_CUSTOM'];
const setRank = (rule: RetentionRule): number => (SET_ORDER.indexOf(rule.ruleSet) < 0 ? SET_ORDER.length : SET_ORDER.indexOf(rule.ruleSet));

/** The published rules of a category in force on a day: a confirmed one first, then the lowest precedence number, as the server picks it. Nothing confirmed means the dossier is kept for ever, provisionally. */
export function ruleForClosing(rules: readonly RetentionRule[], category: string, day: string): { rule: RetentionRule | undefined; provisional: boolean } {
  const live = rules
    .filter((rule) => rule.status === 'PUBLISHED' && rule.categoryCode === category && rule.effectiveFrom <= day && (rule.effectiveUntil === null || day < rule.effectiveUntil))
    .sort((a, b) => Number(b.confirmationStatus === 'CONFIRMED') - Number(a.confirmationStatus === 'CONFIRMED') || a.precedence - b.precedence || setRank(a) - setRank(b) || a.id.localeCompare(b.id));
  const rule = live[0];
  return { rule, provisional: rule === undefined || rule.confirmationStatus !== 'CONFIRMED' };
}
