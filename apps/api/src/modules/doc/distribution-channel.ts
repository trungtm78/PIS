import { DomainError } from '@machvon/kernel';

/** What an email adapter is asked to send: who, which document and which file. The adapter resolves the mailbox of the recipient from its code. */
export interface EmailDelivery {
  outgoingDocumentId: string;
  distributionId: string;
  recipientName: string;
  recipientCode: string | null;
  symbol: string;
  versionId: string;
  fileSha256: string;
}

/** What the adapter did: handed the message on (SENT), or got the confirmation that it arrived (DELIVERED). */
export interface EmailReceipt {
  outcome: 'SENT' | 'DELIVERED';
  externalRef?: string | undefined;
}

/**
 * The email channel of the distribution (DOC.md F8). An adapter must only queue the message: the call runs inside the transaction of the command, so it must
 * not do anything that cannot be taken back when the command is rolled back. A failure is a rejection (a `DomainError` names its code); the row then
 * keeps the failure and can be sent again.
 */
export interface EmailChannelPort {
  send(request: EmailDelivery): Promise<EmailReceipt>;
}

/**
 * The adapter bound until a mail transport is configured: every send says the provider cannot be reached, so the row is FAILED with that reason and the
 * clerk can send it again once an adapter exists. It never reports a message as sent that was not.
 */
export class UnconfiguredEmailChannel implements EmailChannelPort {
  send(): Promise<EmailReceipt> {
    return Promise.reject(new DomainError('PROVIDER_UNAVAILABLE', 503));
  }
}
