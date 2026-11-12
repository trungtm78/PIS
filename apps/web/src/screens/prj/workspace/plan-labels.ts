import type { Translator } from '../../../i18n';

/** The status of a procurement package in words; a status this screen does not know is shown as the server sent it. */
export function packageStatusLabel(t: Translator['t'], status: string): string {
  switch (status) {
    case 'PLANNED':
      return t('prj.wsTab.plan.pkgStatus.planned');
    case 'APPROVED':
      return t('prj.wsTab.plan.pkgStatus.approved');
    case 'AWARDED':
      return t('prj.wsTab.plan.pkgStatus.awarded');
    case 'NO_ACCEPTABLE_BID':
      return t('prj.wsTab.plan.pkgStatus.noBid');
    case 'CANCELLED':
      return t('prj.wsTab.plan.pkgStatus.cancelled');
    default:
      return status;
  }
}
