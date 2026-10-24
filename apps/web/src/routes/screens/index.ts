import type { ScreenLoader } from '../types.ts';

/**
 * The implemented screens by screen id, each loaded on demand. A screen is registered here when its
 * implementation lands (ADM-01 and ADM-03 first); every other route renders NotImplementedScreen.
 */
export const screenModules: Readonly<Record<string, ScreenLoader>> = {
  'ADM-01': () => import('../../screens/adm/OrgTreeScreen'),
  'ADM-02': () => import('../../screens/adm/MembersScreen'),
  'ADM-03': () => import('../../screens/adm/RolesGrantsScreen'),
  'ADM-17': () => import('../../screens/adm/GuestContractorsScreen'),
  'ADM-08': () => import('../../screens/adm/CertificatesScreen'),
  'ADM-14': () => import('../../screens/adm/SecurityPolicyScreen'),
  'DOC-05': () => import('../../screens/doc/SigningSessionScreen'),
  'DOC-06': () => import('../../screens/doc/OutgoingDocumentScreen'),
  'DOC-07': () => import('../../screens/doc/SignatureReportScreen'),
  'DOC-10': () => import('../../screens/doc/NumberRegistersScreen'),
  'DOC-21': () => import('../../screens/doc/DocumentTypesScreen'),
  'IAM-04': () => import('../../screens/iam/TenantChooserScreen'),
  'IAM-09': () => import('../../screens/iam/EffectiveAccessScreen'),
  'MDM-01': () => import('../../screens/mdm/MasterHubScreen'),
  'MDM-25': () => import('../../screens/mdm/MasterCreateScreen'),
  'MDM-26': () => import('../../screens/mdm/MasterEditScreen'),
  'MDM-27': () => import('../../screens/mdm/MasterDetailScreen'),
  'MDM-28': () => import('../../screens/mdm/MasterHistoryScreen'),
  'MDM-31': () => import('../../screens/mdm/MasterRetireScreen'),
  'MDM-32': () => import('../../screens/mdm/MasterApprovalScreen'),
  'MDM-33': () => import('../../screens/mdm/MasterScopeScreen'),
  'NOT-01': () => import('../../screens/not/InboxScreen'),
  'NOT-02': () => import('../../screens/not/NotificationDetailScreen'),
  'SAS-01': () => import('../../screens/sas/TenantListScreen'),
  'SAS-02': () => import('../../screens/sas/TenantCreateScreen'),
  'SAS-03': () => import('../../screens/sas/TenantDetailScreen'),
  'SAS-04': () => import('../../screens/sas/theme/ThemeScreen'),
  'SAS-12': () => import('../../screens/sas/LicenseIssueScreen'),
  'SAS-13': () => import('../../screens/sas/LicenseDetailScreen'),
  'SAS-15': () => import('../../screens/sas/LicenseActionScreen'),
  'SAS-22': () => import('../../screens/sas/ProvisioningRunScreen'),
  'SAS-25': () => import('../../screens/sas/EntitlementsScreen'),
};
