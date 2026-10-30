/** Injection token of the port that sends the code that verifies an identity. */
export const IDENTITY_OTP_SENDER = Symbol('IDENTITY_OTP_SENDER');

export interface OtpDelivery {
  channel: 'PHONE' | 'EMAIL';
  /** The value of the identity in its normalised form: it leaves the application here and nowhere else. */
  destination: string;
  otp: string;
}

/**
 * The sending of the code of an identity (ST-OMNI-002, OMNI.md 3.5): a text message to a phone number or a mail to an address. The code is made and kept as a hash by the directory; the port only carries it out, after the
 * transaction has committed. A deployment without a sender does not make a code, and an identity there is verified by the provider or by a document.
 */
export interface IdentityOtpSender {
  readonly configured: boolean;
  send(delivery: OtpDelivery): Promise<void>;
}

/** Production without a provider of messages: no code is made, so none can be guessed at. */
export class UnconfiguredOtpSender implements IdentityOtpSender {
  readonly configured = false;
  async send(): Promise<void> {
    throw new Error('no sender of codes is configured');
  }
}

/** The stand-in (MOCK) until the SMS and mail providers are contracted (D06): it keeps what it was asked to send, for a test to read. */
export class MockOtpSender implements IdentityOtpSender {
  readonly configured = true;
  readonly sent: OtpDelivery[] = [];

  async send(delivery: OtpDelivery): Promise<void> {
    this.sent.push(delivery);
  }

  /** The last code sent to a destination. */
  lastCodeFor(destination: string): string | undefined {
    return [...this.sent].reverse().find((delivery) => delivery.destination === destination)?.otp;
  }
}
