import type { OutboxDelivery } from '@machvon/db';
import type { Tracer } from '@machvon/kernel';
import { traceDelivery } from '../telemetry/request-telemetry';
import type { EventTypeCatalog } from '../notifications/payload-validator';

/** A consumer of outbox events. It decides for itself whether an event is its own and answers `ignored` (or similar) when it is not. */
export interface OutboxConsumer {
  readonly name: string;
  handle(delivery: OutboxDelivery): Promise<unknown>;
}

/**
 * The publish function of the outbox relay: every consumer sees every delivery. A delivery fails when any consumer fails,
 * after all of them were tried; the relay then retries the whole delivery and the inbox row of each consumer (consumeOnce)
 * makes the ones that already succeeded a counted duplicate.
 */
export function createOutboxPublisher(consumers: readonly OutboxConsumer[], tracer?: Tracer): (delivery: OutboxDelivery) => Promise<void> {
  const deliver = async (delivery: OutboxDelivery): Promise<void> => {
    const results = await Promise.allSettled(consumers.map((consumer) => consumer.handle(delivery)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
  };
  // With a tracer the handling of a delivery is a span of the trace of the request that wrote the event (its correlation id names the trace).
  return tracer === undefined ? deliver : (delivery) => traceDelivery(tracer, delivery, () => deliver(delivery));
}

/**
 * Passes an event on only when its type is registered, Active, in the version of the event. A consumer that validates
 * every payload against a registered type (the notification consumer) would otherwise fail every event of the other
 * modules until the relay marked it DEAD. A catalogue that cannot be read fails the delivery: the event is retried, not dropped.
 */
export class RegisteredEventConsumer implements OutboxConsumer {
  constructor(
    readonly name: string,
    private readonly catalog: EventTypeCatalog,
    private readonly inner: OutboxConsumer,
  ) {}

  async handle(delivery: OutboxDelivery): Promise<unknown> {
    const definition = await this.catalog.get(delivery.type, delivery.schemaVersion);
    if (definition === undefined || definition.status !== 'Active') return 'ignored';
    return this.inner.handle(delivery);
  }
}
