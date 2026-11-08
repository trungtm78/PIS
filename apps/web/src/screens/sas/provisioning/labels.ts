import type { Translator } from '../../../i18n';

type Translate = Translator['t'];

/**
 * What is undone for a step when provisioning is cancelled (SAS 3.1, "Compensation on cancel"): the infrastructure is removed, the pilot
 * license and the pending owner invitation are revoked, and the data steps leave their rows to the tenant that is archived as a whole.
 * Each key is written out so the i18n check can see it is in use.
 */
export function compensationLabel(t: Translate, step: string): string {
  switch (step) {
    case 'IDP_ORG':
      return t('sas.provisioning.compensation.idpOrg');
    case 'DNS_SUBDOMAIN':
      return t('sas.provisioning.compensation.dnsSubdomain');
    case 'STORAGE_PREFIX':
      return t('sas.provisioning.compensation.storagePrefix');
    case 'DB_PLACEMENT':
      return t('sas.provisioning.compensation.dbPlacement');
    case 'LICENSE_PILOT':
      return t('sas.provisioning.compensation.licensePilot');
    case 'OWNER_INVITE':
      return t('sas.provisioning.compensation.ownerInvite');
    case 'RLS_SEED':
    case 'ENTITLEMENT_V1':
    case 'ROLE_SEED':
    case 'ROOT_UNIT':
    case 'THEME_V1':
      return t('sas.provisioning.compensation.none');
    default:
      return t('sas.tenants.none');
  }
}
