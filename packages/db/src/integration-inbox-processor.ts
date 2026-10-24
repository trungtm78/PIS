import { DomainError, NOOP_ALERTS, NOOP_METRICS } from '@machvon/kernel';
import type { AlertSink, MetricsSink, TenantContext } from '@machvon/kernel';
import { ProviderCallbackStore } from './provider-callback-store.ts';
import type { TenantDatabase, TenantTx } from './tenant-database.ts';

/** What a handler is given: the event as stored (never the payload bytes: the handler fetches them from the reference), in the transaction that marks it processed. */
export interface InboxDelivery {
  id: string;
  provider: string;
  eventKey: string;
  eventType: string | null;
  payloadReference: string;
  attempts: number;
}

/** Processes one event of a provider. It throws to fail; whatever it wrote is undone with the transaction, and the failure is counted as an attempt. */
export type InboxHandler = (delivery: InboxDelivery, tx: TenantTx) => Promise<void>;

/**
 * The adapters that process inbound events, by provider. A provider with no handler has no adapter: its events wait as RECEIVED (the
 * monitor shows them) and are never failed, so nothing claims to be processed that no adapter has read.
 */
export class InboxHandlerRegistry {
  private readonly handlers = new Map<string, InboxHandler>();

  register(provider: string, handler: InboxHandler): void {
    if (this.handlers.has(provider)) throw new Error(`provider ${provider} already has an inbox handler`);
    this.handlers.set(provider, handler);
  }

  get(provider: string): InboxHandler | undefined {
    return this.handlers.get(provider);
  }

  providers(): string[] {
    return [...this.handlers.keys()].sort();
  }
}

export type InboxOutcome = 'PROCESSED' | 'FAILED' | 'DEAD' | 'SKIPPED';

export interface InboxRunResult {
  processed: number;
  failed: number;
  dead: number;
}

export const INBOX_DEAD_ALERT = 'INTEGRATION_INBOX_DEAD';
export const INBOX_PROCESSED_METRIC = 'integration_inbox_processed_total';
export const INBOX_FAILED_METRIC = 'integration_inbox_failed_total';
export const INBOX_WAITING_GAUGE = 'integration_inbox_waiting_gauge';

export interface InboxProcessorOptions {
  metrics?: MetricsSink;
  alerts?: AlertSink;
  /** The events taken in one pass of the worker; the rest wait for the next one. */
  batch?: number;
}

const DEFAULT_BATCH = 100;
const CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
const FALLBACK_CODE = 'HANDLER_FAILED';

/** The code an attempt is recorded with: a domain code, or a class name in capitals; never a message, which can carry personal data. */
function errorCodeOf(error: unknown): string {
  const code = error instanceof DomainError ? error.code : undefined;
  return code !== undefined && CODE.test(code) ? code : FALLBACK_CODE;
}

interface DueRow {
  id: string;
  provider: string;
  event_key: string;
  provider_event_type: string | null;
  payload_reference: string | null;
  attempts: number;
}

/**
 * The worker of the integration inbox (ST-ADM-018). It takes the events that are due (RECEIVED, or FAILED whose wait is over) of the providers
 * that have an adapter, runs the adapter, and marks the event PROCESSED in the same transaction; a failing adapter costs an attempt, with a wait
 * of 1, 5 and then 30 minutes, and the tenth failure parks the event as DEAD and raises INTEGRATION_INBOX_DEAD. Several processes can run it at
 * once: a row is taken with `for update skip locked`.
 */
export class IntegrationInboxProcessor {
  private readonly callbacks = new ProviderCallbackStore();
  private readonly metrics: MetricsSink;
  private readonly alerts: AlertSink;
  private readonly batch: number;
  private readonly database: TenantDatabase;
  private readonly registry: InboxHandlerRegistry;

  constructor(database: TenantDatabase, registry: InboxHandlerRegistry, options: InboxProcessorOptions = {}) {
    this.database = database;
    this.registry = registry;
    this.metrics = options.metrics ?? NOOP_METRICS;
    this.alerts = options.alerts ?? NOOP_ALERTS;
    this.batch = options.batch ?? DEFAULT_BATCH;
  }

  /** One pass for a tenant: the due events of the providers with an adapter, oldest first. */
  async processDue(ctx: TenantContext): Promise<InboxRunResult> {
    const providers = this.registry.providers();
    const result: InboxRunResult = { processed: 0, failed: 0, dead: 0 };
    if (providers.length === 0) return result;
    const due = await this.database.withTenant(ctx, (tx) =>
      tx.query<{ id: string }>(
        `select id from machvon.integration_event_inbox
          where status in ('RECEIVED', 'FAILED') and (next_attempt_at is null or next_attempt_at <= now()) and provider = any($1::text[]) and payload_reference is not null
          order by received_at, id limit $2`,
        [providers, this.batch],
      ),
    );
    for (const { id } of due) {
      const outcome = await this.processOne(ctx, id);
      if (outcome === 'PROCESSED') result.processed += 1;
      else if (outcome === 'FAILED') result.failed += 1;
      else if (outcome === 'DEAD') result.dead += 1;
    }
    await this.database.withTenant(ctx, async (tx) => {
      const [waiting] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.integration_event_inbox where status in ('RECEIVED', 'FAILED')");
      this.metrics.gauge(INBOX_WAITING_GAUGE, Number(waiting?.n ?? 0), { tenant_id: ctx.tenantId });
    });
    return result;
  }

  /**
   * Takes up one event now. SKIPPED when it is not due for anyone to take (another process holds it, it is no longer RECEIVED or FAILED, its provider
   * has no adapter, its payload is gone). The adapter and the PROCESSED mark share a transaction, so an event is never processed without being marked.
   */
  async processOne(ctx: TenantContext, id: string): Promise<InboxOutcome> {
    let failure: unknown;
    let outcome: InboxOutcome = 'SKIPPED';
    let delivery: InboxDelivery | undefined;
    try {
      outcome = await this.database.withTenant(ctx, async (tx) => {
        const rows = await tx.query<DueRow>(
          `select id, provider, event_key, provider_event_type, payload_reference, attempts from machvon.integration_event_inbox
            where id = $1::uuid and status in ('RECEIVED', 'FAILED') for update skip locked`,
          [id],
        );
        const row = rows[0];
        if (row === undefined || row.payload_reference === null) return 'SKIPPED';
        const handler = this.registry.get(row.provider);
        if (handler === undefined) return 'SKIPPED';
        delivery = { id: row.id, provider: row.provider, eventKey: row.event_key, eventType: row.provider_event_type, payloadReference: row.payload_reference, attempts: row.attempts };
        await handler(delivery, tx);
        await tx.query(
          "update machvon.integration_event_inbox set status = 'PROCESSED', processed_at = coalesce(processed_at, now()), error_code = null, next_attempt_at = null where id = $1::uuid",
          [id],
        );
        return 'PROCESSED';
      });
    } catch (error) {
      failure = error;
    }
    if (failure === undefined) {
      if (outcome === 'PROCESSED') this.metrics.increment(INBOX_PROCESSED_METRIC, { tenant_id: ctx.tenantId, provider: delivery?.provider ?? '' });
      return outcome;
    }
    // The attempt failed: the work of the adapter is undone, and the failure is recorded on its own, by class and never by message.
    const status = await this.database.withTenant(ctx, (tx) => this.callbacks.failEvent(tx, id, errorCodeOf(failure)));
    this.metrics.increment(INBOX_FAILED_METRIC, { tenant_id: ctx.tenantId, provider: delivery?.provider ?? '' });
    if (status === 'DEAD') this.alerts.raise(INBOX_DEAD_ALERT, { tenantId: ctx.tenantId, provider: delivery?.provider ?? '', eventId: id });
    return status;
  }
}
