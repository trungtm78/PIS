import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { useSession } from '../SessionContext';
import type { SessionValue, TenantCandidate } from '../SessionContext';
import { createLoginStore, OidcError } from './client';
import type { LoginStore, OidcEndpoints, PendingLogin } from './client';
import OidcSessionProvider from './OidcSessionProvider';

const CONFIG = { issuer: 'https://idp.test/realms/m', clientId: 'machvon-web', redirectUri: 'https://app.test/auth/callback' };
const ENDPOINTS: OidcEndpoints = { authorization_endpoint: 'https://idp.test/auth', token_endpoint: 'https://idp.test/token' };
const API = 'https://api.test';
const TENANT_A: TenantCandidate = { tenant_id: 'ta', tenant_name: 'Cao Bằng', tenant_status: 'Active', membership_id: 'ma', membership_type: 'STAFF', status: 'Active', valid_from: '2026-01-01T00:00:00.000Z', valid_until: null };
const TENANT_B: TenantCandidate = { ...TENANT_A, tenant_id: 'tb', tenant_name: 'Lào Cai', membership_id: 'mb' };
const TENANT_S: TenantCandidate = { ...TENANT_A, tenant_id: 'ts', tenant_name: 'Hà Giang', tenant_status: 'Suspended', membership_id: 'ms' };

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${part({ alg: 'ES256' })}.${part(claims)}.sig`;
}

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  dump(): string {
    return JSON.stringify([...this.data.entries()]);
  }
}

interface ApiCall {
  method: string;
  path: string;
  authorization: string | null;
  key: string | null;
  host?: string | null;
  body: unknown;
}

describe('OidcSessionProvider', () => {
  let storage: MemoryStorage;
  let loginStore: LoginStore;
  let calls: ApiCall[];
  let session: SessionValue;
  let mounts: number;
  let redirected: string[];
  let nowMs: number;
  let tokenCounter: number;
  let selectBehaviour: (call: ApiCall) => Response | Promise<Response>;
  let tokenEndpoint: (form: Record<string, string>) => Response;

  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

  function Probe() {
    const value = useSession();
    useEffect(() => {
      mounts += 1;
    }, []);
    session = value;
    return null;
  }

  function mount(overrides: { random?: () => Uint8Array } = {}): void {
    const apiFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const call: ApiCall = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        authorization: headers.get('authorization'),
        key: headers.get('idempotency-key'),
        host: headers.get('x-tenant-host'),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      if (call.method === 'GET') return Promise.resolve(json({ items: [TENANT_A, TENANT_B, TENANT_S] }));
      return Promise.resolve(selectBehaviour(call));
    }) as typeof fetch;
    const tokenFetch = ((_url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(tokenEndpoint(Object.fromEntries(new URLSearchParams(String(init?.body)))))) as typeof fetch;
    render(
      <OidcSessionProvider config={CONFIG} endpoints={ENDPOINTS} apiBaseUrl={API} loginStore={loginStore} redirect={(url) => redirected.push(url)} apiFetch={apiFetch} tokenFetch={tokenFetch} now={() => nowMs} random={overrides.random}>
        <Probe />
      </OidcSessionProvider>,
    );
  }

  const pending: PendingLogin = { state: 'state-1', nonce: 'nonce-1', verifier: 'verifier-1', returnTo: '/adm/adm-01' };

  async function signedIn(): Promise<void> {
    loginStore.save(pending);
    await act(async () => {
      await session.completeSignIn?.('?code=c1&state=state-1');
    });
  }

  const select = (candidate: TenantCandidate) =>
    act(async () => {
      await session.selectTenant?.(candidate);
    });

  beforeEach(() => {
    storage = new MemoryStorage();
    loginStore = createLoginStore(storage);
    calls = [];
    mounts = 0;
    redirected = [];
    nowMs = 1_800_000_000_000;
    tokenCounter = 0;
    tokenEndpoint = () => json({ id_token: jwt({ sub: 'u1', name: 'Nguyễn An', nonce: 'nonce-1', exp: nowMs / 1000 + 600 }), expires_in: 600 });
    selectBehaviour = (call) => {
      tokenCounter += 1;
      const body = call.body as { tenant_id: string; membership_id: string };
      const mode = body.tenant_id === 'ts' ? 'READ_ONLY' : 'FULL';
      return json({ tenant_id: body.tenant_id, membership_id: body.membership_id, scope_version: 1, assurance_level: 'aal2', expires_at: new Date(nowMs + 300_000).toISOString(), access_token: jwt({ tid: body.tenant_id, exp: nowMs / 1000 + 300, n: tokenCounter }), token_type: 'Bearer', expires_in: 300, mode });
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts signed out, and signIn stores the pending login and leaves for the provider with state, nonce and PKCE', async () => {
    mount();
    expect(session.status).toBe('signedOut');
    expect(session.tenant).toBeUndefined();
    await act(async () => {
      await session.signIn?.({ returnTo: '/adm/adm-01' });
    });
    const url = new URL(redirected[0] ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(ENDPOINTS.authorization_endpoint);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const saved = loginStore.take();
    expect(saved).toMatchObject({ state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce'), returnTo: '/adm/adm-01' });
    expect(url.toString()).not.toContain(saved?.verifier ?? 'x');
  });

  it('completes the sign-in: the identity is known, no token is stored in the browser, and the address to continue at is returned', async () => {
    mount();
    loginStore.save(pending);
    let result: { returnTo: string } | undefined;
    await act(async () => {
      result = await session.completeSignIn?.('?code=c1&state=state-1');
    });
    expect(result).toEqual({ returnTo: '/adm/adm-01' });
    expect(session.status).toBe('identified');
    expect(session.identity).toEqual({ subject: 'u1', displayName: 'Nguyễn An' });
    expect(session.user).toMatchObject({ displayName: 'Nguyễn An', initials: 'NA' });
    expect(session.tenant).toBeUndefined();
    expect(storage.dump()).not.toContain('eyJ');
  });

  it.each([
    ['a wrong state', '?code=c1&state=other', 'state_mismatch'],
    ['an answer without a code', '?state=state-1', 'callback_invalid'],
    ['a refusal of the provider', '?error=access_denied&state=state-1', 'callback_invalid'],
  ])('refuses %s and stores no token', async (_label, search, code) => {
    mount();
    loginStore.save(pending);
    const failure = await act(async () => session.completeSignIn?.(search).catch((error: unknown) => error));
    expect(failure).toBeInstanceOf(OidcError);
    expect(failure).toMatchObject({ code });
    expect(session.status).toBe('signedOut');
    expect(session.identity).toBeUndefined();
  });

  it('refuses a replayed callback: the pending login is consumed by the first use', async () => {
    mount();
    await signedIn();
    const second = await act(async () => session.completeSignIn?.('?code=c1&state=state-1').catch((error: unknown) => error));
    expect(second).toMatchObject({ code: 'callback_invalid' });
  });

  it('refuses an identity token whose nonce is not the one of this sign-in', async () => {
    tokenEndpoint = () => json({ id_token: jwt({ sub: 'u1', nonce: 'someone-elses', exp: nowMs / 1000 + 600 }), expires_in: 600 });
    mount();
    loginStore.save(pending);
    const failure = await act(async () => session.completeSignIn?.('?code=c1&state=state-1').catch((error: unknown) => error));
    expect(failure).toMatchObject({ code: 'nonce_mismatch' });
    expect(session.status).toBe('signedOut');
  });

  it('loads the memberships with the identity token as the bearer', async () => {
    mount();
    await signedIn();
    const items = await act(async () => session.loadCandidates?.());
    expect(items).toHaveLength(3);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/me/session/tenant-selection/candidates' });
    expect(calls[0]?.authorization).toMatch(/^Bearer eyJ/);
  });

  it('states the host the page was opened on with the memberships and with the selection, so a verified domain can choose the tenant (ST-SAS-017)', async () => {
    mount();
    await signedIn();
    await act(async () => session.loadCandidates?.());
    await select(TENANT_A);
    const sent = calls.filter((call) => call.path.startsWith('/me/session/tenant-selection'));
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const call of sent) expect(call.host).toBe(window.location.hostname);
  });

  it('selects a tenant: the tenant token becomes the bearer of every later request, and the mode is kept', async () => {
    mount();
    await signedIn();
    await select(TENANT_A);
    expect(session.status).toBe('active');
    expect(session.tenant).toMatchObject({ id: 'ta', name: 'Cao Bằng', membershipId: 'ma', monogram: 'CB' });
    expect(session.mode).toBe('FULL');
    expect(session.tenantToken?.expiresAt).toBe(nowMs + 300_000);
    const bearer = (await session.getSession())?.token;
    expect(bearer).toBeDefined();
    expect(calls.at(-1)?.key).toMatch(/.{16,}/);
    expect(calls.at(-1)?.authorization).toMatch(/^Bearer eyJ/);
    expect(calls.at(-1)?.authorization).not.toBe(`Bearer ${bearer ?? ''}`);
  });

  it('shows READ_ONLY for a suspended tenant', async () => {
    mount();
    await signedIn();
    await select(TENANT_S);
    expect(session.mode).toBe('READ_ONLY');
  });

  it('drops the old tenant token after a switch: the next request carries the new one', async () => {
    mount();
    await signedIn();
    await select(TENANT_A);
    const first = (await session.getSession())?.token;
    await select(TENANT_B);
    const second = (await session.getSession())?.token;
    expect(second).not.toBe(first);
    expect(session.tenant?.id).toBe('tb');
  });

  it('sends one request for a double click and keeps one idempotency key for a retry after a lost answer', async () => {
    let release: (response: Response) => void = () => undefined;
    selectBehaviour = () => new Promise<Response>((resolve) => (release = resolve));
    mount();
    await signedIn();
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await act(async () => {
      first = session.selectTenant?.(TENANT_A);
      second = session.selectTenant?.(TENANT_A);
      await Promise.resolve();
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await act(async () => {
      release(json({ code: 'INTERNAL_ERROR', status: 500, title: 't', type: 'x', correlation_id: 'c' }, 500));
      await Promise.allSettled([first, second]);
    });
    selectBehaviour = () => {
      tokenCounter += 1;
      return json({ tenant_id: 'ta', membership_id: 'ma', scope_version: 1, access_token: jwt({ exp: nowMs / 1000 + 300 }), token_type: 'Bearer', expires_in: 300, mode: 'FULL', assurance_level: 'aal2', expires_at: new Date(nowMs + 300_000).toISOString() });
    };
    await select(TENANT_A);
    const keys = calls.filter((call) => call.method === 'POST').map((call) => call.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('uses a new idempotency key after a final refusal such as MFA_REQUIRED', async () => {
    selectBehaviour = () => json({ type: 'urn:machvon:error:MFA_REQUIRED', title: 't', status: 403, code: 'MFA_REQUIRED', correlation_id: 'c' }, 403);
    mount();
    await signedIn();
    await act(async () => {
      await session.selectTenant?.(TENANT_A).catch(() => undefined);
    });
    await act(async () => {
      await session.selectTenant?.(TENANT_A).catch(() => undefined);
    });
    const keys = calls.filter((call) => call.method === 'POST').map((call) => call.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('renews the tenant token one minute before it expires without remounting the tree', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount();
    await signedIn();
    await select(TENANT_A);
    const mountsBefore = mounts;
    const firstToken = (await session.getSession())?.token;
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    nowMs += 240_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect((await session.getSession())?.token).not.toBe(firstToken);
    expect(session.tenantToken?.expiresAt).toBe(nowMs + 300_000);
    expect(mounts).toBe(mountsBefore);
    expect(session.tenant?.id).toBe('ta');
  });

  it('renews with a new idempotency key, so the server answers with the facts of today and not the replay of the first selection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount();
    await signedIn();
    await select(TENANT_A);
    nowMs += 240_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    const keys = calls.filter((call) => call.method === 'POST').map((call) => call.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('keeps the key of one renewal for its own retry after a lost answer, and uses a new one at the next renewal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tokenEndpoint = () => json({ id_token: jwt({ sub: 'u1', name: 'Nguyễn An', nonce: 'nonce-1', exp: nowMs / 1000 + 3600 }), expires_in: 3600 });
    mount();
    await signedIn();
    await select(TENANT_A);
    const good = selectBehaviour;
    selectBehaviour = () => json({ type: 'x', title: 't', status: 500, code: 'INTERNAL_ERROR', correlation_id: 'c' }, 500);
    nowMs += 240_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    selectBehaviour = good;
    nowMs += 90_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    const keys = calls.filter((call) => call.method === 'POST').map((call) => call.key);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(session.status).toBe('active');
    nowMs += 240_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    const later = calls.filter((call) => call.method === 'POST').map((call) => call.key);
    expect(later).toHaveLength(4);
    expect(later[3]).not.toBe(keys[2]);
  });

  it('ignores a renewal of tenant A that is still running when the person chooses tenant B, and renews B only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount();
    await signedIn();
    await select(TENANT_A);
    const answer = selectBehaviour;
    let release: (response: Response) => void = () => undefined;
    selectBehaviour = () => new Promise<Response>((resolve) => (release = resolve));
    nowMs += 240_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    const staleRelease = release;
    selectBehaviour = answer;
    await select(TENANT_B);
    expect(session.tenant?.id).toBe('tb');
    await act(async () => {
      staleRelease(answer({ method: 'POST', path: '/x', authorization: null, key: null, body: { tenant_id: 'ta', membership_id: 'ma' } }) as Response);
      await Promise.resolve();
    });
    expect(session.tenant?.id).toBe('tb');
    nowMs += 240_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    const bodies = calls.filter((call) => call.method === 'POST').map((call) => (call.body as { tenant_id: string }).tenant_id);
    expect(bodies.slice(2)).toEqual(['tb', 'tb']);
    expect(session.tenant?.id).toBe('tb');
  });

  it('ignores the answer of a first selection that the person replaced by another tenant in the meantime', async () => {
    mount();
    await signedIn();
    const answer = selectBehaviour;
    let release: (response: Response) => void = () => undefined;
    selectBehaviour = () => new Promise<Response>((resolve) => (release = resolve));
    let first: Promise<void> | undefined;
    await act(async () => {
      first = session.selectTenant?.(TENANT_A);
      await Promise.resolve();
    });
    const slow = release;
    selectBehaviour = answer;
    await select(TENANT_B);
    await act(async () => {
      slow(answer({ method: 'POST', path: '/x', authorization: null, key: null, body: { tenant_id: 'ta', membership_id: 'ma' } }) as Response);
      await first;
    });
    expect(session.tenant?.id).toBe('tb');
  });

  it('signs out when a renewal is refused for good: no token is left to send', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount();
    await signedIn();
    await select(TENANT_A);
    selectBehaviour = () => json({ type: 'urn:machvon:error:SESSION_EXPIRED', title: 't', status: 401, code: 'SESSION_EXPIRED', correlation_id: 'c' }, 401);
    nowMs += 240_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240_000);
    });
    expect(session.status).toBe('signedOut');
    expect(await session.getSession()).toBeUndefined();
    expect(session.tenant).toBeUndefined();
  });

  it('signOut forgets the identity and the tenant token', async () => {
    mount();
    await signedIn();
    await select(TENANT_A);
    act(() => session.signOut?.());
    expect(session.status).toBe('signedOut');
    expect(session.identity).toBeUndefined();
    expect(session.tenant).toBeUndefined();
    expect(await session.getSession()).toBeUndefined();
  });

  it('refuses to select a tenant before any sign-in', async () => {
    mount();
    const failure = await act(async () => session.selectTenant?.(TENANT_A).catch((error: unknown) => error));
    expect(failure).toBeInstanceOf(OidcError);
    expect(calls).toHaveLength(0);
  });

  it('asks the provider again with the wanted authentication level when a second factor is needed', async () => {
    mount();
    await signedIn();
    let settled = false;
    await act(async () => {
      void session.requestStepUp?.().then(() => {
        settled = true;
      });
    });
    await waitFor(() => expect(redirected.length).toBeGreaterThan(0));
    expect(settled).toBe(false);
    const url = new URL(redirected.at(-1) ?? 'https://x.test/');
    expect(url.searchParams.get('acr_values')).toBe('aal2');
  });

  describe('accepting an invitation under the identity alone', () => {
    const INVITATION = '00000000-0000-4000-8000-0000000000c1';
    const TOKEN = 'a'.repeat(40);

    it('sends the one-time token with the identity token of the person, before any tenant is chosen', async () => {
      mount();
      await signedIn();
      selectBehaviour = () => json({ status: 'ACTIVE' });
      await act(async () => {
        await session.acceptInvitation?.(INVITATION, TOKEN);
      });
      const call = calls.find((each) => each.path === `/memberships/invitations/${INVITATION}/accept`);
      expect(call).toMatchObject({ method: 'POST', body: { token: TOKEN } });
      expect(call?.key).toBeTruthy();
      expect(call?.authorization).toMatch(/^Bearer /);
      expect(session.tenant).toBeUndefined();
    });

    it('keeps the idempotency key of a lost answer for the retry and takes a new one after a final refusal', async () => {
      mount();
      await signedIn();
      let answers = 0;
      selectBehaviour = () => (answers++ === 0 ? json({ code: 'DEPENDENCY_UNAVAILABLE' }, 503) : answers === 2 ? json({ code: 'INVITATION_EXPIRED' }, 409) : json({ status: 'ACTIVE' }));
      const accept = () => act(async () => session.acceptInvitation?.(INVITATION, TOKEN).catch(() => undefined));
      await accept();
      await accept();
      await accept();
      const keys = calls.filter((each) => each.method === 'POST').map((each) => each.key);
      expect(keys).toHaveLength(3);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[1]);
    });
  });
});
