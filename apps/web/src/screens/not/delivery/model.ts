import { ApiError } from '@machvon/api-client';

/** Permissions of the operator screens (x-permission in openapi.json). */
export const READ_PERMISSION = 'delivery_attempt.read';
export const REPLAY_PERMISSION = 'notification.replay';
export const OPERATE_PERMISSION = 'notification.operate';

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 2000;
/** Sends per channel: the first and four retries (BR-NOT-03). */
export const MAX_ATTEMPTS = 5;
export const PAGE_SIZE = 25;
/** The waits of the retry schedule, in seconds from the failed send; the first send has none. Each is shown as "about": the server adds up to 20 percent of jitter. */
export const RETRY_OFFSETS_SECONDS: readonly number[] = [0, 30, 120, 600, 1800];

export const ATTEMPT_STATUSES = ['Queued', 'Sending', 'ProviderAccepted', 'Delivered', 'Read', 'Failed', 'Unknown', 'Cancelled', 'Suppressed'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export type FailureClass = 'RETRYABLE' | 'PERMANENT' | 'UNKNOWN';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

/**
 * One send as the operator screens show it (`delivery_attempt` DTO). It carries no address, no message body and no recipient: the answer of
 * the server has none, and this reader would not pick one up if it had.
 */
export interface AttemptView {
  id: string;
  notificationId: string;
  notificationStatus: string;
  notificationVersion: number;
  expiresAt: string;
  ackRequired: boolean;
  acknowledgedAt: string | null;
  channel: string;
  attemptNo: number;
  status: AttemptStatus;
  failureClass: FailureClass | null;
  errorCode: string | null;
  providerMessageId: string | null;
  queuedAt: string;
  nextRetryAt: string | null;
  sendingAt: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  fallbackChannel: string | null;
  needsReconcile: boolean;
  reconcileDueAt: string | null;
}

export interface HistoryView {
  fromStatus: string | null;
  toStatus: string;
  cause: string;
  occurredAt: string;
}

export interface AttemptDetail extends AttemptView {
  journey: AttemptView[];
  history: HistoryView[];
}

const FAILURE_CLASSES: readonly string[] = ['RETRYABLE', 'PERMANENT', 'UNKNOWN'];

export function toAttempt(raw: unknown): AttemptView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const notificationId = text(raw.notification_id);
  const status = text(raw.status);
  const channel = text(raw.channel);
  const queuedAt = text(raw.queued_at);
  const expiresAt = text(raw.expires_at);
  const attemptNo = whole(raw.attempt_no);
  const version = whole(raw.notification_version);
  if (id === undefined || notificationId === undefined || channel === undefined || queuedAt === undefined || expiresAt === undefined || attemptNo === undefined || version === undefined) return undefined;
  if (status === undefined || !(ATTEMPT_STATUSES as readonly string[]).includes(status)) return undefined;
  const failureClass = text(raw.failure_class);
  return {
    id,
    notificationId,
    notificationStatus: text(raw.notification_status) ?? '',
    notificationVersion: version,
    expiresAt,
    ackRequired: raw.ack_required === true,
    acknowledgedAt: nullableText(raw.acknowledged_at),
    channel,
    attemptNo,
    status: status as AttemptStatus,
    failureClass: failureClass !== undefined && FAILURE_CLASSES.includes(failureClass) ? (failureClass as FailureClass) : null,
    errorCode: nullableText(raw.error_code),
    providerMessageId: nullableText(raw.provider_message_id),
    queuedAt,
    nextRetryAt: nullableText(raw.next_retry_at),
    sendingAt: nullableText(raw.sending_at),
    acceptedAt: nullableText(raw.accepted_at),
    deliveredAt: nullableText(raw.delivered_at),
    readAt: nullableText(raw.read_at),
    failedAt: nullableText(raw.failed_at),
    fallbackChannel: nullableText(raw.fallback_channel),
    needsReconcile: raw.needs_reconcile === true,
    reconcileDueAt: nullableText(raw.reconcile_due_at),
  };
}

export function toDetail(raw: unknown): AttemptDetail | undefined {
  const base = toAttempt(raw);
  if (base === undefined || !isRecord(raw)) return undefined;
  const journey = Array.isArray(raw.journey) ? raw.journey.flatMap((item) => toAttempt(item) ?? []) : [];
  const history = Array.isArray(raw.history)
    ? raw.history.flatMap((item): HistoryView[] => {
        if (!isRecord(item)) return [];
        const toStatus = text(item.to_status);
        const cause = text(item.cause);
        const occurredAt = text(item.occurred_at);
        return toStatus === undefined || cause === undefined || occurredAt === undefined ? [] : [{ fromStatus: nullableText(item.from_status), toStatus, cause, occurredAt }];
      })
    : [];
  return { ...base, journey, history };
}

export type MilestoneState = 'delivered' | 'failed' | 'sending' | 'waiting' | 'unreached';

export interface Milestone {
  attemptNo: number;
  offsetSeconds: number;
  state: MilestoneState;
  /** When the send was made, failed, or is due. */
  at: string | null;
  attempt: AttemptView | undefined;
}

/**
 * The five sends of one channel as milestones (NOT 8): the first send and the four retries after 30 seconds, 2, 10 and 30 minutes. A milestone is
 * done or failed when its attempt ended, in flight while it is Sending, waiting while it is queued for a time, and unreached when no attempt has
 * been made for it (the earlier ones succeeded, or the schedule has not got there).
 */
export function milestonesOf(journey: readonly AttemptView[], channel: string): Milestone[] {
  return RETRY_OFFSETS_SECONDS.map((offsetSeconds, index) => {
    const attemptNo = index + 1;
    const attempt = journey.find((candidate) => candidate.channel === channel && candidate.attemptNo === attemptNo);
    if (attempt === undefined) return { attemptNo, offsetSeconds, state: 'unreached', at: null, attempt };
    switch (attempt.status) {
      case 'Queued':
        return { attemptNo, offsetSeconds, state: 'waiting', at: attempt.nextRetryAt ?? attempt.queuedAt, attempt };
      case 'Sending':
        return { attemptNo, offsetSeconds, state: 'sending', at: attempt.sendingAt, attempt };
      case 'Failed':
      case 'Unknown':
      case 'Cancelled':
      case 'Suppressed':
        return { attemptNo, offsetSeconds, state: 'failed', at: attempt.failedAt ?? attempt.sendingAt ?? attempt.queuedAt, attempt };
      case 'ProviderAccepted':
      case 'Delivered':
      case 'Read':
        return { attemptNo, offsetSeconds, state: 'delivered', at: attempt.acceptedAt ?? attempt.sendingAt, attempt };
    }
  });
}

/** The failed queue offers a replay for a notification that ended Failed or Unknown; an Unknown one only after its day of reconciliation. */
export function mayReplay(attempt: AttemptView): boolean {
  return (attempt.notificationStatus === 'Failed' || attempt.notificationStatus === 'Unknown') && !attempt.needsReconcile;
}

/** The queue offers a cancel for a send that has not gone out. */
export function mayCancel(attempt: AttemptView): boolean {
  return attempt.status === 'Queued' && !['Failed', 'Unknown', 'Expired', 'Cancelled', 'Suppressed'].includes(attempt.notificationStatus);
}

/** A replay of an Unknown send whose day is over may send the message twice: the screen says so before the operator confirms. */
export const risksDoubleSend = (attempt: AttemptView): boolean => attempt.notificationStatus === 'Unknown' && !attempt.needsReconcile;

export type ProblemReason = 'reconcile' | 'expired' | 'stateInvalid' | 'conflict' | 'notFound' | 'denied' | 'invalid' | 'session' | 'general';

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  RECONCILE_REQUIRED: 'reconcile',
  NOTIFICATION_EXPIRED: 'expired',
  NOTIFICATION_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'conflict',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  FORBIDDEN: 'denied',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SESSION_EXPIRED: 'session',
};

/** Maps the failure of a replay or a cancel to what the screen says; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemReason {
  return error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general';
}

/** The reason an operator types is trimmed and must be 10 to 2000 characters. */
export const reasonIsValid = (reason: string): boolean => reason.trim().length >= REASON_MIN_LENGTH && reason.trim().length <= REASON_MAX_LENGTH;
