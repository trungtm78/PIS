import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { TEAMS_CHANNEL, TIMESTAMPED_HMAC_SHA256, isProductionEnvironment, teamsCardOf } from '@machvon/kernel';
import type { AdapterStatus, ChannelAdapter, ChannelLookupResult, ChannelSendRequest, ChannelSendResult, ParsedChannelCallback, ProviderSignatureScheme } from '@machvon/kernel';

/** The provider of the adapter that posts to an incoming webhook (the other adapter of the channel, `teams-outbox`, hands the card to a relay of the operator). */
export const TEAMS_WEBHOOK_PROVIDER = 'teams-webhook';
/** The environment variables: the URL itself (a development setup), or the vault reference that names it (`secret://<environment>/<path>`, read as `MACHVON_SECRET_<ENVIRONMENT>_<PATH>`); extra host suffixes; the attestation that the relay was verified. */
export const TEAMS_WEBHOOK_URL_VARIABLE = 'MACHVON_TEAMS_WEBHOOK_URL';
export const TEAMS_WEBHOOK_URL_REF_VARIABLE = 'MACHVON_TEAMS_WEBHOOK_URL_REF';
export const TEAMS_WEBHOOK_ALLOWED_HOSTS_VARIABLE = 'MACHVON_TEAMS_WEBHOOK_ALLOWED_HOSTS';
export const TEAMS_WEBHOOK_VERIFIED_VARIABLE = 'MACHVON_TEAMS_WEBHOOK_VERIFIED';

/** The hosts an incoming webhook of Microsoft Teams (Workflows, Power Automate, the connector that is being retired) lives on. A customer relay is added with the allow-list of the operator, never by a code change. */
export const DEFAULT_TEAMS_WEBHOOK_SUFFIXES: readonly string[] = ['webhook.office.com', 'logic.azure.com', 'powerplatform.com'];
const MAX_CARD_BYTES = 28_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SECONDS = 3600;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

type Environment = Readonly<Record<string, string | undefined>>;

const secretVariable = (reference: string): string => `MACHVON_SECRET_${reference.replace(/^secret:\/\//, '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

export interface TeamsWebhookConfig {
  url: URL;
  /** Host suffixes the URL may name (a host is allowed when it IS the suffix or ends with a dot and the suffix). */
  allowedSuffixes: readonly string[];
  timeoutMs: number;
  /** Only for the tests and a development stack: the loopback may be reached over plain http. Never set from the environment where real data lives. */
  loopbackHttp?: boolean | undefined;
}

/** Whether a webhook URL may be called: https on the default port, no credentials in it, a host on the allow-list (and no address literal); the loopback over http only when the configuration says so. */
export function webhookAllowed(url: URL, allowedSuffixes: readonly string[], loopbackHttp = false): boolean {
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if (loopbackHttp && url.protocol === 'http:' && LOOPBACK.has(host)) return true;
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) return false;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  return allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function teamsWebhookConfigFromEnv(env: Environment, environment: string | undefined): TeamsWebhookConfig | undefined {
  const reference = env[TEAMS_WEBHOOK_URL_REF_VARIABLE]?.trim();
  const raw = (reference === undefined || reference === '' ? env[TEAMS_WEBHOOK_URL_VARIABLE] : env[secretVariable(reference)])?.trim();
  if (raw === undefined || raw === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const extra = (env[TEAMS_WEBHOOK_ALLOWED_HOSTS_VARIABLE] ?? '')
    .split(',')
    .map((suffix) => suffix.trim().toLowerCase().replace(/^\./, ''))
    .filter((suffix) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(suffix));
  const allowedSuffixes = [...DEFAULT_TEAMS_WEBHOOK_SUFFIXES, ...extra];
  const loopbackHttp = !isProductionEnvironment(environment) && env.MACHVON_TEAMS_WEBHOOK_ALLOW_LOOPBACK === 'true';
  if (!webhookAllowed(url, allowedSuffixes, loopbackHttp)) return undefined;
  return { url, allowedSuffixes, timeoutMs: DEFAULT_TIMEOUT_MS, loopbackHttp };
}

export interface WebhookAnswer {
  status: number;
  retryAfter: string | undefined;
}

/** How a post failed before there was an answer: before the request was fully written (it can be tried again) or after (the webhook may have the card). */
export class WebhookTransportError extends Error {
  constructor(readonly requestWritten: boolean) {
    super(requestWritten ? 'no answer after the request was sent' : 'the request did not leave');
  }
}

/** The port to the network: the real one is `nodePoster`; a test may give its own. */
export type WebhookPoster = (url: URL, body: string, timeoutMs: number) => Promise<WebhookAnswer>;

/** Posts with node:http(s): no redirect is followed (a 3xx is an answer like any other), the time limit covers the whole exchange, and the body of the answer is never read into memory. */
export const nodePoster: WebhookPoster = (url, body, timeoutMs) =>
  new Promise<WebhookAnswer>((resolve, reject) => {
    let written = false;
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const call = send(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, retryAfter: typeof response.headers['retry-after'] === 'string' ? response.headers['retry-after'] : undefined });
      },
    );
    call.on('timeout', () => call.destroy(new WebhookTransportError(written)));
    call.on('error', (error) => reject(error instanceof WebhookTransportError ? error : new WebhookTransportError(written)));
    call.end(body, () => {
      written = true;
    });
  });

/** Seconds from a `Retry-After` header (a number of seconds or an HTTP date), at most an hour; undefined when it says nothing usable. */
export function retryAfterSeconds(value: string | undefined, now: Date = new Date()): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : Math.ceil((Date.parse(trimmed) - now.getTime()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
}

/**
 * The adapter of the Teams channel that posts the adaptive card to an incoming webhook (YCK.01, QT.02): the reminders and alerts reach the channel the tenant connected without a relay of the operator. The URL is a
 * secret (it carries the signature), so it comes from the vault reference or the environment and is never stored in the database, an audit row or a log; the host must be on the allow-list (Microsoft's own hosts and the
 * suffixes the operator adds for a relay of the customer), https only, no redirect. The engine owns the retries: 408, 429 (with `Retry-After`) and 5xx are failures that can be tried again, other 4xx and a redirect are
 * for good, a card that is too large never leaves, and a request that was sent and not answered is `UNKNOWN` (a second card in a channel is a second interruption). A webhook keeps no idempotency key, so a lookup cannot tell.
 */
export class TeamsWebhookChannelAdapter implements ChannelAdapter {
  readonly provider = TEAMS_WEBHOOK_PROVIDER;
  readonly channel = TEAMS_CHANNEL;
  readonly paid = false;
  readonly signature: ProviderSignatureScheme = TIMESTAMPED_HMAC_SHA256;

  constructor(
    private readonly config: TeamsWebhookConfig,
    readonly status: AdapterStatus,
    private readonly post: WebhookPoster = nodePoster,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    if (!webhookAllowed(this.config.url, this.config.allowedSuffixes, this.config.loopbackHttp === true)) return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_WEBHOOK_HOST_NOT_ALLOWED' };
    const body = JSON.stringify(teamsCardOf({ subject: request.subject, text: request.text, accountId: request.accountId, idempotencyKey: request.idempotencyKey }));
    if (Buffer.byteLength(body) > MAX_CARD_BYTES) return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_CARD_TOO_LARGE' };
    let answer: WebhookAnswer;
    try {
      answer = await this.post(this.config.url, body, this.config.timeoutMs);
    } catch (error) {
      return error instanceof WebhookTransportError && error.requestWritten ? { kind: 'UNKNOWN', errorCode: 'TEAMS_RESULT_LOST' } : { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_CONNECT_FAILED' };
    }
    const { status } = answer;
    if (status === 200 || status === 202) return { kind: 'ACCEPTED', providerMessageId: `webhook:${request.idempotencyKey}` };
    if (status === 429) {
      const wait = retryAfterSeconds(answer.retryAfter, this.now());
      return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: 'TEAMS_429', ...(wait === undefined ? {} : { retryAfterSeconds: wait }) };
    }
    if (status === 408 || status >= 500) return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: `TEAMS_${status}` };
    if (status >= 300 && status < 400) return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'TEAMS_REDIRECT_REFUSED' };
    return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: `TEAMS_${status}` };
  }

  /** A webhook keeps no idempotency key: it cannot say whether a card was posted. */
  lookup(): Promise<ChannelLookupResult> {
    return Promise.resolve({ kind: 'UNDETERMINED' });
  }

  /** A webhook reports nothing back. */
  parseCallback(): ParsedChannelCallback | undefined {
    return undefined;
  }
}

/** The adapter the environment asks for, or undefined when no webhook is configured. In production it is `PROPOSED` (never sends) until the operator attests that the webhook was verified (`MACHVON_TEAMS_WEBHOOK_VERIFIED=true`); elsewhere it is `MOCK`. */
export function teamsWebhookAdapterFromEnv(env: Environment, environment: string | undefined): TeamsWebhookChannelAdapter | undefined {
  const config = teamsWebhookConfigFromEnv(env, environment);
  if (config === undefined) return undefined;
  const status: AdapterStatus = isProductionEnvironment(environment) ? (env[TEAMS_WEBHOOK_VERIFIED_VARIABLE] === 'true' ? 'VERIFIED' : 'PROPOSED') : 'MOCK';
  return new TeamsWebhookChannelAdapter(config, status);
}
