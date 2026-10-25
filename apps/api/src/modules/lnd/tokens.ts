/** The cipher that seals and opens the personal data of the households of a land recovery. */
export const FIELD_CIPHER = Symbol('LND_FIELD_CIPHER');
/** The metrics sink of the households (the readings of their sealed data); the no-op sink is used when none is bound. */
export const LND_METRICS = Symbol('LND_METRICS');
