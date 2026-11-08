/** Injection token of the port that gives the facts of the province (`ProvinceFactsReader`): the real core reader is used when none is bound. */
export const COMMITTEE_FACTS_READER = Symbol('COMMITTEE_FACTS_READER');
/** Injection token of the clock of the committee workspace (the day of the Vietnam calendar is judged against it); the system clock is used when none is bound. */
export const COMMITTEE_CLOCK = Symbol('COMMITTEE_CLOCK');
/** Injection token of the function that reads the level of assurance of a session (SSO and MFA of the infrastructure phase); until it is bound the level is UNKNOWN and the audit says so. */
export const COMMITTEE_ASSURANCE = Symbol('COMMITTEE_ASSURANCE');
