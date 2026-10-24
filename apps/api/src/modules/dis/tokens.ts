/** Injection token of the metrics sink of the disbursement reporting module; the no-op sink is used when none is bound. */
export const DIS_METRICS = Symbol('DIS_METRICS');
/** Injection token of the clock of the disbursement reporting module; the system clock is used when none is bound. */
export const DIS_CLOCK = Symbol('DIS_CLOCK');
