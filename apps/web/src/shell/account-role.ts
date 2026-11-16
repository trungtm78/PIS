import { useTranslation } from '../i18n';
import { useEffectiveAccess } from '../screens/iam/effective-access/hooks';
import { useSession } from '../session/SessionContext';

/** What the shell needs of a grant to name the role of the person. */
export interface RoleOfGrant {
  roleCode: string;
  roleName: string;
  rank: number;
  state: string;
}

type T = ReturnType<typeof useTranslation>['t'];

/** The words of a system role of the product (its stored name is a key, not words); undefined for a role of the organisation. */
export function systemRoleLabel(t: T, code: string): string | undefined {
  switch (code) {
    case 'TENANT_OWNER':
      return t('shell.account.role.tenantOwner');
    case 'TENANT_ADMIN':
      return t('shell.account.role.tenantAdmin');
    case 'SECURITY_ADMIN':
      return t('shell.account.role.securityAdmin');
    case 'UNIT_ADMIN':
      return t('shell.account.role.unitAdmin');
    case 'LEADER':
      return t('shell.account.role.leader');
    case 'COMMITTEE_HEAD':
      return t('shell.account.role.committeeHead');
    case 'COMMITTEE_MEMBER':
      return t('shell.account.role.committeeMember');
    case 'COMMITTEE_SECRETARIAT':
      return t('shell.account.role.committeeSecretariat');
    case 'AUDITOR':
      return t('shell.account.role.auditor');
    case 'STAFF_MEMBER':
      return t('shell.account.role.staffMember');
    case 'MEMBER':
      return t('shell.account.role.member');
    default:
      return undefined;
  }
}

/**
 * The words under the name of the person in the shell: their HIGHEST role in force (by rank). A system role has its words in the catalogue; a role of the organisation
 * shows the name the organisation gave it (a role made in several parts shows one name). Undefined when the person holds no role in force or the access is not known
 * yet: the shell then shows its neutral words.
 */
export function highestRoleLabel(grants: readonly RoleOfGrant[], t: T): string | undefined {
  const active = grants.filter((grant) => grant.state === 'ACTIVE');
  if (active.length === 0) return undefined;
  const top = active.reduce((best, grant) => (grant.rank > best.rank ? grant : best));
  const system = systemRoleLabel(t, top.roleCode);
  if (system !== undefined) return system;
  const name = top.roleName.replace(/ \(phần \d+\)$/u, '').trim();
  return name === '' || name === top.roleCode || name.startsWith('iam.role.') ? undefined : name;
}

/** The role label of the signed-in person, read from their own effective access (`getMyEffectiveAccess`). */
export function useAccountRoleLabel(): string | undefined {
  const { t } = useTranslation();
  // A control-plane session (the platform operator) has no membership of a tenant: the tenant plane refuses the question (403), so it is not asked.
  const { controlPlane } = useSession();
  const access = useEffectiveAccess({ enabled: controlPlane !== true });
  if (access.data === undefined) return undefined;
  return highestRoleLabel(access.data.grants, t);
}
