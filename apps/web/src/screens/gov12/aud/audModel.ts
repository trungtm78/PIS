import type { RuleView } from '../docaud-support';

/** The read models of the investor standing (G4-10), the anonymous channel and the gifts register (G4-12), as the controllers of the AUD module answer them. */

export const REASON_MIN = 5;
export const NOTE_MIN = 10;

export interface StandingRule extends RuleView {
  weights: { overdue: number; disputed: number; open: number; money: number };
  money_step_vnd: string;
}

export interface Standing {
  unit_id: string;
  unit_code: string | null;
  unit_name: string | null;
  follow_up_rank: number | null;
  score: number;
  total: number;
  open: number;
  overdue: number;
  disputed: number;
  closed: number;
  closed_pct: number | null;
  owed_vnd: string;
  disbursement_rank: number | null;
  disbursement_rate_pct: string | null;
}

export interface StandingList {
  as_of: string;
  ranking_as_of: string | null;
  rule: StandingRule;
  items: Standing[];
}

export interface Profile extends Standing {
  as_of: string;
  ranking_as_of: string | null;
  ranked_units: number;
  rule: StandingRule;
  recommendations: Array<{ id: string; code: string; type: string; status: string; due_on: string | null; amount_vnd: string | null; recovered_vnd: string; project_id: string | null; overdue: boolean }>;
}

export const WHISTLE_STATUSES = ['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'] as const;
export type WhistleStatus = (typeof WHISTLE_STATUSES)[number];
export type WhistleMove = 'ACKNOWLEDGE' | 'INVESTIGATE' | 'RESOLVE' | 'DISMISS';

export interface WhistleClock {
  acknowledge_due_on: string;
  acknowledge_state: 'DONE_ON_TIME' | 'DONE_LATE' | 'WAITING' | 'OVERDUE';
  resolve_due_on: string;
  resolve_state: 'DONE_ON_TIME' | 'DONE_LATE' | 'WAITING' | 'OVERDUE';
}

export interface Whistle {
  id: string;
  category: string;
  status: WhistleStatus;
  received_on: string;
  subject_unit_id: string | null;
  handler_id: string | null;
  acknowledged_on: string | null;
  closed_on: string | null;
  clock: WhistleClock;
  version: number;
}

export interface WhistleList {
  as_of: string;
  items: Whistle[];
  has_more: boolean;
}

export interface WhistleSummary {
  as_of: string;
  total: number;
  open: number;
  acknowledge_overdue: number;
  resolve_overdue: number;
}

export interface WhistleDetail extends Whistle {
  as_of: string;
  body: string;
  public_note: string | null;
  thread: Array<{ seq: number; sender: 'REPORTER' | 'HANDLER'; body: string; sent_on: string; handler_id: string | null }>;
}

/** The moves a status allows (the same edges as the kernel). */
export const MOVES: Readonly<Record<WhistleStatus, readonly WhistleMove[]>> = {
  RECEIVED: ['ACKNOWLEDGE', 'DISMISS'],
  ACKNOWLEDGED: ['INVESTIGATE', 'DISMISS'],
  INVESTIGATING: ['RESOLVE', 'DISMISS'],
  RESOLVED: [],
  DISMISSED: [],
};

/** A resolution or a dismissal says why, in words the reporter reads. */
export const moveNeedsNote = (move: WhistleMove): boolean => move === 'RESOLVE' || move === 'DISMISS';

export const GIFT_STATUSES = ['DECLARED', 'UNDER_REVIEW', 'CLOSED'] as const;
export type GiftStatus = (typeof GIFT_STATUSES)[number];
export const GIVER_KINDS = ['CONTRACTOR', 'SUPPLIER', 'OFFICIAL', 'COMMUNITY', 'OTHER'] as const;
export const OUTCOMES = ['KEPT', 'RETURNED', 'HANDED_TO_UNIT'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Gift {
  id: string;
  recipient_id: string;
  declared_by: string;
  giver_name: string;
  giver_kind: string;
  project_id: string | null;
  description: string;
  value_vnd: string;
  received_on: string;
  declared_on: string;
  status: GiftStatus;
  reviewer_id: string | null;
  outcome: Outcome | null;
  outcome_note: string | null;
  closed_on: string | null;
  flags: { late: boolean; declare_due_on: string; needs_review: boolean; may_be_kept: boolean };
  rule_version: number;
  version: number;
}

export interface GiftList {
  as_of: string;
  items: Gift[];
  has_more: boolean;
  rule: RuleView & { declare_within_days: number; review_over_vnd: string; keep_up_to_vnd: string };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
