import type { AuditEntry, OutboxEventInput, TenantTx } from '@machvon/db';
import type { DomainError, TenantContext } from '@machvon/kernel';

/** What a @Command handler may use: the tenant transaction, the audit trail and the outbox. */
export interface CommandScope {
  tx: TenantTx;
  tenant: TenantContext;
  requestId: string;
  correlationId: string;
  /** Parsed `If-Match` for `versioned` commands, otherwise null. */
  expectedVersion: number | null;
  /** Writes the SUCCESS audit row in the command transaction; returns its id. */
  audit(entry: Omit<AuditEntry, 'correlationId' | 'requestId'>): Promise<string>;
  /** Writes an outbox event in the command transaction. */
  emit(event: Omit<OutboxEventInput, 'correlationId'>): Promise<{ id: string; duplicate: boolean }>;
  /**
   * Registers work for after the command transaction committed (clearing an in-process cache, telling a client): it
   * runs in registration order before the answer is sent, never on a rollback, and a failure is logged without
   * turning the committed command into an error.
   */
  afterCommit(callback: () => void | Promise<void>): void;
  /**
   * Makes the command commit what it wrote (its effects, audit row and events) and then answer with this refusal instead of a result: for a command whose refusal is itself a record, such as an
   * amount that does not agree and opens a difference. The refusal is stored as the answer of the idempotency key, so the same key gets it again; the first call wins when it is called twice.
   */
  refuseAfterCommit(error: DomainError): void;
}
