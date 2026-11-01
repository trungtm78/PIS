import type { useTranslation } from '../../../i18n';
import { statusLabel as assetStatus } from '../../ast/asset/labels';
import { ASSET_STATUSES } from '../../ast/asset/model';
import type { Closure } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

/** What the stage of the project and the settlement say together, in a sentence. */
export function closureMessage(t: Translate, closure: Closure): string {
  switch (closure) {
    case 'settled':
      return t('prj.settlement.closure.settled.notice');
    case 'closedAwaitingStage':
      return t('prj.settlement.closure.closedAwaitingStage.notice');
    case 'waiting':
      return t('prj.settlement.closure.waiting.notice');
    case 'notReached':
      return t('prj.settlement.closure.notReached.notice');
  }
}

/** The state of an asset as the handover shows it; a state this screen does not know is shown as it came. */
export function assetStateLabel(t: Translate, status: string): string {
  const known = ASSET_STATUSES.find((candidate) => candidate === status);
  return known === undefined ? status : assetStatus(t, known);
}
