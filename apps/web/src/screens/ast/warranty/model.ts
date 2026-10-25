import { ApiError } from '@machvon/api-client';

/** The permissions of AST-04 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract and of the receiving unit. */
export const READ_PERMISSION = 'warranty.read';
export const MANAGE_PERMISSION = 'warranty.manage';

export const WARRANTY_STATUSES = ['ACTIVE', 'EXPIRED', 'CLOSED'] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];
export const CONSTRUCTION_GRADES = ['SPECIAL', 'I', 'II', 'III', 'IV'] as const;
export type ConstructionGrade = (typeof CONSTRUCTION_GRADES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^\d{1,24}$/;
const MAX_TEXT = 2000;
const MAX_MONTHS = 600;
const DAY_MS = 86_400_000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** One obligation as AST-04 shows it. The status is the one of the day: the server counts an obligation whose last day has come as expired. */
export interface WarrantyLine {
  id: string;
  contract: { id: string; code: string };
  handover: { id: string; handoverNo: string | null };
  scope: string;
  asset: { id: string; assetCode: string; name: string | null } | null;
  startsOn: string;
  endsOn: string;
  periodMonths: number;
  constructionGrade: ConstructionGrade | null;
  minimumMonths: number | null;
  /** The rule the term was judged by waits for the confirmation of its source: the screen says so. */
  rule: { awaitingConfirmation: boolean; cxn: string | null } | null;
  guarantee: { guaranteeNo: string | null; issuer: string; amountVnd: string } | null;
  retentionAmountVnd: string;
  status: WarrantyStatus;
  closedAt: string | null;
  openClaims: number;
  totalClaims: number;
  canClose: boolean;
}

export function toWarranty(raw: unknown): WarrantyLine | undefined {
  const row = asRecord(raw);
  const contract = asRecord(row?.contract);
  const handover = asRecord(row?.handover);
  const asset = asRecord(row?.asset);
  const rule = asRecord(row?.rule);
  const guarantee = asRecord(row?.guarantee);
  const id = text(row?.id);
  const contractId = text(contract?.id);
  const status = oneOf(WARRANTY_STATUSES, row?.status);
  const startsOn = text(row?.starts_on);
  const endsOn = text(row?.ends_on);
  const months = whole(row?.period_months);
  if (row === undefined || id === undefined || contractId === undefined || status === undefined || startsOn === undefined || endsOn === undefined || months === undefined) return undefined;
  return {
    id,
    contract: { id: contractId, code: text(contract?.code) ?? '' },
    handover: { id: text(handover?.id) ?? '', handoverNo: nullableText(handover?.handover_no) },
    scope: text(row.scope_description) ?? '',
    asset: asset === undefined ? null : { id: text(asset.id) ?? '', assetCode: text(asset.asset_code) ?? '', name: nullableText(asset.name) },
    startsOn,
    endsOn,
    periodMonths: months,
    constructionGrade: oneOf(CONSTRUCTION_GRADES, row.construction_grade) ?? null,
    minimumMonths: whole(row.minimum_months) ?? null,
    rule: rule === undefined ? null : { awaitingConfirmation: rule.awaiting_confirmation === true, cxn: nullableText(rule.cxn) },
    guarantee: guarantee === undefined ? null : { guaranteeNo: nullableText(guarantee.guarantee_no), issuer: text(guarantee.issuer) ?? '', amountVnd: text(guarantee.amount_vnd) ?? '0' },
    retentionAmountVnd: text(row.retention_amount_vnd) ?? '0',
    status,
    closedAt: nullableText(row.closed_at),
    openClaims: whole(row.open_claims) ?? 0,
    totalClaims: whole(row.total_claims) ?? 0,
    canClose: asRecord(row.allowed)?.close === true,
  };
}

export function toWarrantyList(raw: unknown): WarrantyLine[] {
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items.flatMap((item) => toWarranty(item) ?? []) : [];
}

const dayNumber = (value: string): number => Date.parse(`${value}T00:00:00Z`) / DAY_MS;

/** The days from `today` to the last day of the warranty; negative once it is over. */
export const daysLeft = (endsOn: string, today: string): number => Math.round(dayNumber(endsOn) - dayNumber(today));

/** The Vietnam date of `now`. */
export const vietnamToday = (now: Date = new Date()): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

// ---- who may do what ------------------------------------------------------------------------------------------------------------

/** Whether the caller may create an obligation: the permission is held (or not yet known) and the session is not read-only. The server judges the scope again. */
export const canManage = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(MANAGE_PERMISSION));

// ---- forms ----------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'date' | 'uuid' | 'tooLong' | 'amount' | 'period' | 'cover';

const isDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export interface CreateForm {
  handoverId: string;
  assetId: string;
  scope: string;
  startsOn: string;
  periodMonths: string;
  grade: ConstructionGrade | '';
  guaranteeId: string;
  retentionVnd: string;
}

export const emptyCreate = (handoverId = ''): CreateForm => ({ handoverId, assetId: '', scope: '', startsOn: '', periodMonths: '', grade: '', guaranteeId: '', retentionVnd: '' });

/** What is wrong with the obligation before it is sent. A warranty is covered by a guarantee or by an amount held back; whichever is given, the other may be left empty. */
export function validateCreate(form: CreateForm): Partial<Record<keyof CreateForm, FormProblem>> {
  const problems: Partial<Record<keyof CreateForm, FormProblem>> = {};
  if (form.handoverId === '') problems.handoverId = 'required';
  const scope = form.scope.trim();
  if (scope === '') problems.scope = 'required';
  else if (scope.length > MAX_TEXT) problems.scope = 'tooLong';
  const start = form.startsOn.trim();
  if (start === '') problems.startsOn = 'required';
  else if (!isDate(start)) problems.startsOn = 'date';
  const months = form.periodMonths.trim();
  if (months === '') problems.periodMonths = 'required';
  else if (!/^\d{1,3}$/.test(months) || Number(months) < 1 || Number(months) > MAX_MONTHS) problems.periodMonths = 'period';
  const guarantee = form.guaranteeId.trim();
  if (guarantee !== '' && !UUID.test(guarantee)) problems.guaranteeId = 'uuid';
  const retention = form.retentionVnd.trim();
  if (retention !== '' && !AMOUNT.test(retention)) problems.retentionVnd = 'amount';
  else if (guarantee === '' && (retention === '' || /^0+$/.test(retention))) problems.retentionVnd = 'cover';
  return problems;
}

export interface CreateBody {
  contract_id: string;
  handover_id: string;
  asset_id?: string;
  scope_description: string;
  starts_on: string;
  period_months: number;
  construction_grade?: ConstructionGrade;
  warranty_guarantee_id?: string;
  retention_amount_vnd?: string;
}

export function createBody(form: CreateForm, contractId: string): CreateBody {
  const guarantee = form.guaranteeId.trim();
  const retention = form.retentionVnd.trim();
  return {
    contract_id: contractId,
    handover_id: form.handoverId,
    ...(form.assetId === '' ? {} : { asset_id: form.assetId }),
    scope_description: form.scope.trim(),
    starts_on: form.startsOn.trim(),
    period_months: Number(form.periodMonths.trim()),
    ...(form.grade === '' ? {} : { construction_grade: form.grade }),
    ...(guarantee === '' ? {} : { warranty_guarantee_id: guarantee.toLowerCase() }),
    ...(retention === '' ? {} : { retention_amount_vnd: retention }),
  };
}

export interface CloseForm {
  note: string;
}

export const emptyClose = (): CloseForm => ({ note: '' });

export const validateClose = (form: CloseForm): Partial<Record<keyof CloseForm, FormProblem>> => (form.note.trim().length > MAX_TEXT ? { note: 'tooLong' } : {});

export interface CloseBody {
  note?: string;
}

export const closeBody = (form: CloseForm): CloseBody => (form.note.trim() === '' ? {} : { note: form.note.trim() });

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem =
  'belowMinimum' | 'noRule' | 'guaranteeRequired' | 'handoverNotAccepted' | 'notExpired' | 'openClaims' | 'stateInvalid' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  problem: Problem;
  /** What the sentence adds to the code: the minimum and the term asked, the last day, or the claims that are open. */
  minimum: number | undefined;
  period: number | undefined;
  endsOn: string | undefined;
  claims: string[];
}

export function describeProblem(error: unknown): ProblemView {
  const none = (problem: Problem): ProblemView => ({ problem, minimum: undefined, period: undefined, endsOn: undefined, claims: [] });
  if (!(error instanceof ApiError)) return none('general');
  switch (error.code) {
    case 'WARRANTY_PERIOD_BELOW_MINIMUM':
      return { ...none('belowMinimum'), minimum: whole(error.extensions.minimum_months), period: whole(error.extensions.period_months) };
    case 'NO_EFFECTIVE_RULE':
      return none('noRule');
    case 'GUARANTEE_REQUIRED':
      return none('guaranteeRequired');
    case 'HANDOVER_NOT_ACCEPTED':
      return none('handoverNotAccepted');
    case 'WARRANTY_NOT_EXPIRED':
      return { ...none('notExpired'), endsOn: text(error.extensions.ends_on) };
    case 'OPEN_WARRANTY_CLAIMS': {
      const claims = error.extensions.claim_nos;
      return { ...none('openClaims'), claims: Array.isArray(claims) ? claims.filter((claim): claim is string => typeof claim === 'string') : [] };
    }
    case 'WARRANTY_STATE_INVALID':
      return none('stateInvalid');
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return none('validation');
    case 'RESOURCE_NOT_FOUND':
      return none('notFound');
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return none('denied');
    case 'SESSION_EXPIRED':
      return none('session');
    default:
      return none('general');
  }
}
