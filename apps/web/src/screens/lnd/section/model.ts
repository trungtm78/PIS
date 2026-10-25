import { isArea, isDay, isUuid } from '../model';
import type { FormProblem } from '../model';

/** The permission of the handover (x-permission of recordSectionHandover in openapi.json); the server judges the command again, with the scope of the project and the contract. */
export const HANDOVER_PERMISSION = 'land.handover';

export const SECTION_STATUSES = ['NOT_READY', 'PARTIAL', 'HANDED_OVER'] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One section of a project as LND-10 shows it: the area it needs, the area handed over, the contract that receives it and where it stands. */
export interface SectionLine {
  id: string;
  projectId: string;
  contractId: string | null;
  code: string;
  name: string;
  fromKm: string | null;
  toKm: string | null;
  requiredAreaM2: string;
  handedAreaM2: string;
  targetDate: string | null;
  handedOverOn: string | null;
  status: SectionStatus;
  version: number;
}

export function toSectionLine(raw: unknown): SectionLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const projectId = text(row?.project_id);
  const code = text(row?.code);
  const required = text(row?.required_area_m2);
  const handed = text(row?.handed_area_m2);
  const status = SECTION_STATUSES.find((candidate) => candidate === row?.status);
  const version = typeof row?.version === 'number' && Number.isInteger(row.version) ? row.version : undefined;
  if (row === undefined || id === undefined || projectId === undefined || code === undefined || required === undefined || handed === undefined || status === undefined || version === undefined) return undefined;
  return {
    id,
    projectId,
    contractId: nullableText(row.contract_id),
    code,
    name: text(row.name) ?? '',
    fromKm: nullableText(row.from_km),
    toKm: nullableText(row.to_km),
    requiredAreaM2: required,
    handedAreaM2: handed,
    targetDate: nullableText(row.target_date),
    handedOverOn: nullableText(row.handed_over_on),
    status,
    version,
  };
}

export const canHandover = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean =>
  (permissions === undefined || permissions.includes(HANDOVER_PERMISSION)) && mode !== 'READ_ONLY';

/** A section can receive a handover when a contract is named for it and not all of its area has been handed over; whether that contract is active is for the server to say. */
export const canHandOver = (section: SectionLine): boolean => section.contractId !== null && section.status !== 'HANDED_OVER';

// ---- exact areas ---------------------------------------------------------------------------------------------------------------

/** An area as a whole number of hundredths of a square metre: no floating point is involved in a ratio or a sum. */
function hundredths(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

const areaOf = (amount: bigint): string => `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;

/** The share handed over, in percent to two decimals and rounded half up (BR-LND-06); 0.00 when nothing is required. */
export function ratioText(handedAreaM2: string, requiredAreaM2: string): string {
  const handed = hundredths(handedAreaM2);
  const required = hundredths(requiredAreaM2);
  if (required === 0n) return '0.00';
  const scaled = (handed * 10_000n * 2n + required) / (required * 2n);
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}

export interface SectionTotals {
  count: number;
  handedOver: number;
  requiredAreaM2: string;
  handedAreaM2: string;
  ratio: string;
}

/** What the project has handed over of what it needs: the sum of the areas of its sections and their share. */
export function totalsOf(sections: readonly SectionLine[]): SectionTotals {
  const required = sections.reduce((sum, section) => sum + hundredths(section.requiredAreaM2), 0n);
  const handed = sections.reduce((sum, section) => sum + hundredths(section.handedAreaM2), 0n);
  return {
    count: sections.length,
    handedOver: sections.filter((section) => section.status === 'HANDED_OVER').length,
    requiredAreaM2: areaOf(required),
    handedAreaM2: areaOf(handed),
    ratio: ratioText(areaOf(handed), areaOf(required)),
  };
}

/** The area of a section that is still to hand over. */
export const remainingText = (section: SectionLine): string => areaOf(hundredths(section.requiredAreaM2) - hundredths(section.handedAreaM2));

// ---- the handover form ---------------------------------------------------------------------------------------------------------

export type HandoverProblem = FormProblem | 'notIncreasing' | 'exceeds' | 'beforeLast';

export interface HandoverForm {
  /** The area handed over by now, not the area of this step. */
  handedAreaM2: string;
  handedOverOn: string;
  documentVersionId: string;
}

export const emptyHandover = (today: string): HandoverForm => ({ handedAreaM2: '', handedOverOn: today, documentVersionId: '' });

/** What is wrong with the handover before it is sent: an area that grows and does not pass what the section needs, a day that is real, not in the future and not before the last handover, and the document. */
export function validateHandover(form: HandoverForm, section: SectionLine, today: string): Partial<Record<keyof HandoverForm, HandoverProblem>> {
  const problems: Partial<Record<keyof HandoverForm, HandoverProblem>> = {};
  const area = form.handedAreaM2.trim();
  if (area === '') problems.handedAreaM2 = 'required';
  else if (!isArea(area)) problems.handedAreaM2 = 'invalid';
  else if (hundredths(area) > hundredths(section.requiredAreaM2)) problems.handedAreaM2 = 'exceeds';
  else if (hundredths(area) <= hundredths(section.handedAreaM2)) problems.handedAreaM2 = 'notIncreasing';
  const day = form.handedOverOn.trim();
  if (day === '') problems.handedOverOn = 'required';
  else if (!isDay(day)) problems.handedOverOn = 'invalid';
  else if (day > today) problems.handedOverOn = 'future';
  else if (section.handedOverOn !== null && day < section.handedOverOn) problems.handedOverOn = 'beforeLast';
  const document = form.documentVersionId.trim();
  if (document === '') problems.documentVersionId = 'required';
  else if (!isUuid(document)) problems.documentVersionId = 'invalid';
  return problems;
}

export interface HandoverBody {
  handed_area_m2: string;
  handed_over_on: string;
  handover_document_version_id: string;
}

export const handoverBody = (form: HandoverForm): HandoverBody => ({
  handed_area_m2: form.handedAreaM2.trim(),
  handed_over_on: form.handedOverOn.trim(),
  handover_document_version_id: form.documentVersionId.trim().toLowerCase(),
});
