import { ApiError } from '@machvon/api-client';
import { ELEMENTS } from './types';
import type { Box, Element, LayoutProfile } from './types';

/**
 * The ranges of Appendix I of Decree 30/2020 as the table of BR-DOC-13 gives them. The server judges every value again (422 LAYOUT_OUT_OF_LEGAL_RANGE) and the database refuses what lies outside them; the screen
 * shows them next to each field and tells a value that is outside before it is sent.
 */
export const MARGIN_RANGES = {
  top: { min: 20, max: 25 },
  bottom: { min: 20, max: 25 },
  left: { min: 30, max: 35 },
  right: { min: 15, max: 20 },
} as const;
export type Margin = keyof typeof MARGIN_RANGES;
export const MARGINS = Object.keys(MARGIN_RANGES) as Margin[];

export const SIZE_RANGES: Readonly<Record<Element, { min: number; max: number }>> = {
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

/** The seal covers a third of the width of the signature of the leader, give or take 0.03, starting to the left of it. */
export const SEAL_OVERLAP_TARGET = 1 / 3;
export const SEAL_OVERLAP_TOLERANCE = 0.03;

export function sealOverlapRatio(leader: Box, seal: Box): number {
  const covered = Math.min(seal.xMm + seal.widthMm, leader.xMm + leader.widthMm) - Math.max(seal.xMm, leader.xMm);
  return leader.widthMm > 0 ? Math.max(0, covered) / leader.widthMm : 0;
}

/** Whether the boxes have a size and meet up and down as well as side to side. */
function meets(leader: Box, seal: Box): boolean {
  const high = Math.min(seal.yMm + seal.heightMm, leader.yMm + leader.heightMm) - Math.max(seal.yMm, leader.yMm);
  return [leader.widthMm, leader.heightMm, seal.widthMm, seal.heightMm].every((size) => size > 0) && high > 0;
}

/** The page is A4: a box has a size and lies on it. */
export const onPage = (box: Box): boolean => box.widthMm > 0 && box.heightMm > 0 && box.xMm >= 0 && box.yMm >= 0 && box.xMm + box.widthMm <= 210 && box.yMm + box.heightMm <= 297;

export const sealWithinRange = (leader: Box, seal: Box): boolean => seal.xMm < leader.xMm && Math.abs(sealOverlapRatio(leader, seal) - SEAL_OVERLAP_TARGET) <= SEAL_OVERLAP_TOLERANCE + 1e-9 && meets(leader, seal);

// ---- the form ----------------------------------------------------------------------------------------------------------------

export interface BoxForm {
  x: string;
  y: string;
  width: string;
  height: string;
}

export interface LayoutForm {
  /** The revision the new one starts from: what the form does not edit (the flags of the letters, the number fields, the font, the watermark) is taken from it. */
  baseId: string;
  profileCode: string;
  effectiveFrom: string;
  effectiveUntil: string;
  legalBasis: string;
  margins: Record<Margin, string>;
  sizes: Record<Element, string>;
  leader: BoxForm;
  seal: BoxForm;
}

const boxForm = (box: Box): BoxForm => ({ x: String(box.xMm), y: String(box.yMm), width: String(box.widthMm), height: String(box.heightMm) });

export const EMPTY_FORM: LayoutForm = {
  baseId: '',
  profileCode: '',
  effectiveFrom: '',
  effectiveUntil: '',
  legalBasis: '',
  margins: { top: '', bottom: '', left: '', right: '' },
  sizes: Object.fromEntries(ELEMENTS.map((name) => [name, ''])) as Record<Element, string>,
  leader: { x: '', y: '', width: '', height: '' },
  seal: { x: '', y: '', width: '', height: '' },
};

/** The form for a new revision of a profile, filled with the values of the revision it starts from. */
export function formFrom(base: LayoutProfile): LayoutForm {
  return {
    baseId: base.id,
    profileCode: base.profileCode,
    effectiveFrom: '',
    effectiveUntil: '',
    legalBasis: base.legalBasis,
    margins: { top: String(base.marginsMm.top), bottom: String(base.marginsMm.bottom), left: String(base.marginsMm.left), right: String(base.marginsMm.right) },
    sizes: Object.fromEntries(ELEMENTS.map((name) => [name, String(base.elementStyles[name].sizePt)])) as Record<Element, string>,
    leader: boxForm(base.signatureLayout.leaderBox),
    seal: boxForm(base.signatureLayout.sealBox),
  };
}

export type FieldProblem = 'required' | 'invalid' | 'outOfRange';

export interface FormProblems {
  profileCode?: FieldProblem;
  effectiveFrom?: FieldProblem;
  effectiveUntil?: FieldProblem;
  legalBasis?: FieldProblem;
  margins: Partial<Record<Margin, FieldProblem>>;
  sizes: Partial<Record<Element, FieldProblem>>;
  boxes?: FieldProblem;
  seal?: FieldProblem;
}

const NUMBER = /^[0-9]+(\.[0-9]+)?$/;
const PROFILE_CODE = /^[A-Z0-9][A-Z0-9_.-]{2,59}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDay(value: string): boolean {
  const match = DAY.exec(value);
  if (match === null) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

const numberOf = (value: string): number => Number(value.trim());

export function boxOfForm(form: BoxForm): Box | undefined {
  const values = [form.x, form.y, form.width, form.height].map((value) => value.trim());
  if (values.some((value) => !NUMBER.test(value))) return undefined;
  return { xMm: numberOf(form.x), yMm: numberOf(form.y), widthMm: numberOf(form.width), heightMm: numberOf(form.height) };
}

/** What is wrong with the form as typed, judged against the ranges of BR-DOC-13 and the shape the server asks for. */
export function validateForm(form: LayoutForm): FormProblems {
  const problems: FormProblems = { margins: {}, sizes: {} };
  if (form.profileCode.trim() === '') problems.profileCode = 'required';
  else if (!PROFILE_CODE.test(form.profileCode.trim())) problems.profileCode = 'invalid';
  if (form.effectiveFrom.trim() === '') problems.effectiveFrom = 'required';
  else if (!validDay(form.effectiveFrom.trim())) problems.effectiveFrom = 'invalid';
  if (form.effectiveUntil.trim() !== '' && (!validDay(form.effectiveUntil.trim()) || (problems.effectiveFrom === undefined && form.effectiveUntil.trim() <= form.effectiveFrom.trim()))) problems.effectiveUntil = 'invalid';
  if (form.legalBasis.trim() === '') problems.legalBasis = 'required';
  else if (form.legalBasis.trim().length > 2000) problems.legalBasis = 'invalid';
  for (const margin of MARGINS) {
    const value = form.margins[margin].trim();
    if (value === '') problems.margins[margin] = 'required';
    else if (!NUMBER.test(value)) problems.margins[margin] = 'invalid';
    else if (numberOf(value) < MARGIN_RANGES[margin].min || numberOf(value) > MARGIN_RANGES[margin].max) problems.margins[margin] = 'outOfRange';
  }
  for (const element of ELEMENTS) {
    const value = form.sizes[element].trim();
    if (value === '') problems.sizes[element] = 'required';
    else if (!NUMBER.test(value)) problems.sizes[element] = 'invalid';
    else if (numberOf(value) < SIZE_RANGES[element].min || numberOf(value) > SIZE_RANGES[element].max) problems.sizes[element] = 'outOfRange';
  }
  const leader = boxOfForm(form.leader);
  const seal = boxOfForm(form.seal);
  if (leader === undefined || seal === undefined) problems.boxes = 'invalid';
  else if (!onPage(leader) || !onPage(seal)) problems.boxes = 'outOfRange';
  else if (!sealWithinRange(leader, seal)) problems.seal = 'outOfRange';
  return problems;
}

export const hasProblems = (problems: FormProblems): boolean =>
  Object.values(problems.margins).length > 0 ||
  Object.values(problems.sizes).length > 0 ||
  [problems.profileCode, problems.effectiveFrom, problems.effectiveUntil, problems.legalBasis, problems.boxes, problems.seal].some((problem) => problem !== undefined);

/** The body of `createDocumentLayoutProfileRevision`: the values of the form over the members of the revision it starts from. */
export function layoutBody(form: LayoutForm, base: LayoutProfile): Record<string, unknown> {
  const leader = boxOfForm(form.leader) as Box;
  const seal = boxOfForm(form.seal) as Box;
  return {
    profile_code: form.profileCode.trim(),
    margins_mm: Object.fromEntries(MARGINS.map((margin) => [margin, numberOf(form.margins[margin])])),
    font_family: base.fontFamily,
    ...(base.fontSubstitute === null ? {} : { font_substitute: base.fontSubstitute }),
    element_styles: Object.fromEntries(ELEMENTS.map((element) => [element, { ...base.elementStyles[element], sizePt: numberOf(form.sizes[element]) }])),
    signature_layout: { leaderBox: leader, sealBox: seal },
    number_field_layout: base.numberFieldLayout,
    watermark_policy: base.watermarkPolicy,
    legal_basis: form.legalBasis.trim(),
    effective_from: form.effectiveFrom.trim(),
    ...(form.effectiveUntil.trim() === '' ? {} : { effective_until: form.effectiveUntil.trim() }),
  };
}

/** A draft waits for a publisher who is not its drafter. */
export const canPublish = (profile: Pick<LayoutProfile, 'status' | 'createdBy'>, membershipId: string | undefined): boolean =>
  profile.status === 'DRAFT' && (membershipId === undefined || profile.createdBy !== membershipId);

// ---- what the server refuses -------------------------------------------------------------------------------------------------

export type LayoutProblem = 'outOfRange' | 'legalBasis' | 'selfApproval' | 'state' | 'overlap' | 'conflict' | 'invalid' | 'scope' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, LayoutProblem>> = {
  LAYOUT_OUT_OF_LEGAL_RANGE: 'outOfRange',
  LEGAL_BASIS_REQUIRED: 'legalBasis',
  SELF_APPROVAL_DENIED: 'selfApproval',
  LAYOUT_STATE_INVALID: 'state',
  TEMPLATE_RANGE_OVERLAP: 'overlap',
  VERSION_CONFLICT: 'conflict',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'scope',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeProblem = (error: unknown): LayoutProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
