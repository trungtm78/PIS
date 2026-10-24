/** Injection token of the metrics sink of the project register; the no-op sink is used when none is bound. */
export const PRJ_METRICS = Symbol('PRJ_METRICS');

/** Injection token of the cache of the project bank; the cache of the process is used when none is bound. */
export const PRJ_PIPELINE_CACHE = Symbol('PRJ_PIPELINE_CACHE');
