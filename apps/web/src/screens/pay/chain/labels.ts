import type { useTranslation } from '../../../i18n';
import type { NodeType } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function typeLabel(t: Translate, type: NodeType): string {
  switch (type) {
    case 'project':
      return t('pay.chain.type.project');
    case 'contract':
      return t('pay.chain.type.contract');
    case 'measurement':
      return t('pay.chain.type.measurement');
    case 'acceptance':
      return t('pay.chain.type.acceptance');
    case 'payment_request':
      return t('pay.chain.type.paymentRequest');
    case 'treasury_transaction':
      return t('pay.chain.type.treasuryTransaction');
    case 'settlement_revision':
      return t('pay.chain.type.settlementRevision');
  }
}
