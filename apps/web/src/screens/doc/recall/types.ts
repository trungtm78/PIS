import { CHANNELS, DISTRIBUTION_STATUSES } from '../distribution/types';
import type { Channel, DistributionStatus } from '../distribution/types';

/** The permissions of DOC-19 (x-permission in openapi.json). */
export const READ_OUTGOING_PERMISSION = 'doc.outgoing.read';
export const RECALL_PERMISSION = 'doc.outgoing.recall';
export const VOID_PERMISSION = 'doc.outgoing.void_number';

/** The documents in force that can be recalled, the one that was, and the ones whose number can be voided. */
export const RECALLABLE_STATUSES = ['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED'] as const;
export const VOIDABLE_STATUSES = ['NUMBERED', 'SEALED'] as const;
export const QUEUE_STATUSES = ['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'RECALLED', 'NUMBERED', 'SEALED'] as const;
export const DOCUMENT_STATUSES = [...RECALLABLE_STATUSES, ...VOIDABLE_STATUSES, 'RECALLED', 'OTHER'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const EFFECTS = ['PENDING', 'EFFECTIVE', 'RECALLED', 'OTHER'] as const;
export type Effect = (typeof EFFECTS)[number];

export interface QueueRow {
  id: string;
  /** The anchor of the document: what a recall names as its basis, and what the timeline is read by. */
  documentId: string;
  title: string;
  status: DocumentStatus;
  symbol: string | null;
  createdAt: string;
}

export interface QueuePage {
  items: QueueRow[];
  nextCursor: string | undefined;
}

/** A recipient and what is known of the notice of the recall for them. */
export interface NoticeRow {
  id: string;
  recipientName: string;
  channel: Channel;
  status: DistributionStatus;
  recallNoticeAt: string | null;
}

export interface RecallDocument {
  id: string;
  documentId: string;
  title: string;
  status: DocumentStatus;
  effect: Effect;
  version: number;
  symbol: string | null;
  documentNumber: number | null;
  issuedAt: string | null;
  recallReason: string | null;
  recalledAt: string | null;
  recalledBy: string | null;
  distributions: NoticeRow[];
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function toNotice(raw: unknown): NoticeRow {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(row.id),
    recipientName: text(row.recipient_name),
    channel: oneOf(row.channel, CHANNELS, 'PAPER_HANDOVER'),
    status: oneOf(row.status, DISTRIBUTION_STATUSES, 'PENDING'),
    recallNoticeAt: nullableText(row.recall_notice_at),
  };
}

export function toQueueRow(raw: unknown): QueueRow {
  const row: Raw = isRecord(raw) ? raw : {};
  return { id: text(row.id), documentId: text(row.document_id), title: text(row.title), status: oneOf(row.status, DOCUMENT_STATUSES, 'OTHER'), symbol: nullableText(row.symbol), createdAt: text(row.created_at) };
}

export function toQueuePage(raw: unknown): QueuePage {
  const body: Raw = isRecord(raw) ? raw : {};
  return { items: list(body.items).map(toQueueRow), nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : undefined };
}

export function toDocument(raw: unknown): RecallDocument {
  const body: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(body.id),
    documentId: text(body.document_id),
    title: text(body.title),
    status: oneOf(body.status, DOCUMENT_STATUSES, 'OTHER'),
    effect: oneOf(body.effect_status, EFFECTS, 'OTHER'),
    version: count(body.version),
    symbol: nullableText(body.symbol),
    documentNumber: typeof body.document_number === 'number' ? body.document_number : null,
    issuedAt: nullableText(body.issued_at),
    recallReason: nullableText(body.recall_reason),
    recalledAt: nullableText(body.recalled_at),
    recalledBy: nullableText(body.recalled_by),
    distributions: list(body.distributions).map(toNotice),
  };
}
