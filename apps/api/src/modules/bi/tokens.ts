/** Injection token of the clock of the queries of BI (the age of a drill token and of a cached answer are judged against it); the system clock is used when none is bound. */
export const BI_CLOCK = Symbol('BI_CLOCK');
/** Injection token of the secret the host configures for the drill tokens (shared by every replica, kept across restarts); BI_DRILL_KEY is made from it. */
export const BI_DRILL_SECRET = Symbol('BI_DRILL_SECRET');
/** Injection token of the key the drill tokens are signed from (at least 32 bytes); the key of each tenant is made from it. */
export const BI_DRILL_KEY = Symbol('BI_DRILL_KEY');
