/** The permissions of the three separate steps of a template (x-permission in openapi.json). */
export const MANAGE_TEMPLATES_PERMISSION = 'doc.template.manage';
export const APPROVE_TEMPLATES_PERMISSION = 'doc.template.approve';
export const CONFIRM_TEMPLATES_PERMISSION = 'doc.template.confirm_legal';

export const TEMPLATE_GROUPS = ['DECISION', 'OFFICIAL_LETTER', 'REPORT_DISBURSEMENT', 'REPORT_MONITORING', 'TREASURY_FORM', 'SETTLEMENT_FORM', 'AUDIT_FOLLOWUP', 'OTHER'] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];
export const TEMPLATE_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'SUPERSEDED', 'RETIRED'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
export type ConfirmationStatus = 'CONFIRMED' | 'PENDING_CONFIRMATION';

/** One revision of a template as `listDocumentTemplates` returns it. */
export interface Template {
  id: string;
  templateCode: string;
  revision: number;
  groupCode: TemplateGroup;
  docTypeCode: string;
  formCode: string | null;
  title: string;
  sourceModule: string | null;
  legalBasis: string;
  legalConfirmationRef: string | null;
  confirmationStatus: ConfirmationStatus;
  watermarkText: string | null;
  /** The legal confirmations the legal basis and the watermark name, e.g. `CXN-10`. */
  cxnRefs: string[];
  origin: 'PLATFORM_PACK' | 'TENANT';
  packVersion: string | null;
  layoutConfirmationStatus: ConfirmationStatus | null;
  rendersWatermarked: boolean;
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  status: TemplateStatus;
  version: number;
  createdBy: string;
  approvedBy: string | null;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;
const confirmation = (value: unknown): ConfirmationStatus => (value === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_CONFIRMATION');

export function toTemplate(raw: unknown): Template {
  const row: Raw = isRecord(raw) ? raw : {};
  const status = confirmation(row.confirmation_status);
  const layout = row.layout_confirmation_status === undefined || row.layout_confirmation_status === null ? null : confirmation(row.layout_confirmation_status);
  return {
    id: text(row.id),
    templateCode: text(row.template_code),
    revision: count(row.revision),
    groupCode: oneOf(row.group_code, TEMPLATE_GROUPS, 'OTHER'),
    docTypeCode: text(row.doc_type_code),
    formCode: nullableText(row.form_code),
    title: text(row.title),
    sourceModule: nullableText(row.source_module),
    legalBasis: text(row.legal_basis),
    legalConfirmationRef: nullableText(row.legal_confirmation_ref),
    confirmationStatus: status,
    watermarkText: nullableText(row.watermark_text),
    cxnRefs: Array.isArray(row.cxn_refs) ? row.cxn_refs.filter((item): item is string => typeof item === 'string') : [],
    origin: row.origin === 'TENANT' ? 'TENANT' : 'PLATFORM_PACK',
    packVersion: nullableText(row.pack_version),
    layoutConfirmationStatus: layout,
    rendersWatermarked: typeof row.renders_watermarked === 'boolean' ? row.renders_watermarked : status !== 'CONFIRMED',
    effectiveFrom: text(row.effective_from),
    effectiveUntil: nullableText(row.effective_until),
    status: oneOf(row.status, TEMPLATE_STATUSES, 'DRAFT'),
    version: count(row.version),
    createdBy: text(row.created_by),
    approvedBy: nullableText(row.approved_by),
  };
}

export interface TemplatePage {
  items: Template[];
  nextCursor: string | undefined;
}

export function toTemplatePage(raw: unknown): TemplatePage {
  const page: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(page.items) ? page.items.map(toTemplate) : [],
    nextCursor: typeof page.next_cursor === 'string' ? page.next_cursor : undefined,
  };
}
