import { DomainError } from './errors.ts';

export type ElementName =
  | 'nationalTitle'
  | 'motto'
  | 'agency'
  | 'number'
  | 'placeDate'
  | 'docTypeName'
  | 'summary'
  | 'body'
  | 'signerTitle'
  | 'signerName'
  | 'recipientsLabel'
  | 'recipientsList'
  | 'pageNumber';

export interface ElementStyle {
  sizePt: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
}

export interface Box {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
}

export interface SignatureLayout {
  leaderBox: Box;
  sealBox: Box;
}

export interface NumberFieldLayout {
  number: Box;
  symbol: Box;
  date: Box;
}

export interface WatermarkPolicy {
  /** Text drawn on every page while the profile or the template is not confirmed (BR-DOC-10). */
  text: string;
}

/** A `document_layout_profile` as the renderer needs it (Decree 30/2020 Appendix I as data, BR-DOC-13). */
export interface LayoutProfile {
  code: string;
  revision: number;
  pageSize: 'A4';
  marginsMm: { top: number; bottom: number; left: number; right: number };
  fontFamily: string;
  fontSubstitute?: string;
  elementStyles: Record<ElementName, ElementStyle>;
  signatureLayout: SignatureLayout;
  numberFieldLayout: NumberFieldLayout;
  watermarkPolicy: WatermarkPolicy;
  confirmationStatus: 'CONFIRMED' | 'PENDING_CONFIRMATION';
}

interface Range {
  min: number;
  max: number;
}

const MARGIN_RANGES: Readonly<Record<keyof LayoutProfile['marginsMm'], Range>> = {
  top: { min: 20, max: 25 },
  bottom: { min: 20, max: 25 },
  left: { min: 30, max: 35 },
  right: { min: 15, max: 20 },
};

const SIZE_RANGES: Readonly<Record<ElementName, Range>> = {
  nationalTitle: { min: 12, max: 13 },
  motto: { min: 13, max: 14 },
  agency: { min: 12, max: 13 },
  number: { min: 13, max: 14 },
  placeDate: { min: 13, max: 14 },
  docTypeName: { min: 13, max: 14 },
  summary: { min: 13, max: 14 },
  body: { min: 13, max: 14 },
  signerTitle: { min: 13, max: 14 },
  signerName: { min: 13, max: 14 },
  recipientsLabel: { min: 12, max: 12 },
  recipientsList: { min: 11, max: 11 },
  pageNumber: { min: 13, max: 14 },
};

const ELEMENT_NAMES = Object.keys(SIZE_RANGES) as ElementName[];

/** The seal of the organisation lies over a third of the signature of the leader, on its left (BR-DOC-13): the share of the width of the signature that the seal covers, and what it may differ by. */
export const SEAL_OVERLAP_TARGET = 1 / 3;
export const SEAL_OVERLAP_TOLERANCE = 0.03;

/** The share of the width of the leader's signature box that the seal box covers, side to side; 0 when they do not meet. */
export function sealOverlapRatio(layout: SignatureLayout): number {
  const { leaderBox, sealBox } = layout;
  const covered = Math.min(sealBox.xMm + sealBox.widthMm, leaderBox.xMm + leaderBox.widthMm) - Math.max(sealBox.xMm, leaderBox.xMm);
  return leaderBox.widthMm > 0 ? Math.max(0, covered) / leaderBox.widthMm : 0;
}

/** Whether the two boxes meet up and down as well as side to side, and have a size: a seal that is beside the signature, not over it, is no seal over it. */
export function sealMeetsSignature(layout: SignatureLayout): boolean {
  const { leaderBox, sealBox } = layout;
  const sized = [leaderBox.widthMm, leaderBox.heightMm, sealBox.widthMm, sealBox.heightMm].every((size) => size > 0);
  const high = Math.min(sealBox.yMm + sealBox.heightMm, leaderBox.yMm + leaderBox.heightMm) - Math.max(sealBox.yMm, leaderBox.yMm);
  return sized && high > 0;
}

const style = (sizePt: number, flags: Partial<Omit<ElementStyle, 'sizePt'>> = {}): ElementStyle => ({
  sizePt,
  bold: flags.bold ?? false,
  italic: flags.italic ?? false,
  uppercase: flags.uppercase ?? false,
});

/** The default profile of the table of BR-DOC-13 (legal text still to be confirmed against the original: CXN-DOC-01). */
export const ND30_A4_STANDARD: LayoutProfile = {
  code: 'ND30_A4_STANDARD',
  revision: 1,
  pageSize: 'A4',
  marginsMm: { top: 20, bottom: 20, left: 30, right: 15 },
  fontFamily: 'Times New Roman',
  fontSubstitute: 'Tinos',
  elementStyles: {
    nationalTitle: style(13, { bold: true, uppercase: true }),
    motto: style(14, { bold: true }),
    agency: style(13, { bold: true, uppercase: true }),
    number: style(13),
    placeDate: style(14, { italic: true }),
    docTypeName: style(14, { bold: true, uppercase: true }),
    summary: style(14, { bold: true }),
    body: style(14),
    signerTitle: style(14, { bold: true, uppercase: true }),
    signerName: style(14, { bold: true }),
    recipientsLabel: style(12, { bold: true, italic: true }),
    recipientsList: style(11),
    pageNumber: style(14),
  },
  signatureLayout: {
    leaderBox: { xMm: 110, yMm: 215, widthMm: 70, heightMm: 40 },
    sealBox: { xMm: 95, yMm: 225, widthMm: 40, heightMm: 40 },
  },
  numberFieldLayout: {
    number: { xMm: 30, yMm: 42, widthMm: 40, heightMm: 6 },
    symbol: { xMm: 70, yMm: 42, widthMm: 50, heightMm: 6 },
    date: { xMm: 125, yMm: 50, widthMm: 60, heightMm: 6 },
  },
  // The watermark of BR-DOC-10 is Vietnamese ("awaiting confirmation"); escaped so the source stays English-only.
  watermarkPolicy: { text: 'CHO X\u00c1C NH\u1eacN' },
  confirmationStatus: 'PENDING_CONFIRMATION',
};

function outOfRange(field: string): DomainError {
  return new DomainError('LAYOUT_OUT_OF_LEGAL_RANGE', 422, field);
}

function stateInvalid(field: string): DomainError {
  return new DomainError('LAYOUT_STATE_INVALID', 409, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BOX_FIELDS = ['xMm', 'yMm', 'widthMm', 'heightMm'] as const;

/** The page is A4, 210 x 297 mm: a box of the signature or of the number fields has a size and lies on it, or the widget it places is not on the page. */
export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;

export const boxOnPage = (box: Box): boolean => box.widthMm > 0 && box.heightMm > 0 && box.xMm >= 0 && box.yMm >= 0 && box.xMm + box.widthMm <= PAGE_WIDTH_MM && box.yMm + box.heightMm <= PAGE_HEIGHT_MM;

/** A box of the signature or number layout must be an object of four finite numbers: the renderer and the form place it. */
function assertBox(value: unknown, field: string): void {
  if (!isRecord(value) || BOX_FIELDS.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw stateInvalid(field);
}

/**
 * Refuses a profile whose margins or sizes leave the ranges of BR-DOC-13 (a profile is data: this is the guard). A member
 * of the stored JSON that is not the object it should be is LAYOUT_STATE_INVALID, never a native error.
 */
export function assertLayoutWithinLegalRange(profile: LayoutProfile): void {
  if (profile.pageSize !== 'A4') throw outOfRange('pageSize');
  for (const [name, range] of Object.entries(MARGIN_RANGES) as [keyof LayoutProfile['marginsMm'], Range][]) {
    const value = profile.marginsMm[name];
    if (!Number.isFinite(value) || value < range.min || value > range.max) throw outOfRange(`marginsMm.${name}`);
  }
  if (!isRecord(profile.elementStyles)) throw stateInvalid('elementStyles');
  for (const name of ELEMENT_NAMES) {
    const element = profile.elementStyles[name] as unknown;
    if (element === undefined) throw outOfRange(`elementStyles.${name}`);
    if (!isRecord(element)) throw stateInvalid(`elementStyles.${name}`);
    const range = SIZE_RANGES[name];
    const size = element.sizePt;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < range.min || size > range.max) {
      throw outOfRange(`elementStyles.${name}.sizePt`);
    }
  }
  if (!isRecord(profile.signatureLayout)) throw stateInvalid('signatureLayout');
  for (const name of ['leaderBox', 'sealBox'] as const) assertBox(profile.signatureLayout[name], `signatureLayout.${name}`);
  for (const name of ['leaderBox', 'sealBox'] as const) if (!boxOnPage(profile.signatureLayout[name])) throw outOfRange(`signatureLayout.${name}`);
  // The seal is over the left third of the signature of the leader: it starts to the left of it and covers a third of its width, give or take 0.03.
  const ratio = sealOverlapRatio(profile.signatureLayout);
  if (profile.signatureLayout.sealBox.xMm >= profile.signatureLayout.leaderBox.xMm || Math.abs(ratio - SEAL_OVERLAP_TARGET) > SEAL_OVERLAP_TOLERANCE + 1e-9 || !sealMeetsSignature(profile.signatureLayout)) throw outOfRange('signatureLayout.sealBox');
  if (!isRecord(profile.numberFieldLayout)) throw stateInvalid('numberFieldLayout');
  for (const name of ['number', 'symbol', 'date'] as const) assertBox(profile.numberFieldLayout[name], `numberFieldLayout.${name}`);
  for (const name of ['number', 'symbol', 'date'] as const) if (!boxOnPage(profile.numberFieldLayout[name])) throw outOfRange(`numberFieldLayout.${name}`);
}

/** The layout profile of a command as the contract carries it (`margins_mm`, `element_styles`..., the members of the boxes named as the renderer names them). */
export interface LayoutProfileBody {
  margins_mm: unknown;
  font_family: string;
  font_substitute?: string | undefined;
  element_styles: unknown;
  signature_layout: unknown;
  number_field_layout: unknown;
  watermark_policy: unknown;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function boxOf(value: unknown, field: string): Box {
  if (!isRecord(value) || BOX_FIELDS.some((key) => !finite(value[key]))) throw invalid(field);
  return { xMm: value.xMm as number, yMm: value.yMm as number, widthMm: value.widthMm as number, heightMm: value.heightMm as number };
}

/**
 * The profile a command asks for. A member that is not the shape the renderer needs is 422 VALIDATION_FAILED naming it; a value outside the ranges of BR-DOC-13 (the margins, the sizes of the letters, the place of the
 * seal over the signature) is 422 LAYOUT_OUT_OF_LEGAL_RANGE naming it, and nothing is written. The code and the revision are the store's.
 */
export function layoutFromBody(body: LayoutProfileBody, code: string, revision: number): LayoutProfile {
  if (!isRecord(body.margins_mm) || !(['top', 'bottom', 'left', 'right'] as const).every((key) => finite((body.margins_mm as Record<string, unknown>)[key]))) throw invalid('margins_mm');
  const margins = body.margins_mm as Record<string, number>;
  if (!isRecord(body.element_styles)) throw invalid('element_styles');
  const styles = {} as Record<ElementName, ElementStyle>;
  for (const name of ELEMENT_NAMES) {
    const entry = body.element_styles[name];
    if (entry === undefined) throw outOfRange(`elementStyles.${name}`);
    if (!isRecord(entry) || !finite(entry.sizePt) || [entry.bold, entry.italic, entry.uppercase].some((flag) => typeof flag !== 'boolean')) throw invalid(`element_styles.${name}`);
    styles[name] = { sizePt: entry.sizePt, bold: entry.bold as boolean, italic: entry.italic as boolean, uppercase: entry.uppercase as boolean };
  }
  if (!isRecord(body.signature_layout)) throw invalid('signature_layout');
  if (!isRecord(body.number_field_layout)) throw invalid('number_field_layout');
  if (!isRecord(body.watermark_policy) || typeof body.watermark_policy.text !== 'string' || body.watermark_policy.text.trim().length < 3 || body.watermark_policy.text.length > 120) throw invalid('watermark_policy');
  const profile: LayoutProfile = {
    code,
    revision,
    pageSize: 'A4',
    marginsMm: { top: margins.top as number, bottom: margins.bottom as number, left: margins.left as number, right: margins.right as number },
    fontFamily: body.font_family,
    ...(body.font_substitute === undefined || body.font_substitute === '' ? {} : { fontSubstitute: body.font_substitute }),
    elementStyles: styles,
    signatureLayout: { leaderBox: boxOf(body.signature_layout.leaderBox, 'signature_layout.leaderBox'), sealBox: boxOf(body.signature_layout.sealBox, 'signature_layout.sealBox') },
    numberFieldLayout: {
      number: boxOf(body.number_field_layout.number, 'number_field_layout.number'),
      symbol: boxOf(body.number_field_layout.symbol, 'number_field_layout.symbol'),
      date: boxOf(body.number_field_layout.date, 'number_field_layout.date'),
    },
    watermarkPolicy: { text: body.watermark_policy.text.trim() },
    confirmationStatus: 'PENDING_CONFIRMATION',
  };
  assertLayoutWithinLegalRange(profile);
  return profile;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('LAYOUT_STATE_INVALID', 409, field);
  return value as Record<string, unknown>;
}

/** The columns of a `document_layout_profile` row (jsonb already parsed). */
export interface LayoutProfileRow {
  profile_code: string;
  revision: number;
  page_size: string;
  margins_mm: unknown;
  font_family: string;
  font_substitute?: string | null;
  element_styles: unknown;
  signature_layout: unknown;
  number_field_layout: unknown;
  watermark_policy: unknown;
  confirmation_status: string;
}

/** Maps a stored row to a profile and applies the legal range guard; a malformed row is LAYOUT_STATE_INVALID. */
export function layoutProfileOf(row: LayoutProfileRow): LayoutProfile {
  const margins = record(row.margins_mm, 'margins_mm');
  const profile: LayoutProfile = {
    code: row.profile_code,
    revision: row.revision,
    pageSize: row.page_size as 'A4',
    marginsMm: {
      top: Number(margins.top),
      bottom: Number(margins.bottom),
      left: Number(margins.left),
      right: Number(margins.right),
    },
    fontFamily: row.font_family,
    ...(row.font_substitute === undefined || row.font_substitute === null ? {} : { fontSubstitute: row.font_substitute }),
    elementStyles: record(row.element_styles, 'element_styles') as Record<ElementName, ElementStyle>,
    signatureLayout: record(row.signature_layout, 'signature_layout') as unknown as SignatureLayout,
    numberFieldLayout: record(row.number_field_layout, 'number_field_layout') as unknown as NumberFieldLayout,
    watermarkPolicy: { text: String(record(row.watermark_policy, 'watermark_policy').text ?? '') },
    confirmationStatus: row.confirmation_status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
  };
  assertLayoutWithinLegalRange(profile);
  return profile;
}
