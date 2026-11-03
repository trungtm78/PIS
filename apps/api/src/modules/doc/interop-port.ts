import { DomainError } from '@machvon/kernel';
import type { IncomingUrgency } from '@machvon/kernel';

/** What the adapter is given to build the envelope of a document that leaves: the facts of the issued document and its sealed PDF. */
export interface OutboundEnvelopeInput {
  /** The id of the message in this system: the receiving agency can drop a message it has seen. */
  messageId: string;
  senderCode: string | null;
  receiverCode: string;
  symbol: string;
  issuedOn: string;
  title: string;
  docTypeCode: string;
  urgency: string;
  pdf: Uint8Array;
}

/** What an envelope that arrived says, once the adapter has read it: the facts of the letter and its PDF. */
export interface InboundLetter {
  title: string;
  docTypeCode: string;
  originalSymbol: string | undefined;
  originalIssuedOn: string | undefined;
  senderName: string | undefined;
  urgency: IncomingUrgency;
  pdf: Buffer;
}

/**
 * The envelope format of the LGSP (QCVN 102:2016/BTTTT, edXML) behind a port. `encode` builds the bytes that leave; `decode` reads the bytes that arrived and refuses what is not an envelope of the format
 * (422 `ENVELOPE_INVALID`). The adapter of the real format waits for the specification of the pilot tenant [CXN-06]; the JSON stand-in (`interop-codec.ts`) is what MOCK runs on.
 */
export interface InteropCodec {
  encode(input: OutboundEnvelopeInput): Buffer;
  decode(bytes: Uint8Array): InboundLetter;
}

export interface InteropSendRequest {
  /** The address of the gateway, already checked against the allowlist of the tenant. */
  endpoint: string;
  messageId: string;
  senderCode: string | null;
  receiverCode: string;
  envelope: Uint8Array;
  envelopeSha256: string;
}

export interface InteropReceiptRequest {
  endpoint: string;
  externalMessageId: string;
}

export type InteropReceipt = { outcome: 'PENDING' } | { outcome: 'ACKED' } | { outcome: 'REJECTED'; reasonCode: string };

/**
 * The gateway of the LGSP behind a port. `send` hands the envelope over and returns the id the gateway gave the message; `receipt` asks what the receiving agency did with it. A failure is a rejection (a `DomainError` names
 * its code, anything else is a general channel error): the message then waits for its next attempt. An adapter must bound the time of a call, because the call runs inside the transaction that records its outcome; it may be
 * called again for a message whose outcome was lost, so the gateway has to drop a message id it has seen. Only addresses on the allowlist of the tenant are ever passed in.
 */
export interface InteropTransportPort {
  send(request: InteropSendRequest): Promise<{ externalMessageId: string }>;
  receipt(request: InteropReceiptRequest): Promise<InteropReceipt>;
}

/**
 * The adapter bound until the specification of the LGSP of the pilot tenant exists [CXN-06]: every call says the provider cannot be reached, so a message waits, fails with that reason and is dead after twenty attempts
 * (with its alert). It never reports a message as sent that was not.
 */
export class UnconfiguredInteropTransport implements InteropTransportPort {
  send(): Promise<{ externalMessageId: string }> {
    return Promise.reject(new DomainError('PROVIDER_UNAVAILABLE', 503));
  }

  receipt(): Promise<InteropReceipt> {
    return Promise.reject(new DomainError('PROVIDER_UNAVAILABLE', 503));
  }
}
