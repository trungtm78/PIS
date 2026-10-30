import type { VerificationOutcome, VerificationTarget } from '@machvon/db';

/** Injection token of the port that asks a provider whether an account is what it says it is. */
export const CHANNEL_VERIFIER = Symbol('CHANNEL_VERIFIER');

/**
 * The check of a channel account at its provider (ST-OMNI-001, OMNI 3.7): the provider is asked whether the credential works, the webhook is registered with it, and the challenge it sends back is answered. The port
 * reads the secrets it needs from the vault itself, by the references it is given, so that no secret passes through the application. It says whether the account is good; what to do about it is not its business.
 */
export interface ChannelVerifierPort {
  verify(target: Pick<VerificationTarget, 'channel' | 'externalAccountId' | 'credentialSecretRef' | 'webhookSecretRef'>): Promise<VerificationOutcome>;
}

/** Production without a provider: the account stays as it was and says why, instead of being declared good by a stand-in. */
export class UnconfiguredChannelVerifier implements ChannelVerifierPort {
  async verify(): Promise<VerificationOutcome> {
    return { ok: false, code: 'PROVIDER_NOT_CONFIGURED' };
  }
}

/** The stand-in of the providers (MOCK) until they are contracted (D06): every account is good unless a test says it is not. */
export class MockChannelVerifier implements ChannelVerifierPort {
  /** Every account that was asked about, in order. */
  readonly asked: Array<{ channel: string; externalAccountId: string }> = [];
  private readonly refused = new Map<string, string>();
  private outage: string | undefined;
  private hang = false;

  /** The account is refused with this code from now on (`CREDENTIAL_INVALID`, `WEBHOOK_REJECTED`...). */
  refuse(externalAccountId: string, code: string): void {
    this.refused.set(externalAccountId, code);
  }

  /** Every call throws, as a provider that cannot be reached does. */
  failAll(message: string): void {
    this.outage = message;
  }

  /** Every call waits for ever, as a provider that does not answer does. */
  hangAll(): void {
    this.hang = true;
  }

  recover(): void {
    this.refused.clear();
    this.outage = undefined;
    this.hang = false;
  }

  async verify(target: Pick<VerificationTarget, 'channel' | 'externalAccountId'>): Promise<VerificationOutcome> {
    this.asked.push({ channel: target.channel, externalAccountId: target.externalAccountId });
    if (this.hang) return new Promise<VerificationOutcome>(() => undefined);
    if (this.outage !== undefined) throw new Error(this.outage);
    const code = this.refused.get(target.externalAccountId);
    return code === undefined ? { ok: true } : { ok: false, code };
  }
}
