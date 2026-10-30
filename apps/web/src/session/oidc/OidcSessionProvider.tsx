import { ApiError, createApiClient, newCommandAttempt } from '@machvon/api-client';
import type { ApiClient, CommandAttempt } from '@machvon/api-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { BASE_THEME } from '../../theme/ThemeProvider';
import { SessionContext } from '../SessionContext';
import type { SessionIdentity, SessionMode, SessionStatus, SessionTenant, SessionTenantToken, SessionUser, SessionValue, TenantCandidate } from '../SessionContext';
import { expiresAtMs, payloadOf, renewalDelayMs } from '../tenant-token';
import { OidcError, buildAuthorizationRequest, checkNonce, createLoginStore, discover, exchangeCode, parseCallback, refreshIdentity } from './client';
import type { IdentityTokens, LoginStore, OidcConfig, OidcEndpoints } from './client';
import type { RandomOctets } from './pkce';

export interface OidcSessionProviderProps {
  config: OidcConfig;
  children: ReactNode;
  /** Base address of the API; the same origin when empty. */
  apiBaseUrl?: string;
  /** Skips discovery (tests and hosts that know the endpoints). */
  endpoints?: OidcEndpoints;
  loginStore?: LoginStore;
  /** How the browser leaves for the provider; defaults to `window.location.assign`. */
  redirect?: (url: string) => void;
  apiFetch?: typeof fetch;
  tokenFetch?: typeof fetch;
  now?: () => number;
  random?: RandomOctets;
}

interface HeldIdentity {
  token: string;
  expiresAt: number;
  refreshToken?: string;
}

interface HeldTenantToken {
  value: string;
  expiresAt: number;
}

interface SessionContextAnswer {
  access_token: string;
  expires_in: number;
  mode?: SessionMode;
}

const IDENTITY_SAFETY_MS = 30_000;
const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;
const IDEMPOTENCY_IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS';
const RETRY_AFTER_FAILURE_MS = 30_000;

/** The host the page was opened on, sent with every request of the identity: a verified domain of a tenant chooses the tenant the sign-in starts from (ST-SAS-017). A host that is not a name (localhost) chooses nothing on the server. */
function hostHeader(): Record<string, string> {
  const host = globalThis.location?.hostname;
  return host === undefined || host === '' ? {} : { 'x-tenant-host': host };
}

/** The server answered the command for good: a refusal of the request itself (4xx) is final, a lost or unfinished answer is not. */
function isDefinitive(failure: unknown): boolean {
  if (!(failure instanceof ApiError)) return false;
  return failure.status >= 400 && failure.status < 500 && failure.status !== REQUEST_TIMEOUT && failure.status !== TOO_MANY_REQUESTS && failure.code !== IDEMPOTENCY_IN_PROGRESS;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== '');
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return letters.map((word) => word?.[0] ?? '').join('').toUpperCase() || '?';
}

function monogramOf(name: string): string {
  const initials = initialsOf(name);
  return initials.length >= 2 ? initials.slice(0, 2) : name.trim().slice(0, 2).toUpperCase();
}

function userOf(claims: Record<string, unknown> | undefined): { identity: SessionIdentity; user: SessionUser } {
  const subject = typeof claims?.sub === 'string' ? claims.sub : '';
  const named = [claims?.name, claims?.preferred_username, claims?.email].find((value): value is string => typeof value === 'string' && value !== '');
  const displayName = named ?? subject;
  return { identity: { subject, displayName }, user: { displayName, initials: initialsOf(displayName) } };
}

/**
 * Real sign-in: the authorization code flow with PKCE against the identity provider, then the tenant chosen by
 * `selectTenantContext`. Both tokens live in memory only: a reload signs in again (the provider's own session makes
 * that a redirect and back). The tenant access token is renewed one minute before it expires without touching the tree.
 */
export default function OidcSessionProvider({ config, children, apiBaseUrl = '', endpoints: knownEndpoints, loginStore, redirect, apiFetch, tokenFetch, now = Date.now, random }: OidcSessionProviderProps) {
  const store = useMemo(() => loginStore ?? createLoginStore(), [loginStore]);
  const identityRef = useRef<HeldIdentity | undefined>(undefined);
  const tenantTokenRef = useRef<HeldTenantToken | undefined>(undefined);
  const candidateRef = useRef<TenantCandidate | undefined>(undefined);
  const endpointsRef = useRef<OidcEndpoints | undefined>(knownEndpoints);
  const attempts = useRef(new Map<string, CommandAttempt>());
  const inFlight = useRef(new Map<string, Promise<void>>());
  // Counts the selections and the sign-outs: an answer that arrives after a later one started is ignored.
  const epoch = useRef(0);
  const renewal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const [status, setStatus] = useState<SessionStatus>('signedOut');
  const [identity, setIdentity] = useState<SessionIdentity | undefined>(undefined);
  const [user, setUser] = useState<SessionUser | undefined>(undefined);
  const [tenant, setTenant] = useState<SessionTenant | undefined>(undefined);
  const [tenants, setTenants] = useState<readonly SessionTenant[]>([]);
  const [mode, setMode] = useState<SessionMode | undefined>(undefined);
  const [tenantToken, setTenantToken] = useState<SessionTenantToken | undefined>(undefined);

  const clearRenewal = useCallback(() => {
    if (renewal.current !== undefined) clearTimeout(renewal.current);
    renewal.current = undefined;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearRenewal();
    };
  }, [clearRenewal]);

  const endpointsOf = useCallback(async (): Promise<OidcEndpoints> => {
    endpointsRef.current ??= await discover(config.issuer, tokenFetch === undefined ? undefined : (url, init) => tokenFetch(url, init));
    return endpointsRef.current;
  }, [config.issuer, tokenFetch]);

  const forgetEverything = useCallback(() => {
    clearRenewal();
    identityRef.current = undefined;
    tenantTokenRef.current = undefined;
    candidateRef.current = undefined;
    attempts.current.clear();
    inFlight.current.clear();
    epoch.current += 1;
    if (!mounted.current) return;
    setStatus('signedOut');
    setIdentity(undefined);
    setUser(undefined);
    setTenant(undefined);
    setTenants([]);
    setMode(undefined);
    setTenantToken(undefined);
  }, [clearRenewal]);

  const signIn = useCallback(
    async (options?: { returnTo?: string; acrValues?: string }) => {
      const endpoints = await endpointsOf();
      const request = await buildAuthorizationRequest({ ...config, ...(options?.acrValues === undefined ? {} : { acrValues: options.acrValues }) }, endpoints, random);
      store.save({ state: request.state, nonce: request.nonce, verifier: request.verifier, returnTo: options?.returnTo ?? `${window.location.pathname}${window.location.search}` });
      (redirect ?? ((url: string) => window.location.assign(url)))(request.url);
    },
    [config, endpointsOf, random, redirect, store],
  );

  const adoptIdentity = useCallback(
    (tokens: IdentityTokens, previousRefresh?: string) => {
      const expiresAt = expiresAtMs(tokens.idToken) ?? now() + tokens.expiresIn * 1000;
      identityRef.current = { token: tokens.idToken, expiresAt, refreshToken: tokens.refreshToken ?? previousRefresh };
      const person = userOf(payloadOf(tokens.idToken));
      setIdentity(person.identity);
      setUser(person.user);
    },
    [now],
  );

  const completeSignIn = useCallback(
    async (search: string): Promise<{ returnTo: string }> => {
      const pending = store.take();
      const callback = parseCallback(search);
      if (pending === undefined || 'error' in callback) throw new OidcError('callback_invalid');
      if (callback.state !== pending.state) throw new OidcError('state_mismatch');
      const endpoints = await endpointsOf();
      const tokens = await exchangeCode(config, endpoints, callback.code, pending.verifier, tokenFetch === undefined ? undefined : (url, init) => tokenFetch(url, init));
      if (!checkNonce(tokens.idToken, pending.nonce)) throw new OidcError('nonce_mismatch');
      adoptIdentity(tokens);
      setStatus(tenantTokenRef.current === undefined ? 'identified' : 'active');
      return { returnTo: pending.returnTo };
    },
    [adoptIdentity, config, endpointsOf, store, tokenFetch],
  );

  // A refresh token, when the provider issued one, keeps the identity token alive; without it the person signs in again.
  const freshIdentityToken = useCallback(async (): Promise<string> => {
    const held = identityRef.current;
    if (held === undefined) throw new OidcError('callback_invalid');
    if (held.expiresAt - now() > IDENTITY_SAFETY_MS) return held.token;
    if (held.refreshToken === undefined) {
      forgetEverything();
      throw new OidcError('callback_invalid');
    }
    try {
      const tokens = await refreshIdentity(config, await endpointsOf(), held.refreshToken, tokenFetch === undefined ? undefined : (url, init) => tokenFetch(url, init));
      adoptIdentity(tokens, held.refreshToken);
      return tokens.idToken;
    } catch (error) {
      forgetEverything();
      throw error;
    }
  }, [adoptIdentity, config, endpointsOf, forgetEverything, now, tokenFetch]);

  const apiClient = useCallback(
    (token: () => Promise<string | undefined>): ApiClient =>
      createApiClient({ baseUrl: apiBaseUrl, headers: hostHeader, session: async () => {
        const value = await token();
        return value === undefined ? undefined : { token: value };
      }, ...(apiFetch === undefined ? {} : { fetch: apiFetch }) }),
    [apiBaseUrl, apiFetch],
  );

  const identityClient = useMemo(() => apiClient(freshIdentityToken), [apiClient, freshIdentityToken]);

  const loadCandidates = useCallback(async (): Promise<readonly TenantCandidate[]> => {
    const answer = (await identityClient.read('listTenantSelectionCandidates')) as { items: TenantCandidate[] };
    return answer.items;
  }, [identityClient]);

  const scheduleRenewal = useCallback(
    (expiresAt: number, renew: () => Promise<void>) => {
      clearRenewal();
      renewal.current = setTimeout(() => void renew(), renewalDelayMs(expiresAt, now()));
    },
    [clearRenewal, now],
  );

  const adoptTenant = useCallback(
    (candidate: TenantCandidate, answer: SessionContextAnswer, renew: () => Promise<void>) => {
      const expiresAt = expiresAtMs(answer.access_token) ?? now() + answer.expires_in * 1000;
      tenantTokenRef.current = { value: answer.access_token, expiresAt };
      candidateRef.current = candidate;
      setTenant({ id: candidate.tenant_id, name: candidate.tenant_name, monogram: monogramOf(candidate.tenant_name), membershipId: candidate.membership_id, theme: BASE_THEME });
      setTenants([{ id: candidate.tenant_id, name: candidate.tenant_name, monogram: monogramOf(candidate.tenant_name), membershipId: candidate.membership_id, theme: BASE_THEME }]);
      setMode(answer.mode ?? 'FULL');
      setTenantToken({ expiresAt });
      setStatus('active');
      scheduleRenewal(expiresAt, renew);
    },
    [now, scheduleRenewal],
  );

  const selectTenant = useCallback(
    (candidate: TenantCandidate): Promise<void> => {
      if (identityRef.current === undefined) return Promise.reject(new OidcError('callback_invalid'));
      const key = `${candidate.tenant_id}:${candidate.membership_id}`;
      const running = inFlight.current.get(key);
      if (running !== undefined) return running;
      const mine = (epoch.current += 1);
      const live = (): boolean => epoch.current === mine;
      const attempt = attempts.current.get(key) ?? newCommandAttempt();
      attempts.current.set(key, attempt);
      const ask = async (target: TenantCandidate, using: CommandAttempt): Promise<SessionContextAnswer> =>
        (await identityClient.command('selectTenantContext', { body: { tenant_id: target.tenant_id, membership_id: target.membership_id }, attempt: using })) as unknown as SessionContextAnswer;
      // Every renewal is a new request: it gets a new key, kept only for the retries of that same renewal, so the
      // server decides again on today's facts (a tenant suspended or reactivated since) instead of replaying the first answer.
      let renewalAttempt: CommandAttempt | undefined;
      const renew = async (): Promise<void> => {
        if (!live()) return;
        renewalAttempt ??= newCommandAttempt();
        try {
          const answer = await ask(candidate, renewalAttempt);
          if (!live()) return;
          renewalAttempt = undefined;
          adoptTenant(candidate, answer, renew);
        } catch (error) {
          if (!live()) return;
          if (isDefinitive(error) || error instanceof OidcError) {
            renewalAttempt = undefined;
            forgetEverything();
          } else scheduleRenewal(now() + RETRY_AFTER_FAILURE_MS + 60_000, renew);
        }
      };
      const run = ask(candidate, attempt)
        .then((answer) => {
          attempts.current.delete(key);
          if (live()) adoptTenant(candidate, answer, renew);
        })
        .catch((error: unknown) => {
          if (isDefinitive(error)) attempts.current.delete(key);
          throw error;
        })
        .finally(() => {
          inFlight.current.delete(key);
        });
      inFlight.current.set(key, run);
      return run;
    },
    [adoptTenant, forgetEverything, identityClient, now, scheduleRenewal],
  );

  const getSession = useCallback(async () => {
    const held = tenantTokenRef.current;
    return held === undefined ? undefined : { token: held.value };
  }, []);

  const switchTenant = useCallback(
    (tenantId: string) => {
      void loadCandidates().then((items) => {
        const next = items.find((item) => item.tenant_id === tenantId && item.status === 'Active');
        return next === undefined ? undefined : selectTenant(next);
      });
    },
    [loadCandidates, selectTenant],
  );

  // The browser leaves for the provider, so the promise of the second factor never resolves on this page.
  const requestStepUp = useCallback(() => signIn({ acrValues: 'aal2' }).then(() => new Promise<void>(() => undefined)), [signIn]);

  const value = useMemo<SessionValue>(
    () => ({
      tenant,
      tenants,
      user,
      access: ALL_MODULES_VISIBLE,
      switchTenant,
      getSession,
      requestStepUp,
      status,
      identity,
      tenantToken,
      mode,
      signIn,
      signOut: forgetEverything,
      completeSignIn,
      loadCandidates,
      selectTenant,
    }),
    [tenant, tenants, user, switchTenant, getSession, requestStepUp, status, identity, tenantToken, mode, signIn, forgetEverything, completeSignIn, loadCandidates, selectTenant],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
