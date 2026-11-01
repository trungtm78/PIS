import type { useTranslation } from '../../../i18n';
import type { PlaceProblem } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function placeProblemMessage(t: Translate, problem: PlaceProblem): string {
  switch (problem) {
    case 'consentRequired':
      return t('qms.offline.place.consentRequired');
    case 'pairRequired':
      return t('qms.offline.place.pairRequired');
    case 'invalidLatitude':
      return t('qms.offline.place.invalidLatitude');
    case 'invalidLongitude':
      return t('qms.offline.place.invalidLongitude');
    case 'invalidAccuracy':
      return t('qms.offline.place.invalidAccuracy');
  }
}
