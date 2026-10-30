import { randomUUID } from 'node:crypto';
import { AuditWriter, ChannelAccountStore, WORKER_MEMBERSHIP_ID, consumeOnce, enqueueOutbox, verifyDelivery } from '@machvon/db';
import type { ConsumeSecurity, OutboxDelivery, TenantDatabase, VerificationOutcome, VerificationTarget } from '@machvon/db';
import { NOOP_ALERTS, asUuid } from '@machvon/kernel';
import type { AlertSink } from '@machvon/kernel';
import type { ChannelVerifierPort } from './channel-verifier';

export const CHANNEL_VERIFICATION_CONSUMER = 'omni.channel-verification';
export const VERIFICATION_REQUESTED_EVENT = 'omni.channel_account.verification_requested.v1';
export const CHANNEL_VERIFIED_EVENT = 'omni.channel_account.verified.v1';
export const OMNI_CHANNEL_VERIFICATION_FAILED_ALERT = 'OMNI_CHANNEL_VERIFICATION_FAILED';
const CALL_TIMEOUT_MS = 15_000;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;

type Delivery = Pick<OutboxDelivery, 'id' | 'tenantId' | 'tenantContext' | 'type' | 'payload'>;

export interface ChannelVerificationDeps {
  database: TenantDatabase;
  verifier: ChannelVerifierPort;
  security: ConsumeSecurity;
  /** How long the provider may take to answer. */
  timeoutMs?: number;
  alerts?: AlertSink;
}

/**
 * The answer to `verifyChannelAccount` (ST-OMNI-001, OMNI 3.7): when verification is asked for, the account is read, the provider is asked outside any transaction (a slow provider holds no lock), and the answer is
 * recorded against the request it answers. An account the provider accepts becomes Active and verified; one it refuses keeps the reason (`CREDENTIAL_INVALID`...) for the supervisor to correct and ask again. A provider
 * that cannot be reached or does not answer in time is a refusal with `PROVIDER_UNREACHABLE`: the supervisor asks again when it is back. A request renewed, answered or withdrawn since (the account was disabled) is not
 * answered twice. If the process stops between the question and the record, the account simply stays as it was and verification is asked for again.
 */
export class ChannelVerificationConsumer {
  private readonly accounts = new ChannelAccountStore();
  private readonly audit: AuditWriter;

  constructor(private readonly deps: ChannelVerificationDeps) {
    this.audit = new AuditWriter(deps.database);
  }

  async handle(delivery: Delivery): Promise<'processed' | 'duplicate' | 'ignored'> {
    if (delivery.type !== VERIFICATION_REQUESTED_EVENT) return 'ignored';
    // The payload names the tenant too; a delivery whose payload disagrees with its signed tenant is not ours to act on.
    if (asUuid(delivery.payload.tenant_id) !== delivery.tenantId) return 'ignored';
    const accountId = asUuid(delivery.payload.channel_account_id);
    if (accountId === undefined) return 'ignored';
    const { database, security } = this.deps;
    let target: VerificationTarget | undefined;
    const outcome = await consumeOnce(
      database,
      delivery,
      CHANNEL_VERIFICATION_CONSUMER,
      async (tx) => {
        target = await this.accounts.verificationTarget(tx, accountId);
      },
      security,
    );
    if (outcome !== 'processed' || target === undefined) return outcome;
    const asked = target;
    const answer = await this.ask(asked);
    const context = verifyDelivery(delivery, security);
    let failed: string | undefined;
    await database.withTenant(context, async (tx) => {
      const result = await this.accounts.recordVerification(tx, accountId, asked.verifyRequestedAt, answer);
      if (result === 'STALE') return;
      failed = result === 'FAILED' && !answer.ok ? answer.code : undefined;
      const correlationId = randomUUID();
      await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
        action: result === 'VERIFIED' ? 'omni.channel_account_verified' : 'omni.channel_account_verification_failed',
        resourceType: 'channel_account',
        resourceId: accountId,
        classification: 'CONFIDENTIAL',
        // The channel and the reason only: no external id, no reference to a secret.
        diff: answer.ok ? { channel: asked.channel } : { channel: asked.channel, error_code: answer.code },
        correlationId,
        requestId: randomUUID(),
      });
      if (result === 'VERIFIED') {
        await enqueueOutbox(tx, {
          aggregateType: 'channel_account',
          aggregateId: accountId,
          aggregateVersion: 1,
          type: CHANNEL_VERIFIED_EVENT,
          schemaVersion: 1,
          payload: { tenant_id: delivery.tenantId, channel_account_id: accountId, channel: asked.channel },
          eventKey: `${CHANNEL_VERIFIED_EVENT}:${accountId}:${asked.verifyRequestedAt}`,
          correlationId,
          causationId: delivery.id,
        });
      }
    });
    // Told once the record is committed, so a record that is rolled back does not raise it twice.
    if (failed !== undefined) (this.deps.alerts ?? NOOP_ALERTS).raise(OMNI_CHANNEL_VERIFICATION_FAILED_ALERT, { tenantId: delivery.tenantId, channelAccountId: accountId, channel: asked.channel, reason: failed });
    return 'processed';
  }

  private async ask(target: VerificationTarget): Promise<VerificationOutcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<VerificationOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, code: 'PROVIDER_UNREACHABLE' }), this.deps.timeoutMs ?? CALL_TIMEOUT_MS);
      });
      const answer = await Promise.race([this.deps.verifier.verify(target), timeout]);
      // A code written by the adapter of a provider is kept only in the form the database keeps.
      return answer.ok || SAFE_CODE.test(answer.code) ? answer : { ok: false, code: 'VERIFICATION_REFUSED' };
    } catch {
      return { ok: false, code: 'PROVIDER_UNREACHABLE' };
    } finally {
      clearTimeout(timer);
    }
  }
}
