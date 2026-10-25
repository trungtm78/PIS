import type { BoqLine } from '../boq-model';
import type { RevisionLine } from '../model';
import { isUuid, reasonProblem } from '../change/model';
import type { FormProblem } from '../change/model';
import { isDate } from '../workspace/model';

export const DECISION_PATH = '/ctr/ctr-08';
export const VERSIONS_PATH = '/ctr/ctr-26';

/** The permission of the decision (x-permission in openapi.json); the server judges it again, with the scope, the people of the chain, the document and the delegation limit. */
export const DECIDE_PERMISSION = 'contract.change.approve';

const link = (path: string, params: Record<string, string>): string => `${path}?${new URLSearchParams(params).toString()}`;
/** The screen that compares a change order with the contract and decides it (CTR-08). */
export const decisionLink = (projectId: string, requestId: string): string => link(DECISION_PATH, { project: projectId, request: requestId });
/** The timeline of the revisions of a contract (CTR-26). */
export const versionsLink = (contractId: string): string => link(VERSIONS_PATH, { id: contractId });

export const DECISIONS = ['approve', 'return', 'reject'] as const;
export type Decision = (typeof DECISIONS)[number];

const MAX_EVIDENCE = 50;
const MAX_LINES = 2000;
const SIGNED_AMOUNT = /^-?\d{1,24}$/;

// ---- the timeline of revisions ---------------------------------------------------------------------------------------------

/** How a revision stands now: in force, waiting for its day, over, or never decided. */
export type Standing = 'IN_FORCE' | 'WAITING' | 'OVER' | 'DRAFT' | 'REJECTED';

export interface TimelineEntry {
  revision: RevisionLine;
  standing: Standing;
  /** The signed amount this revision adds to the one it follows (the first revision adds nothing); exact decimal text. */
  deltaVnd: string | null;
  /** The part of the value that the lines of its BOQ do not cover yet, when they cover less than the value; null when they cover it. */
  boqShortVnd: string | null;
}

const standingOf = (status: string): Standing => {
  switch (status) {
    case 'EFFECTIVE':
      return 'IN_FORCE';
    case 'PENDING_EFFECTIVE':
      return 'WAITING';
    case 'SUPERSEDED':
      return 'OVER';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'DRAFT';
  }
};

const difference = (later: string, earlier: string): string => (BigInt(later) - BigInt(earlier)).toString();

/**
 * The revisions of a contract in the order they were made, each with what it adds to the revision it follows and what its BOQ leaves uncovered. A revision that was never decided
 * (a draft, a rejected one) adds nothing to the history.
 */
export function timelineOf(revisions: readonly RevisionLine[]): TimelineEntry[] {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  const byId = new Map(ordered.map((revision) => [revision.id, revision]));
  return ordered.map((revision) => {
    const standing = standingOf(revision.status);
    const follows = revision.supersedesId === null ? undefined : byId.get(revision.supersedesId);
    const decided = standing === 'IN_FORCE' || standing === 'WAITING' || standing === 'OVER';
    const short = revision.boqTotalVnd !== undefined && /^\d+$/.test(revision.boqTotalVnd) && /^\d+$/.test(revision.amountVnd) && BigInt(revision.boqTotalVnd) < BigInt(revision.amountVnd);
    return {
      revision,
      standing,
      deltaVnd: decided && follows !== undefined && /^\d+$/.test(revision.amountVnd) && /^\d+$/.test(follows.amountVnd) ? difference(revision.amountVnd, follows.amountVnd) : null,
      boqShortVnd: decided && short && revision.boqTotalVnd !== undefined ? difference(revision.amountVnd, revision.boqTotalVnd) : null,
    };
  });
}

// ---- the comparison of two BOQs ---------------------------------------------------------------------------------------------

export type LineChange = 'ADDED' | 'REMOVED' | 'CHANGED' | 'SAME';

export interface LineDiff {
  businessKey: string;
  description: string;
  change: LineChange;
  before: BoqLine | undefined;
  after: BoqLine | undefined;
}

/** The lines of the revision a change order made against the lines of the one it follows, by item: what was added, taken out, re-priced or left as it was. */
export function diffLines(before: readonly BoqLine[], after: readonly BoqLine[]): LineDiff[] {
  const was = new Map(before.map((line) => [line.businessKey, line]));
  const now = new Map(after.map((line) => [line.businessKey, line]));
  const keys = [...new Set([...before.map((line) => line.businessKey), ...after.map((line) => line.businessKey)])];
  return keys.map((businessKey) => {
    const a = was.get(businessKey);
    const b = now.get(businessKey);
    const change: LineChange = a === undefined ? 'ADDED' : b === undefined ? 'REMOVED' : a.quantity === b.quantity && a.unitPrice === b.unitPrice && a.amountVnd === b.amountVnd ? 'SAME' : 'CHANGED';
    return { businessKey, description: (b ?? a)?.description ?? '', change, before: a, after: b };
  });
}

// ---- the form of the decision -----------------------------------------------------------------------------------------------

export type DecisionProblem = FormProblem | 'date' | 'past' | 'evidence' | 'json' | 'choose';

export interface DecisionForm {
  decision: '' | Decision;
  reason: string;
  /** One identifier of a document per line, or separated by commas. */
  evidence: string;
  approvedDeltaVnd: string;
  effectiveOn: string;
  documentVersionId: string;
  /** The lines of the new BOQ as a JSON list; empty to start from a copy of the BOQ in force. */
  boqLines: string;
}

export const emptyDecision = (evaluatedDeltaVnd: string | null, today: string): DecisionForm => ({
  decision: '',
  reason: '',
  evidence: '',
  approvedDeltaVnd: evaluatedDeltaVnd ?? '',
  effectiveOn: today,
  documentVersionId: '',
  boqLines: '',
});

export const evidenceIds = (form: DecisionForm): string[] =>
  form.evidence
    .split(/[\s,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');

/** The lines typed as JSON: undefined when none were typed, a list of objects when they were, null when what was typed is none. */
export function parseLines(text: string): Array<Record<string, unknown>> | undefined | null {
  if (text.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_LINES) return null;
    return parsed.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item)) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

export function validateDecision(form: DecisionForm, today: string): Partial<Record<keyof DecisionForm, DecisionProblem>> {
  const problems: Partial<Record<keyof DecisionForm, DecisionProblem>> = {};
  if (form.decision === '') {
    problems.decision = 'choose';
    return problems;
  }
  const reason = reasonProblem(form.reason);
  if (reason !== undefined) problems.reason = reason;
  const evidence = evidenceIds(form);
  if (evidence.length > MAX_EVIDENCE || evidence.some((item) => !isUuid(item))) problems.evidence = 'evidence';
  if (form.decision !== 'approve') return problems;
  if (form.approvedDeltaVnd.trim() === '') problems.approvedDeltaVnd = 'required';
  else if (!SIGNED_AMOUNT.test(form.approvedDeltaVnd.trim())) problems.approvedDeltaVnd = 'amount';
  if (form.effectiveOn.trim() === '') problems.effectiveOn = 'required';
  else if (!isDate(form.effectiveOn)) problems.effectiveOn = 'date';
  else if (form.effectiveOn.trim() < today) problems.effectiveOn = 'past';
  if (form.documentVersionId.trim() === '') problems.documentVersionId = 'required';
  else if (!isUuid(form.documentVersionId)) problems.documentVersionId = 'uuid';
  if (parseLines(form.boqLines) === null) problems.boqLines = 'json';
  return problems;
}

export interface DecisionBody {
  decision: Decision;
  reason: string;
  evidence_ids: string[];
  approved_delta_vnd?: string;
  effective_on?: string;
  decision_document_version_id?: string;
  boq_lines?: Array<Record<string, unknown>>;
}

/** The body of the decision the form asks for; call it once the form is valid and a decision is chosen. A return and a rejection carry the reason and the evidence only. */
export function decisionBody(form: DecisionForm, decision: Decision): DecisionBody {
  const common = { reason: form.reason.trim(), evidence_ids: [...new Set(evidenceIds(form))] };
  if (decision !== 'approve') return { decision, ...common };
  const lines = parseLines(form.boqLines);
  return {
    decision: 'approve',
    ...common,
    approved_delta_vnd: BigInt(form.approvedDeltaVnd.trim()).toString(),
    effective_on: form.effectiveOn.trim(),
    decision_document_version_id: form.documentVersionId.trim().toLowerCase(),
    ...(lines === undefined || lines === null ? {} : { boq_lines: lines }),
  };
}
