/** The permissions of the drafting and review screens (x-permission in openapi.json). */
export const READ_DOCUMENTS_PERMISSION = 'doc.outgoing.read';
export const CREATE_DOCUMENT_PERMISSION = 'doc.outgoing.create';
export const EDIT_DOCUMENT_PERMISSION = 'doc.outgoing.edit';
export const SUBMIT_DOCUMENT_PERMISSION = 'doc.outgoing.submit';
export const REVIEW_DOCUMENT_PERMISSION = 'doc.outgoing.review';
export const CANCEL_DOCUMENT_PERMISSION = 'doc.outgoing.cancel';
export const RENDER_PERMISSION = 'doc.render';

export const DOCUMENT_STATUSES = [
  'DRAFT',
  'IN_REVIEW',
  'SUBMITTED',
  'SIGNED',
  'NUMBERED',
  'SEALED',
  'ISSUED',
  'DELIVERED',
  'ACKNOWLEDGED',
  'FILED',
  'ARCHIVED',
  'CANCELLED',
  'RECALLED',
  'REPLACED',
  'CORRECTED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const URGENCIES = ['NORMAL', 'KHAN', 'THUONG_KHAN', 'HOA_TOC'] as const;
export type Urgency = (typeof URGENCIES)[number];
export const CIRCULATIONS = ['INTERNAL_CIRCULATION', 'PUBLIC'] as const;
export type Circulation = (typeof CIRCULATIONS)[number];
export const SIGNING_MODES = ['DIRECT', 'KT', 'TM', 'TL', 'TUQ'] as const;
export type SigningMode = (typeof SIGNING_MODES)[number];
export const RECIPIENT_KINDS = ['EXTERNAL_AGENCY', 'INTERNAL_UNIT', 'PERSON'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];
export const EFFECT_STATUSES = ['PENDING', 'EFFECTIVE', 'RECALLED', 'REPLACED', 'CORRECTED', 'EXPIRED'] as const;
export type EffectStatus = (typeof EFFECT_STATUSES)[number];
export const CANCEL_CODES = ['CANCELLED_BY_DRAFTER', 'REJECTED_BY_LEADER', 'SUPERSEDED_BEFORE_ISSUE', 'SOURCE_WITHDRAWN'] as const;
export type CancelCode = (typeof CANCEL_CODES)[number];

/** The items the reviewer confirms (DOC.md F3); the same keys as the server's catalogue. */
export const REVIEW_CHECKLIST = ['national_title', 'motto', 'agency_name', 'number_symbol', 'summary', 'body', 'signer_title', 'recipients'] as const;
export type ChecklistKey = (typeof REVIEW_CHECKLIST)[number];

export interface Recipient {
  kind: RecipientKind;
  name: string;
  code: string | undefined;
  unitId: string | undefined;
}

/** One outgoing document as the list of DOC-03 and the queue of DOC-04 carry it. */
export interface DraftRow {
  id: string;
  documentId: string;
  title: string;
  docTypeCode: string;
  status: DocumentStatus;
  effectStatus: EffectStatus;
  urgency: Urgency;
  draftingUnitId: string;
  drafterUserId: string;
  signerUserId: string | null;
  signingMode: SigningMode;
  delegationId: string | null;
  documentNumber: number | null;
  symbol: string | null;
  issuedOn: string | null;
  sourceModule: string | null;
  createdAt: string;
  version: number;
}

export interface ReviewRecord {
  kind: 'REVIEW_APPROVED' | 'RETURNED';
  actorId: string;
  comment: string | null;
  checklist: Partial<Record<ChecklistKey, boolean>> | null;
  fileSha256: string | null;
  occurredAt: string;
}

export interface VersionBrief {
  id: string;
  stage: string;
  checksum: string;
  pageCount: number;
}

export interface DraftDetail extends DraftRow {
  templateId: string | null;
  signerTitle: string | null;
  reviewDueOn: string | null;
  cancelReason: string | null;
  payloadSha256: string | null;
  circulation: Circulation;
  payload: Record<string, unknown>;
  recipients: Recipient[];
  latestReview: ReviewRecord | null;
  currentVersionId: string | null;
  versions: VersionBrief[];
}

export interface DraftPage {
  items: DraftRow[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const nullableCount = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function toRow(raw: unknown): DraftRow {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(row.id),
    documentId: text(row.document_id),
    title: text(row.title),
    docTypeCode: text(row.doc_type_code),
    status: oneOf(row.status, DOCUMENT_STATUSES, 'DRAFT'),
    effectStatus: oneOf(row.effect_status, EFFECT_STATUSES, 'PENDING'),
    urgency: oneOf(row.urgency, URGENCIES, 'NORMAL'),
    draftingUnitId: text(row.drafting_unit_id),
    drafterUserId: text(row.drafter_user_id),
    signerUserId: nullableText(row.signer_user_id),
    signingMode: oneOf(row.signing_mode, SIGNING_MODES, 'DIRECT'),
    delegationId: nullableText(row.delegation_id),
    documentNumber: nullableCount(row.document_number),
    symbol: nullableText(row.symbol),
    issuedOn: nullableText(row.issued_on),
    sourceModule: nullableText(row.source_module),
    createdAt: text(row.created_at),
    version: count(row.version),
  };
}

export function toPage(raw: unknown): DraftPage {
  const page: Raw = isRecord(raw) ? raw : {};
  return { items: list(page.items).map(toRow), nextCursor: typeof page.next_cursor === 'string' ? page.next_cursor : undefined };
}

function toRecipient(raw: unknown): Recipient {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    kind: oneOf(row.kind, RECIPIENT_KINDS, 'EXTERNAL_AGENCY'),
    name: text(row.name),
    code: typeof row.code === 'string' ? row.code : undefined,
    unitId: typeof row.unit_id === 'string' ? row.unit_id : undefined,
  };
}

function toReview(raw: unknown): ReviewRecord | null {
  if (!isRecord(raw)) return null;
  const checklist = isRecord(raw.checklist) ? raw.checklist : undefined;
  return {
    kind: raw.kind === 'RETURNED' ? 'RETURNED' : 'REVIEW_APPROVED',
    actorId: text(raw.actor_id),
    comment: nullableText(raw.comment),
    checklist: checklist === undefined ? null : Object.fromEntries(REVIEW_CHECKLIST.map((key) => [key, checklist[key] === true])),
    fileSha256: nullableText(raw.file_sha256),
    occurredAt: text(raw.occurred_at),
  };
}

export function toDetail(raw: unknown): DraftDetail {
  const body: Raw = isRecord(raw) ? raw : {};
  return {
    ...toRow(body),
    templateId: nullableText(body.template_id),
    signerTitle: nullableText(body.signer_title),
    reviewDueOn: nullableText(body.review_due_on),
    cancelReason: nullableText(body.cancel_reason),
    payloadSha256: nullableText(body.payload_sha256),
    circulation: oneOf(body.circulation, CIRCULATIONS, 'INTERNAL_CIRCULATION'),
    payload: isRecord(body.payload) ? body.payload : {},
    recipients: list(body.recipients).map(toRecipient),
    latestReview: toReview(body.latest_review),
    currentVersionId: nullableText(body.current_version_id),
    versions: list(body.versions).map((version) => {
      const row: Raw = isRecord(version) ? version : {};
      return { id: text(row.id), stage: text(row.stage), checksum: text(row.checksum), pageCount: count(row.page_count) };
    }),
  };
}
