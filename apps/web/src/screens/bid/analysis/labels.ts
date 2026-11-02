import type { useTranslation } from '../../../i18n';
import type { Classification, ConfidenceType, EvidenceKind, FailureKind, FindingStatus, FormProblem, Problem, ReasonProblem, RouteClass, RunStatus, Step, StepState } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function runStatusLabel(t: Translate, status: RunStatus): string {
  switch (status) {
    case 'QUEUED':
      return t('bid.analysis.status.queued');
    case 'RUNNING':
      return t('bid.analysis.status.running');
    case 'AWAITING_REVIEW':
      return t('bid.analysis.status.awaitingReview');
    case 'COMPLETED':
      return t('bid.analysis.status.completed');
    case 'FAILED':
      return t('bid.analysis.status.failed');
    case 'CANCELLED':
      return t('bid.analysis.status.cancelled');
    case 'REJECTED_BY_POLICY':
      return t('bid.analysis.status.rejectedByPolicy');
  }
}

/** The look of the badge of a run: waiting for the experts or done is fine, an end without an answer is a warning. */
export function runTone(status: RunStatus): 'ok' | 'warning' | 'danger' {
  switch (status) {
    case 'AWAITING_REVIEW':
    case 'COMPLETED':
      return 'ok';
    case 'FAILED':
    case 'REJECTED_BY_POLICY':
      return 'danger';
    default:
      return 'warning';
  }
}

export function findingStatusLabel(t: Translate, status: FindingStatus): string {
  switch (status) {
    case 'SUPPORTED':
      return t('bid.analysis.findingStatus.supported');
    case 'CONTRADICTED':
      return t('bid.analysis.findingStatus.contradicted');
    case 'MISSING':
      return t('bid.analysis.findingStatus.missing');
    case 'NEEDS_REVIEW':
      return t('bid.analysis.findingStatus.needsReview');
  }
}

export function stepLabel(t: Translate, step: Step): string {
  switch (step) {
    case 'EXTRACT':
      return t('bid.analysis.step.extract');
    case 'MATCH':
      return t('bid.analysis.step.match');
    case 'VERIFY':
      return t('bid.analysis.step.verify');
    case 'COMPLETE':
      return t('bid.analysis.step.complete');
  }
}

export function stepStateLabel(t: Translate, state: StepState): string {
  switch (state) {
    case 'DONE':
      return t('bid.analysis.stepState.done');
    case 'FAILED':
      return t('bid.analysis.stepState.failed');
    case 'PENDING':
      return t('bid.analysis.stepState.pending');
    case 'SKIPPED':
      return t('bid.analysis.stepState.skipped');
  }
}

export function classificationLabel(t: Translate, classification: Classification): string {
  switch (classification) {
    case 'PUBLIC':
      return t('bid.analysis.class.public');
    case 'INTERNAL':
      return t('bid.analysis.class.internal');
    case 'CONFIDENTIAL':
      return t('bid.analysis.class.confidential');
    case 'PERSONAL':
      return t('bid.analysis.class.personal');
    case 'IMPORTANT_CORE':
      return t('bid.analysis.class.importantCore');
  }
}

export function routeLabel(t: Translate, route: RouteClass | null): string {
  switch (route) {
    case 'DOMESTIC_HOSTED':
      return t('bid.analysis.route.domesticHosted');
    case 'SELF_HOSTED':
      return t('bid.analysis.route.selfHosted');
    case 'INTERNATIONAL':
      return t('bid.analysis.route.international');
    case null:
      return t('bid.analysis.route.none');
  }
}

/** The signal of a finding by its kind: a signal tested against an evaluation, or not, and never a probability of being right (BR-BID-08). */
export function confidenceLabel(t: Translate, type: ConfidenceType): string {
  switch (type) {
    case 'CALIBRATED':
      return t('bid.analysis.confidence.calibrated');
    case 'HEURISTIC':
      return t('bid.analysis.confidence.heuristic');
    case 'NONE':
      return t('bid.analysis.confidence.none');
  }
}

export function evidenceKindLabel(t: Translate, kind: EvidenceKind): string {
  switch (kind) {
    case 'DOCUMENT':
      return t('bid.analysis.evidenceKind.document');
    case 'SCORECARD':
      return t('bid.analysis.evidenceKind.scorecard');
    case 'DETERMINISTIC_CALC':
      return t('bid.analysis.evidenceKind.calc');
  }
}

/** Why a run ended without an answer, in the words of the person. */
export function failureMessage(t: Translate, kind: FailureKind): string {
  switch (kind) {
    case 'routeExhausted':
      return t('bid.analysis.failure.routeExhausted');
    case 'noCitation':
      return t('bid.analysis.failure.noCitation');
    case 'outputInvalid':
      return t('bid.analysis.failure.outputInvalid');
    case 'routeNotAllowed':
      return t('bid.analysis.failure.routeNotAllowed');
    case 'costAboveLimit':
      return t('bid.analysis.failure.costAboveLimit');
    case 'budget':
      return t('bid.analysis.failure.budget');
    case 'killSwitch':
      return t('bid.analysis.failure.killSwitch');
    case 'invalidJson':
      return t('bid.analysis.failure.invalidJson');
    case 'other':
      return t('bid.analysis.failure.other');
  }
}

export function formProblemMessage(t: Translate, problem: FormProblem): string {
  switch (problem) {
    case 'proposal':
      return t('bid.analysis.formProblem.proposal');
    case 'criteria':
      return t('bid.analysis.formProblem.criteria');
    case 'profile':
      return t('bid.analysis.formProblem.profile');
    case 'cost':
      return t('bid.analysis.formProblem.cost');
  }
}

export function reasonProblemMessage(t: Translate, problem: ReasonProblem): string {
  switch (problem) {
    case 'tooShort':
      return t('bid.analysis.reasonProblem.tooShort');
    case 'tooLong':
      return t('bid.analysis.reasonProblem.tooLong');
  }
}

/** What a refusal of the server says. */
export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'undeclared':
      return t('bid.analysis.error.undeclared');
    case 'ocrPending':
      return t('bid.analysis.error.ocrPending');
    case 'ocrNotRecorded':
      return t('bid.analysis.error.ocrNotRecorded');
    case 'criteriaState':
      return t('bid.analysis.error.criteriaState');
    case 'profile':
      return t('bid.analysis.error.profile');
    case 'tools':
      return t('bid.analysis.error.tools');
    case 'routeNotAllowed':
      return t('bid.analysis.error.routeNotAllowed');
    case 'budget':
      return t('bid.analysis.error.budget');
    case 'killSwitch':
      return t('bid.analysis.error.killSwitch');
    case 'validation':
      return t('bid.analysis.error.validation');
    case 'notFound':
      return t('bid.analysis.error.notFound');
    case 'state':
      return t('bid.analysis.error.state');
    case 'conflict':
      return t('bid.analysis.error.conflict');
    case 'denied':
      return t('bid.analysis.error.denied');
    case 'session':
      return t('bid.analysis.error.session');
    case 'general':
      return t('bid.analysis.error.general');
  }
}
