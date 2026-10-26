import { DomainError } from './errors.ts';

export const ENGAGEMENT_STATUSES = ['PLANNED', 'ONGOING', 'AWAITING_CONCLUSION', 'FOLLOW_UP', 'CLOSED', 'CANCELLED'] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

export const ENGAGEMENT_TYPES = ['ADMINISTRATIVE_INSPECTION', 'SPECIALIZED_INSPECTION', 'STATE_AUDIT', 'INTERNAL_AUDIT', 'SUPERVISORY_CHECK'] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

/** The commands that move an engagement (AUD 4): the first three belong to ST-AUD-001, the others to the stories that record a conclusion and close. */
export type EngagementAction = 'start' | 'endFieldwork' | 'recordConclusion' | 'cancel' | 'close';

interface Edge {
  from: readonly EngagementStatus[];
  to: EngagementStatus;
}

export const ENGAGEMENT_EDGES: Readonly<Record<EngagementAction, Edge>> = {
  start: { from: ['PLANNED'], to: 'ONGOING' },
  endFieldwork: { from: ['ONGOING'], to: 'AWAITING_CONCLUSION' },
  recordConclusion: { from: ['ONGOING', 'AWAITING_CONCLUSION'], to: 'FOLLOW_UP' },
  // A conclusion ends the right to cancel: what the authority concluded is followed up, not withdrawn (the state before it still has none).
  cancel: { from: ['PLANNED', 'ONGOING', 'AWAITING_CONCLUSION'], to: 'CANCELLED' },
  close: { from: ['FOLLOW_UP'], to: 'CLOSED' },
};

/** The states from which a hold is released: an engagement that is over (closed or cancelled) protects nothing any more. */
export const ENDED_STATUSES: readonly EngagementStatus[] = ['CLOSED', 'CANCELLED'];

/** The state a command leads to, or 409 ENGAGEMENT_STATE_INVALID naming the edge that is not there. */
export function nextEngagementStatus(status: EngagementStatus, action: EngagementAction): EngagementStatus {
  const edge = ENGAGEMENT_EDGES[action];
  if (!edge.from.includes(status)) throw new DomainError('ENGAGEMENT_STATE_INVALID', 409, `${status}->${action}`);
  return edge.to;
}

/** The kind of legal hold an engagement places: an audit holds as an AUDIT, an inspection or a supervisory check as an INSPECTION (ADM hold kinds). */
export function holdKindOf(type: EngagementType): 'AUDIT' | 'INSPECTION' {
  return type === 'STATE_AUDIT' || type === 'INTERNAL_AUDIT' ? 'AUDIT' : 'INSPECTION';
}
