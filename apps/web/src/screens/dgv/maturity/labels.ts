import type { Translator } from '../../../i18n';
import type { AssessmentStatus, CriterionState, EvidenceKind, MaturityReason, MilestoneStatus, OverallState, ReviewStatus, RubricStatus, Scope } from './model';

type T = Translator['t'];

export function pillarLabel(t: T, code: string): string {
  switch (code) {
    case 'GOVERNANCE':
      return t('dgv.maturity.pillar.governance');
    case 'METADATA':
      return t('dgv.maturity.pillar.metadata');
    case 'QUALITY':
      return t('dgv.maturity.pillar.quality');
    case 'INTEGRATION':
      return t('dgv.maturity.pillar.integration');
    case 'SECURITY':
      return t('dgv.maturity.pillar.security');
    case 'LINEAGE_BI':
      return t('dgv.maturity.pillar.lineage');
    case 'AI_READINESS':
      return t('dgv.maturity.pillar.ai');
    case 'VALUE_COST':
      return t('dgv.maturity.pillar.value');
    default:
      return code;
  }
}

export function rubricStatusLabel(t: T, status: RubricStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('dgv.maturity.rubric.status.draft');
    case 'PUBLISHED':
      return t('dgv.maturity.rubric.status.published');
    case 'SUPERSEDED':
      return t('dgv.maturity.rubric.status.superseded');
  }
}

export function assessmentStatusLabel(t: T, status: AssessmentStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('dgv.maturity.status.draft');
    case 'IN_REVIEW':
      return t('dgv.maturity.status.inReview');
    case 'PUBLISHED':
      return t('dgv.maturity.status.published');
    case 'REJECTED':
      return t('dgv.maturity.status.rejected');
  }
}

export function stateLabel(t: T, state: CriterionState): string {
  switch (state) {
    case 'ASSESSED':
      return t('dgv.maturity.state.assessed');
    case 'NOT_ASSESSED':
      return t('dgv.maturity.state.notAssessed');
    case 'NOT_APPLICABLE':
      return t('dgv.maturity.state.notApplicable');
  }
}

export function reviewLabel(t: T, status: ReviewStatus): string {
  switch (status) {
    case 'PENDING':
      return t('dgv.maturity.review.pending');
    case 'ACCEPTED':
      return t('dgv.maturity.review.accepted');
    case 'REJECTED':
      return t('dgv.maturity.review.rejected');
    case 'EXPIRED':
      return t('dgv.maturity.review.expired');
  }
}

export function overallLabel(t: T, state: OverallState): string {
  return state === 'COMPUTED' ? t('dgv.maturity.overall.computed') : t('dgv.maturity.overall.notComputed');
}

export function milestoneStatusLabel(t: T, status: MilestoneStatus): string {
  switch (status) {
    case 'PLANNED':
      return t('dgv.maturity.milestone.status.planned');
    case 'IN_PROGRESS':
      return t('dgv.maturity.milestone.status.inProgress');
    case 'ACHIEVED':
      return t('dgv.maturity.milestone.status.achieved');
    case 'MISSED':
      return t('dgv.maturity.milestone.status.missed');
  }
}

export function scopeLabel(t: T, scope: Scope): string {
  switch (scope) {
    case 'TENANT':
      return t('dgv.maturity.scope.tenant');
    case 'DOMAIN':
      return t('dgv.maturity.scope.domain');
    case 'DATA_PRODUCT':
      return t('dgv.maturity.scope.product');
  }
}

export function kindLabel(t: T, kind: EvidenceKind): string {
  switch (kind) {
    case 'ARTIFACT':
      return t('dgv.maturity.kind.artifact');
    case 'LOG':
      return t('dgv.maturity.kind.log');
    case 'INTERVIEW':
      return t('dgv.maturity.kind.interview');
    case 'TEST':
      return t('dgv.maturity.kind.test');
  }
}

export function confidenceLabel(t: T, confidence: string): string {
  switch (confidence) {
    case 'HIGH':
      return t('dgv.maturity.confidence.high');
    case 'MEDIUM':
      return t('dgv.maturity.confidence.medium');
    case 'LOW':
      return t('dgv.maturity.confidence.low');
    default:
      return confidence;
  }
}

export function problemMessage(t: T, reason: MaturityReason, detail: string): string {
  switch (reason) {
    case 'weights':
      return t('dgv.maturity.problem.weights');
    case 'notPublished':
      return t('dgv.maturity.problem.notPublished');
    case 'sameRole':
      return t('dgv.maturity.problem.sameRole');
    case 'evidenceRequired':
      return t('dgv.maturity.problem.evidenceRequired');
    case 'expired':
      return t('dgv.maturity.problem.expired');
    case 'level':
      return t('dgv.maturity.problem.level');
    case 'targetBelow':
      return t('dgv.maturity.problem.targetBelow');
    case 'self':
      return t('dgv.maturity.problem.self');
    case 'scope':
      return t('dgv.maturity.problem.scope');
    case 'stale':
      return t('dgv.maturity.problem.stale');
    case 'state':
      return t('dgv.maturity.problem.state');
    case 'duplicate':
      return t('dgv.maturity.problem.duplicate');
    case 'validation':
      return t('dgv.maturity.problem.validation', { field: detail });
    case 'notFound':
      return t('dgv.maturity.problem.notFound');
    case 'general':
      return t('dgv.maturity.problem.general');
  }
}
