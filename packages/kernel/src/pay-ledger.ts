import { DomainError } from './errors.ts';

/**
 * The cumulative ledger of a contract (ST-PAY-001, PAY 3.1, BR-PAY-01): for each BOQ item of each acceptance (and party) the amounts accepted, requested, paid, recovered from the advance and
 * held back are kept as a balance that is the sum of append-only entries. A balance never goes below zero, `paid <= requested <= accepted`, and what is recovered and held back is part of what
 * was requested; a mistake is corrected by an entry that reverses another, never by changing or deleting one. All amounts are whole dong, as decimal text.
 */
export const LEDGER_ENTRY_KINDS = [
  'RECOGNIZE_ACCEPTANCE',
  'REVOKE_ACCEPTANCE',
  'CLAIM',
  'CLAIM_RELEASE',
  'PAYMENT',
  'PAYMENT_REVERSAL',
  'ADVANCE_RECOVERY',
  'ADVANCE_RECOVERY_REVERSAL',
  'RETENTION_HOLD',
  'RETENTION_RELEASE',
  'ADJUSTMENT',
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** The kinds of entry that reverse another, and the kind of entry each reverses. */
export const REVERSAL_OF: Readonly<Partial<Record<LedgerEntryKind, LedgerEntryKind>>> = {
  REVOKE_ACCEPTANCE: 'RECOGNIZE_ACCEPTANCE',
  CLAIM_RELEASE: 'CLAIM',
  PAYMENT_REVERSAL: 'PAYMENT',
  ADVANCE_RECOVERY_REVERSAL: 'ADVANCE_RECOVERY',
};

export const isReversal = (kind: LedgerEntryKind): boolean => REVERSAL_OF[kind] !== undefined;

/** What the ledger of one item of one acceptance holds, in whole dong. */
export interface LedgerBalance {
  acceptedVnd: string;
  requestedVnd: string;
  paidVnd: string;
  advanceRecoveredVnd: string;
  retentionHeldVnd: string;
}

/** What an entry adds to the balance (negative for a reversal). */
export interface LedgerDelta {
  accepted: string;
  requested: string;
  paid: string;
  advanceRecovery: string;
  retention: string;
}

export const ZERO_BALANCE: LedgerBalance = { acceptedVnd: '0', requestedVnd: '0', paidVnd: '0', advanceRecoveredVnd: '0', retentionHeldVnd: '0' };
export const ZERO_DELTA: LedgerDelta = { accepted: '0', requested: '0', paid: '0', advanceRecovery: '0', retention: '0' };

const WHOLE = /^-?(0|[1-9][0-9]{0,23})$/;

/** An amount of whole dong as a BigInt; 422 `VALIDATION_FAILED` naming the field when the text is not one. */
export function dong(value: string, field: string): bigint {
  if (!WHOLE.test(value)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return BigInt(value);
}

const add = (balance: string, delta: string): string => (BigInt(balance) + BigInt(delta)).toString();

/** The balance after an entry. */
export function applyDelta(balance: LedgerBalance, delta: LedgerDelta): LedgerBalance {
  return {
    acceptedVnd: add(balance.acceptedVnd, delta.accepted),
    requestedVnd: add(balance.requestedVnd, delta.requested),
    paidVnd: add(balance.paidVnd, delta.paid),
    advanceRecoveredVnd: add(balance.advanceRecoveredVnd, delta.advanceRecovery),
    retentionHeldVnd: add(balance.retentionHeldVnd, delta.retention),
  };
}

/** The delta of the entry that reverses an entry with this delta. */
export const negate = (delta: LedgerDelta): LedgerDelta => ({
  accepted: (-BigInt(delta.accepted)).toString(),
  requested: (-BigInt(delta.requested)).toString(),
  paid: (-BigInt(delta.paid)).toString(),
  advanceRecovery: (-BigInt(delta.advanceRecovery)).toString(),
  retention: (-BigInt(delta.retention)).toString(),
});

/** The rules the database keeps on a balance (the CHECKs of `cumulative_ledger`), named as the constraints are. */
export const LEDGER_RULES = ['NONNEGATIVE', 'REQUESTED_LE_ACCEPTED', 'PAID_LE_REQUESTED', 'DEDUCTIONS_LE_REQUESTED'] as const;
export type LedgerRule = (typeof LEDGER_RULES)[number];

/** The first rule a balance breaks, if any. */
export function brokenRule(balance: LedgerBalance): LedgerRule | undefined {
  const accepted = BigInt(balance.acceptedVnd);
  const requested = BigInt(balance.requestedVnd);
  const paid = BigInt(balance.paidVnd);
  const recovered = BigInt(balance.advanceRecoveredVnd);
  const held = BigInt(balance.retentionHeldVnd);
  if (accepted < 0n || requested < 0n || paid < 0n || recovered < 0n || held < 0n) return 'NONNEGATIVE';
  if (requested > accepted) return 'REQUESTED_LE_ACCEPTED';
  if (paid > requested) return 'PAID_LE_REQUESTED';
  if (recovered + held > requested) return 'DEDUCTIONS_LE_REQUESTED';
  return undefined;
}

/** 409 `VALUE_EXCEEDED` (naming the rule and the balance that would result) unless the balance keeps the rules of the ledger. */
export function assertLedgerInvariants(balance: LedgerBalance): void {
  const rule = brokenRule(balance);
  if (rule !== undefined) {
    throw new DomainError('VALUE_EXCEEDED', 409, 'ledger', {
      extensions: { rule, accepted_vnd: balance.acceptedVnd, requested_vnd: balance.requestedVnd, paid_vnd: balance.paidVnd, advance_recovered_vnd: balance.advanceRecoveredVnd, retention_held_vnd: balance.retentionHeldVnd },
    });
  }
}

/**
 * 422 `VALIDATION_FAILED` unless the signs of the delta fit the kind of the entry (the CHECKs of `cumulative_ledger_entry`): an entry that reverses another takes away (accepted, requested, paid
 * and recovered are not above zero), a forward entry adds (none is below zero, the release of retention apart), and a reversal says which entry it reverses and a forward entry does not. An
 * adjustment (ST-CTR-016) is neither: it moves the accepted amount of the balance by a difference of price, up or down, never by zero, leaves requested, paid, recovered and held alone, and
 * is corrected by a later adjustment, not by reversing it.
 */
export function assertEntryShape(kind: LedgerEntryKind, delta: LedgerDelta, reversalOfId: string | null): void {
  if (isReversal(kind) !== (reversalOfId !== null)) throw new DomainError('VALIDATION_FAILED', 422, 'reversal_of_id');
  if (kind === 'ADJUSTMENT') {
    const untouched = [delta.requested, delta.paid, delta.advanceRecovery, delta.retention];
    if (BigInt(delta.accepted) === 0n || untouched.some((value) => BigInt(value) !== 0n)) throw new DomainError('VALIDATION_FAILED', 422, 'delta');
    return;
  }
  const signed = [BigInt(delta.accepted), BigInt(delta.requested), BigInt(delta.paid), BigInt(delta.advanceRecovery)];
  if (isReversal(kind)) {
    if (signed.some((value) => value > 0n)) throw new DomainError('VALIDATION_FAILED', 422, 'delta');
  } else if (kind !== 'RETENTION_RELEASE' && (signed.some((value) => value < 0n) || BigInt(delta.retention) < 0n)) {
    throw new DomainError('VALIDATION_FAILED', 422, 'delta');
  }
}

/**
 * The advance of a contract still to be recovered: what was paid out less what was recovered from the payments (never below zero). The ledger keeps a picture of it with every entry, for the
 * auditor.
 */
export function advanceOutstanding(advancePaidVnd: string, advanceRecoveredVnd: string): string {
  const left = BigInt(advancePaidVnd) - BigInt(advanceRecoveredVnd);
  return (left < 0n ? 0n : left).toString();
}

/** The balances added together, as the contract shows them. */
export function totalOf(balances: readonly LedgerBalance[]): LedgerBalance {
  return balances.reduce(
    (sum, balance) => ({
      acceptedVnd: add(sum.acceptedVnd, balance.acceptedVnd),
      requestedVnd: add(sum.requestedVnd, balance.requestedVnd),
      paidVnd: add(sum.paidVnd, balance.paidVnd),
      advanceRecoveredVnd: add(sum.advanceRecoveredVnd, balance.advanceRecoveredVnd),
      retentionHeldVnd: add(sum.retentionHeldVnd, balance.retentionHeldVnd),
    }),
    ZERO_BALANCE,
  );
}
