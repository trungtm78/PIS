import type { EtlPorts } from '@machvon/kernel';
import type { TenantTx } from '@machvon/db';

/**
 * What a connector module gives the hub so that a reject of its pipeline can be reprocessed: the ports of the pipeline (validate, crosswalk, load through the connector's own command) bound to the tenant
 * transaction of the command. A connector that has not wired one is answered 409 `HUB_PIPELINE_NOT_WIRED` when a person asks to reprocess; a reject can still be discarded with a reason.
 */
export type HubPipelinePorts = (tx: TenantTx, pipelineCode: string) => EtlPorts;

/** Injection token of the map of connector code to the ports of its pipelines (bound by the module of the connector, absent while none is wired). */
export const HUB_PIPELINE_EXECUTORS = Symbol('HUB_PIPELINE_EXECUTORS');

/** Injection token of the clock of the hub (the sweep and the heartbeat are judged against it); the system clock is used when none is bound. */
export const HUB_CLOCK = Symbol('HUB_CLOCK');
