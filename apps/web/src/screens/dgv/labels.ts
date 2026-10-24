import type { useTranslation } from '../../i18n';
import type { Classification, DatasetStatus, FieldProblem, ProblemView, QualityBadge } from './model';
import { freshnessOf } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function classificationLabel(t: Translate, classification: Classification): string {
  switch (classification) {
    case 'PUBLIC':
      return t('dgv.classification.public.text');
    case 'INTERNAL':
      return t('dgv.classification.internal.text');
    case 'CONFIDENTIAL':
      return t('dgv.classification.confidential.text');
    case 'PERSONAL':
      return t('dgv.classification.personal.text');
    case 'IMPORTANT_CORE':
      return t('dgv.classification.importantCore.text');
  }
}

export function statusLabel(t: Translate, status: DatasetStatus): string {
  switch (status) {
    case 'DRAFT':
      return t('dgv.status.dataset.draft.text');
    case 'ACTIVE':
      return t('dgv.status.dataset.active.text');
    case 'DEPRECATED':
      return t('dgv.status.dataset.deprecated.text');
    case 'RETIRED':
      return t('dgv.status.dataset.retired.text');
  }
}

export function badgeLabel(t: Translate, badge: QualityBadge): string {
  switch (badge) {
    case 'NOT_ASSESSED':
      return t('dgv.badge.notAssessed.text');
    case 'PASSED':
      return t('dgv.badge.passed.text');
    case 'WARNING':
      return t('dgv.badge.warning.text');
    case 'FAILED':
      return t('dgv.badge.failed.text');
    case 'STALE':
      return t('dgv.badge.stale.text');
  }
}

/** The colour of a badge; "not assessed" is neutral, never green or red (BR-DGV-01). */
export function badgeTone(badge: QualityBadge): 'green' | 'gray' | 'warn' | 'red' {
  switch (badge) {
    case 'PASSED':
      return 'green';
    case 'WARNING':
    case 'STALE':
      return 'warn';
    case 'FAILED':
      return 'red';
    case 'NOT_ASSESSED':
      return 'gray';
  }
}

export function freshnessLabel(t: Translate, seconds: number): string {
  const { unit, count } = freshnessOf(seconds);
  switch (unit) {
    case 'days':
      return t('dgv.freshness.days.text', { count });
    case 'hours':
      return t('dgv.freshness.hours.text', { count });
    case 'minutes':
      return t('dgv.freshness.minutes.text', { count });
    case 'seconds':
      return t('dgv.freshness.seconds.text', { count });
  }
}

export function fieldProblemMessage(t: Translate, problem: FieldProblem): string {
  switch (problem) {
    case 'required':
      return t('dgv.field.required.error');
    case 'tooShort':
      return t('dgv.field.tooShort.error');
    case 'tooLong':
      return t('dgv.field.tooLong.error');
    case 'invalidNumber':
      return t('dgv.field.invalidNumber.error');
    case 'invalidModule':
      return t('dgv.field.invalidModule.error');
    case 'sameAsOwner':
      return t('dgv.field.sameAsOwner.error');
  }
}

/** The sentence for a refusal of a command; a problem the screen has no sentence for is the general one. */
export function problemMessage(t: Translate, problem: ProblemView): string {
  switch (problem.reason) {
    case 'ownerStewardSame':
      return t('dgv.problem.ownerStewardSame.error');
    case 'duplicateCode':
      return t('dgv.problem.duplicateCode.error');
    case 'versionConflict':
      return t('dgv.problem.versionConflict.error');
    case 'validation':
      return problem.field === undefined ? t('dgv.problem.validation.error') : t('dgv.problem.validationField.error', { field: problem.field });
    case 'notFound':
      return t('dgv.problem.notFound.error');
    case 'retired':
      return t('dgv.problem.retired.error');
    case 'denied':
      return t('dgv.problem.denied.error');
    case 'general':
      return t('dgv.problem.general.error');
  }
}
