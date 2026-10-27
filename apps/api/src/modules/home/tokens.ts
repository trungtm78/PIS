/** Injection token of the clock of the command center (the Vietnam day and the age of a snapshot are judged against it); the system clock is used when none is bound. */
export const HOME_CLOCK = Symbol('HOME_CLOCK');
/** Injection token of the metrics sink of the command center; the no-op sink is used when none is bound. */
export const HOME_METRICS = Symbol('HOME_METRICS');
/** Injection token of the key that signs the context tokens of the tiles (at least 32 bytes). */
export const HOME_CONTEXT_KEY = Symbol('HOME_CONTEXT_KEY');
