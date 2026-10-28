import { randomUUID } from 'node:crypto';
import { scrubSecrets } from '@machvon/kernel';
import type { LiteLlmAdminPort, SecretVaultPort } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { LlmKeyStore } from './llm-key-store.ts';
import type { KeyRow } from './llm-key-store.ts';
import { enqueueOutbox } from './outbox.ts';
import type { TenantTx } from './tenant-database.ts';

export const KEY_REVOKED_EVENT = 'llm.key.revoked.v1';
const RESOURCE_TYPE = 'ai_virtual_key';

export interface LlmKeySweepResult {
  /** The keys that went to REVOKED in this pass. */
  revoked: number;
  /** The keys whose time had come and that could not be stopped at LiteLLM: they are left as they are and taken again by the next pass. */
  failed: number;
}

/**
 * ST-LLM-002, the sweep of the virtual keys: the old key of a rotation is revoked at the end of its last day (24 hours, F5), and a key that reached its expiry is recorded as revoked. A key is marked REVOKED only after
 * LiteLLM has stopped it, so the record never says a key is dead while it still works; one LiteLLM cannot be reached for is left for the next pass. The secret is removed from the vault with the key. One audit row and
 * one `llm.key.revoked.v1` for each key; neither carries the secret or the references. A second pass finds nothing. It runs for the tenant of the transaction.
 */
export class LlmKeySweepJob {
  private readonly keys = new LlmKeyStore();
  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly litellm: Pick<LiteLlmAdminPort, 'revokeKey'>;
  private readonly vault: Pick<SecretVaultPort, 'remove'>;
  private readonly log: (line: string) => void;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, litellm: Pick<LiteLlmAdminPort, 'revokeKey'>, vault: Pick<SecretVaultPort, 'remove'>, log: (line: string) => void = () => undefined) {
    this.audit = audit;
    this.litellm = litellm;
    this.vault = vault;
    this.log = log;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<LlmKeySweepResult> {
    const correlationId = randomUUID();
    const result: LlmKeySweepResult = { revoked: 0, failed: 0 };
    for (const key of await this.keys.due(tx, now)) {
      // A key that was made and could not be taken back when its command failed carries its reason already.
      const reason = key.revokedReason ?? (key.status === 'ROTATING' ? 'ROTATION_COMPLETED' : 'EXPIRED');
      try {
        await this.litellm.revokeKey(key.litellmKeyRef);
      } catch (error) {
        // Only the class of the failure is kept: the message of a key service can carry the key.
        this.log(scrubSecrets(`llm key sweep: ${error instanceof Error ? error.constructor.name : 'UnknownError'} for key ${key.id}`));
        result.failed += 1;
        continue;
      }
      await this.record(tx, actor, key, reason, correlationId);
      result.revoked += 1;
      if (!(await this.letGo(tx, key.id, key.secretRef))) result.failed += 1;
    }
    // A secret the vault could not let go of when its key was revoked is asked for again, until it has.
    for (const key of await this.keys.pendingCleanup(tx)) {
      if (!(await this.letGo(tx, key.id, key.secretRef))) result.failed += 1;
    }
    return result;
  }

  /** Marks the key REVOKED and leaves the audit row and the event of it. */
  private async record(tx: TenantTx, actor: string, key: KeyRow, reason: string, correlationId: string): Promise<void> {
    const revoked = await this.keys.markRevoked(tx, key.id, reason, actor);
    await this.audit.recordInTx(tx, actor, {
      action: 'llm.key_revoked',
      resourceType: RESOURCE_TYPE,
      resourceId: key.id,
      classification: 'CONFIDENTIAL',
      diff: { key_alias: key.alias, fingerprint: key.fingerprint, reason },
      correlationId,
      requestId: randomUUID(),
    });
    await enqueueOutbox(tx, {
      aggregateType: RESOURCE_TYPE,
      aggregateId: key.id,
      aggregateVersion: revoked.version,
      type: KEY_REVOKED_EVENT,
      schemaVersion: 1,
      payload: { key_id: key.id, key_alias: key.alias, reason },
      eventKey: `${KEY_REVOKED_EVENT}:${key.id}:${revoked.version}`,
      correlationId,
    });
  }

  /**
   * A revocation that was done at LiteLLM and whose command did not commit: the key is dead and the record must say so. Runs in a transaction of its own after the rollback; a key that is already REVOKED is left alone.
   * The audit row and the event are those of a revocation, with the reason the person gave.
   */
  async reconcileRevocation(tx: TenantTx, actor: string, keyId: string, reason: string): Promise<boolean> {
    const key = await this.keys.find(tx, keyId, true);
    if (key === undefined || key.status === 'REVOKED') return false;
    await this.record(tx, actor, key, reason, randomUUID());
    await this.letGo(tx, key.id, key.secretRef);
    return true;
  }

  private async letGo(tx: TenantTx, id: string, secretRef: string): Promise<boolean> {
    try {
      await this.vault.remove(secretRef);
    } catch (error) {
      this.log(scrubSecrets(`llm key sweep: vault failed with ${error instanceof Error ? error.constructor.name : 'UnknownError'} for key ${id}`));
      return false;
    }
    await this.keys.markSecretRemoved(tx, id);
    return true;
  }
}
