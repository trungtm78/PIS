import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';

/** BID-34: the recorded outcome of a petition of a contractor (PORTAL-2). The shapes are the contract's. */
type S = components['schemas'];
export type OutcomeLine = S['BidPetitionOutcomeLine'];
export type OutcomeList = S['BidPetitionOutcomeList'];
export type Decision = OutcomeLine['outcome'];
export type OutcomeStatus = OutcomeLine['status'];

export const OUTCOME_PERMISSION = { record: 'bid.petition.outcome.record', confirm: 'bid.petition.outcome.confirm' } as const;

export const DECISIONS: readonly Decision[] = ['UPHELD', 'REJECTED', 'WITHDRAWN'];
export const OUTCOME_STATUSES: readonly OutcomeStatus[] = ['PROPOSED', 'CONFIRMED', 'RETURNED'];

const STATUS_TONE: Readonly<Record<OutcomeStatus, Tone>> = { PROPOSED: 'info', CONFIRMED: 'success', RETURNED: 'warning' };
const STATUS_ICON: Readonly<Record<OutcomeStatus, string>> = { PROPOSED: '○', CONFIRMED: '✓', RETURNED: '↩' };
export const outcomeTone = (status: OutcomeStatus): Tone => STATUS_TONE[status];
export const outcomeIcon = (status: OutcomeStatus): string => STATUS_ICON[status];

/** Only a confirmed decision enters the dispute figures; the screen says so next to the status. */
export const feedsFigures = (status: OutcomeStatus): boolean => status === 'CONFIRMED';
