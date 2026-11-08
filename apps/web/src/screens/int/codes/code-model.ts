/** The kinds of system the register knows (the server holds the same list). */
export const SOURCE_SYSTEM_KINDS = ['PMIS', 'ERP', 'FINANCE', 'LAKEHOUSE', 'GOV_PORTAL', 'OTHER'] as const;

/** The filters of the codes list, by their names in the address. */
export const CODE_FILTERS = ['source_system', 'status', 'q'] as const;
