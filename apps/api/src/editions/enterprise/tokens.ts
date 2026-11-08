/** The file writer that stands for HPM (`HpmPort`): replaced by an API adapter when the customer publishes the interface (ENT-2, PENDING-EXTERNAL). */
export const HPM_PORT = Symbol('HPM_PORT');
/** Where the package of a push is written (`HpmFileSink`): the default is a folder of the server, one sub-folder per tenant. */
export const HPM_FILE_SINK = Symbol('HPM_FILE_SINK');
/** Whether the reopening of a period that a correction names is in force (`PeriodReopenPort`): the default reads the reopenings of DIS. */
export const HPM_PERIOD_REOPEN = Symbol('HPM_PERIOD_REOPEN');
/** The metrics sink of the connections of the enterprise edition (`MetricsSink`); optional. */
export const ENTERPRISE_METRICS = Symbol('ENTERPRISE_METRICS');
