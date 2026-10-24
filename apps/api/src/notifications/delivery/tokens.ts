/** Injection token of the delivery engine (SQL of the sends: claim, record, retry, fallback, replay, cancel). */
export const DELIVERY_ENGINE = Symbol('DELIVERY_ENGINE');
/** Injection token of the dispatcher that the scheduled jobs of the workers run. */
export const DELIVERY_DISPATCHER = Symbol('DELIVERY_DISPATCHER');
/** Injection token of the metrics sink of the notification module; the no-op sink is used when none is bound. */
export const NOT_METRICS = Symbol('NOT_METRICS');
