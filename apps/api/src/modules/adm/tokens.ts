/** Injection token of the metrics sink of the tenant administration module; the no-op sink is used when none is bound. */
export const ADM_METRICS = Symbol('ADM_METRICS');
/** Injection token of the clock of the tenant administration module; the system clock is used when none is bound. */
export const ADM_CLOCK = Symbol('ADM_CLOCK');
/** Injection token of the adapters that process inbound provider events, by provider (ST-ADM-018): a module registers its adapter here. */
export const ADM_INBOX_HANDLERS = Symbol('ADM_INBOX_HANDLERS');
/** Injection token of the processor that takes up one inbox event right after its replay committed. */
export const ADM_INBOX_PROCESSOR = Symbol('ADM_INBOX_PROCESSOR');
/**
 * Injection token of the name of the deployment environment (infra/environments): `production` and `dr` hold real data, and a connector with a
 * MOCK adapter is never Active there. An environment that is not named is taken as production.
 */
export const ADM_ENVIRONMENT = Symbol('ADM_ENVIRONMENT');
/** Injection token of the codes of the modules mounted in this process: the boot guard of the approval engine judges the business types whose owning module is among them (R14). Absent where the host does not say. */
export const ADM_MOUNTED_MODULES = Symbol('ADM_MOUNTED_MODULES');
