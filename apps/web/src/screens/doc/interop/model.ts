import { ApiError } from '@machvon/api-client';

/** The permissions of DOC-20 (x-permission of the operations in openapi.json); the server judges each command again, over the whole tenant. */
export const READ_PERMISSION = 'doc.interop.read';
export const MANAGE_PERMISSION = 'doc.interop.manage';

export const DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const STATUSES = ['QUEUED', 'SENT', 'ACKED', 'REJECTED', 'FAILED', 'DEAD', 'RECEIVED', 'PROCESSED'] as const;
export type MessageStatus = (typeof STATUSES)[number];

export const ADAPTER_STATUSES = ['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING'] as const;
export type AdapterStatus = (typeof ADAPTER_STATUSES)[number];

/** How many messages the monitor asks for at a time, and the most attempts a message has (a dead message used all of them). */
export const PAGE_SIZE = 50;
export const MAX_ATTEMPTS = 20;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

export const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** One message as the monitor shows it. The envelope, which carries the letter itself, is never part of it. */
export interface InteropMessage {
  id: string;
  direction: Direction;
  status: MessageStatus;
  adapterCode: string;
  adapterStatus: AdapterStatus;
  externalMessageId: string | null;
  senderCode: string | null;
  receiverCode: string | null;
  outgoingDocumentId: string | null;
  incomingDocumentId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  errorCode: string | null;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The server says the message failed or died and can be sent again; the screen adds the session and the permission. */
  canRetry: boolean;
  version: number;
}

export function toMessage(raw: unknown): InteropMessage | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const direction = DIRECTIONS.find((candidate) => candidate === row?.direction);
  const status = STATUSES.find((candidate) => candidate === row?.status);
  const adapterStatus = ADAPTER_STATUSES.find((candidate) => candidate === row?.adapter_status);
  const attempts = whole(row?.attempts);
  const version = whole(row?.version);
  const createdAt = text(row?.created_at);
  const updatedAt = text(row?.updated_at);
  if (row === undefined || id === undefined || direction === undefined || status === undefined || adapterStatus === undefined) return undefined;
  if (attempts === undefined || version === undefined || createdAt === undefined || updatedAt === undefined) return undefined;
  return {
    id,
    direction,
    status,
    adapterCode: text(row.adapter_code) ?? '',
    adapterStatus,
    externalMessageId: nullableText(row.external_message_id),
    senderCode: nullableText(row.sender_code),
    receiverCode: nullableText(row.receiver_code),
    outgoingDocumentId: nullableText(row.outgoing_document_id),
    incomingDocumentId: nullableText(row.incoming_document_id),
    attempts,
    nextAttemptAt: nullableText(row.next_attempt_at),
    errorCode: nullableText(row.error_code),
    processedAt: nullableText(row.processed_at),
    createdAt,
    updatedAt,
    canRetry: asRecord(row.actions)?.retry === true,
    version,
  };
}

export interface MessagePage {
  items: InteropMessage[];
  next: string | undefined;
  asOf: string;
}

export function toPage(raw: unknown): MessagePage {
  const body = asRecord(raw);
  const items = body?.items;
  return {
    items: Array.isArray(items) ? items.flatMap((item) => toMessage(item) ?? []) : [],
    next: typeof body?.next_cursor === 'string' ? body.next_cursor : undefined,
    asOf: text(body?.as_of) ?? '',
  };
}

export interface Filter {
  status: '' | MessageStatus;
  direction: '' | Direction;
}

export const NO_FILTER: Filter = { status: '', direction: '' };

/** The query of the read: only what is narrowed travels, the page size always does. */
export function queryOf(filter: Filter, cursor: string | undefined): Record<string, string | number> {
  return {
    limit: PAGE_SIZE,
    ...(filter.status === '' ? {} : { status: filter.status }),
    ...(filter.direction === '' ? {} : { direction: filter.direction }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Whether the caller is offered to send a message again: it failed or died, the session is not read-only, the right is held and the server said so. */
export function mayRetry(message: InteropMessage, permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean {
  return mode !== 'READ_ONLY' && holds(permissions, MANAGE_PERMISSION) && message.canRetry && (message.status === 'FAILED' || message.status === 'DEAD');
}

/** Where a message leads: the distributions of the outgoing document it carries (DOC-08), or the incoming letter it made (DOC-13); nowhere for a message that has neither. */
export function linkOf(message: InteropMessage): string | undefined {
  if (message.outgoingDocumentId !== null) return `/doc/doc-08?doc=${encodeURIComponent(message.outgoingDocumentId)}`;
  if (message.incomingDocumentId !== null) return `/doc/doc-13?id=${encodeURIComponent(message.incomingDocumentId)}`;
  return undefined;
}

export type Problem = 'versionConflict' | 'stateInvalid' | 'notFound' | 'denied' | 'session' | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return 'versionConflict';
    case 'INTEROP_STATE_INVALID':
      return 'stateInvalid';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}
