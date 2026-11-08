import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import { FEASIBILITY_SECTIONS, SOURCE_KINDS, camelKey, failureCode, failureDetail, failureStatus, isKnownCode, parseReviewDetail } from './assist-model';
import type {
  ApprovalProblem,
  CheckKind,
  CheckSeverity,
  Completeness,
  ConfigStatus,
  Decision,
  ExceptionStatus,
  ExternalRouting,
  FieldProblem,
  PresentedAs,
  ReviewBy,
  ReviewResult,
  RunKind,
  RunProblem,
  RunStatus,
  ScoreStatus,
  SourceProblem,
  StatementDecisionProblem,
  Verdict,
  Verification,
  WeightState,
} from './assist-model';

type T = Translator['t'];

// Every label of an enumeration is one key of a family (`llm.assist.<family>.<value in lower camel case>`): the catalogue holds one key for each value and a test holds the lists to it.

export const kindLabel = (t: T, kind: RunKind): string => t(`llm.assist.kind.${camelKey(kind)}`);

export const kindHint = (t: T, kind: RunKind): string => t(`llm.assist.kindHint.${camelKey(kind)}`);

/** The name of a kind of source; a kind this screen does not know is shown as the server wrote it. */
export const sourceKindLabel = (t: T, kind: string): string => ((SOURCE_KINDS as readonly string[]).includes(kind) ? t(`llm.assist.sourceKind.${camelKey(kind)}`) : kind);

export const basisLabel = (t: T, basis: PresentedAs): string => t(`llm.assist.basis.${camelKey(basis)}`);

export const basisHint = (t: T, basis: PresentedAs): string => t(`llm.assist.basisHint.${camelKey(basis)}`);

export const verificationLabel = (t: T, verification: Verification): string => t(`llm.assist.verification.${camelKey(verification)}`);

export const runStatusLabel = (t: T, status: RunStatus): string => t(`llm.assist.runStatus.${camelKey(status)}`);

export const completenessLabel = (t: T, completeness: Completeness): string => t(`llm.assist.completeness.${camelKey(completeness)}`);

export const completenessNote = (t: T, completeness: Completeness): string => t(`llm.assist.completenessNote.${camelKey(completeness)}`);

export const decisionLabel = (t: T, decision: Decision): string => t(`llm.assist.decision.${camelKey(decision)}`);

export const checkKindLabel = (t: T, kind: CheckKind): string => t(`llm.assist.checkKind.${camelKey(kind)}`);

export const severityLabel = (t: T, severity: CheckSeverity): string => t(`llm.assist.severity.${camelKey(severity)}`);

export const reviewResultLabel = (t: T, result: ReviewResult): string => t(`llm.assist.reviewResult.${camelKey(result)}`);

export const reviewByLabel = (t: T, by: ReviewBy): string => t(`llm.assist.reviewBy.${camelKey(by)}`);

export const verdictLabel = (t: T, verdict: Verdict): string => t(`llm.assist.verdict.${camelKey(verdict)}`);

export const verdictNote = (t: T, verdict: Verdict): string => t(`llm.assist.verdictNote.${camelKey(verdict)}`);

export const scoreStatusLabel = (t: T, status: ScoreStatus): string => t(`llm.assist.scoreStatus.${camelKey(status)}`);

/** A section of a feasibility analysis; a section this screen does not know is shown as the server wrote it. */
export function sectionLabel(t: T, section: string): string {
  return (FEASIBILITY_SECTIONS as readonly string[]).includes(section) ? t(`llm.assist.section.${camelKey(section)}`) : section;
}

export const configStatusLabel = (t: T, status: ConfigStatus): string => t(`llm.assist.configStatus.${camelKey(status)}`);

export const exceptionStatusLabel = (t: T, status: ExceptionStatus): string => t(`llm.assist.exceptionStatus.${camelKey(status)}`);

export const routingNote = (t: T, routing: ExternalRouting): string => t(`llm.assist.routing.${camelKey(routing)}`);

export const weightStateText = (t: T, state: WeightState, params: { total: string }): string => t(`llm.assist.weight.${camelKey(state)}`, params);

/** The sentence for a refusal code (of a failed command or of a refused run); a code outside the list gets the generic sentence with the code beside it. */
export function codeText(t: T, code: string): string {
  return isKnownCode(code) ? t(`llm.assist.error.${camelKey(code)}`) : t('llm.assist.error.other', { code });
}

/** What a failed command says to the person: the sentence of the code, the detail of a validation, the refusal of the scope, else the generic sentence. */
export function errorText(t: T, error: unknown): string {
  const code = failureCode(error);
  if (code === 'VALIDATION_FAILED') {
    const detail = failureDetail(error);
    return detail === undefined ? t('llm.assist.error.validationFailed') : t('llm.assist.error.validationDetail', { detail });
  }
  if (code !== undefined && isKnownCode(code)) return t(`llm.assist.error.${camelKey(code)}`);
  if (failureStatus(error) === 403) return t('llm.assist.error.scopeDenied');
  return t('llm.assist.error.unknown');
}

export function fieldProblemText(t: T, problem: FieldProblem): string {
  return t(`llm.assist.problem.${problem}`);
}

export function runProblemText(t: T, problem: RunProblem): string {
  return t(`llm.assist.runProblem.${camelKey(problem)}`);
}

export function sourceProblemText(t: T, problem: SourceProblem): string {
  return t(`llm.assist.sourceProblem.${camelKey(problem)}`);
}

export function decisionProblemText(t: T, problem: StatementDecisionProblem): string {
  return t(`llm.assist.decisionProblem.${camelKey(problem)}`);
}

export function approvalProblemText(t: T, problem: ApprovalProblem): string {
  return t(`llm.assist.approvalProblem.${camelKey(problem)}`);
}

/** The detail of an item of a review in words. */
export function reviewDetailText(t: T, detail: string): string {
  const parsed = parseReviewDetail(detail);
  switch (parsed.kind) {
    case 'missing':
      return t('llm.review.detail.missing', { terms: parsed.terms });
    case 'words':
      return t('llm.review.detail.words', { words: parsed.words, min: parsed.min });
    case 'patternAbsent':
      return t('llm.review.detail.patternAbsent');
    case 'patternPresent':
      return t('llm.review.detail.patternPresent');
    case 'notAnswered':
      return t('llm.review.detail.notAnswered');
    case 'passWithoutEvidence':
      return t('llm.review.detail.passWithoutEvidence');
    case 'notComputable':
      return t('llm.review.detail.notComputable');
    case 'other':
      return parsed.text;
  }
}

// ---- tones: a state is always written next to its tone ----------------------------------------------------------------------------------------------------------------

export function basisTone(basis: PresentedAs): Tone {
  switch (basis) {
    case 'SOURCE':
      return 'success';
    case 'ASSUMPTION':
      return 'warning';
    case 'INFERENCE':
      return 'info';
    case 'UNSUPPORTED':
      return 'danger';
  }
}

export function completenessTone(completeness: Completeness): Tone {
  return completeness === 'FULL' ? 'success' : completeness === 'PARTIAL' ? 'warning' : 'danger';
}

export function runStatusTone(status: RunStatus): Tone {
  return status === 'COMPLETED' ? 'success' : status === 'REFUSED' ? 'warning' : 'danger';
}

export function decisionTone(decision: Decision): Tone {
  return decision === 'REJECTED' ? 'neutral' : 'success';
}

export function severityTone(severity: CheckSeverity): Tone {
  return severity === 'BLOCKER' ? 'danger' : severity === 'WARNING' ? 'warning' : 'info';
}

/** Only a proven pass is green; a result that is not proven is never shown as one. */
export function resultTone(result: ReviewResult): Tone {
  return result === 'PASS' ? 'success' : result === 'FAIL' ? 'danger' : 'warning';
}

export function verdictTone(verdict: Verdict): Tone {
  return verdict === 'READY' ? 'success' : verdict === 'NEEDS_ATTENTION' ? 'warning' : 'danger';
}

export function scoreStatusTone(status: ScoreStatus): Tone {
  return status === 'PROPOSED' ? 'success' : status === 'OUT_OF_SCALE' ? 'danger' : 'warning';
}

export function configStatusTone(status: ConfigStatus): Tone {
  return status === 'PUBLISHED' ? 'success' : status === 'DRAFT' ? 'info' : 'neutral';
}

export function exceptionStatusTone(status: ExceptionStatus, inForce: boolean): Tone {
  if (status === 'APPROVED') return inForce ? 'success' : 'neutral';
  return status === 'REQUESTED' ? 'info' : status === 'REJECTED' ? 'danger' : 'neutral';
}
