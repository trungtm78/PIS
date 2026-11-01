import type { useTranslation } from '../../../i18n';
import type { ItemState } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** Where the issue of a failed item stands; an item nobody has tried yet is waiting. */
export function itemStateLabel(t: Translate, state: ItemState | undefined): string {
  switch (state) {
    case 'raised':
      return t('iss.field.item.raised');
    case 'existing':
      return t('iss.field.item.existing');
    case 'failed':
      return t('iss.field.item.failed');
    case undefined:
      return t('iss.field.item.waiting');
  }
}
