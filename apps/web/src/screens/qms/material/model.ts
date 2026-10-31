import { ApiError } from '@machvon/api-client';

/** QMS-06: the testing of materials (ST-QMS-007, QMS 3.3, UC-QMS-03, UAT-AC362). The server judges every request again. */
export const MANAGE_PERMISSION = 'material.manage';

export const RESULTS = ['PASS', 'FAIL'] as const;
export type Result = (typeof RESULTS)[number];
export const STATUSES = ['REGISTERED', 'RESULT_RECORDED', 'ACCEPTED', 'REJECTED'] as const;
export type Status = (typeof STATUSES)[number];
export const SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MAX_WORDS = 200;
const MAX_VALUES = 65_536;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

export interface MaterialTest {
  id: string;
  contract: { id: string; code: string };
  sampleCode: string;
  materialKind: string;
  labName: string;
  standardRef: string;
  sampledOn: string;
  testedOn: string | null;
  result: Result | 'PENDING';
  resultValues: Record<string, unknown>;
  reportId: string | null;
  status: Status;
  nonconformance: { id: string; ncrNo: string; severity: Severity; status: string } | null;
  canRecord: boolean;
  version: number;
}

export function toMaterialTest(raw: unknown): MaterialTest | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const ncr = asRecord(row?.nonconformance);
  const id = text(row?.id);
  const contractId = text(contract?.id);
  const sampleCode = text(row?.sample_code);
  const status = oneOf(STATUSES, row?.status);
  const sampledOn = text(row?.sampled_on);
  if (row === undefined || id === undefined || contractId === undefined || sampleCode === undefined || status === undefined || sampledOn === undefined) return undefined;
  const ncrId = text(ncr?.id);
  return {
    id,
    contract: { id: contractId, code: text(contract?.code) ?? '' },
    sampleCode,
    materialKind: text(row.material_kind) ?? '',
    labName: text(row.lab_name) ?? '',
    standardRef: text(row.standard_ref) ?? '',
    sampledOn,
    testedOn: nullableText(row.tested_on),
    result: oneOf(RESULTS, row.result) ?? 'PENDING',
    resultValues: asRecord(row.result_values) ?? {},
    reportId: nullableText(row.report_document_version_id),
    status,
    nonconformance: ncrId === undefined ? null : { id: ncrId, ncrNo: text(ncr?.ncr_no) ?? '', severity: oneOf(SEVERITIES, ncr?.severity) ?? 'MAJOR', status: text(ncr?.status) ?? '' },
    canRecord: asRecord(row.allowed)?.record === true,
    version: typeof row.version === 'number' ? row.version : 0,
  };
}

/** A contract being performed that a sample can be registered on. */
export interface ContractOption {
  id: string;
  code: string;
  title: string | null;
}

export function toContractOption(raw: unknown): ContractOption[] {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.code);
  return row === undefined || id === undefined || code === undefined ? [] : [{ id, code, title: nullableText(row.title) }];
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
export const canManage = (permissions: readonly string[] | undefined, mode: Mode): boolean => (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';

/** The Vietnam date of `now`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

/** A calendar day written YYYY-MM-DD that exists. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// ---- the forms -----------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'invalid' | 'tooLong' | 'future' | 'early' | 'object';

export interface RegisterForm {
  contractId: string;
  sampleCode: string;
  materialKind: string;
  labName: string;
  standardRef: string;
  sampledOn: string;
}
export type RegisterField = keyof RegisterForm;

export const emptyRegister = (contractId: string, today: string): RegisterForm => ({ contractId, sampleCode: '', materialKind: '', labName: '', standardRef: '', sampledOn: today });

const wordsProblem = (value: string): FormProblem | undefined => (value.trim() === '' ? 'required' : value.trim().length > MAX_WORDS ? 'tooLong' : undefined);

export function validateRegister(form: RegisterForm, contractIds: readonly string[], today: string): Partial<Record<RegisterField, FormProblem>> {
  const found: Partial<Record<RegisterField, FormProblem>> = {};
  if (form.contractId === '') found.contractId = 'required';
  else if (!contractIds.includes(form.contractId)) found.contractId = 'invalid';
  for (const field of ['sampleCode', 'materialKind', 'labName', 'standardRef'] as const) {
    const problem = wordsProblem(form[field]);
    if (problem !== undefined) found[field] = problem;
  }
  if (form.sampledOn.trim() === '') found.sampledOn = 'required';
  else if (!isDay(form.sampledOn.trim())) found.sampledOn = 'invalid';
  else if (form.sampledOn.trim() > today) found.sampledOn = 'future';
  return found;
}

export const registerBody = (form: RegisterForm): Record<string, unknown> => ({
  contract_id: form.contractId,
  sample_code: form.sampleCode.trim(),
  material_kind: form.materialKind.trim(),
  lab_name: form.labName.trim(),
  standard_ref: form.standardRef.trim(),
  sampled_on: form.sampledOn.trim(),
});

export interface ResultForm {
  result: string;
  testedOn: string;
  values: string;
  reportId: string;
}
export type ResultField = keyof ResultForm;

export const emptyResult = (today: string): ResultForm => ({ result: '', testedOn: today, values: '{}', reportId: '' });

/** The values the laboratory reported, typed as an object; undefined when the text is not one. */
export function parseValues(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

export function validateResult(form: ResultForm, test: MaterialTest, today: string): Partial<Record<ResultField, FormProblem>> {
  const found: Partial<Record<ResultField, FormProblem>> = {};
  if (form.result === '') found.result = 'required';
  else if (oneOf(RESULTS, form.result) === undefined) found.result = 'invalid';
  if (form.testedOn.trim() === '') found.testedOn = 'required';
  else if (!isDay(form.testedOn.trim())) found.testedOn = 'invalid';
  else if (form.testedOn.trim() < test.sampledOn) found.testedOn = 'early';
  else if (form.testedOn.trim() > today) found.testedOn = 'future';
  const values = parseValues(form.values);
  if (values === undefined) found.values = 'object';
  else if (JSON.stringify(values).length > MAX_VALUES) found.values = 'tooLong';
  if (form.reportId.trim() === '') found.reportId = 'required';
  else if (!UUID.test(form.reportId.trim())) found.reportId = 'invalid';
  return found;
}

/** The body of the command for a form that passed `validateResult`. */
export const resultBody = (form: ResultForm): Record<string, unknown> => ({
  result: form.result,
  tested_on: form.testedOn.trim(),
  result_values: parseValues(form.values) ?? {},
  report_document_version_id: form.reportId.trim(),
});

// ---- what the server refuses ---------------------------------------------------------------------------------------------------

export type Problem = 'duplicate' | 'state' | 'conflict' | 'notClean' | 'contractState' | 'future' | 'early' | 'denied' | 'notFound' | 'validation' | 'general';

const BY_CODE: Readonly<Record<string, Problem>> = {
  SAMPLE_CODE_DUPLICATE: 'duplicate',
  MATERIAL_TEST_STATE_INVALID: 'state',
  VERSION_CONFLICT: 'conflict',
  DOCUMENT_NOT_CLEAN: 'notClean',
  CONTRACT_STATE_INVALID: 'contractState',
  SCOPE_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
};

const BY_REASON: Readonly<Record<string, Problem>> = { IN_THE_FUTURE: 'future', BEFORE_SAMPLE: 'early' };

export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  const reason = text(error.extensions.reason);
  return (error.code === 'VALIDATION_FAILED' && reason !== undefined ? BY_REASON[reason] : undefined) ?? BY_CODE[error.code] ?? 'general';
}
