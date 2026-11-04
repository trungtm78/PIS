import { DomainError } from './errors.ts';
import { hasControlChar } from './control-chars.ts';

/**
 * The channel accounts of a tenant (ST-OMNI-001, OMNI.md 3.7, BR-OMNI-02, BR-OMNI-04): the account at a provider through which messages go out and webhooks come in. An account is connected with references to its secrets
 * (never the secrets), verified against the provider, and only a verified (Active) account sends or receives. The rules below are pure.
 *
 *   PendingVerification -verify-> Active -disable-> Disabled          Active -(provider says the credential is gone)-> CredentialExpired -verify-> Active
 */
export const ACCOUNT_CHANNELS = ['EMAIL', 'SMS', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP'] as const;
export type AccountChannel = (typeof ACCOUNT_CHANNELS)[number];
export const ACCOUNT_STATUSES = ['PendingVerification', 'Active', 'Disabled', 'CredentialExpired'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** The channels whose provider calls back with a signed webhook: their account needs the reference of the webhook secret. The two push providers answer "accepted" and call nothing back. */
export const WEBHOOK_CHANNELS: ReadonlySet<string> = new Set(['EMAIL', 'SMS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP']);

const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const SECRET_REF = /^secret:\/\/[A-Za-z0-9._/-]{1,200}$/;
const CALENDAR_CODE = /^[A-Za-z0-9._-]{1,60}$/;
export const AUTO_REPLY_MAX = 500;
/** What an adapter answers when the provider says the credential of the account no longer works: the account is CredentialExpired until it is verified again. */
export const CREDENTIAL_EXPIRED_CODE = 'CREDENTIAL_EXPIRED';
export const DISPLAY_NAME_MAX = 120;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export const isAccountChannel = (value: unknown): value is AccountChannel => typeof value === 'string' && (ACCOUNT_CHANNELS as readonly string[]).includes(value);

/** A name people read: NFC, trimmed, one line. */
export function displayNameOf(raw: unknown, field = 'display_name'): string {
  if (typeof raw !== 'string') throw invalid(field);
  const name = raw.normalize('NFC').trim();
  if (name === '' || name.length > DISPLAY_NAME_MAX || hasControlChar(name)) throw invalid(field);
  return name;
}

export interface ConnectInput {
  channel: unknown;
  externalAccountId: unknown;
  displayName: unknown;
  credentialSecretRef: unknown;
  webhookSecretRef: unknown;
}

export interface ConnectedAccount {
  channel: AccountChannel;
  externalAccountId: string;
  displayName: string;
  credentialSecretRef: string;
  webhookSecretRef: string | undefined;
}

/**
 * What may be connected. The secrets are references into the vault (`secret://...`) and nothing else, so a pasted token is refused before it can reach a log or the database. A channel with webhooks needs the
 * reference of its webhook secret; a push channel has none to give.
 */
export function assertConnectable(input: ConnectInput): ConnectedAccount {
  if (!isAccountChannel(input.channel)) throw invalid('channel');
  if (typeof input.externalAccountId !== 'string' || !EXTERNAL_ID.test(input.externalAccountId.trim())) throw invalid('external_account_id');
  if (typeof input.credentialSecretRef !== 'string' || !SECRET_REF.test(input.credentialSecretRef)) throw invalid('credential_secret_ref');
  let webhook: string | undefined;
  if (input.webhookSecretRef !== undefined && input.webhookSecretRef !== null) {
    if (typeof input.webhookSecretRef !== 'string' || !SECRET_REF.test(input.webhookSecretRef)) throw invalid('webhook_secret_ref');
    webhook = input.webhookSecretRef;
  }
  if (WEBHOOK_CHANNELS.has(input.channel) && webhook === undefined) throw invalid('webhook_secret_ref');
  if (!WEBHOOK_CHANNELS.has(input.channel) && webhook !== undefined) throw invalid('webhook_secret_ref');
  if (webhook !== undefined && webhook === input.credentialSecretRef) throw invalid('webhook_secret_ref');
  return { channel: input.channel, externalAccountId: input.externalAccountId.trim(), displayName: displayNameOf(input.displayName), credentialSecretRef: input.credentialSecretRef, webhookSecretRef: webhook };
}

export interface AccountChanges {
  displayName?: string;
  autoReplyText?: string | null;
  calendarCode?: string | null;
}

/** The fields of an update that were given; an update that changes nothing is refused. An empty text (or `null`) clears the auto reply and the calendar. */
export function assertChanges(raw: { display_name?: unknown; auto_reply_text?: unknown; calendar_code?: unknown }): AccountChanges {
  const changes: AccountChanges = {};
  if (raw.display_name !== undefined) changes.displayName = displayNameOf(raw.display_name);
  if (raw.auto_reply_text !== undefined) {
    if (raw.auto_reply_text === null || (typeof raw.auto_reply_text === 'string' && raw.auto_reply_text.trim() === '')) changes.autoReplyText = null;
    else if (typeof raw.auto_reply_text === 'string' && raw.auto_reply_text.length <= AUTO_REPLY_MAX && !hasControlChar(raw.auto_reply_text.replace(/[\n\r\t]/g, ' '))) changes.autoReplyText = raw.auto_reply_text.normalize('NFC').trim();
    else throw invalid('auto_reply_text');
  }
  if (raw.calendar_code !== undefined) {
    if (raw.calendar_code === null || raw.calendar_code === '') changes.calendarCode = null;
    else if (typeof raw.calendar_code === 'string' && CALENDAR_CODE.test(raw.calendar_code)) changes.calendarCode = raw.calendar_code;
    else throw invalid('calendar_code');
  }
  if (Object.keys(changes).length === 0) throw invalid('display_name');
  return changes;
}

/** Verification is asked for an account that has not been verified, or whose credential the provider gave up on; an Active account is verified and a Disabled one is closed for good. */
export const canVerifyAccount = (status: AccountStatus): boolean => status === 'PendingVerification' || status === 'CredentialExpired';
/** An account that is not Disabled may be disabled; the account is not brought back, a new one is connected. */
export const canDisableAccount = (status: AccountStatus): boolean => status !== 'Disabled';
/** Only a verified account takes part in a send or a receipt (BR-OMNI-02). */
export const isUsable = (status: string): boolean => status === 'Active';

/** The code a send is stopped with when its account cannot be used: a closed account is told apart from one that is not (or is no longer) verified. */
export const unusableCodeOf = (status: string): string => (status === 'Disabled' ? 'CHANNEL_ACCOUNT_DISABLED' : 'CHANNEL_UNVERIFIED');
