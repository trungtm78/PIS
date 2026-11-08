import { DomainError } from './errors.ts';
import type { FormPeriod, FormPeriodKind } from './report-layout.ts';

// This file reads report-layout.ts for types only: report-layout reaches the governance rules, which register the rule type of this file, so a runtime import here would be a cycle.

/**
 * The period reports that go to the Ministry of Finance (G4-6, practices P6 and P18): the form of each period kind (week, month, quarter, year), the lock of a period once its report is signed, and the digital
 * signature over the issued copy. The forms are built on the report engine of RPT-1: a form is a layout, and a layout made before the official template is supplied is PENDING_EXTERNAL, so it cannot be issued
 * (R18); nothing here changes that. The signature is a detached CMS over the package digest of the issued copy (`packageDigestOf`), made through the signing port of DOC; a signature of the MOCK provider is a TEST signature
 * and never counts for a delivery to the Ministry. Every number is the governance rule `PERIOD_REPORT_RULE` (UNVERIFIED).
 */

export const PERIOD_REPORT_RULE_TYPE = 'PERIOD_REPORT_RULE';

export interface PeriodReportPolicy {
  /** The receivers that accept a copy only when it is signed. */
  signature_required_receivers: string[];
  /** The period is locked when its copy is signed, or only when the receiver accepted it. */
  lock_after: 'SIGNED' | 'ACCEPTED';
  /** The shortest reason that unlocks a period. */
  unlock_reason_min_chars: number;
}

export const periodReportDefaults = (): PeriodReportPolicy => ({ signature_required_receivers: ['MOF'], lock_after: 'SIGNED', unlock_reason_min_chars: 15 });

export function periodReportPolicyOf(params: Readonly<Record<string, unknown>>): PeriodReportPolicy {
  const receivers = params.signature_required_receivers;
  if (!Array.isArray(receivers) || receivers.length > 20 || !receivers.every((one) => typeof one === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(one))) throw new DomainError('VALIDATION_FAILED', 422, 'signature_required_receivers');
  if (params.lock_after !== 'SIGNED' && params.lock_after !== 'ACCEPTED') throw new DomainError('VALIDATION_FAILED', 422, 'lock_after');
  const min = params.unlock_reason_min_chars;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 5 || min > 500) throw new DomainError('VALIDATION_FAILED', 422, 'unlock_reason_min_chars');
  return { signature_required_receivers: [...receivers] as string[], lock_after: params.lock_after, unlock_reason_min_chars: min };
}

export const MOF_RECEIVER = 'MOF';

/** The forms for the Ministry: one for each period kind. The layout of each is derived from the weekly layout in `mof-forms.ts` of the API; here only the identity is kept. */
export const MOF_FORMS = [
  { code: 'MOF-DIS-WEEKLY', periodKind: 'AS_OF' },
  { code: 'MOF-DIS-MONTHLY', periodKind: 'MONTH' },
  { code: 'MOF-DIS-QUARTERLY', periodKind: 'QUARTER' },
  { code: 'MOF-DIS-YEARLY', periodKind: 'YEAR' },
] as const satisfies ReadonlyArray<{ code: string; periodKind: FormPeriodKind }>;
export type MofFormCode = (typeof MOF_FORMS)[number]['code'];

export const mofFormOf = (code: string): (typeof MOF_FORMS)[number] | undefined => MOF_FORMS.find((form) => form.code === code);

const pad = (value: number): string => String(value).padStart(2, '0');

/** The key of a period inside a series: the same period always has the same key (`AS_OF:2026-11-06`, `MONTH:2026-03`, `QUARTER:2026-Q1`, `HALF_YEAR:2026-H1`, `YEAR:2026`). */
const INDEX_LIMIT: Readonly<Record<FormPeriodKind, number>> = { MONTH: 12, QUARTER: 4, HALF_YEAR: 2, YEAR: 0, AS_OF: 0 };
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertPeriodShape(period: FormPeriod): void {
  const limit = INDEX_LIMIT[period.kind];
  if (limit === undefined || !Number.isInteger(period.year) || period.year < 1900 || period.year > 2999) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  if (period.kind === 'AS_OF') {
    const match = period.day === undefined ? null : DAY.exec(period.day);
    if (match === null || Number(match[1]) !== period.year || period.index !== undefined || new Date(period.day + 'T00:00:00Z').toISOString().slice(0, 10) !== period.day) throw new DomainError('VALIDATION_FAILED', 422, 'period');
    return;
  }
  if (period.day !== undefined) throw new DomainError('VALIDATION_FAILED', 422, 'period');
  if (limit === 0 ? period.index !== undefined : !Number.isInteger(period.index) || (period.index as number) < 1 || (period.index as number) > limit) throw new DomainError('VALIDATION_FAILED', 422, 'period');
}

export function periodKeyOf(period: FormPeriod): string {
  assertPeriodShape(period);
  switch (period.kind) {
    case 'AS_OF':
      return `AS_OF:${period.day as string}`;
    case 'MONTH':
      return `MONTH:${period.year}-${pad(period.index as number)}`;
    case 'QUARTER':
      return `QUARTER:${period.year}-Q${period.index as number}`;
    case 'HALF_YEAR':
      return `HALF_YEAR:${period.year}-H${period.index as number}`;
    case 'YEAR':
      return `YEAR:${period.year}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The signature.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SIGNATURE_PROVIDERS = ['REMOTE_CA', 'LOCAL_AGENT', 'MOCK'] as const;
export type SignatureProvider = (typeof SIGNATURE_PROVIDERS)[number];

export interface ReportSignatureFacts {
  /** The package digest the signature covers. */
  digestSha256: string;
  provider: SignatureProvider;
  signerId: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** Whose signature counts: the one who approved the copy signs it (the issuer of the engine is the approver), and nobody else. */
export function assertSignerIsApprover(input: { signerId: string; approverId: string }): void {
  if (input.signerId !== input.approverId) throw new DomainError('SCOPE_DENIED', 403, 'signer');
}

/** A signature covers one digest: it is valid for a copy only when the digest is the copy's own. */
export function signatureCovers(signature: ReportSignatureFacts | null, copyDigestSha256: string): boolean {
  return signature !== null && SHA256.test(copyDigestSha256) && signature.digestSha256 === copyDigestSha256;
}

/** A signature made with the test provider proves that the flow works and nothing else: it never lets a copy go to a receiver that requires a signature. */
export const signatureCountsForDelivery = (signature: ReportSignatureFacts | null, copyDigestSha256: string): boolean => signatureCovers(signature, copyDigestSha256) && (signature as ReportSignatureFacts).provider !== 'MOCK';

export function assertSignedForDelivery(input: { receiver: string; policy: PeriodReportPolicy; signature: ReportSignatureFacts | null; copyDigestSha256: string }): void {
  if (!input.policy.signature_required_receivers.includes(input.receiver)) return;
  if (!signatureCountsForDelivery(input.signature, input.copyDigestSha256)) throw new DomainError('REPORT_SIGNATURE_REQUIRED', 422, input.signature === null ? 'unsigned' : input.signature.provider === 'MOCK' ? 'test_signature' : 'digest');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The lock of a period.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PeriodLockFacts {
  lockedBy: string;
  unlockedAt: string | null;
}

export const isLocked = (lock: PeriodLockFacts | null): boolean => lock !== null && lock.unlockedAt === null;

/** A period that is locked takes no new revision: a correction needs the unlock first (PERIOD_LOCKED). */
export function assertPeriodOpen(lock: PeriodLockFacts | null): void {
  if (isLocked(lock)) throw new DomainError('PERIOD_LOCKED', 409, 'period');
}

/** Whether the event (a copy signed, a copy accepted) locks the period under the policy. */
export const eventLocks = (event: 'SIGNED' | 'ACCEPTED', policy: PeriodReportPolicy): boolean => event === policy.lock_after || (event === 'ACCEPTED' && policy.lock_after === 'SIGNED');

/** Unlocking takes two different people (the one who unlocks is not the one who locked) and a reason of the length the policy asks for. */
export function assertUnlock(input: { lock: PeriodLockFacts | null; actorId: string; reason: string }, policy: PeriodReportPolicy): void {
  if (input.lock === null || input.lock.unlockedAt !== null) throw new DomainError('PERIOD_LOCK_NOT_FOUND', 404, 'period');
  if (input.actorId === input.lock.lockedBy) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  if (input.reason.trim().length < policy.unlock_reason_min_chars) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
}
