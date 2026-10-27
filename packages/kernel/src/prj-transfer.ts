import { DomainError } from './errors.ts';

/**
 * The transfer of a project between units (ST-PRJ-007, PRJ 3.1 F10): the investor asks that the owner unit, or the investor unit, of a project become another unit of the same tenant from a day; someone else decides;
 * the change is made on that day and reports and snapshots before it keep the old unit. The statuses and what each may do are here, with no store or clock of their own.
 */
export const TRANSFER_STATUSES = ['REQUESTED', 'APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];
export const TRANSFER_SCOPES = ['OWNER_UNIT', 'INVESTOR_UNIT'] as const;
export type TransferScope = (typeof TRANSFER_SCOPES)[number];
export const TRANSFER_DECISIONS = ['approve', 'reject', 'return'] as const;
export type TransferDecision = (typeof TRANSFER_DECISIONS)[number];

/** The statuses of a request that is still open: one is allowed at a time for a project and a scope (409 TRANSFER_PENDING_EXISTS). */
export const OPEN_TRANSFER_STATUSES: readonly TransferStatus[] = ['REQUESTED', 'APPROVED'];

/** The projects that a transfer may not touch: a project that is settled or cancelled has nothing left to be attributed. */
export const UNTRANSFERABLE_PROJECT_STATUSES: readonly string[] = ['SETTLED', 'CANCELLED'];

/**
 * The status a decision gives a request that waits for it: approve makes it APPROVED (it is applied on its day), reject closes it for good (REJECTED), return closes it so that the requester asks again with
 * what was wrong put right (CANCELLED, the reason says what). A request that is not waiting is 409 STAGE_TRANSITION_DENIED.
 */
export function decidedStatus(status: TransferStatus, decision: TransferDecision): TransferStatus {
  if (status !== 'REQUESTED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status', { extensions: { transfer_status: status } });
  return decision === 'approve' ? 'APPROVED' : decision === 'reject' ? 'REJECTED' : 'CANCELLED';
}

/** Whether an approved transfer is made now: its day is today or has passed (a day after today waits for the job). Days are `YYYY-MM-DD` and compare as text. */
export const isDueToday = (effectiveDate: string, today: string): boolean => effectiveDate <= today;

/** Whether the unit a project had when the transfer was asked for is still the unit it has: a transfer of something that changed in the meantime is not applied. */
export const stillFromUnit = (currentUnitId: string | null, fromUnitId: string): boolean => currentUnitId === fromUnitId;
