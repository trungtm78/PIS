import { ApiError } from '@machvon/api-client';

/** Permission of the replay (x-permission of replayInboxEvent in openapi.json). */
export const OPERATE_INTEGRATION_PERMISSION = 'adm.integration.operate';
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 2000;

export type InboxStatus = 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DEAD';
export const INBOX_STATUSES: readonly InboxStatus[] = ['RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

/**
 * An event of the integration inbox as the sync monitor shows it. It carries no payload and no reference to one: the monitor never reads
 * either, whatever the answer holds, so a payload can never reach the screen (AC-ST-ADM-018-4). Whether it is still kept says whether it can be replayed.
 */
export interface InboxEventView {
  id: string;
  provider: string;
  eventKey: string;
  eventType: string | null;
  /** The channel account a webhook event is for (OMNI-11 shows the events of the channels); none for the events of the other providers. */
  channelAccountId: string | null;
  status: InboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  receivedAt: string;
  processedAt: string | null;
  payloadKept: boolean;
  replayCount: number;
  version: number;
}

export function toInboxEvent(raw: unknown): InboxEventView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = text(raw.id);
  const provider = text(raw.provider);
  const eventKey = text(raw.event_key);
  const status = text(raw.status);
  const receivedAt = text(raw.received_at);
  const attempts = whole(raw.attempts);
  const version = whole(raw.version);
  if (id === undefined || provider === undefined || eventKey === undefined || receivedAt === undefined || attempts === undefined || version === undefined) return undefined;
  if (status === undefined || !(INBOX_STATUSES as readonly string[]).includes(status)) return undefined;
  return {
    id,
    provider,
    eventKey,
    eventType: nullableText(raw.provider_event_type),
    channelAccountId: nullableText(raw.channel_account_id),
    status: status as InboxStatus,
    attempts,
    nextAttemptAt: nullableText(raw.next_attempt_at),
    errorCode: nullableText(raw.error_code),
    receivedAt,
    processedAt: nullableText(raw.processed_at),
    payloadKept: raw.payload_kept !== false,
    replayCount: whole(raw.replay_count) ?? 0,
    version,
  };
}

/** Whether the replay can take the event up again: it failed or is dead, and its payload is still there. */
export function mayReplay(event: InboxEventView): boolean {
  return (event.status === 'FAILED' || event.status === 'DEAD') && event.payloadKept;
}

export type ProblemReason = 'stateInvalid' | 'conflict' | 'notFound' | 'denied' | 'invalid' | 'session' | 'general';

export interface ProblemView {
  reason: ProblemReason;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  INBOX_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'conflict',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SESSION_EXPIRED: 'session',
};

/** Maps the error of the replay to what the screen shows; an unknown failure is the general message. */
export function describeProblem(error: unknown): ProblemView {
  return { reason: error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general' };
}
