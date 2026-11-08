/** Injection token of the metrics sink of the indicator import; the no-op sink is used when none is bound. */
export const IND_METRICS = Symbol('IND_METRICS');
/** Injection token of the clock of the indicator module; the system clock is used when none is bound. */
export const IND_CLOCK = Symbol('IND_CLOCK');
