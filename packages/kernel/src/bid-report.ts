import { DomainError } from './errors.ts';
import type { CellRisk, Comparison, ComparisonRow } from './bid-review.ts';
import type { FindingStatus } from './bid-analysis.ts';
import type { ConflictStanding } from './bid-proposal.ts';
import { payloadSha256 } from './pdf-render.ts';
import { asUuid } from './tenant-context.ts';

/**
 * The evaluation report of a package and its sign-off by the evaluation team (ST-BID-012, BID 3 F6, BR-BID-03/09, BID-13). The report is made from what the experts decided about the findings of the analyses and from
 * nothing the model said: it freezes the comparison of the chosen runs together with the conclusion its author wrote, every member of the team signs it (with the dissent they hold, in their own words), and when the
 * last one has signed DOC is asked to issue the minutes. Everything that judges a report lives here as pure functions: the words a person gives, the road a report takes, who has still to sign, and the payload DOC prints.
 */

export const EVALUATION_REPORT_STATUSES = ['DRAFT', 'SIGNED_OFF', 'ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED'] as const;
export type EvaluationReportStatus = (typeof EVALUATION_REPORT_STATUSES)[number];

/** The edges of BID 4: a fully signed report asks DOC to issue it; DOC's refusal puts it back to SIGNED_OFF; a member shut out by a conflict takes a complete sign-off back to DRAFT; a later issued report supersedes it. */
export const EVALUATION_REPORT_TRANSITIONS: ReadonlyArray<readonly [EvaluationReportStatus, EvaluationReportStatus]> = [
  ['DRAFT', 'SIGNED_OFF'],
  ['SIGNED_OFF', 'DRAFT'],
  ['SIGNED_OFF', 'ISSUE_REQUESTED'],
  ['ISSUE_REQUESTED', 'ISSUED'],
  ['ISSUE_REQUESTED', 'SIGNED_OFF'],
  ['ISSUED', 'SUPERSEDED'],
];

/** The statuses in which the decisions the report was made from are frozen: the findings of its runs are no longer decided again (409 `REPORT_FROZEN`). */
export const FROZEN_REPORT_STATUSES: readonly EvaluationReportStatus[] = ['ISSUE_REQUESTED', 'ISSUED', 'SUPERSEDED'];

/** The module DOC knows the request by, the template it issues the minutes with, and how it names a report in its events. */
export const EVALUATION_REPORT_SOURCE_MODULE = 'BID';
export const EVALUATION_REPORT_TEMPLATE_CODE = 'BID-BB-DANH-GIA-HSDT';
const SOURCE_REF = /^BID:evaluation_report:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const evaluationReportSourceRef = (id: string): string => `BID:evaluation_report:${id.toLowerCase()}`;

export function parseEvaluationReportSourceRef(ref: unknown): { id: string } | undefined {
  if (typeof ref !== 'string') return undefined;
  const found = SOURCE_REF.exec(ref);
  return found === null ? undefined : { id: found[1] as string };
}

/** The conclusion of the minutes and the dissent of a member are written in words a colleague can read. */
export const MIN_CONCLUSION = 20;
export const MAX_CONCLUSION = 8000;
export const MIN_DISSENT = 20;
export const MAX_DISSENT = 4000;
/** At most this many runs make a report: one for each proposal of the package. */
export const MAX_REPORT_RUNS = 500;

const wordsOf = (value: unknown): string => (typeof value === 'string' ? value.normalize('NFC').trim() : '');

/** The conclusion the author writes: 422 `VALIDATION_FAILED` on `summary` when it is not there, too short once trimmed or too long. */
export function reportConclusionOf(summary: unknown): string {
  const conclusion = typeof summary === 'object' && summary !== null && !Array.isArray(summary) ? wordsOf((summary as Record<string, unknown>).conclusion) : '';
  const keys = typeof summary === 'object' && summary !== null ? Object.keys(summary) : [];
  if (conclusion.length < MIN_CONCLUSION || conclusion.length > MAX_CONCLUSION || keys.some((key) => key !== 'conclusion')) throw new DomainError('VALIDATION_FAILED', 422, 'summary');
  return conclusion;
}

/** The dissent a member signs with, in their own words; none is fine, an empty or short one is not (422 `VALIDATION_FAILED` on `dissent`). */
export function reportDissentOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = wordsOf(value);
  if (text.length < MIN_DISSENT || text.length > MAX_DISSENT) throw new DomainError('VALIDATION_FAILED', 422, 'dissent');
  return text;
}

/** The runs a report is made from: some ids, each named once (422 `VALIDATION_FAILED` on `run_ids`). */
export function reportRunIdsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REPORT_RUNS) throw new DomainError('VALIDATION_FAILED', 422, 'run_ids');
  const ids = value.map((item) => asUuid(item));
  if (ids.some((id) => id === undefined) || new Set(ids).size !== ids.length) throw new DomainError('VALIDATION_FAILED', 422, 'run_ids');
  return (ids as string[]).sort();
}

/** The report is in one of the states the action starts from (409 `REPORT_STATE_INVALID`, naming the state). */
export function assertEvaluationReportState(status: EvaluationReportStatus, allowed: readonly EvaluationReportStatus[]): void {
  if (!allowed.includes(status)) throw new DomainError('REPORT_STATE_INVALID', 409, 'status', { extensions: { report_status: status } });
}

/** A report is signed while it is a draft; once it has asked DOC for the minutes, or has them, it is not changed. */
export const assertReportDraft = (status: EvaluationReportStatus): void => assertEvaluationReportState(status, ['DRAFT']);

// ---- the team ------------------------------------------------------------------------------------------------------------------------------

export interface TeamMember {
  membershipId: string;
  standing: ConflictStanding;
}

/** A member shut out by a decision on a conflict of interest signs nothing and is not waited for. */
const SHUT_OUT: readonly ConflictStanding[] = ['RECUSED', 'BLOCKED'];

/** A signature is a membership id or an object that names the membership (what `removeFromSignOff` of the conflict store reads too). */
export function signerIds(signedOffBy: readonly unknown[]): string[] {
  return signedOffBy.flatMap((entry) => {
    const id = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).membership_id : undefined;
    return typeof id === 'string' ? [id.toLowerCase()] : [];
  });
}

export interface Quorum {
  /** The members whose signature the report waits for: the whole team but the ones a decision on a conflict shut out. */
  required: TeamMember[];
  awaiting: TeamMember[];
  complete: boolean;
}

/** Every member of the team who is not shut out has signed. A team with nobody to sign is never complete. */
export function evaluationQuorum(team: readonly TeamMember[], signed: readonly string[]): Quorum {
  const required = team.filter((member) => !SHUT_OUT.includes(member.standing));
  const signers = new Set(signed.map((id) => id.toLowerCase()));
  const awaiting = required.filter((member) => !signers.has(member.membershipId.toLowerCase()));
  return { required, awaiting, complete: required.length > 0 && awaiting.length === 0 };
}

// ---- the content ---------------------------------------------------------------------------------------------------------------------------

export interface DecisionLine {
  findingId: string;
  runId: string;
  status: FindingStatus;
  score: string | null;
  decision: string;
  decidedAt: string;
}

/** The digest of what the experts decided about the findings of the runs: a decision made again after the report was drafted changes it, and the report no longer says what stands. */
export function decisionsDigest(lines: readonly DecisionLine[]): string {
  return payloadSha256({ decisions: [...lines].sort((a, b) => a.findingId.localeCompare(b.findingId)).map((line) => [line.findingId, line.runId, line.status, line.score, line.decision, line.decidedAt]) });
}

export type NotCoveredReason = 'NOT_SELECTED' | 'NO_ANALYSIS_RUN' | 'CRITERIA_VERSION_MISMATCH';

export interface ReportSummary {
  conclusion: string;
  package: { id: string; code: string };
  criteria_version_id: string;
  decisions_sha256: string;
  proposals: Array<{
    proposal_id: string;
    contractor: { id: string; legal_name: string };
    run_id: string;
    criteria_count: number;
    decided_count: number;
    mandatory_not_met: number;
    weighted_score: string | null;
  }>;
  rows: Array<{
    criterion: { code: string; name: string; kind: string; weight: number | null; max_score: number | null; threshold: number | null; mandatory: boolean };
    cells: Array<{ proposal_id: string; finding_id: string | null; decided: { status: FindingStatus; score: string | null; decision: string; decided_at: string } | null; risk: CellRisk }>;
  }>;
  not_covered: Array<{ proposal_id: string; contractor: { id: string; legal_name: string }; reason: NotCoveredReason }>;
  excluded_criteria: Array<{ code: string; rule: string }>;
  excluded_attributes: string[];
}

export interface SummaryInput {
  conclusion: string;
  pack: { id: string; code: string };
  comparison: Comparison;
  /** The proposals with a standing analysis that the author did not choose. */
  notSelected: ReadonlyArray<{ proposalId: string; contractor: { id: string; name: string } }>;
  decisionsSha256: string;
}

const rowOf = (row: ComparisonRow): ReportSummary['rows'][number] => ({
  criterion: { code: row.criterion.code, name: row.criterion.name, kind: row.criterion.kind, weight: row.criterion.weight, max_score: row.criterion.maxScore, threshold: row.criterion.threshold, mandatory: row.criterion.mandatory },
  cells: row.cells.map((cell) => ({
    proposal_id: cell.proposalId,
    finding_id: cell.findingId,
    decided: cell.decided === null ? null : { status: cell.decided.status, score: cell.decided.score, decision: cell.decided.decision, decided_at: cell.decided.decidedAt },
    risk: cell.risk,
  })),
});

/**
 * What the report freezes: the comparison of the chosen runs (what the experts decided cell by cell, with the weighted score and the mandatory criteria not met; no ranking and no winner) and the
 * proposals of the package that are not in it, with the reason. The words of the model are not part of it.
 */
export function reportSummary(input: SummaryInput): ReportSummary {
  const left = (proposalId: string, contractor: { id: string; name: string }, reason: NotCoveredReason): ReportSummary['not_covered'][number] => ({ proposal_id: proposalId, contractor: { id: contractor.id, legal_name: contractor.name }, reason });
  return {
    conclusion: input.conclusion,
    package: input.pack,
    criteria_version_id: input.comparison.criteriaVersionId,
    decisions_sha256: input.decisionsSha256,
    proposals: input.comparison.proposals.map((proposal) => ({
      proposal_id: proposal.proposalId,
      contractor: { id: proposal.contractor.id, legal_name: proposal.contractor.name },
      run_id: proposal.runId,
      criteria_count: proposal.criteriaCount,
      decided_count: proposal.decidedCount,
      mandatory_not_met: proposal.mandatoryNotMet,
      weighted_score: proposal.weightedScore,
    })),
    rows: input.comparison.rows.map(rowOf),
    not_covered: [
      ...input.notSelected.map((entry) => left(entry.proposalId, entry.contractor, 'NOT_SELECTED')),
      ...input.comparison.excluded.map((entry) => left(entry.proposalId, entry.contractor, entry.reason)),
    ].sort((a, b) => a.contractor.legal_name.localeCompare(b.contractor.legal_name) || a.proposal_id.localeCompare(b.proposal_id)),
    excluded_criteria: input.comparison.excludedCriteria,
    excluded_attributes: input.comparison.excludedAttributes,
  };
}

// ---- the minutes DOC prints ---------------------------------------------------------------------------------------------------------------

const STATUS_WORDS: Readonly<Record<FindingStatus, string>> = { SUPPORTED: 'đáp ứng', CONTRADICTED: 'mâu thuẫn với hồ sơ', MISSING: 'thiếu', NEEDS_REVIEW: 'chưa kết luận' };
const RISK_WORDS: Readonly<Record<CellRisk, string>> = { UNDECIDED: 'chưa có quyết định', NONE: 'không có lưu ý', ATTENTION: 'cần lưu ý', MANDATORY_NOT_MET: 'không đạt tiêu chí bắt buộc' };
const NOT_COVERED_WORDS: Readonly<Record<NotCoveredReason, string>> = { NOT_SELECTED: 'không đưa vào biên bản', NO_ANALYSIS_RUN: 'chưa có lượt phân tích', CRITERIA_VERSION_MISMATCH: 'phân tích theo bộ tiêu chí khác' };

export interface Signature {
  displayName: string;
  signedAt: string;
}

export interface Dissent {
  displayName: string;
  text: string;
  recordedAt: string;
}

export interface PayloadInput {
  summary: ReportSummary;
  packageName: string;
  agency: string;
  signatures: readonly Signature[];
  dissents: readonly Dissent[];
}

const criterionLine = (row: ReportSummary['rows'][number], index: number): string => {
  const cell = row.cells[index];
  const decided = cell?.decided ?? null;
  if (decided === null) return `   - ${row.criterion.code} ${row.criterion.name}: chưa có quyết định`;
  const score = decided.score === null ? '' : `, điểm ${decided.score}${row.criterion.max_score === null ? '' : `/${row.criterion.max_score}`}`;
  return `   - ${row.criterion.code} ${row.criterion.name}: ${STATUS_WORDS[decided.status]}${score}; ${RISK_WORDS[cell?.risk ?? 'NONE']}`;
};

/**
 * What DOC prints (the placeholders `title` and `body` of the template BID-BB-DANH-GIA-HSDT, and the agency and place every head of a document needs): the package, one block for each proposal with what the
 * experts decided for each criterion, the proposals left out, the conclusion, who signed and the dissent of whoever holds one. The same report with the same signatures always gives the same payload, which is
 * what its hash is the hash of. The minutes say nothing of an award: that is another decision.
 */
export function evaluationReportPayload(input: PayloadInput): Record<string, string> {
  const { summary } = input;
  const lines: string[] = [`Gói thầu ${summary.package.code}: ${input.packageName}`, `Số hồ sơ dự thầu được đánh giá: ${summary.proposals.length}.`];
  summary.proposals.forEach((proposal, position) => {
    const score = proposal.weighted_score === null ? 'chưa đủ điểm để tính' : proposal.weighted_score;
    lines.push('', `${position + 1}. ${proposal.contractor.legal_name}: điểm theo trọng số ${score}; tiêu chí bắt buộc không đạt: ${proposal.mandatory_not_met}; đã quyết định ${proposal.decided_count}/${proposal.criteria_count} tiêu chí.`);
    for (const row of summary.rows) lines.push(criterionLine(row, summary.proposals.findIndex((candidate) => candidate.proposal_id === proposal.proposal_id)));
  });
  if (summary.not_covered.length > 0) {
    lines.push('', 'Hồ sơ không có trong biên bản:');
    for (const entry of summary.not_covered) lines.push(`   - ${entry.contractor.legal_name}: ${NOT_COVERED_WORDS[entry.reason]}`);
  }
  lines.push('', 'Kết luận của tổ chuyên gia:', summary.conclusion, '', 'Các thành viên đã ký:');
  for (const signature of input.signatures) lines.push(`   - ${signature.displayName} (${signature.signedAt})`);
  if (input.dissents.length > 0) {
    lines.push('', 'Ý kiến khác:');
    for (const dissent of input.dissents) lines.push(`   - ${dissent.displayName} (${dissent.recordedAt}): ${dissent.text}`);
  }
  return {
    title: `BIÊN BẢN ĐÁNH GIÁ HỒ SƠ DỰ THẦU - GÓI THẦU ${summary.package.code}`,
    body: lines.join('\n'),
    agency: input.agency,
    // The place of issue is in no record of the tenant; DOC requires it, and its drafter completes a dash before the minutes go out.
    place: '-',
  };
}
