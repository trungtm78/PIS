import { ApiError } from '@machvon/api-client';

/** Permissions of the screens (x-permission in openapi.json). */
export const MANAGE_PERMISSION = 'omni.channel.manage';
export const READ_PERMISSION = 'channel_account.read';

export const CHANNELS = ['EMAIL', 'SMS', 'PUSH_FCM', 'PUSH_APNS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP'] as const;
export type Channel = (typeof CHANNELS)[number];
export const STATUSES = ['PendingVerification', 'Active', 'Disabled', 'CredentialExpired'] as const;
export type AccountStatus = (typeof STATUSES)[number];
/** The channels whose provider calls back with a signed webhook: their account has a webhook secret. The push channels have none. */
export const WEBHOOK_CHANNELS: readonly string[] = ['EMAIL', 'SMS', 'ZALO_OA', 'ZALO_ZNS', 'WHATSAPP'];

export const REASON_MIN = 10;
export const REASON_MAX = 2000;
export const AUTO_REPLY_MAX = 500;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** A channel account as the supervisor sees it: no secret and no reference to one, only whether they are configured (OMNI 8). */
export interface AccountView {
  id: string;
  channel: string;
  externalAccountId: string;
  displayName: string;
  status: AccountStatus;
  credentialConfigured: boolean;
  webhookConfigured: boolean;
  verifiedAt: string | undefined;
  /** Set while a verification that was asked for waits for the provider. */
  verifyRequestedAt: string | undefined;
  verificationError: string | undefined;
  autoReplyText: string | undefined;
  calendarCode: string | undefined;
  createdAt: string;
  version: number;
}

export interface AccountPage {
  items: AccountView[];
  nextCursor: string | undefined;
}

export function toAccount(raw: unknown): AccountView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    channel: text(raw.channel),
    externalAccountId: text(raw.external_account_id),
    displayName: text(raw.display_name),
    status: (STATUSES as readonly string[]).includes(text(raw.status)) ? (raw.status as AccountStatus) : 'PendingVerification',
    credentialConfigured: raw.credential_configured === true,
    webhookConfigured: raw.webhook_configured === true,
    verifiedAt: optional(raw.verified_at),
    verifyRequestedAt: optional(raw.verify_requested_at),
    verificationError: optional(raw.verification_error),
    autoReplyText: optional(raw.auto_reply_text),
    calendarCode: optional(raw.calendar_code),
    createdAt: text(raw.created_at),
    version: typeof raw.version === 'number' ? raw.version : 0,
  };
}

export function toAccountPage(raw: unknown): AccountPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toAccount(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

export const isWaiting = (account: Pick<AccountView, 'verifyRequestedAt'>): boolean => account.verifyRequestedAt !== undefined;
/** A verification that has waited this long for the provider is taken to be stranded (the worker stopped before it recorded the answer): it may be asked for again. */
export const STRANDED_AFTER_MS = 60_000;
export const isStranded = (account: Pick<AccountView, 'verifyRequestedAt'>, now: number = Date.now()): boolean =>
  account.verifyRequestedAt !== undefined && now - Date.parse(account.verifyRequestedAt) > STRANDED_AFTER_MS;
/** Verification is asked for an account that waits for one, or whose credential expired; one that was asked for is not asked twice, unless it has waited so long that it is stranded. */
export const canVerify = (account: Pick<AccountView, 'status' | 'verifyRequestedAt'>, now: number = Date.now()): boolean =>
  (account.status === 'PendingVerification' || account.status === 'CredentialExpired') && (account.verifyRequestedAt === undefined || isStranded(account, now));
export const canDisable = (account: Pick<AccountView, 'status'>): boolean => account.status !== 'Disabled';
export const canEdit = (account: Pick<AccountView, 'status'>): boolean => account.status !== 'Disabled';
export const isReasonValid = (reason: string): boolean => reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;

// ---- the connect form -----------------------------------------------------------------------------------------------------------------

export interface ConnectForm {
  channel: Channel;
  externalAccountId: string;
  displayName: string;
  credentialSecretRef: string;
  webhookSecretRef: string;
}

export const emptyConnectForm = (): ConnectForm => ({ channel: 'EMAIL', externalAccountId: '', displayName: '', credentialSecretRef: '', webhookSecretRef: '' });

const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const SECRET_REF = /^secret:\/\/[A-Za-z0-9._/-]{1,200}$/;

export type FormField = 'externalAccountId' | 'displayName' | 'credentialSecretRef' | 'webhookSecretRef';

/** What the server would refuse, judged the way it does, so that the supervisor is told before sending: a secret written in place of its reference is the case to catch (the server stays the judge). */
export function formProblems(form: ConnectForm): FormField[] {
  const found: FormField[] = [];
  if (!EXTERNAL_ID.test(form.externalAccountId.trim())) found.push('externalAccountId');
  const name = form.displayName.trim();
  if (name === '' || name.length > 120) found.push('displayName');
  if (!SECRET_REF.test(form.credentialSecretRef.trim())) found.push('credentialSecretRef');
  const webhook = form.webhookSecretRef.trim();
  if (WEBHOOK_CHANNELS.includes(form.channel)) {
    if (!SECRET_REF.test(webhook) || webhook === form.credentialSecretRef.trim()) found.push('webhookSecretRef');
  }
  return found;
}

export function connectBody(form: ConnectForm): Record<string, unknown> {
  return {
    channel: form.channel,
    external_account_id: form.externalAccountId.trim(),
    display_name: form.displayName.trim(),
    credential_secret_ref: form.credentialSecretRef.trim(),
    ...(WEBHOOK_CHANNELS.includes(form.channel) ? { webhook_secret_ref: form.webhookSecretRef.trim() } : {}),
  };
}

// ---- what the server refused with --------------------------------------------------------------------------------------------------------

export type ProblemReason = 'invalid' | 'exists' | 'state' | 'conflict' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  CHANNEL_ACCOUNT_EXISTS: 'exists',
  CHANNEL_ACCOUNT_STATE_INVALID: 'state',
  VERSION_CONFLICT: 'conflict',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
