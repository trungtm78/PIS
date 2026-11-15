import { payloadOf } from '../tenant-token';
import { createPkcePair, randomToken } from './pkce';
import type { RandomOctets } from './pkce';

/** Where and who: the identity provider (issuer), this web client and the address it is sent back to. */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  /** Passed to the provider as `login_hint` (the test provider uses it to pick a user). */
  loginHint?: string;
  /** Asks for a stronger authentication, for example `aal2` for the second factor. */
  acrValues?: string;
  /** The language of the pages of the provider (`ui_locales`): the language of the application, whatever the browser announces. */
  uiLocales?: string;
  /** `login` asks the provider for a new sign-in whatever session its cookies name (the way out of a session of the provider that no longer works). */
  prompt?: 'login';
}

export interface OidcEndpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

export type OidcErrorCode = 'discovery_failed' | 'token_exchange_failed' | 'callback_invalid' | 'state_mismatch' | 'nonce_mismatch' | 'login_state_unavailable';

/** A failure of the sign-in; the message is fixed text, never what the provider or the address said. */
export class OidcError extends Error {
  readonly code: OidcErrorCode;

  constructor(code: OidcErrorCode) {
    super(code);
    this.name = 'OidcError';
    this.code = code;
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_SCOPE = 'openid';
const PENDING_KEY = 'mv.oidc.pending';

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The endpoints the issuer announces in its discovery document. */
export async function discover(issuer: string, fetcher: Fetcher = (url, init) => fetch(url, init)): Promise<OidcEndpoints> {
  let document: unknown;
  try {
    const response = await fetcher(`${issuer}/.well-known/openid-configuration`);
    document = response.ok ? await jsonOf(response) : undefined;
  } catch {
    throw new OidcError('discovery_failed');
  }
  if (!isRecord(document) || typeof document.authorization_endpoint !== 'string' || typeof document.token_endpoint !== 'string') {
    throw new OidcError('discovery_failed');
  }
  return {
    authorization_endpoint: document.authorization_endpoint,
    token_endpoint: document.token_endpoint,
    ...(typeof document.end_session_endpoint === 'string' ? { end_session_endpoint: document.end_session_endpoint } : {}),
  };
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

/** The address that sends the browser to the provider: authorization code flow with PKCE S256, `state` and `nonce`. */
export async function buildAuthorizationRequest(config: OidcConfig, endpoints: OidcEndpoints, random?: RandomOctets): Promise<AuthorizationRequest> {
  const { verifier, challenge } = await createPkcePair(random);
  const state = randomToken(random);
  const nonce = randomToken(random);
  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope ?? DEFAULT_SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (config.loginHint !== undefined) url.searchParams.set('login_hint', config.loginHint);
  if (config.acrValues !== undefined) url.searchParams.set('acr_values', config.acrValues);
  if (config.uiLocales !== undefined) url.searchParams.set('ui_locales', config.uiLocales);
  if (config.prompt !== undefined) url.searchParams.set('prompt', config.prompt);
  return { url: url.toString(), state, nonce, verifier };
}

/** What the provider appended to the redirect address: the code and the state, or a refusal (whose text is never repeated). */
export function parseCallback(search: string): { code: string; state: string } | { error: string } {
  const params = new URLSearchParams(search);
  if (params.has('error')) return { error: 'provider_refused' };
  const code = params.get('code');
  const state = params.get('state');
  if (code === null || code === '' || state === null || state === '') return { error: 'callback_incomplete' };
  return { code, state };
}

/** Whether the identity token carries the nonce of this sign-in (the API still verifies the whole token). */
export function checkNonce(idToken: string, nonce: string): boolean {
  return payloadOf(idToken)?.nonce === nonce;
}

export interface IdentityTokens {
  idToken: string;
  refreshToken?: string;
  expiresIn: number;
}

const DEFAULT_EXPIRES_IN = 300;

async function postForm(endpoints: OidcEndpoints, form: Record<string, string>, fetcher: Fetcher): Promise<IdentityTokens> {
  let body: unknown;
  try {
    const response = await fetcher(endpoints.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    body = response.ok ? await jsonOf(response) : undefined;
  } catch {
    throw new OidcError('token_exchange_failed');
  }
  if (!isRecord(body) || typeof body.id_token !== 'string' || body.id_token === '') throw new OidcError('token_exchange_failed');
  return {
    idToken: body.id_token,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    expiresIn: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN,
  };
}

/** Trades the authorization code (and the PKCE verifier) for the identity token. */
export function exchangeCode(config: OidcConfig, endpoints: OidcEndpoints, code: string, verifier: string, fetcher: Fetcher = (url, init) => fetch(url, init)): Promise<IdentityTokens> {
  return postForm(
    endpoints,
    { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: config.clientId, code_verifier: verifier },
    fetcher,
  );
}

/** Gets a new identity token with the refresh token the provider issued. */
export function refreshIdentity(config: OidcConfig, endpoints: OidcEndpoints, refreshToken: string, fetcher: Fetcher = (url, init) => fetch(url, init)): Promise<IdentityTokens> {
  return postForm(endpoints, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId }, fetcher);
}

/** A sign-in that has left for the provider and not yet come back. */
export interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

export interface LoginStore {
  save(pending: PendingLogin): void;
  /** The pending login, removed as it is read: a callback that is replayed finds nothing. */
  take(): PendingLogin | undefined;
}

function isPending(value: unknown): value is PendingLogin {
  return (
    isRecord(value) && typeof value.state === 'string' && typeof value.nonce === 'string' && typeof value.verifier === 'string' && typeof value.returnTo === 'string'
  );
}

/** The pending login lives in session storage (per tab, gone with the tab); every access tolerates storage that is blocked. */
export function createLoginStore(storage: Storage | undefined = typeof sessionStorage === 'undefined' ? undefined : sessionStorage): LoginStore {
  return {
    save(pending) {
      try {
        if (storage === undefined) throw new Error('no storage');
        storage.setItem(PENDING_KEY, JSON.stringify(pending));
      } catch {
        throw new OidcError('login_state_unavailable');
      }
    },
    take() {
      try {
        const raw = storage?.getItem(PENDING_KEY);
        storage?.removeItem(PENDING_KEY);
        if (raw === null || raw === undefined) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return isPending(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
