import type { Translator } from '../../i18n';
import type { Problem } from './approval-model';

/** What a refusal of the decision says to the person, in words; one place for the queue (PWA-02) and the detail (PWA-05). */
export function problemText(t: Translator['t'], problem: Problem): string {
  switch (problem) {
    case 'selfApproval':
      return t('pwa.approvals.problem.selfApproval');
    case 'stepUp':
      return t('pwa.approvals.problem.stepUp');
    case 'notAuthorized':
      return t('pwa.approvals.problem.notAuthorized');
    case 'alreadyDecided':
      return t('pwa.approvals.problem.alreadyDecided');
    case 'versionConflict':
      return t('pwa.approvals.problem.versionConflict');
    case 'notRunning':
      return t('pwa.approvals.problem.notRunning');
    case 'periodLocked':
      return t('pwa.approvals.problem.periodLocked');
    case 'licenseExpired':
      return t('pwa.approvals.problem.licenseExpired');
    case 'denied':
      return t('pwa.approvals.problem.denied');
    case 'notFound':
      return t('pwa.approvals.problem.notFound');
    case 'validation':
      return t('pwa.approvals.problem.validation');
    case 'sessionEnded':
      return t('pwa.approvals.problem.sessionEnded');
    case 'general':
      return t('pwa.approvals.problem.general');
  }
}
