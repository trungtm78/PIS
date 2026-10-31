import { ApiError } from '@machvon/api-client';
import type { FormProblem } from '../payment/model';
import { KINDS } from './model';
import type { AdvanceKind } from './model';

/** PAY-11: the request for an advance (ST-PAY-011, PAY 3.2 step 1). The cap is worked out by the server and shown once the advance is planned; the form never takes it. */
const WHOLE = /^[1-9][0-9]{0,23}$/;
const TRANCHE = /^[1-9][0-9]{0,4}$/;
const MAX_TRANCHE = 32767;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface RequestForm {
  contractId: string;
  partyId: string;
  kind: AdvanceKind | '';
  amount: string;
  allocationLineId: string;
  trancheNo: string;
}

export const EMPTY_REQUEST: RequestForm = { contractId: '', partyId: '', kind: '', amount: '', allocationLineId: '', trancheNo: '' };

export function validateRequest(form: RequestForm): Partial<Record<keyof RequestForm, FormProblem>> {
  const problems: Partial<Record<keyof RequestForm, FormProblem>> = {};
  if (form.contractId === '') problems.contractId = 'required';
  if (form.partyId === '') problems.partyId = 'required';
  if (form.kind === '') problems.kind = 'required';
  const amount = form.amount.trim();
  if (amount === '') problems.amount = 'required';
  else if (!WHOLE.test(amount)) problems.amount = 'amount';
  if (form.allocationLineId === '') problems.allocationLineId = 'required';
  const tranche = form.trancheNo.trim();
  if (tranche !== '' && (!TRANCHE.test(tranche) || Number(tranche) > MAX_TRANCHE)) problems.trancheNo = 'amount';
  return problems;
}

export interface RequestBody {
  party_id: string;
  kind: AdvanceKind;
  amount_vnd: string;
  allocation_line_id: string;
  tranche_no?: number;
}

/** The body of the command for a form that passed `validateRequest`: no cap and no guarantee, the server finds the guarantee that covers and works the cap out. */
export function requestBody(form: RequestForm): RequestBody {
  const tranche = form.trancheNo.trim();
  return {
    party_id: form.partyId,
    kind: KINDS.find((kind) => kind === form.kind) ?? 'CONTRACT',
    amount_vnd: form.amount.trim(),
    allocation_line_id: form.allocationLineId,
    ...(tranche === '' ? {} : { tranche_no: Number(tranche) }),
  };
}

/** The advance as it was planned: what was asked, the cap the rule of the day gave and whether that rule still waits for its confirmation. */
export interface Requested {
  id: string;
  amountVnd: string;
  capVnd: string;
  capPct: string | null;
  ruleAwaitingConfirmation: boolean;
}

export function toRequested(value: unknown): Requested | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  const amountVnd = text(row?.amount_vnd);
  const capVnd = text(row?.cap_vnd);
  if (row === undefined || id === undefined || amountVnd === undefined || capVnd === undefined) return undefined;
  const warnings = Array.isArray(row.warnings) ? row.warnings : [];
  return { id, amountVnd, capVnd, capPct: text(row.cap_pct) ?? null, ruleAwaitingConfirmation: warnings.some((warning) => asRecord(warning)?.code === 'RULE_AWAITING_CONFIRMATION') };
}

export type RequestProblem =
  | 'contractNotEffective'
  | 'guaranteeRequired'
  | 'capExceeded'
  | 'ruleUnconfirmed'
  | 'outstandingPrior'
  | 'valueExceeded'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'session'
  | 'general';

export const GUARANTEE_REASONS = ['NO_GUARANTEE', 'NOT_FOUND', 'NOT_VERIFIED', 'NOT_ACTIVE', 'EXPIRED', 'TOO_SMALL', 'OTHER_MEMBER'] as const;
export type GuaranteeReason = (typeof GUARANTEE_REASONS)[number];

export interface RequestRefusal {
  problem: RequestProblem;
  /** The cap the server gave when the amount was above it. */
  capVnd: string | null;
  reason: GuaranteeReason | null;
}

const BY_CODE: Readonly<Record<string, RequestProblem>> = {
  ADVANCE_CONTRACT_NOT_EFFECTIVE: 'contractNotEffective',
  ADVANCE_GUARANTEE_REQUIRED: 'guaranteeRequired',
  ADVANCE_CAP_EXCEEDED: 'capExceeded',
  ADVANCE_RULE_UNCONFIRMED: 'ruleUnconfirmed',
  ADVANCE_OUTSTANDING_PRIOR: 'outstandingPrior',
  VALUE_EXCEEDED: 'valueExceeded',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  SESSION_EXPIRED: 'session',
};

export function describeRequestRefusal(error: unknown): RequestRefusal {
  if (!(error instanceof ApiError)) return { problem: 'general', capVnd: null, reason: null };
  const cap = error.extensions.cap_vnd;
  return {
    problem: BY_CODE[error.code] ?? 'general',
    capVnd: typeof cap === 'string' ? cap : null,
    reason: GUARANTEE_REASONS.find((reason) => reason === error.extensions.reason) ?? null,
  };
}
