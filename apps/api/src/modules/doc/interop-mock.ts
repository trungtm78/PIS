import { DomainError } from '@machvon/kernel';
import type { InteropReceipt, InteropReceiptRequest, InteropSendRequest, InteropTransportPort } from './interop-port';

/**
 * The MOCK gateway of the LGSP (adapter status MOCK, ST-DOC-021): it keeps what it was handed, can be told to refuse a number of sends with a code (the 503 of a gateway that is down) and to answer the receipt a
 * test wants. A message id it has seen is not taken twice, as a real gateway drops it. It is what the tests and a tenant that tries the interoperability out bind; no production tenant runs on it.
 */
export class MockLgspGateway implements InteropTransportPort {
  /** Every send that was accepted, and every address a call was made to: the tests check these against the allowlist. */
  readonly accepted: InteropSendRequest[] = [];
  readonly endpoints: string[] = [];
  /** The sends to refuse before one is accepted, and how: a `DomainError` names its code. */
  failures = 0;
  failure: Error = new DomainError('PROVIDER_UNAVAILABLE', 503);
  /** What the receiving agency answers when asked. */
  answer: InteropReceipt = { outcome: 'ACKED' };
  /** When set, the gateway cannot say what became of a message. */
  receiptFailure: Error | undefined;
  private readonly ids = new Map<string, string>();
  /** The ids the gateway gives never repeat, not even after a reset: the id of a message is unique in the table of the tenant. */
  private sequence = 0;

  /** Back to a gateway that has seen nothing and answers every message: for the next test. */
  reset(): void {
    this.accepted.length = 0;
    this.endpoints.length = 0;
    this.ids.clear();
    this.failures = 0;
    this.failure = new DomainError('PROVIDER_UNAVAILABLE', 503);
    this.answer = { outcome: 'ACKED' };
    this.receiptFailure = undefined;
  }

  send(request: InteropSendRequest): Promise<{ externalMessageId: string }> {
    this.endpoints.push(request.endpoint);
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(this.failure);
    }
    const known = this.ids.get(request.messageId);
    if (known !== undefined) return Promise.resolve({ externalMessageId: known });
    this.sequence += 1;
    const externalMessageId = `LGSP-${this.sequence}`;
    this.ids.set(request.messageId, externalMessageId);
    this.accepted.push(request);
    return Promise.resolve({ externalMessageId });
  }

  receipt(request: InteropReceiptRequest): Promise<InteropReceipt> {
    this.endpoints.push(request.endpoint);
    return this.receiptFailure === undefined ? Promise.resolve(this.answer) : Promise.reject(this.receiptFailure);
  }
}
