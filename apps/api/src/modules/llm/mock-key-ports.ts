import { randomBytes, randomUUID } from 'node:crypto';
import type { LiteLlmAdminPort, SecretVaultPort } from '@machvon/kernel';

/**
 * The stand-in of LiteLLM until the service is deployed (ST-LLM-002 asks for it in the internal network, with a runbook and a restore test): it makes keys, stops them at once and ends them at the moment given, in memory.
 * A key it made is checked with `isUsable`. `failNext` makes the next call fail with a message that carries a key, to show that such a message never reaches a log.
 */
export class MockLiteLlm implements LiteLlmAdminPort {
  readonly keys = new Map<string, { secret: string; alias: string; models: readonly string[]; revoked: boolean; until: Date }>();
  private failure: string | undefined;

  failNext(message: string): void {
    this.failure = message;
  }

  private maybeFail(): void {
    if (this.failure === undefined) return;
    const message = this.failure;
    this.failure = undefined;
    throw new Error(message);
  }

  async createKey(input: { alias: string; models: readonly string[]; rpmLimit: number | null; tpmLimit: number | null; expiresAt: Date }): Promise<{ keyRef: string; secret: string }> {
    this.maybeFail();
    // A reference is unique for ever, also across restarts of the process: a reference that came back would stop another tenant's key.
    const keyRef = `litellm-key-${randomUUID()}`;
    const secret = `sk-${randomBytes(24).toString('base64url')}`;
    this.keys.set(keyRef, { secret, alias: input.alias, models: input.models, revoked: false, until: input.expiresAt });
    return { keyRef, secret };
  }

  async revokeKey(keyRef: string): Promise<void> {
    this.maybeFail();
    const key = this.keys.get(keyRef);
    if (key !== undefined) key.revoked = true;
  }

  async limitLifetime(keyRef: string, until: Date): Promise<void> {
    this.maybeFail();
    const key = this.keys.get(keyRef);
    if (key !== undefined) key.until = until;
  }

  /** Whether a call with this secret would be served at the moment given. */
  isUsable(secret: string, now: Date): boolean {
    return [...this.keys.values()].some((key) => key.secret === secret && !key.revoked && key.until.getTime() > now.getTime());
  }
}

/** The stand-in of the vault: the secrets in memory, by reference. */
export class InMemoryVault implements SecretVaultPort {
  readonly secrets = new Map<string, string>();
  private failure = false;

  /** Makes the next removal fail, to show that the sweep tries again. */
  failNextRemoval(): void {
    this.failure = true;
  }

  async put(ref: string, value: string): Promise<void> {
    this.secrets.set(ref, value);
  }

  async remove(ref: string): Promise<void> {
    if (this.failure) {
      this.failure = false;
      throw new Error('vault unavailable');
    }
    this.secrets.delete(ref);
  }
}
