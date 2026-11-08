import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';

/** VND-09 and VND-10: the bid security register and the subcontracts of a contract (VND-2). The shapes are the contract's. */
type S = components['schemas'];
export type SecurityRow = S['VndBidSecurity'];
export type SecurityStanding = S['VndBidSecurityStanding'];
export type SecurityList = S['VndBidSecurityList'];
export type SecurityDetail = S['VndBidSecurityDetail'];
export type SecurityEvent = S['VndBidSecurityEvent'];
export type SecurityState = SecurityRow['state'];
export type SecurityKind = SecurityRow['kind'];
export type SubcontractList = S['VndSubcontractList'];
export type Subcontract = S['VndSubcontract'];
export type SubcontractPayment = S['VndSubcontractPayment'];
export type PendingConfirmation = S['VndPendingConfirmation'];
export type SubcontractState = Subcontract['state'];

export const PERMISSION = {
  securityWrite: 'vnd.security.write',
  securityConfirm: 'vnd.security.confirm',
  forfeitPropose: 'vnd.security.forfeit.propose',
  forfeitDecide: 'vnd.security.forfeit.decide',
  subcontractWrite: 'vnd.subcontract.write',
  subcontractApprove: 'vnd.subcontract.approve',
  subcontractPay: 'vnd.subcontract.pay',
} as const;

export const SECURITY_STATES: readonly SecurityState[] = ['RECEIVED', 'CONFIRMED', 'REJECTED', 'FORFEIT_PROPOSED', 'FORFEITED', 'RELEASED', 'EXPIRED'];
export const SECURITY_KINDS: readonly SecurityKind[] = ['BANK_GUARANTEE', 'INSURANCE_BOND', 'CASH_DEPOSIT'];
export const FORFEIT_REASONS = ['WITHDREW_AFTER_CLOSING', 'WITHDREW_BEFORE_VALIDITY_END', 'REFUSED_TO_SIGN', 'NO_PERFORMANCE_SECURITY', 'FALSE_DECLARATION', 'OTHER_BY_BIDDING_DOCUMENT'] as const;
export const SUBCONTRACT_STATES: readonly SubcontractState[] = ['PROPOSED', 'APPROVED', 'REJECTED', 'TERMINATED'];

export type ForfeitReason = (typeof FORFEIT_REASONS)[number];

export const securityTone = (state: SecurityState): Tone => {
  switch (state) {
    case 'CONFIRMED':
      return 'success';
    case 'FORFEITED':
      return 'danger';
    case 'FORFEIT_PROPOSED':
      return 'warning';
    case 'RECEIVED':
      return 'info';
    default:
      return 'neutral';
  }
};

export const subcontractTone = (state: SubcontractState): Tone => (state === 'APPROVED' ? 'success' : state === 'PROPOSED' ? 'info' : 'neutral');

export const expiryTone = (facet: NonNullable<SecurityRow['expiry_facet']>): Tone => (facet === 'EXPIRED' ? 'danger' : facet === 'SECOND' ? 'warning' : 'info');

/** Dong in the grouping of the Vietnamese locale. */
export const money = (value: number): string => new Intl.NumberFormat('vi-VN').format(value);

/** A share of a contract as the server gives it (a number with up to four decimals), said without a trailing zero. */
export const shareText = (value: number): string => `${Number(value.toFixed(4))}%`;

/** The gap between the required amount and the lodged one; zero when the security meets it or none is required. */
export const shortfallOf = (row: Pick<SecurityRow, 'amount' | 'required_amount'>): number => (row.required_amount === null ? 0 : Math.max(0, row.required_amount - row.amount));

/** The share of the contract the prime keeps against its floor: below the floor is shown as a problem. */
export const primeBelowFloor = (list: Pick<SubcontractList, 'prime_share_pct' | 'prime_min_share_pct'>): boolean => list.prime_share_pct < list.prime_min_share_pct;

export const subcontractOverDeclared = (list: Pick<SubcontractList, 'total_share_pct' | 'declaration'>): boolean => list.declaration === null || list.total_share_pct > list.declaration.declared_share_pct;

export const isUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
