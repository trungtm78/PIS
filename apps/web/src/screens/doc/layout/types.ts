/** The permissions of DOC-16 (x-permission in openapi.json). */
export const READ_LAYOUT_PERMISSION = 'doc.template.read';
export const MANAGE_LAYOUT_PERMISSION = 'doc.layout.manage';
export const APPROVE_LAYOUT_PERMISSION = 'doc.layout.approve';

export const LAYOUT_STATUSES = ['DRAFT', 'PUBLISHED', 'SUPERSEDED'] as const;
export type LayoutStatus = (typeof LAYOUT_STATUSES)[number];

/** The thirteen elements of a page that Appendix I sizes, in the order of the table of BR-DOC-13. */
export const ELEMENTS = [
  'nationalTitle',
  'motto',
  'agency',
  'number',
  'placeDate',
  'docTypeName',
  'summary',
  'body',
  'signerTitle',
  'signerName',
  'recipientsLabel',
  'recipientsList',
  'pageNumber',
] as const;
export type Element = (typeof ELEMENTS)[number];

export interface Box {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface ElementStyle {
  sizePt: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
}

/** One revision of a layout profile as `listDocumentLayoutProfiles` returns it; the members the form does not edit are kept as they came, to be sent again. */
export interface LayoutProfile {
  id: string;
  profileCode: string;
  revision: number;
  marginsMm: { top: number; bottom: number; left: number; right: number };
  fontFamily: string;
  fontSubstitute: string | null;
  elementStyles: Record<Element, ElementStyle>;
  signatureLayout: { leaderBox: Box; sealBox: Box };
  numberFieldLayout: Record<string, unknown>;
  watermarkPolicy: Record<string, unknown>;
  legalBasis: string;
  confirmationStatus: 'CONFIRMED' | 'PENDING_CONFIRMATION';
  effectiveFrom: string;
  /** Exclusive: the first day the revision no longer applies. */
  effectiveUntil: string | null;
  status: LayoutStatus;
  createdBy: string;
  approvedBy: string | null;
  version: number;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

function boxOf(value: unknown): Box {
  const raw: Raw = isRecord(value) ? value : {};
  return { xMm: count(raw.xMm), yMm: count(raw.yMm), widthMm: count(raw.widthMm), heightMm: count(raw.heightMm) };
}

function styleOf(value: unknown): ElementStyle {
  const raw: Raw = isRecord(value) ? value : {};
  return { sizePt: count(raw.sizePt), bold: raw.bold === true, italic: raw.italic === true, uppercase: raw.uppercase === true };
}

export function toProfile(raw: unknown): LayoutProfile {
  const row: Raw = isRecord(raw) ? raw : {};
  const margins: Raw = isRecord(row.margins_mm) ? row.margins_mm : {};
  const styles: Raw = isRecord(row.element_styles) ? row.element_styles : {};
  const signature: Raw = isRecord(row.signature_layout) ? row.signature_layout : {};
  return {
    id: text(row.id),
    profileCode: text(row.profile_code),
    revision: count(row.revision),
    marginsMm: { top: count(margins.top), bottom: count(margins.bottom), left: count(margins.left), right: count(margins.right) },
    fontFamily: text(row.font_family),
    fontSubstitute: nullableText(row.font_substitute),
    elementStyles: Object.fromEntries(ELEMENTS.map((name) => [name, styleOf(styles[name])])) as Record<Element, ElementStyle>,
    signatureLayout: { leaderBox: boxOf(signature.leaderBox), sealBox: boxOf(signature.sealBox) },
    numberFieldLayout: isRecord(row.number_field_layout) ? row.number_field_layout : {},
    watermarkPolicy: isRecord(row.watermark_policy) ? row.watermark_policy : {},
    legalBasis: text(row.legal_basis),
    confirmationStatus: row.confirmation_status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
    effectiveFrom: text(row.effective_from),
    effectiveUntil: nullableText(row.effective_until),
    status: oneOf(row.status, LAYOUT_STATUSES, 'DRAFT'),
    createdBy: text(row.created_by),
    approvedBy: nullableText(row.approved_by),
    version: count(row.version),
  };
}
