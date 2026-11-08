import type { Translator } from '../../../i18n';

type T = Translator['t'];

export function outcomeLabel(t: T, outcome: string): string {
  switch (outcome) {
    case 'OK':
      return t('int.log.outcome.ok');
    case 'DENIED_CLIENT':
      return t('int.log.outcome.deniedClient');
    case 'DENIED_SCOPE':
      return t('int.log.outcome.deniedScope');
    case 'DENIED_DATASET':
      return t('int.log.outcome.deniedDataset');
    case 'RATE_LIMITED':
      return t('int.log.outcome.rateLimited');
    case 'INVALID_REQUEST':
      return t('int.log.outcome.invalidRequest');
    default:
      return outcome;
  }
}
