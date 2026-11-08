import type { RuleView } from '../docaud-support';

/** The read models of the document containers and the transmittals (G4-11), as `doc/transmittal.controller.ts` answers them. */

export const CONTAINER_STATES = ['WIP', 'SHARED', 'PUBLISHED', 'ARCHIVE'] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];
export const PURPOSES = ['FOR_INFORMATION', 'FOR_REVIEW', 'FOR_APPROVAL'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const ANSWERS = ['APPROVED', 'APPROVED_WITH_COMMENTS', 'REJECTED', 'NO_COMMENT'] as const;
export type Answer = (typeof ANSWERS)[number];

export const REASON_MIN = 5;

export interface Container {
  id: string;
  project_id: string;
  document_id: string;
  document_kind: 'DOCUMENT' | 'PROJECT_DOCUMENT';
  revision_label: string;
  title: string;
  content_sha256: string;
  state: ContainerState;
  author_id: string;
  state_changed_at: string;
  version: number;
}

export interface ContainerList {
  as_of: string;
  items: Container[];
  has_more: boolean;
}

export interface Progress {
  required: number;
  answered: number;
  approved?: number;
  rejected: number;
  overdue: number;
  recipients?: number;
  all_required_answered: boolean;
}

export interface ContainerDetail extends Container {
  as_of: string;
  moves: Array<{ id: string; from_state: string | null; to_state: string; actor_id: string; transmittal_id: string | null; reason: string | null; at: string }>;
  latest_review: Progress | null;
}

export interface TransmittalHead {
  id: string;
  project_id: string;
  number: string;
  purpose: Purpose;
  subject: string;
  message: string | null;
  sent_on: string;
  sent_by: string;
  review_days: number | null;
  rule_version: number;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  version: number;
  progress?: Progress | null;
}

export interface TransmittalList {
  as_of: string;
  items: TransmittalHead[];
  has_more: boolean;
}

export interface Inbox {
  as_of: string;
  items: Array<TransmittalHead & { my_due_on: string | null; my_review: { state: string; days_left: number | null } }>;
}

export interface Review {
  state: string;
  due_on: string | null;
  days_left: number | null;
  days_late: number | null;
}

export interface Recipient {
  id: string;
  recipient_id: string;
  required: boolean;
  due_on: string | null;
  extended_due_on: string | null;
  extension_reason: string | null;
  answer: Answer | null;
  answer_comment: string | null;
  answered_on: string | null;
  review: Review;
}

export interface TransmittalDetail extends TransmittalHead {
  as_of: string;
  items: Array<{ id: string; container_id: string; document_id: string; revision_label: string; title: string; content_sha256: string }>;
  recipients: Recipient[];
  progress: Progress & { recipients: number };
}

export const stateTone = (state: string): 'neutral' | 'info' | 'success' | 'warning' => (state === 'PUBLISHED' ? 'success' : state === 'SHARED' ? 'info' : state === 'ARCHIVE' ? 'neutral' : 'warning');

/** The states a container can go to from where it is (the same edges as the database holds). */
export const NEXT_STATES: Readonly<Record<ContainerState, readonly ContainerState[]>> = { WIP: ['SHARED', 'ARCHIVE'], SHARED: ['PUBLISHED', 'WIP', 'ARCHIVE'], PUBLISHED: ['ARCHIVE'], ARCHIVE: [] };

/** A move to Archive, or back from Shared to WIP, says why. */
export const needsReason = (from: ContainerState, to: ContainerState): boolean => to === 'ARCHIVE' || (from === 'SHARED' && to === 'WIP');

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RuleHolder {
  rule?: RuleView;
}

/** One move of a container between states, as getDocContainer writes it (append-only). */
export interface ContainerMove {
  id: string;
  from_state: ContainerState | null;
  to_state: ContainerState;
  actor_id: string;
  transmittal_id: string | null;
  reason: string | null;
  at: string;
}

export interface ContainerDetailRead extends Container {
  as_of: string;
  moves: ContainerMove[];
  /** The answers of the newest review of the container, or null when it was never sent for review. */
  latest_review: { required: number; answered: number; approved: number; rejected: number; overdue: number; all_required_answered: boolean } | null;
}
