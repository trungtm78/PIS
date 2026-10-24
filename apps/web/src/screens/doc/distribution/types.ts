/** The permissions of DOC-08 (x-permission in openapi.json). */
export const READ_OUTGOING_PERMISSION = 'doc.outgoing.read';
export const ISSUE_PERMISSION = 'doc.outgoing.issue';
export const DISTRIBUTE_PERMISSION = 'doc.distribution.manage';
export const CONFIRM_LEGAL_PERMISSION = 'doc.template.confirm_legal';

/** The states of a document this screen works with: sealed (waiting to be issued) and issued (being distributed). */
export const QUEUE_STATUSES = ['SEALED', 'ISSUED', 'DELIVERED'] as const;
export const DOCUMENT_STATUSES = ['SEALED', 'ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'OTHER'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const CHANNELS = ['INTERNAL', 'EMAIL', 'PAPER_HANDOVER', 'LGSP'] as const;
export type Channel = (typeof CHANNELS)[number];
/** The channels the server takes in the first release: LGSP waits for another story and is never offered. */
export const DISPATCH_CHANNELS = ['INTERNAL', 'EMAIL', 'PAPER_HANDOVER'] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];

export const DISTRIBUTION_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED', 'CANCELLED'] as const;
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];

export const RECIPIENT_KINDS = ['INTERNAL_UNIT', 'EXTERNAL_AGENCY', 'PERSON'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

/** One recipient printed on the document ("Noi nhan"): a dispatch goes only to these. */
export interface DocumentRecipient {
  kind: RecipientKind;
  name: string;
  code: string | null;
  unitId: string | null;
}

export interface DistributionRow {
  id: string;
  recipientKind: RecipientKind;
  recipientName: string;
  recipientCode: string | null;
  channel: Channel;
  status: DistributionStatus;
  acknowledgementRequired: boolean;
  sentAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  externalRef: string | null;
  attempts: number;
  errorCode: string | null;
  version: number;
}

export interface QueueRow {
  id: string;
  title: string;
  status: DocumentStatus;
  symbol: string | null;
  createdAt: string;
}

export interface QueuePage {
  items: QueueRow[];
  nextCursor: string | undefined;
}

/** One outgoing document as the issue and distribution screen needs it. */
export interface DistributionDocument {
  id: string;
  title: string;
  status: DocumentStatus;
  version: number;
  symbol: string | null;
  documentNumber: number | null;
  issuedOn: string | null;
  currentVersionId: string | null;
  sealedAt: string | null;
  issuedAt: string | null;
  recipients: DocumentRecipient[];
  distributions: DistributionRow[];
  /** The template (or its layout) still waits for its legal confirmation: issuing needs the written reason of a legal officer. */
  rendersWatermarked: boolean;
  overrideReason: string | null;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function toRecipient(raw: unknown): DocumentRecipient {
  const row: Raw = isRecord(raw) ? raw : {};
  return { kind: oneOf(row.kind, RECIPIENT_KINDS, 'EXTERNAL_AGENCY'), name: text(row.name), code: nullableText(row.code), unitId: nullableText(row.unit_id) };
}

function toDistribution(raw: unknown): DistributionRow {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(row.id),
    recipientKind: oneOf(row.recipient_kind, RECIPIENT_KINDS, 'EXTERNAL_AGENCY'),
    recipientName: text(row.recipient_name),
    recipientCode: nullableText(row.recipient_code),
    channel: oneOf(row.channel, CHANNELS, 'PAPER_HANDOVER'),
    status: oneOf(row.status, DISTRIBUTION_STATUSES, 'PENDING'),
    acknowledgementRequired: row.acknowledgement_required !== false,
    sentAt: nullableText(row.sent_at),
    deliveredAt: nullableText(row.delivered_at),
    acknowledgedAt: nullableText(row.acknowledged_at),
    externalRef: nullableText(row.external_ref),
    attempts: count(row.attempts),
    errorCode: nullableText(row.error_code),
    version: count(row.version),
  };
}

export function toQueueRow(raw: unknown): QueueRow {
  const row: Raw = isRecord(raw) ? raw : {};
  return { id: text(row.id), title: text(row.title), status: oneOf(row.status, DOCUMENT_STATUSES, 'OTHER'), symbol: nullableText(row.symbol), createdAt: text(row.created_at) };
}

export function toQueuePage(raw: unknown): QueuePage {
  const body: Raw = isRecord(raw) ? raw : {};
  return { items: list(body.items).map(toQueueRow), nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : undefined };
}

export function toDocument(raw: unknown): DistributionDocument {
  const body: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(body.id),
    title: text(body.title),
    status: oneOf(body.status, DOCUMENT_STATUSES, 'OTHER'),
    version: count(body.version),
    symbol: nullableText(body.symbol),
    documentNumber: typeof body.document_number === 'number' ? body.document_number : null,
    issuedOn: nullableText(body.issued_on),
    currentVersionId: nullableText(body.current_version_id),
    sealedAt: nullableText(body.sealed_at),
    issuedAt: nullableText(body.issued_at),
    recipients: list(body.recipients).map(toRecipient),
    distributions: list(body.distributions).map(toDistribution),
    rendersWatermarked: body.renders_watermarked === true,
    overrideReason: nullableText(body.unconfirmed_override_reason),
  };
}
