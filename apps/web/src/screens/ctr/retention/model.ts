import { ApiError } from '@machvon/api-client';

/** The permissions of CTR-21 (x-permission of the operations in openapi.json); the server judges each command again, with the scope of the contract. */
export const READ_PERMISSION = 'ledger.read';
export const RELEASE_PERMISSION = 'retention.release';

export const RETENTION_STATUSES = ['HELD', 'PARTIALLY_RELEASED', 'RELEASED', 'FORFEITED'] as const;
export type RetentionStatus = (typeof RETENTION_STATUSES)[number];
export const RELEASE_CONDITIONS = ['WARRANTY_END', 'COMPLETION', 'MANUAL_DECISION'] as const;
export type ReleaseCondition = (typeof RELEASE_CONDITIONS)[number];
export const BLOCKERS = ['NOT_BEFORE', 'NO_WARRANTY', 'WARRANTY_OPEN', 'CONTRACT_NOT_COMPLETED', 'DECISION_REQUIRED'] as const;
export type Blocker = (typeof BLOCKERS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT = /^\d{1,24}$/;
const MAX_TEXT = 2000;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined => values.find((candidate) => candidate === value);

/** One hold of retention as CTR-21 shows it: the BOQ item, what is held and released, the condition of the release and whether the caller may release it. */
export interface HoldLine {
  id: string;
  item: { id: string; key: string; description: string };
  heldVnd: string;
  releasedVnd: string;
  leftVnd: string;
  condition: ReleaseCondition;
  releaseNotBefore: string | null;
  status: RetentionStatus;
  /** Why the money may not be released yet; null when the condition is met today. */
  blocker: Blocker | null;
  releasedAt: string | null;
  releaseReason: string | null;
  hasDecision: boolean;
  canRelease: boolean;
  version: number;
}

export interface Holds {
  contract: { id: string; code: string; status: string; heldVnd: string; releasedVnd: string };
  items: HoldLine[];
}

export function toHold(raw: unknown): HoldLine | undefined {
  const row = asRecord(raw);
  const item = asRecord(row?.boq_item);
  const id = text(row?.id);
  const itemId = text(item?.id);
  const status = oneOf(RETENTION_STATUSES, row?.status);
  const condition = oneOf(RELEASE_CONDITIONS, row?.release_condition);
  const version = whole(row?.version);
  const held = text(row?.held_vnd);
  const released = text(row?.released_vnd);
  if (row === undefined || id === undefined || itemId === undefined || status === undefined || condition === undefined || version === undefined || held === undefined || released === undefined)
    return undefined;
  return {
    id,
    item: { id: itemId, key: text(item?.key) ?? '', description: text(item?.description) ?? '' },
    heldVnd: held,
    releasedVnd: released,
    leftVnd: text(row.left_vnd) ?? '0',
    condition,
    releaseNotBefore: nullableText(row.release_not_before),
    status,
    blocker: oneOf(BLOCKERS, asRecord(row.condition)?.reason) ?? null,
    releasedAt: nullableText(row.released_at),
    releaseReason: nullableText(row.release_reason),
    hasDecision: typeof row.decision_document_version_id === 'string',
    canRelease: asRecord(row.allowed)?.release === true,
    version,
  };
}

export function toHolds(raw: unknown): Holds | undefined {
  const root = asRecord(raw);
  const contract = asRecord(root?.contract);
  const id = text(contract?.id);
  if (root === undefined || id === undefined || !Array.isArray(root.items)) return undefined;
  return {
    contract: {
      id,
      code: text(contract?.code) ?? '',
      status: text(contract?.status) ?? '',
      heldVnd: text(contract?.retention_held_vnd) ?? '0',
      releasedVnd: text(contract?.retention_released_vnd) ?? '0',
    },
    items: root.items.flatMap((item) => toHold(item) ?? []),
  };
}

// ---- forms ----------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'uuid' | 'tooLong' | 'amount' | 'exceeds';

export interface ReleaseForm {
  amount: string;
  reason: string;
  decision: string;
}

/** The form opens with everything that is still held, the most common release. */
export const emptyRelease = (hold: HoldLine): ReleaseForm => ({ amount: hold.leftVnd, reason: '', decision: '' });

/** What is wrong with the release before it is sent. A hold that waits for a decision of the authority needs it attached, unless an earlier release already did. */
export function validateRelease(form: ReleaseForm, hold: HoldLine): Partial<Record<keyof ReleaseForm, FormProblem>> {
  const problems: Partial<Record<keyof ReleaseForm, FormProblem>> = {};
  const amount = form.amount.trim();
  if (amount === '') problems.amount = 'required';
  else if (!AMOUNT.test(amount) || /^0+$/.test(amount)) problems.amount = 'amount';
  else if (BigInt(amount) > BigInt(hold.leftVnd)) problems.amount = 'exceeds';
  const reason = form.reason.trim();
  if (reason === '') problems.reason = 'required';
  else if (reason.length > MAX_TEXT) problems.reason = 'tooLong';
  const decision = form.decision.trim();
  if (decision !== '' && !UUID.test(decision)) problems.decision = 'uuid';
  else if (decision === '' && hold.condition === 'MANUAL_DECISION' && !hold.hasDecision) problems.decision = 'required';
  return problems;
}

export interface ReleaseBody {
  amount_vnd: string;
  reason: string;
  decision_document_version_id?: string;
}

export function releaseBody(form: ReleaseForm): ReleaseBody {
  const decision = form.decision.trim();
  return { amount_vnd: form.amount.trim().replace(/^0+(?=\d)/, ''), reason: form.reason.trim(), ...(decision === '' ? {} : { decision_document_version_id: decision.toLowerCase() }) };
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

export type Problem = 'conditionNotMet' | 'exceedsHeld' | 'selfApproval' | 'notClean' | 'versionConflict' | 'paymentState' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

export interface ProblemView {
  problem: Problem;
  /** What a condition that is not met waits for. */
  blocker: Blocker | undefined;
  /** What is still held, when the amount asked is more. */
  leftVnd: string | undefined;
  /** The earliest day, when the day has not come. */
  notBefore: string | undefined;
}

export function describeProblem(error: unknown): ProblemView {
  const none = (problem: Problem): ProblemView => ({ problem, blocker: undefined, leftVnd: undefined, notBefore: undefined });
  if (!(error instanceof ApiError)) return none('general');
  switch (error.code) {
    case 'RELEASE_CONDITION_NOT_MET':
      return { ...none('conditionNotMet'), blocker: oneOf(BLOCKERS, error.extensions.reason), notBefore: text(error.extensions.release_not_before) };
    case 'RELEASE_EXCEEDS_HELD':
      return { ...none('exceedsHeld'), leftVnd: text(error.extensions.left_vnd) };
    case 'SELF_APPROVAL_DENIED':
      return none('selfApproval');
    case 'DOCUMENT_NOT_CLEAN':
      return none('notClean');
    case 'VERSION_CONFLICT':
      return none('versionConflict');
    case 'PAYMENT_STATE_INVALID':
      return none('paymentState');
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
