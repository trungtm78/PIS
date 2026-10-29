import type { useTranslation } from '../../../i18n';
import type { TileKey } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function tileLabel(t: Translate, key: TileKey): string {
  switch (key) {
    case 'drafts_in_review':
      return t('doc.overview.tile.draftsInReview');
    case 'awaiting_leader_signature':
      return t('doc.overview.tile.awaitingSignature');
    case 'awaiting_number':
      return t('doc.overview.tile.awaitingNumber');
    case 'awaiting_seal':
      return t('doc.overview.tile.awaitingSeal');
    case 'overdue_incoming':
      return t('doc.overview.tile.overdueIncoming');
    case 'interop_errors':
      return t('doc.overview.tile.interopErrors');
    case 'templates_pending_confirmation':
      return t('doc.overview.tile.templatesPending');
  }
}
