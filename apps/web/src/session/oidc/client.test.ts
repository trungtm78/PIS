import { describe, expect, it, vi } from 'vitest';
import { OidcError, buildAuthorizationRequest, buildEndSessionUrl, checkNonce, createLoginStore, discover, exchangeCode, parseCallback, refreshIdentity } from './client';
import type { OidcConfig, OidcEndpoints } from './client';

const CONFIG: OidcConfig = { issuer: 'https://idp.example/realms/machvon', clientId: 'machvon-web', redirectUri: 'https://app.example/auth/callback' };
const ENDPOINTS: OidcEndpoints = {
  authorization_endpoint: 'https://idp.example/realms/machvon/auth',
  token_endpoint: 'https://idp.example/realms/machvon/token',
};

function jwtWithNonce(nonce: unknown): string {
  const part = (value: unknown): string => btoa(JSON.stringify(value)).replace(/=+$/, '');
  return `${part({ alg: 'RS256' })}.${part({ nonce, sub: 'u1' })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('discover', () => {
  it('reads the endpoints from the discovery document of the issuer', async () => {
    const fetcher = vi.fn(() => Promise.resolve(jsonResponse({ ...ENDPOINTS, issuer: CONFIG.issuer, end_session_endpoint: 'https://idp.example/logout' })));
    expect(await discover(CONFIG.issuer, fetcher)).toEqual({ ...ENDPOINTS, end_session_endpoint: 'https://idp.example/logout' });
    expect(fetcher).toHaveBeenCalledWith(`${CONFIG.issuer}/.well-known/openid-configuration`);
  });

  it.each([
    ['a failing provider', () => jsonResponse({}, 503)],
    ['a document without the token endpoint', () => jsonResponse({ authorization_endpoint: ENDPOINTS.authorization_endpoint })],
    ['a document that is not an object', () => jsonResponse([])],
  ])('fails with discovery_failed for %s', async (_label, answer) => {
    await expect(discover(CONFIG.issuer, () => Promise.resolve(answer()))).rejects.toMatchObject({ code: 'discovery_failed' });
  });
});

describe('buildAuthorizationRequest', () => {
  it('names the language of the pages of the provider and asks for a new sign-in only when told to', async () => {
    const plain = new URL((await buildAuthorizationRequest(CONFIG, ENDPOINTS)).url);
    expect(plain.searchParams.has('ui_locales')).toBe(false);
    expect(plain.searchParams.has('prompt')).toBe(false);
    const fresh = new URL((await buildAuthorizationRequest({ ...CONFIG, uiLocales: 'vi', prompt: 'login' }, ENDPOINTS)).url);
    expect(fresh.searchParams.get('ui_locales')).toBe('vi');
    expect(fresh.searchParams.get('prompt')).toBe('login');
  });


  it('asks for the authorization code with PKCE S256, the state and the nonce', async () => {
    const request = await buildAuthorizationRequest(CONFIG, ENDPOINTS);
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe(ENDPOINTS.authorization_endpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('machvon-web');
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toHaveLength(43);
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
    expect(request.verifier).toHaveLength(43);
    expect(request.state).not.toBe(request.nonce);
  });

  it('adds a login hint and the wanted authentication level when asked and never puts the verifier in the address', async () => {
    const request = await buildAuthorizationRequest({ ...CONFIG, loginHint: 'owner', acrValues: 'aal2' }, ENDPOINTS);
    expect(new URL(request.url).searchParams.get('login_hint')).toBe('owner');
    expect(new URL(request.url).searchParams.get('acr_values')).toBe('aal2');
    expect(request.url).not.toContain(request.verifier);
  });
});

describe('parseCallback', () => {
  it('reads the code and the state', () => {
    expect(parseCallback('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
  });

  it.each([
    ['an error answer of the provider', '?error=access_denied&state=xyz'],
    ['no code', '?state=xyz'],
    ['no state', '?code=abc'],
    ['an empty code', '?code=&state=xyz'],
    ['nothing', ''],
  ])('refuses %s', (_label, search) => {
    expect(parseCallback(search)).toEqual({ error: expect.any(String) });
  });

  it('never repeats the text the provider sent in the error', () => {
    expect(JSON.stringify(parseCallback('?error=access_denied&error_description=secret%20detail&state=x'))).not.toContain('secret');
  });
});

describe('checkNonce', () => {
  it('accepts an identity token whose nonce matches and refuses every other', () => {
    expect(checkNonce(jwtWithNonce('n1'), 'n1')).toBe(true);
    expect(checkNonce(jwtWithNonce('n2'), 'n1')).toBe(false);
    expect(checkNonce(jwtWithNonce(undefined), 'n1')).toBe(false);
    expect(checkNonce('not-a-token', 'n1')).toBe(false);
  });
});

describe('exchangeCode', () => {
  it('posts the code with the verifier as a form and returns the identity token', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(jsonResponse({ id_token: 'id.tok.en', refresh_token: 'r1', expires_in: 300, token_type: 'Bearer' })));
    const tokens = await exchangeCode(CONFIG, ENDPOINTS, 'the-code', 'the-verifier', fetcher);
    expect(tokens).toEqual({ idToken: 'id.tok.en', refreshToken: 'r1', expiresIn: 300 });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(ENDPOINTS.token_endpoint);
    expect(init?.method).toBe('POST');
    const form = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'authorization_code', code: 'the-code', redirect_uri: CONFIG.redirectUri, client_id: 'machvon-web', code_verifier: 'the-verifier' });
  });

  it.each([
    ['a refusal of the provider', () => jsonResponse({ error: 'invalid_grant' }, 400)],
    ['an answer without an identity token', () => jsonResponse({ access_token: 'x' })],
    ['an identity token that is not a string', () => jsonResponse({ id_token: 7 })],
  ])('fails with token_exchange_failed for %s and does not repeat what the provider said', async (_label, answer) => {
    const failure = await exchangeCode(CONFIG, ENDPOINTS, 'c', 'v', () => Promise.resolve(answer())).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OidcError);
    expect(failure).toMatchObject({ code: 'token_exchange_failed' });
    expect(String((failure as Error).message)).not.toContain('invalid_grant');
  });

  it('fails with token_exchange_failed when the network fails', async () => {
    await expect(exchangeCode(CONFIG, ENDPOINTS, 'c', 'v', () => Promise.reject(new TypeError('offline')))).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });
});

describe('refreshIdentity', () => {
  it('posts the refresh token and returns the new identity token', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() => Promise.resolve(jsonResponse({ id_token: 'new.id.token', refresh_token: 'r2', expires_in: 300 })));
    expect(await refreshIdentity(CONFIG, ENDPOINTS, 'r1', fetcher)).toEqual({ idToken: 'new.id.token', refreshToken: 'r2', expiresIn: 300 });
    expect(Object.fromEntries(new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'machvon-web' });
  });

  it('fails with token_exchange_failed when the provider refuses', async () => {
    await expect(refreshIdentity(CONFIG, ENDPOINTS, 'r1', () => Promise.resolve(jsonResponse({}, 400)))).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });
});

describe('createLoginStore', () => {
  const pending = { state: 's', nonce: 'n', verifier: 'v', returnTo: '/adm/adm-01' };

  function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => void data.delete(key),
      setItem: (key, value) => void data.set(key, value),
    };
  }

  it('hands a pending login over exactly once (a replayed callback finds nothing)', () => {
    const store = createLoginStore(memoryStorage());
    store.save(pending);
    expect(store.take()).toEqual(pending);
    expect(store.take()).toBeUndefined();
  });

  it('returns undefined for a stored value that is not a pending login', () => {
    const storage = memoryStorage();
    storage.setItem('mv.oidc.pending', '{"state":1}');
    expect(createLoginStore(storage).take()).toBeUndefined();
    storage.setItem('mv.oidc.pending', 'not json');
    expect(createLoginStore(storage).take()).toBeUndefined();
  });

  it('works without storage: saving fails with login_state_unavailable and taking returns undefined', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const store = createLoginStore(broken);
    expect(() => store.save(pending)).toThrow(expect.objectContaining({ code: 'login_state_unavailable' }) as Error);
    expect(store.take()).toBeUndefined();
  });
});

describe('buildEndSessionUrl', () => {
  it('sends the browser to the end-session endpoint of the provider with the client, the identity token and the way back', () => {
    const url = new URL(buildEndSessionUrl({ ...CONFIG, uiLocales: 'vi' }, { ...ENDPOINTS, end_session_endpoint: 'https://idp.example/realms/machvon/protocol/openid-connect/logout' }, { idToken: 'id.token.value', returnTo: 'https://app.example/' }) ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://idp.example/realms/machvon/protocol/openid-connect/logout');
    expect(url.searchParams.get('client_id')).toBe('machvon-web');
    expect(url.searchParams.get('id_token_hint')).toBe('id.token.value');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example/');
    expect(url.searchParams.get('ui_locales')).toBe('vi');
  });

  it('gives nothing for a provider that announces no end-session endpoint, and leaves the token out when there is none', () => {
    expect(buildEndSessionUrl(CONFIG, ENDPOINTS, { returnTo: 'https://app.example/' })).toBeUndefined();
    const url = new URL(buildEndSessionUrl(CONFIG, { ...ENDPOINTS, end_session_endpoint: 'https://idp.example/logout' }, { returnTo: 'https://app.example/' }) ?? '');
    expect(url.searchParams.has('id_token_hint')).toBe(false);
  });
});
