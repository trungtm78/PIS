import type { components } from '@machvon/contracts';
import { ApiError } from '@machvon/api-client';

export type Schemas = components['schemas'];
export type Entry = Schemas['RptCatalogueEntry'];
export type Catalogue = Schemas['RptCatalogue'];
export type Draft = Schemas['RptDraft'];
export type Issue = Schemas['RptIssue'];
export type Delivery = Schemas['RptDelivery'];
export type Preview = Schemas['RptPreview'];
export type Generated = Schemas['RptGenerated'];
export type FileContent = Schemas['RptFileContent'];
export type FileInfo = Schemas['RptFileInfo'];
export type Period = Schemas['RptPeriod'];
export type PeriodKind = Period['kind'];

export const PERIOD_KINDS: readonly PeriodKind[] = ['MONTH', 'QUARTER', 'HALF_YEAR', 'YEAR', 'AS_OF'];
export const DELIVERY_CHANNELS = ['MANUAL', 'DOWNLOAD', 'EMAIL', 'PORTAL'] as const;
export const REASON_MIN = 10;
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The word of the key of a period kind (`rpt.common.kind.<word>`). */
export const kindWord = (kind: PeriodKind): string => (kind === 'HALF_YEAR' ? 'halfYear' : kind === 'AS_OF' ? 'asOf' : kind.toLowerCase());
export const statusWord = (status: string): string => status.toLowerCase().replace(/_(\w)/g, (_m, letter: string) => letter.toUpperCase());
export const channelWord = (channel: string): string => statusWord(channel);

/** What a person types for a period: the year, the number inside it and the cut-off day. */
export interface PeriodInput {
  kind: PeriodKind;
  year: string;
  index: string;
  day: string;
}

/** The highest number a period kind has inside its year: months 12, quarters 4, halves 2; none for a year and for a cut-off day. */
export const indexLimit = (kind: PeriodKind): number => (kind === 'MONTH' ? 12 : kind === 'QUARTER' ? 4 : kind === 'HALF_YEAR' ? 2 : 0);

/** The period the form opens with: the month, quarter or half before `now` (a report is of a period that ended), the year before, or `now` itself for a cut-off day. */
export function defaultPeriod(kind: PeriodKind, now: Date): PeriodInput {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.toISOString().slice(0, 10);
  switch (kind) {
    case 'MONTH':
      return month === 1 ? { kind, year: String(year - 1), index: '12', day: '' } : { kind, year: String(year), index: String(month - 1), day: '' };
    case 'QUARTER': {
      const quarter = Math.ceil(month / 3);
      return quarter === 1 ? { kind, year: String(year - 1), index: '4', day: '' } : { kind, year: String(year), index: String(quarter - 1), day: '' };
    }
    case 'HALF_YEAR':
      return month <= 6 ? { kind, year: String(year - 1), index: '2', day: '' } : { kind, year: String(year), index: '1', day: '' };
    case 'YEAR':
      return { kind, year: String(year - 1), index: '', day: '' };
    case 'AS_OF':
      return { kind, year: String(year), index: '', day, };
  }
}

/** Whether the text is a day of the calendar (the 30th of February is not one): it reads back as itself. */
const isRealDay = (day: string): boolean => ISO_DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/** The period the server takes, or undefined while what was typed is not a whole period (a number inside the year, a day that belongs to the year). */
export function periodBody(input: PeriodInput): Period | undefined {
  if (!/^\d{4}$/.test(input.year)) return undefined;
  const year = Number(input.year);
  if (input.kind === 'AS_OF') {
    if (!isRealDay(input.day) || Number(input.day.slice(0, 4)) !== year) return undefined;
    return { kind: 'AS_OF', year, day: input.day };
  }
  const limit = indexLimit(input.kind);
  if (limit === 0) return { kind: input.kind, year };
  const index = Number(input.index);
  if (!/^\d{1,2}$/.test(input.index) || index < 1 || index > limit) return undefined;
  return { kind: input.kind, year, index };
}

/** A hash short enough to read in a table, with both ends so two hashes are told apart. */
export const shortHash = (sha: string): string => `${sha.slice(0, 12)}…${sha.slice(-6)}`;

/** Day and hour of the Vietnam calendar, `dd/mm/yyyy hh:mm`; the dash for a missing time. */
export function vietnamDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || Number.isNaN(Date.parse(iso))) return '–';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const MEDIA: Readonly<Record<string, string>> = {
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF: 'application/pdf',
};

/** Hands the file to the browser as a download; the bytes are those the server checked against the recorded hash. */
export function saveFile(file: FileContent): void {
  const bytes = decodeBase64(file.content_base64);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MEDIA[file.format] ?? 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The kind of refusal a command got, for the one sentence the screen says: the code of the problem and, for a validation, the field it names. */
export interface Refusal {
  code: string;
  status: number;
  detail: string | undefined;
  currentRevision: number | undefined;
}

export function refusalOf(error: unknown): Refusal {
  if (error instanceof ApiError) {
    const revision = error.extensions.current_revision;
    return { code: error.code, status: error.status, detail: error.detail, currentRevision: typeof revision === 'number' ? revision : undefined };
  }
  return { code: 'UNKNOWN', status: 0, detail: undefined, currentRevision: undefined };
}

/** Whether a draft can still be moved: it is not issued. */
export const isOpen = (draft: Pick<Draft, 'state'>): boolean => draft.state !== 'ISSUED';
