import { wholeDong } from './aud-conclusion.ts';
import { DomainError } from './errors.ts';
import { enterpriseNarrativeOf, isEmptyBlock } from './ent-narrative.ts';
import type { EnterpriseNarrative, RawEnterpriseNarrative } from './ent-narrative.ts';
import { asUuid } from './tenant-context.ts';

/** The volumes of a weekly report (DIS 3 F1 step 3, DIS-03): what was built, accepted, sent to the Treasury and is being prepared, in whole dong. */
export interface ProgressInput {
  constructionVnd: string;
  acceptanceVnd: string;
  treasurySubmittedVnd: string;
  preparingDossierVnd: string;
  /** Percent of the physical work, two decimals, 0 to 100; null when the report does not say. */
  physicalProgressPct: string | null;
}

/** The members of the request that carry the volumes, as the contract names them. */
export interface RawProgress {
  construction_vnd?: string | undefined;
  acceptance_vnd?: string | undefined;
  treasury_submitted_vnd?: string | undefined;
  preparing_dossier_vnd?: string | undefined;
  physical_progress_pct?: string | undefined;
}

const PROGRESS_MEMBERS = ['construction_vnd', 'acceptance_vnd', 'treasury_submitted_vnd', 'preparing_dossier_vnd'] as const;
const PERCENT = /^(?:100(?:\.0{1,2})?|[0-9]{1,2}(?:\.[0-9]{1,2})?)$/;

/**
 * The volumes of a request. A request that names none of them leaves the volumes of the draft as they are (undefined); one that names any names the four amounts together (422
 * `VALIDATION_FAILED` naming the first that is missing, a negative or fractional amount or one that is not a number), because a volume is read against the others. The percent is optional,
 * written like `37.5` and kept with two decimals.
 */
export function progressOf(raw: RawProgress): ProgressInput | undefined {
  const named = [...PROGRESS_MEMBERS, 'physical_progress_pct' as const].some((member) => raw[member] !== undefined);
  if (!named) return undefined;
  for (const member of PROGRESS_MEMBERS) {
    if (raw[member] === undefined) throw new DomainError('VALIDATION_FAILED', 422, member);
  }
  const pct = raw.physical_progress_pct;
  if (pct !== undefined && !PERCENT.test(pct)) throw new DomainError('VALIDATION_FAILED', 422, 'physical_progress_pct');
  return {
    constructionVnd: wholeDong(raw.construction_vnd as string, 'construction_vnd'),
    acceptanceVnd: wholeDong(raw.acceptance_vnd as string, 'acceptance_vnd'),
    treasurySubmittedVnd: wholeDong(raw.treasury_submitted_vnd as string, 'treasury_submitted_vnd'),
    preparingDossierVnd: wholeDong(raw.preparing_dossier_vnd as string, 'preparing_dossier_vnd'),
    physicalProgressPct: pct === undefined ? null : Number(pct).toFixed(2),
  };
}

/** The words a person writes about a period (DIS-06 notes, the narrative of the report): each section is optional in the weekly report and mandatory in the monthly one (a later story). */
export interface NarrativeInput {
  resultsText: string | null;
  causesText: string | null;
  solutionsText: string | null;
  proposalsText: string | null;
  /** Issues of the project the report speaks about (ISS), each once, in the order they were named. */
  linkedIssueIds: readonly string[];
  /** The block of the enterprise pack (ENT-3b): the eight structured fields; absent in the public edition and in a report that has none. */
  enterprise?: EnterpriseNarrative | undefined;
}

export interface RawNarrative {
  results?: string | undefined;
  causes?: string | undefined;
  solutions?: string | undefined;
  proposals?: string | undefined;
  linked_issue_ids?: readonly string[] | undefined;
  enterprise?: RawEnterpriseNarrative | undefined;
}

export const NARRATIVE_MAX_CHARS = 4000;
export const NARRATIVE_MAX_ISSUES = 50;
const NARRATIVE_SECTIONS = [
  ['results', 'resultsText'],
  ['causes', 'causesText'],
  ['solutions', 'solutionsText'],
  ['proposals', 'proposalsText'],
] as const;

/**
 * The narrative of a request. The member is the whole narrative: what it leaves out is gone from the draft, and a narrative with nothing in it (no words and no issue) is the same as none (null).
 * A section is trimmed, normalised and between 1 and 4000 characters (an empty one counts as left out); issues are valid ids, each once, at most 50 (422 `VALIDATION_FAILED` naming the member).
 */
export function narrativeOf(raw: RawNarrative | undefined): NarrativeInput | null {
  if (raw === undefined) return null;
  const sections: Record<string, string | null> = {};
  for (const [member, field] of NARRATIVE_SECTIONS) {
    const value = raw[member];
    if (value === undefined) {
      sections[field] = null;
      continue;
    }
    if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, `narrative.${member}`);
    const words = value.normalize('NFC').trim();
    if (words.length > NARRATIVE_MAX_CHARS) throw new DomainError('VALIDATION_FAILED', 422, `narrative.${member}`);
    sections[field] = words === '' ? null : words;
  }
  const given = raw.linked_issue_ids ?? [];
  if (!Array.isArray(given) || given.length > NARRATIVE_MAX_ISSUES) throw new DomainError('VALIDATION_FAILED', 422, 'narrative.linked_issue_ids');
  const issues: string[] = [];
  given.forEach((id, index) => {
    const parsed = typeof id === 'string' ? asUuid(id) : undefined;
    if (parsed === undefined || issues.includes(parsed)) throw new DomainError('VALIDATION_FAILED', 422, `narrative.linked_issue_ids[${index}]`);
    issues.push(parsed);
  });
  const enterprise = enterpriseNarrativeOf(raw.enterprise);
  const narrative: NarrativeInput = {
    resultsText: sections.resultsText ?? null,
    causesText: sections.causesText ?? null,
    solutionsText: sections.solutionsText ?? null,
    proposalsText: sections.proposalsText ?? null,
    linkedIssueIds: issues,
    ...(enterprise === null ? {} : { enterprise }),
  };
  const empty = NARRATIVE_SECTIONS.every(([, field]) => narrative[field] === null) && issues.length === 0 && (enterprise === null || isEmptyBlock(enterprise));
  return empty ? null : narrative;
}

/** The file a person attached to a report as the upload door of the report answered it (DIS-06, MOB-19). */
export interface AttachmentRef {
  fileObjectId: string;
  fileSha256: string;
  fileName: string;
}

export interface RawAttachment {
  file_object_id: string;
  file_sha256: string;
  file_name: string;
}

export const ATTACHMENT_MAX_COUNT = 20;
const SHA256 = /^[0-9a-f]{64}$/;
/** A name that carries a path separator or a control character is not the name of a file. */
const isPathOrControl = (name: string): boolean => [...name].some((char) => char === '/' || char === '\\' || char.charCodeAt(0) < 32);

/**
 * The attachments of a request: the whole list of the draft, each file once, at most 20 (422 `VALIDATION_FAILED` naming `attachments[i].<member>`). The name is the one the person gave, trimmed,
 * 1 to 200 characters with no path in it. That the file exists, is of this tenant and is clean is checked against the store, not here.
 */
export function attachmentsOf(raw: readonly RawAttachment[] | undefined): AttachmentRef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > ATTACHMENT_MAX_COUNT) throw new DomainError('VALIDATION_FAILED', 422, 'attachments');
  const refs: AttachmentRef[] = [];
  raw.forEach((entry, index) => {
    const at = (member: string): string => `attachments[${index}].${member}`;
    const id = typeof entry?.file_object_id === 'string' ? asUuid(entry.file_object_id) : undefined;
    if (id === undefined || refs.some((ref) => ref.fileObjectId === id)) throw new DomainError('VALIDATION_FAILED', 422, at('file_object_id'));
    if (typeof entry.file_sha256 !== 'string' || !SHA256.test(entry.file_sha256)) throw new DomainError('VALIDATION_FAILED', 422, at('file_sha256'));
    const name = typeof entry.file_name === 'string' ? entry.file_name.normalize('NFC').trim() : '';
    if (name.length < 1 || name.length > 200 || isPathOrControl(name)) throw new DomainError('VALIDATION_FAILED', 422, at('file_name'));
    refs.push({ fileObjectId: id, fileSha256: entry.file_sha256, fileName: name });
  });
  return refs;
}
