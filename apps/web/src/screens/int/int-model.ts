import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

type Schemas = components['schemas'];

export type MachineAccountPage = Schemas['MachineAccountPage'];
export type MachineAccount = Schemas['MachineAccount'];
export type MachineCredential = Schemas['MachineCredential'];
export type OpenAccessLogPage = Schemas['OpenAccessLogPage'];
export type ExportDatasetList = Schemas['ExportDatasetList'];
export type ExportDataset = Schemas['ExportDataset'];
export type BiReaderPage = Schemas['BiReaderPage'];
export type BiReader = Schemas['BiReader'];
export type BiReaderDetail = Schemas['BiReaderDetail'];
export type SourceSystemList = Schemas['SourceSystemList'];
export type SourceSystem = Schemas['SourceSystem'];
export type ProjectCodePage = Schemas['ProjectCodePage'];
export type ProjectCode = Schemas['ProjectCode'];

/** The shortest reason the server accepts for a decision that changes what the register believes. */
export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const PAGE_SIZE = 50;
export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export const CODE_STATUSES = ['PROPOSED', 'ACTIVE', 'REJECTED', 'RETIRED'] as const;
export const OUTCOMES = ['OK', 'DENIED_CLIENT', 'DENIED_SCOPE', 'DENIED_DATASET', 'RATE_LIMITED', 'INVALID_REQUEST'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type CodeStatus = (typeof CODE_STATUSES)[number];

/** What went wrong with a command, in the terms the dialogs explain. */
export type ProblemKind =
  | 'versionConflict'
  | 'selfApproval'
  | 'duplicateTaken'
  | 'duplicateHolds'
  | 'duplicateWaiting'
  | 'duplicate'
  | 'stateInvalid'
  | 'nameTaken'
  | 'systemTaken'
  | 'systemInUse'
  | 'datasetClosed'
  | 'provisioning'
  | 'validation'
  | 'notFound'
  | 'forbidden'
  | 'general';

export interface Problem {
  kind: ProblemKind;
  /** The field a validation names, when it names one of the form. */
  field: string | undefined;
  /** The reason a closed dataset or a duplicate carries. */
  reason: string | undefined;
}

const DUPLICATES: Readonly<Record<string, ProblemKind>> = { EXTERNAL_CODE_TAKEN: 'duplicateTaken', SUBJECT_HAS_OTHER_CODE: 'duplicateHolds', ALREADY_PROPOSED: 'duplicateWaiting' };

/** Reads the error of a command or a read into a Problem; anything that is not an ApiError is general. */
export function problemOf(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined, reason: undefined };
  const reason = typeof error.extensions.reason === 'string' ? error.extensions.reason : undefined;
  const simple = (kind: ProblemKind): Problem => ({ kind, field: undefined, reason });
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return simple('versionConflict');
    case 'SELF_APPROVAL_DENIED':
      return simple('selfApproval');
    case 'CROSSWALK_DUPLICATE':
      return simple(reason === undefined ? 'duplicate' : (DUPLICATES[reason] ?? 'duplicate'));
    case 'EGP_MAPPING_STATE_INVALID':
    case 'OPEN_ACCOUNT_STATE_INVALID':
    case 'BI_READER_STATE_INVALID':
      return simple('stateInvalid');
    case 'OPEN_ACCOUNT_NAME_TAKEN':
      return { kind: 'nameTaken', field: 'name', reason };
    case 'INT_SOURCE_SYSTEM_TAKEN':
      return { kind: 'systemTaken', field: 'code', reason };
    case 'INT_SOURCE_SYSTEM_IN_USE':
      return simple('systemInUse');
    case 'OPEN_DATASET_NOT_CERTIFIED':
      return simple('datasetClosed');
    case 'BI_PROVISIONING_UNAVAILABLE':
      return simple('provisioning');
    case 'VALIDATION_FAILED':
      return { kind: 'validation', field: error.detail, reason };
    case 'RESOURCE_NOT_FOUND':
      return simple('notFound');
    default:
      return simple(error.status === 403 ? 'forbidden' : 'general');
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `yyyy-mm-dd` as `dd/mm/yyyy`; anything else as it came. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (!DAY.test(value)) return value;
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

/** The day of an ISO instant in Vietnam, as `dd/mm/yyyy`. */
export function instantDay(value: string | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Date.parse(value))) return '';
  return dayText(new Date(Date.parse(value) + 7 * 3_600_000).toISOString().slice(0, 10));
}

/** The time of an ISO instant in Vietnam, `dd/mm/yyyy hh:mm`. */
export function instantText(value: string | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Date.parse(value))) return '';
  const shifted = new Date(Date.parse(value) + 7 * 3_600_000).toISOString();
  return `${dayText(shifted.slice(0, 10))} ${shifted.slice(11, 16)}`;
}

/** The pattern of a source system as the server judges a code: the whole code must match. */
export function fitsPattern(pattern: string | null, code: string): boolean {
  if (pattern === null) return true;
  try {
    return new RegExp(`^(?:${pattern})$`).test(code);
  } catch {
    return true;
  }
}

/** The reason of a form, trimmed, or undefined when it is too short for the server. */
export function reasonOf(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length >= MIN_REASON && trimmed.length <= MAX_REASON ? trimmed : undefined;
}

/** The query of a list: only what is set, with the page size and the cursor. */
export function queryOf(filters: Readonly<Record<string, string | undefined>>, cursor: string | undefined): Record<string, string | number> {
  const query: Record<string, string | number> = { limit: PAGE_SIZE };
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value.trim() !== '') query[key] = value.trim();
  if (cursor !== undefined) query.cursor = cursor;
  return query;
}

/** The filters of an address, limited to the names a screen knows. */
export function filtersOf(search: URLSearchParams, names: readonly string[]): Record<string, string | undefined> {
  const found: Record<string, string | undefined> = {};
  for (const name of names) {
    const value = search.get(name);
    if (value !== null && value !== '') found[name] = value;
  }
  return found;
}

export function searchOf(filters: Readonly<Record<string, string | undefined>>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') search.set(key, value);
  return search;
}
