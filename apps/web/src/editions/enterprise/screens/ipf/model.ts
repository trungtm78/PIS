import type { components } from '@machvon/contracts';
import { camel } from '../../../../screens/mdm/catalogues';
import { shaped } from '../shared/format';

export { camel };

/**
 * IPF-01: the investment profile of one project of the enterprise edition (MD.01 type and flag of the stage, MD.02 milestones and legal documents, CN.01 the plan split by origin). The profile is a read model of the API
 * (`getProjectInvestmentProfile`); this file reads it and holds the small rules the screen applies to it, none of which changes a number.
 */
export type Profile = components['schemas']['ProjectInvestmentProfile'];
export type Milestone = Profile['milestones'][number];
export type LegalGroup = Profile['legal_documents'][number];
export type OriginAmount = Profile['origin_split']['origins'][number];

export const PROFILE_PATH = '/ipf/ipf-01';
export const MIN_PLAN_YEAR = 2000;
export const MAX_PLAN_YEAR = 2100;

export const toProfile = (raw: unknown): Profile =>
  shaped<Profile>(raw, 'investment profile', ['plans', 'milestones', 'findings', 'legal_documents'], ['origin_split']);

export type YearProblem = 'format' | 'range';

/** What is wrong with a year typed into the form, if anything. */
export function yearProblem(value: string): YearProblem | undefined {
  const text = value.trim();
  if (text === '') return undefined;
  if (!/^\d{4}$/u.test(text)) return 'format';
  const year = Number(text);
  return year < MIN_PLAN_YEAR || year > MAX_PLAN_YEAR ? 'range' : undefined;
}

export type MilestoneTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

/** The tone of the state of a milestone: reached is calm, planned is neutral, delayed is a warning, cancelled is an error, and a milestone the project does not hold is said so in the plainest tone. */
export function milestoneTone(state: string): MilestoneTone {
  switch (state) {
    case 'REACHED':
      return 'success';
    case 'PLANNED':
      return 'info';
    case 'DELAYED':
      return 'warning';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export interface Finding {
  kind: 'MILESTONE_ORDER' | 'REQUIRED_SKIPPED';
  code: string;
}

/** The findings of the API (`KIND:<milestone code>`); one that is not of a kind the screen knows is dropped rather than shown as a guess. */
export function findingsOf(raw: readonly string[]): Finding[] {
  const found: Finding[] = [];
  for (const entry of raw) {
    const split = entry.indexOf(':');
    const kind = entry.slice(0, split);
    const code = entry.slice(split + 1);
    if (split > 0 && code !== '' && (kind === 'MILESTONE_ORDER' || kind === 'REQUIRED_SKIPPED')) found.push({ kind, code });
  }
  return found;
}

export interface EvidenceKind {
  code: string;
  /** Active documents of this legal type the caller may read. */
  held: number;
}

/** The evidence a milestone asks for, with how many documents of each type the project holds. */
export function evidenceOf(milestone: Milestone, groups: readonly LegalGroup[]): EvidenceKind[] {
  return milestone.evidence_kinds.map((code) => ({ code, held: groups.find((group) => group.legal_doc_type === code)?.count ?? 0 }));
}

/** Whether the milestone is reached although no document of any kind it asks for is held: said as such, never hidden. */
export function reachedWithoutEvidence(milestone: Milestone, groups: readonly LegalGroup[]): boolean {
  return milestone.state === 'REACHED' && evidenceOf(milestone, groups).every((kind) => kind.held === 0);
}

const NAMED_ORIGINS = ['GROUP_ASSIGNED', 'BOARD_APPROVED'] as const;
export type NamedOrigin = (typeof NAMED_ORIGINS)[number];

export const isNamedOrigin = (origin: string): origin is NamedOrigin => (NAMED_ORIGINS as readonly string[]).includes(origin);

/** The lifecycle and plan document types the built-in catalogue names; a code of a tenant is shown by the label the API sends or, failing that, as it is. */
export const BUILT_IN_DOC_TYPES: readonly string[] = [
  'GROUP_RESOLUTION',
  'GROUP_DECISION',
  'COMPANY_RESOLUTION',
  'COMPANY_DECISION',
  'INVESTMENT_POLICY_DECISION',
  'INVESTMENT_CERTIFICATE_DOC',
  'FS_APPROVAL_DECISION',
  'TMDT_APPROVAL_DECISION',
  'CONTRACTOR_PLAN_DECISION',
  'GROUNDBREAKING_RECORD',
  'ACCEPTANCE_RECORD',
  'SETTLEMENT_DECISION',
];
