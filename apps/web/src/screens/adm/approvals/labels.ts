import { businessTypeLabel } from '../workflow/labels';
import { BUSINESS_TYPES } from '../workflow/model';
import type { useTranslation } from '../../../i18n';
import type { Problem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export { BUSINESS_TYPES, businessTypeLabel };

export function problemMessage(t: Translate, problem: Problem): string {
  switch (problem) {
    case 'versionConflict':
      return t('adm.monitor.error.versionConflict');
    case 'notAuthorized':
      return t('adm.monitor.error.notAuthorized');
    case 'selfApproval':
      return t('adm.monitor.error.selfApproval');
    case 'alreadyDecided':
      return t('adm.monitor.error.alreadyDecided');
    case 'notRunning':
      return t('adm.monitor.error.notRunning');
    case 'denied':
      return t('adm.monitor.error.denied');
    case 'notFound':
      return t('adm.monitor.error.notFound');
    case 'validation':
      return t('adm.monitor.error.validation');
    case 'general':
      return t('adm.monitor.error.general');
  }
}
