import type { SecretVaultPort } from '@machvon/kernel';

/** Injection token of the vault that holds the push tokens of the devices. */
export const PUSH_TOKEN_VAULT = Symbol('PUSH_TOKEN_VAULT');

/** The vault of the push tokens: the application writes a token when a device registers or rotates it, the adapters of the push channels read it to send, and it is removed when the device is. */
export interface PushTokenVault extends SecretVaultPort {
  read(ref: string): Promise<string | undefined>;
}

/** Where the token of a device is kept; the reference names the tenant and the device, never the token. */
export const pushSecretRefOf = (tenantId: string, deviceId: string): string => `secret://push/${tenantId}/${deviceId}`;

/** The stand-in of the vault until the one of the platform is deployed (OpenBao): the tokens in memory, by reference (MOCK). */
export class InMemoryPushTokenVault implements PushTokenVault {
  readonly tokens = new Map<string, string>();
  private failure: 'put' | 'put-after-write' | 'remove' | 'read' | undefined;

  /** Makes the next write or removal fail, to show that the command fails whole or that the cleanup is tried and noticed. */
  failNext(operation: 'put' | 'put-after-write' | 'remove' | 'read'): void {
    this.failure = operation;
  }

  async put(ref: string, value: string): Promise<void> {
    if (this.failure === 'put') {
      this.failure = undefined;
      throw new Error('vault unavailable');
    }
    this.tokens.set(ref, value);
    // A write that took effect and was not acknowledged: the caller cannot tell, so it must be able to put the vault right.
    if (this.failure === 'put-after-write') {
      this.failure = undefined;
      throw new Error('vault did not answer');
    }
  }

  async remove(ref: string): Promise<void> {
    if (this.failure === 'remove') {
      this.failure = undefined;
      throw new Error('vault unavailable');
    }
    this.tokens.delete(ref);
  }

  async read(ref: string): Promise<string | undefined> {
    if (this.failure === 'read') {
      this.failure = undefined;
      throw new Error('vault unavailable');
    }
    return this.tokens.get(ref);
  }
}
