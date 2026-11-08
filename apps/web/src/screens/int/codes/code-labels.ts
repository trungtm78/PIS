import type { Translator } from '../../../i18n';

type T = Translator['t'];

export function codeStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'PROPOSED':
      return t('int.codes.status.proposed');
    case 'ACTIVE':
      return t('int.codes.status.active');
    case 'REJECTED':
      return t('int.codes.status.rejected');
    case 'RETIRED':
      return t('int.codes.status.retired');
    default:
      return status;
  }
}

export function systemKindLabel(t: T, kind: string): string {
  switch (kind) {
    case 'PMIS':
      return t('int.codes.kind.pmis');
    case 'ERP':
      return t('int.codes.kind.erp');
    case 'FINANCE':
      return t('int.codes.kind.finance');
    case 'LAKEHOUSE':
      return t('int.codes.kind.lakehouse');
    case 'GOV_PORTAL':
      return t('int.codes.kind.govPortal');
    case 'OTHER':
      return t('int.codes.kind.other');
    default:
      return kind;
  }
}
