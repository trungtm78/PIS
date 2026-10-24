import type { useTranslation } from '../../i18n';
import type { ReasonProblem, RevisionProblem } from './revision-model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function reasonProblemMessage(t: Translate, problem: ReasonProblem): string {
  switch (problem) {
    case 'required':
      return t('cap.adjustment.reason.required.error');
    case 'tooShort':
      return t('cap.adjustment.reason.tooShort.error');
    case 'tooLong':
      return t('cap.adjustment.reason.tooLong.error');
  }
}

/** The sentence for a refusal of the revision command. */
export function revisionProblemMessage(t: Translate, problem: RevisionProblem): string {
  switch (problem) {
    case 'pending':
      return t('cap.adjustment.pending.error');
    case 'notPublished':
      return t('cap.adjustment.notPublished.error');
    case 'versionConflict':
      return t('cap.adjustment.versionConflict.error');
    case 'yearLocked':
      return t('cap.adjustment.yearLocked.error');
    case 'denied':
      return t('cap.adjustment.denied.error');
    case 'notFound':
      return t('cap.adjustment.notFound.error');
    case 'validation':
      return t('cap.adjustment.validation.error');
    case 'general':
      return t('cap.adjustment.general.error');
  }
}
