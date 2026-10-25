import type { useTranslation } from '../../../i18n';
import type { HaltAction } from '../workspace/model';
import type { GuaranteeAction } from './model';

type Translate = ReturnType<typeof useTranslation>['t'];

export function actionLabel(t: Translate, action: HaltAction): string {
  switch (action) {
    case 'suspend':
      return t('ctr.halt.action.suspend');
    case 'resume':
      return t('ctr.halt.action.resume');
    case 'terminate':
      return t('ctr.halt.action.terminate');
  }
}

export function submitLabel(t: Translate, action: HaltAction): string {
  switch (action) {
    case 'suspend':
      return t('ctr.halt.submit.suspend');
    case 'resume':
      return t('ctr.halt.submit.resume');
    case 'terminate':
      return t('ctr.halt.submit.terminate');
  }
}

export function dayLabel(t: Translate, action: HaltAction): string {
  switch (action) {
    case 'suspend':
      return t('ctr.halt.field.day.suspend');
    case 'resume':
      return t('ctr.halt.field.day.resume');
    case 'terminate':
      return t('ctr.halt.field.day.terminate');
  }
}

/** What the command does to the payments of the contract (BR-PAY-09), said before it is run. */
export function impactLabel(t: Translate, action: HaltAction): string {
  switch (action) {
    case 'suspend':
      return t('ctr.halt.impact.suspend');
    case 'resume':
      return t('ctr.halt.impact.resume');
    case 'terminate':
      return t('ctr.halt.impact.terminate');
  }
}

export function guaranteeLabel(t: Translate, action: GuaranteeAction): string {
  switch (action) {
    case 'CALL':
      return t('ctr.halt.guarantee.call');
    case 'RELEASE':
      return t('ctr.halt.guarantee.release');
    case 'HOLD':
      return t('ctr.halt.guarantee.hold');
  }
}
