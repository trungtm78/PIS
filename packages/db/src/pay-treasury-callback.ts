import { createHmac } from 'node:crypto';
import type { ProviderSignatureScheme } from '@machvon/kernel';

/**
 * What the Treasury callback signs (ST-PAY-006, PAY 3.3 step 6): the fields of the event in a fixed order, as one JSON array. An array is
 * unambiguous where a joined string is not (a document number that contains the separator cannot be read as two fields), and the
 * signature field itself is not part of it. The adapter is MOCK in tests and MISSING in production: no Treasury API exists for third parties.
 */
export interface TreasuryCallbackFields {
  providerEventId: string;
  provider: string;
  documentNo: string;
  documentDate: string;
  projectCode: string;
  amountVnd: string;
  direction: string;
  confirmedAt: string;
}

export function treasuryCallbackPayload(fields: TreasuryCallbackFields): Buffer {
  return Buffer.from(
    JSON.stringify([fields.providerEventId, fields.provider, fields.documentNo, fields.documentDate, fields.projectCode, fields.amountVnd, fields.direction, fields.confirmedAt]),
    'utf8',
  );
}

/** `hex(hmac_sha256(secret, payload))`, with no timestamp under the signature: replay is stopped by the event id in the inbox, not by a window. */
export const TREASURY_CALLBACK_SCHEME: ProviderSignatureScheme = {
  signedPayload: (_timestampSeconds, rawBody) => rawBody,
  encoding: 'hex',
  prefix: '',
};

/**
 * The time the inbox keeps as the provider's own: the booking time of the event in whole seconds. A value that does not read as a time is 0,
 * so that the signature is still judged first and the fields are refused afterwards, by name (422), not as a forged event.
 */
export function callbackTimestampSeconds(confirmedAt: string): number {
  const milliseconds = Date.parse(confirmedAt);
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0;
}

/** A freshness window that never refuses: the callback carries the time the Treasury booked the payment, which is not a send time. */
export const TREASURY_CALLBACK_WINDOW_SECONDS = Number.MAX_SAFE_INTEGER;

/** The signature that the MOCK Treasury (and the tests) put on an event. */
export function signTreasuryCallback(secret: Buffer, fields: TreasuryCallbackFields): string {
  return createHmac('sha256', secret).update(treasuryCallbackPayload(fields)).digest('hex');
}

/** Where the vault keeps the signing keys of a callback provider; the name is a reference, never a secret. */
export const treasuryCallbackSecretRef = (provider: string): string => `secret://pay/treasury/${provider}`;
