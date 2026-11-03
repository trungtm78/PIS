import type { useTranslation } from '../../../i18n';
import type { EntryKind } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function entryKindLabel(t: Translate, kind: EntryKind): string {
  switch (kind) {
    case 'RECOGNIZE_ACCEPTANCE':
      return t('pay.ledger.entry.kind.recognizeAcceptance');
    case 'REVOKE_ACCEPTANCE':
      return t('pay.ledger.entry.kind.revokeAcceptance');
    case 'CLAIM':
      return t('pay.ledger.entry.kind.claim');
    case 'CLAIM_RELEASE':
      return t('pay.ledger.entry.kind.claimRelease');
    case 'PAYMENT':
      return t('pay.ledger.entry.kind.payment');
    case 'PAYMENT_REVERSAL':
      return t('pay.ledger.entry.kind.paymentReversal');
    case 'ADVANCE_RECOVERY':
      return t('pay.ledger.entry.kind.advanceRecovery');
    case 'ADVANCE_RECOVERY_REVERSAL':
      return t('pay.ledger.entry.kind.advanceRecoveryReversal');
    case 'RETENTION_HOLD':
      return t('pay.ledger.entry.kind.retentionHold');
    case 'RETENTION_RELEASE':
      return t('pay.ledger.entry.kind.retentionRelease');
    case 'ADJUSTMENT':
      return t('pay.ledger.entry.kind.adjustment');
  }
}
