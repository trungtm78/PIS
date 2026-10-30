import type { useTranslation } from '../../../i18n';
import type { Criterion, EvaluationKind, EvaluationStatus, FormProblem, PenaltyKind, Problem, Rating, Severity, ViolationKind, ViolationStatus } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function kindLabel(t: Translate, kind: EvaluationKind): string {
  switch (kind) {
    case 'PERIODIC':
      return t('ctr.scorecard.kind.periodic');
    case 'COMPLETION':
      return t('ctr.scorecard.kind.completion');
    case 'TERMINATION':
      return t('ctr.scorecard.kind.termination');
  }
}

export function ratingLabel(t: Translate, rating: Rating): string {
  switch (rating) {
    case 'EXCELLENT':
      return t('ctr.scorecard.rating.excellent');
    case 'GOOD':
      return t('ctr.scorecard.rating.good');
    case 'FAIR':
      return t('ctr.scorecard.rating.fair');
    case 'POOR':
      return t('ctr.scorecard.rating.poor');
  }
}

export function evaluationStatusLabel(t: Translate, status: EvaluationStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('ctr.scorecard.status.draft');
    case 'SUBMITTED':
      return t('ctr.scorecard.status.submitted');
    case 'APPROVED':
      return t('ctr.scorecard.status.approved');
    case 'SUPERSEDED':
      return t('ctr.scorecard.status.superseded');
  }
}

export function criterionLabel(t: Translate, criterion: Criterion): string {
  switch (criterion) {
    case 'quality':
      return t('ctr.scorecard.criterion.quality');
    case 'schedule':
      return t('ctr.scorecard.criterion.schedule');
    case 'safetyEnv':
      return t('ctr.scorecard.criterion.safetyEnv');
    case 'cooperation':
      return t('ctr.scorecard.criterion.cooperation');
    case 'financial':
      return t('ctr.scorecard.criterion.financial');
  }
}

export function violationKindLabel(t: Translate, kind: ViolationKind): string {
  switch (kind) {
    case 'DELAY':
      return t('ctr.scorecard.violation.delay');
    case 'QUALITY':
      return t('ctr.scorecard.violation.quality');
    case 'SAFETY':
      return t('ctr.scorecard.violation.safety');
    case 'ENVIRONMENT':
      return t('ctr.scorecard.violation.environment');
    case 'FALSE_DOCUMENT':
      return t('ctr.scorecard.violation.falseDocument');
    case 'ABANDONMENT':
      return t('ctr.scorecard.violation.abandonment');
    case 'OTHER':
      return t('ctr.scorecard.violation.other');
  }
}

export function severityLabel(t: Translate, severity: Severity): string {
  switch (severity) {
    case 'MINOR':
      return t('ctr.scorecard.severity.minor');
    case 'MAJOR':
      return t('ctr.scorecard.severity.major');
    case 'CRITICAL':
      return t('ctr.scorecard.severity.critical');
  }
}

export function penaltyLabel(t: Translate, penalty: PenaltyKind): string {
  switch (penalty) {
    case 'NONE':
      return t('ctr.scorecard.penalty.none');
    case 'WARNING':
      return t('ctr.scorecard.penalty.warning');
    case 'LIQUIDATED_DAMAGES':
      return t('ctr.scorecard.penalty.liquidated');
    case 'TERMINATION':
      return t('ctr.scorecard.penalty.termination');
    case 'DEBARMENT_PROPOSAL':
      return t('ctr.scorecard.penalty.debarment');
  }
}

export function violationStatusLabel(t: Translate, status: ViolationStatus): string {
  switch (status) {
    case 'RECORDED':
      return t('ctr.scorecard.vstatus.recorded');
    case 'CONFIRMED':
      return t('ctr.scorecard.vstatus.confirmed');
    case 'APPEALED':
      return t('ctr.scorecard.vstatus.appealed');
    case 'REVOKED':
      return t('ctr.scorecard.vstatus.revoked');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'required':
      return t('ctr.scorecard.problem.required');
    case 'uuid':
      return t('ctr.scorecard.problem.uuid');
    case 'tooLong':
      return t('ctr.scorecard.problem.tooLong');
    case 'score':
      return t('ctr.scorecard.problem.score');
    case 'amount':
      return t('ctr.scorecard.problem.amount');
    case 'day':
      return t('ctr.scorecard.problem.day');
    case 'future':
      return t('ctr.scorecard.problem.future');
  }
}

/** What a refusal of the server says, in words. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'selfApproval':
      return t('ctr.scorecard.error.selfApproval');
    case 'duplicate':
      return t('ctr.scorecard.error.duplicate');
    case 'evaluationState':
      return t('ctr.scorecard.error.evaluationState');
    case 'violationState':
      return t('ctr.scorecard.error.violationState');
    case 'contractState':
      return t('ctr.scorecard.error.contractState');
    case 'decisionRequired':
      return t('ctr.scorecard.error.decisionRequired');
    case 'notClean':
      return t('ctr.scorecard.error.notClean');
    case 'versionConflict':
      return t('ctr.scorecard.error.versionConflict');
    case 'validation':
      return t('ctr.scorecard.error.validation');
    case 'denied':
      return t('ctr.scorecard.error.denied');
    case 'notFound':
      return t('ctr.scorecard.error.notFound');
    case 'session':
      return t('ctr.scorecard.error.session');
    case 'general':
      return t('ctr.scorecard.error.general');
  }
}
