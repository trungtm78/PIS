import { LEGAL_DOC_TYPE_SEEDS, startFlagOf } from './ent-catalogue.ts';
import type { LegalDocTypeEntry, MilestoneEntry, StartFlag } from './ent-catalogue.ts';

/**
 * The investment profile of one project in the enterprise edition (MD.01 type and flag of the stage, MD.02 milestones of the investment life against the catalogue, CN.01 the split of the plan between the resolution of
 * the group and the decision of the company). It is a read model over what the register already holds: the milestones of the project (`project_milestone`, matched to the catalogue by code), the plan lines with their
 * origin and decision document (`v_project_origin_decision`) and the catalogues of the edition (`ent-catalogue.ts`). Nothing is stored here; the pure rules are in this file, the reads in `investment-profile-store.ts`.
 */

/** The milestone of the catalogue whose day decides whether a project starts in a plan year. */
export const START_MILESTONE = 'GROUNDBREAKING';
export const GROUP_ORIGIN = 'GROUP_ASSIGNED';
export const BOARD_ORIGIN = 'BOARD_APPROVED';

export interface HeldMilestone {
  code: string;
  plannedOn: string;
  actualOn: string | null;
  status: 'PLANNED' | 'DONE' | 'DELAYED' | 'CANCELLED';
}

export interface OriginLine {
  origin: string;
  decisionKind: string | null;
  decisionSymbol: string | null;
  decisionIssuedOn: string | null;
  issuingAuthority: string | null;
  /** Whole dong as text. */
  amountVnd: string;
}

export type MilestoneState = 'REACHED' | 'PLANNED' | 'DELAYED' | 'CANCELLED' | 'NOT_HELD';

export interface ProfileMilestone {
  code: string;
  label: string;
  sequence: number;
  phase: MilestoneEntry['phase'];
  required: boolean;
  evidenceKinds: readonly string[];
  state: MilestoneState;
  plannedOn: string | null;
  actualOn: string | null;
}

export interface OriginDecision {
  kind: string | null;
  symbol: string;
  issuedOn: string | null;
  authority: string | null;
}

export interface OriginAmount {
  origin: string;
  amountVnd: string;
  lines: number;
  decisions: OriginDecision[];
}

export interface OriginSplit {
  totalVnd: string;
  groupAssignedVnd: string;
  boardApprovedVnd: string;
  otherVnd: string;
  origins: OriginAmount[];
}

/** One active legal document of the project as the register holds it, with the type the enterprise edition gave it. */
export interface LegalDocumentRow {
  id: string;
  legalDocType: string;
  title: string;
  reference: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  effectiveState: 'UNDATED' | 'NOT_YET' | 'IN_FORCE' | 'EXPIRED';
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface LegalDocumentGroup {
  legalDocType: string;
  /** The label of the catalogue; the code itself for a type that is no longer in the catalogue. */
  label: string;
  /** Null for a type that is no longer in the catalogue. */
  issuer: LegalDocTypeEntry['issuer'] | null;
  purpose: LegalDocTypeEntry['purpose'] | null;
  /** The number of documents of the type, whatever is listed. */
  count: number;
  documents: Array<Omit<LegalDocumentRow, 'legalDocType'>>;
}

/** The documents listed under one type; `count` says how many there are. */
export const LEGAL_DOCUMENTS_PER_TYPE = 20;

export interface InvestmentProfile {
  projectType: { code: string; label: string; kind: string | null } | null;
  planYear: number;
  /** The plan versions the split is read from, one per annual plan of the year (a plan code has its own history of revisions): the published revision, else, for a caller who drafts, the newest still in work. Empty when the project has no plan in the year. */
  plans: Array<{ planCode: string | null; status: string; revision: number }>;
  startFlag: StartFlag | null;
  startYear: number | null;
  /** Where the start year comes from: the day the groundbreaking happened, the day it is planned for, or the start year written on the project when the project holds no such milestone. */
  startYearBasis: 'ACTUAL' | 'PLANNED' | 'PROJECT' | null;
  milestones: ProfileMilestone[];
  /** `MILESTONE_ORDER:<code>` (reached before an earlier milestone of the catalogue) and `REQUIRED_SKIPPED:<code>` (a required milestone not reached although a later one was). */
  findings: string[];
  originSplit: OriginSplit;
  /** The legal documents of the project by type of the catalogue (MD.02): the types of the catalogue first in the order of the pack, then the codes a tenant added, then a type that left the catalogue. */
  legalDocuments: LegalDocumentGroup[];
}

export interface ProfileInput {
  catalogue: readonly MilestoneEntry[];
  projectType: InvestmentProfile['projectType'];
  /** The start year written on the project (the register's own field), used while the project holds no groundbreaking milestone. */
  projectStartYear: number | null;
  held: readonly HeldMilestone[];
  plans: InvestmentProfile['plans'];
  origins: readonly OriginLine[];
  planYear: number;
  /** The legal-document types in force (the catalogue ENT_LEGAL_DOC_TYPE on the day). */
  legalTypes: readonly LegalDocTypeEntry[];
  /** The active documents of the project that carry a type and that the reader may read, newest first. */
  legalDocuments: readonly LegalDocumentRow[];
}

export interface PlanRevision {
  id: string;
  /** The code of the plan, which every revision of it keeps; null for a version of the legacy shape that has no capital plan. */
  planCode: string | null;
  status: string;
  revision: number;
}

const IN_WORK = ['DRAFT', 'IN_REVIEW', 'APPROVED'];

/**
 * The revisions the split is read from: one per plan. Every revision of a plan keeps its plan code, so the plan is the code, not the row; the published revision stands for the plan, and only a caller who drafts or approves
 * plans sees, when none is published, the newest revision still in work. A version without a plan code is a plan of its own.
 */
export function planRevisionsOf(candidates: readonly PlanRevision[], drafts: boolean): PlanRevision[] {
  const groups = new Map<string, PlanRevision[]>();
  for (const one of candidates) groups.set(one.planCode ?? `#${one.id}`, [...(groups.get(one.planCode ?? `#${one.id}`) ?? []), one]);
  const chosen: PlanRevision[] = [];
  for (const revisions of groups.values()) {
    const published = revisions.filter((one) => one.status === 'PUBLISHED').sort((left, right) => right.revision - left.revision)[0];
    const working = drafts ? revisions.filter((one) => IN_WORK.includes(one.status)).sort((left, right) => right.revision - left.revision)[0] : undefined;
    const pick = published ?? working;
    if (pick !== undefined) chosen.push(pick);
  }
  return chosen.sort((left, right) => (left.planCode ?? '').localeCompare(right.planCode ?? '') || left.id.localeCompare(right.id));
}

const STATE_OF: Readonly<Record<HeldMilestone['status'], MilestoneState>> = { DONE: 'REACHED', PLANNED: 'PLANNED', DELAYED: 'DELAYED', CANCELLED: 'CANCELLED' };
const yearOf = (day: string): number => Number(day.slice(0, 4));

function milestoneOf(entry: MilestoneEntry, held: readonly HeldMilestone[]): ProfileMilestone {
  const found = held.find((one) => one.code === entry.code);
  return {
    code: entry.code,
    label: entry.label,
    sequence: entry.sequence,
    phase: entry.phase,
    required: entry.required,
    evidenceKinds: entry.evidenceKinds,
    state: found === undefined ? 'NOT_HELD' : STATE_OF[found.status],
    plannedOn: found?.plannedOn ?? null,
    actualOn: found?.actualOn ?? null,
  };
}

/**
 * The year the project starts in: the day of the groundbreaking when it happened, else the day it is planned for, else the start year written on the project. A cancelled groundbreaking is a start that will not happen: it gives none,
 * whatever the project record says.
 */
function startOf(milestones: readonly ProfileMilestone[], projectStartYear: number | null): { year: number | null; basis: InvestmentProfile['startYearBasis'] } {
  const start = milestones.find((one) => one.code === START_MILESTONE);
  if (start?.state === 'CANCELLED') return { year: null, basis: null };
  if (start === undefined || start.state === 'NOT_HELD') return projectStartYear === null ? { year: null, basis: null } : { year: projectStartYear, basis: 'PROJECT' };
  if (start.state === 'REACHED' && start.actualOn !== null) return { year: yearOf(start.actualOn), basis: 'ACTUAL' };
  return start.plannedOn === null ? { year: null, basis: null } : { year: yearOf(start.plannedOn), basis: 'PLANNED' };
}

function findingsOf(milestones: readonly ProfileMilestone[]): string[] {
  const reached = milestones.filter((one) => one.state === 'REACHED' && one.actualOn !== null);
  const findings: string[] = [];
  let latest = '';
  for (const one of reached) {
    const day = one.actualOn as string;
    if (day < latest) findings.push(`MILESTONE_ORDER:${one.code}`);
    else latest = day;
  }
  const lastReached = reached.reduce((top, one) => Math.max(top, one.sequence), 0);
  for (const one of milestones) if (one.required && one.sequence < lastReached && one.state !== 'REACHED') findings.push(`REQUIRED_SKIPPED:${one.code}`);
  return findings;
}

const sumOf = (amounts: readonly string[]): string => amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString();

export function originSplitOf(lines: readonly OriginLine[]): OriginSplit {
  const origins = [...new Set(lines.map((one) => one.origin))].sort().map((origin): OriginAmount => {
    const own = lines.filter((one) => one.origin === origin);
    const decisions: OriginDecision[] = [];
    for (const one of own) {
      if (one.decisionSymbol === null || decisions.some((seen) => seen.symbol === one.decisionSymbol && seen.kind === one.decisionKind)) continue;
      decisions.push({ kind: one.decisionKind, symbol: one.decisionSymbol, issuedOn: one.decisionIssuedOn, authority: one.issuingAuthority });
    }
    decisions.sort((left, right) => left.symbol.localeCompare(right.symbol));
    return { origin, amountVnd: sumOf(own.map((one) => one.amountVnd)), lines: own.length, decisions };
  });
  const of = (names: readonly string[]): string => sumOf(origins.filter((one) => names.includes(one.origin)).map((one) => one.amountVnd));
  return {
    totalVnd: sumOf(origins.map((one) => one.amountVnd)),
    groupAssignedVnd: of([GROUP_ORIGIN]),
    boardApprovedVnd: of([BOARD_ORIGIN]),
    otherVnd: sumOf(origins.filter((one) => one.origin !== GROUP_ORIGIN && one.origin !== BOARD_ORIGIN).map((one) => one.amountVnd)),
    origins,
  };
}

const SEED_ORDER: ReadonlyMap<string, number> = new Map(LEGAL_DOC_TYPE_SEEDS.map((seed, at) => [seed.code, at]));
/** The pack lists its own types in the order the customer gives them; a code a tenant added follows by code, and the codes outside the catalogue come last. */
const typeRank = (code: string, inCatalogue: boolean): number => (!inCatalogue ? 2_000_000 : (SEED_ORDER.get(code) ?? 1_000_000));

/**
 * The legal documents of a project grouped by type. A group exists for a type with at least one active document; its documents keep the order they come in (newest first) and the first `LEGAL_DOCUMENTS_PER_TYPE` are
 * listed, while `count` is the whole number. A document of a type the catalogue no longer holds is still shown, under its code, with no issuer or purpose: it is evidence the project holds, not something to hide.
 */
export function legalDocumentsOf(types: readonly LegalDocTypeEntry[], rows: readonly LegalDocumentRow[]): LegalDocumentGroup[] {
  const entries = new Map(types.map((one) => [one.code, one] as const));
  const byType = new Map<string, LegalDocumentRow[]>();
  for (const row of rows) if (row.status === 'ACTIVE') byType.set(row.legalDocType, [...(byType.get(row.legalDocType) ?? []), row]);
  return [...byType.entries()]
    .sort(([left], [right]) => typeRank(left, entries.has(left)) - typeRank(right, entries.has(right)) || left.localeCompare(right))
    .map(([code, own]): LegalDocumentGroup => {
      const entry = entries.get(code);
      return {
        legalDocType: code,
        label: entry?.label ?? code,
        issuer: entry?.issuer ?? null,
        purpose: entry?.purpose ?? null,
        count: own.length,
        documents: own.slice(0, LEGAL_DOCUMENTS_PER_TYPE).map((one) => ({ id: one.id, title: one.title, reference: one.reference, effectiveFrom: one.effectiveFrom, effectiveTo: one.effectiveTo, effectiveState: one.effectiveState, status: one.status })),
      };
    });
}

export function investmentProfileOf(input: ProfileInput): InvestmentProfile {
  const milestones = [...input.catalogue].sort((left, right) => left.sequence - right.sequence || left.code.localeCompare(right.code)).map((entry) => milestoneOf(entry, input.held));
  const start = startOf(milestones, input.projectStartYear);
  return {
    projectType: input.projectType,
    planYear: input.planYear,
    plans: input.plans,
    startFlag: start.year === null ? null : startFlagOf({ startYear: start.year, planYear: input.planYear }),
    startYear: start.year,
    startYearBasis: start.basis,
    milestones,
    findings: findingsOf(milestones),
    originSplit: originSplitOf(input.origins),
    legalDocuments: legalDocumentsOf(input.legalTypes, input.legalDocuments),
  };
}
