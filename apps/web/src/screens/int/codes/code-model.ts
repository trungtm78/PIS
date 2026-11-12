/** The kinds of system the register knows (the server holds the same list). */
export const SOURCE_SYSTEM_KINDS = ['PMIS', 'ERP', 'FINANCE', 'LAKEHOUSE', 'GOV_PORTAL', 'OTHER'] as const;

/** Permissions of the commands of the screen (x-permission in openapi.json): a person offered a control holds the permission of the command behind it. */
export const PROPOSE_PERMISSION = 'int.codes.propose';
export const APPROVE_PERMISSION = 'int.codes.approve';
export const SYSTEM_PERMISSION = 'int.system.manage';

/** What the caller may change on the screen, the permissions and the mode of the tenant together. */
export interface CodeRights {
  propose: boolean;
  approve: boolean;
  system: boolean;
}

/** The filters of the codes list, by their names in the address. */
export const CODE_FILTERS = ['source_system', 'status', 'q'] as const;
