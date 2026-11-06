import { createHash, randomUUID } from 'node:crypto';
import { E2eIdentityProvider } from './oidc-idp';
import type { IdpUser } from './oidc-idp';

const USERS: IdpUser[] = [
  { key: 'owner', subject: 'sub-owner', name: 'Nguyễn An' },
  { key: 'auditor', subject: 'sub-auditor', name: 'Kiểm toán viên' },
];
const CLIENT = 'machvon-web';
const REDIRECT = 'http://127.0.0.1:5173/auth/callback';
const base64url = (buffer: Buffer): string => buffer.toString('base64url');

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('E2eIdentityProvider', () => {
  let idp: E2eIdentityProvider;

  beforeAll(async () => {
    idp = await E2eIdentityProvider.start({ users: USERS, clientId: CLIENT, port: 0 });
  });

  afterAll(async () => {
    await idp.stop();
  });

  const verifierAndChallenge = () => {
    const verifier = base64url(Buffer.from(randomUUID() + randomUUID()));
    return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
  };

  async function authorize(params: Record<string, string>): Promise<Response> {
    const url = new URL(`${idp.issuer}/protocol/openid-connect/auth`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, scope: 'openid', state: 'st-1', nonce: 'no-1', code_challenge_method: 'S256', ...params })) {
      url.searchParams.set(key, value);
    }
    return fetch(url, { redirect: 'manual' });
  }

  async function token(form: Record<string, string>): Promise<Response> {
    return fetch(`${idp.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  }

  async function login(hint = 'owner', extra: Record<string, string> = {}): Promise<{ code: string; verifier: string }> {
    const { verifier, challenge } = verifierAndChallenge();
    const response = await authorize({ login_hint: hint, code_challenge: challenge, ...extra });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe(extra.state ?? 'st-1');
    return { code: location.searchParams.get('code') ?? '', verifier };
  }

  const exchange = (code: string, verifier: string, over: Record<string, string> = {}) =>
    token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier, ...over });

  it('announces its endpoints and publishes its signing key', async () => {
    const discovery = (await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json()) as Record<string, string>;
    expect(discovery).toMatchObject({ issuer: idp.issuer, token_endpoint: `${idp.issuer}/protocol/openid-connect/token`, authorization_endpoint: `${idp.issuer}/protocol/openid-connect/auth` });
    const jwks = (await (await fetch(discovery.jwks_uri ?? '')).json()) as { keys: Array<{ kid: string }> };
    expect(jwks.keys).toHaveLength(1);
  });

  it('answers cross-origin requests, because the browser app lives on another origin', async () => {
    const response = await fetch(`${idp.issuer}/.well-known/openid-configuration`);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const preflight = await fetch(`${idp.issuer}/protocol/openid-connect/token`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('signs in the user named by login_hint and returns an identity token with the nonce and the audience of the client', async () => {
    const { code, verifier } = await login('auditor');
    const answer = (await (await exchange(code, verifier)).json()) as { id_token: string };
    const claims = claimsOf(answer.id_token);
    expect(claims).toMatchObject({ iss: idp.issuer, aud: CLIENT, sub: 'sub-auditor', name: 'Kiểm toán viên', nonce: 'no-1', acr: 'aal1' });
    expect(typeof claims.sid).toBe('string');
    expect(Number(claims.exp)).toBeGreaterThan(Date.now() / 1000);
  });

  it('defaults to the first user and issues acr aal2 only when asked for it', async () => {
    const first = await login(undefined as unknown as string, {});
    expect(claimsOf(((await (await exchange(first.code, first.verifier)).json()) as { id_token: string }).id_token).sub).toBe('sub-owner');
    const second = await login('owner', { acr_values: 'aal2' });
    const claims = claimsOf(((await (await exchange(second.code, second.verifier)).json()) as { id_token: string }).id_token);
    expect(claims).toMatchObject({ acr: 'aal2', amr: ['pwd', 'otp'] });
  });

  it('gives every sign-in its own session id', async () => {
    const a = await login();
    const b = await login();
    const sidA = claimsOf(((await (await exchange(a.code, a.verifier)).json()) as { id_token: string }).id_token).sid;
    const sidB = claimsOf(((await (await exchange(b.code, b.verifier)).json()) as { id_token: string }).id_token).sid;
    expect(sidA).not.toBe(sidB);
  });

  it('exchanges a code only once and only with the right verifier, client and redirect address', async () => {
    const wrongVerifier = await login();
    expect((await exchange(wrongVerifier.code, 'not-the-verifier-not-the-verifier-not-the-verifier')).status).toBe(400);
    expect((await exchange(wrongVerifier.code, wrongVerifier.verifier)).status).toBe(400); // the failed try burnt the code

    const wrongClient = await login();
    expect((await exchange(wrongClient.code, wrongClient.verifier, { client_id: 'someone-else' })).status).toBe(400);

    const wrongRedirect = await login();
    expect((await exchange(wrongRedirect.code, wrongRedirect.verifier, { redirect_uri: 'http://127.0.0.1:1/x' })).status).toBe(400);

    const once = await login();
    expect((await exchange(once.code, once.verifier)).status).toBe(200);
    expect((await exchange(once.code, once.verifier)).status).toBe(400);
  });

  it('refuses an authorization request that is not a code flow with PKCE S256 for its own client, or names an unknown user', async () => {
    expect((await authorize({ response_type: 'token', code_challenge: 'x' })).status).toBe(400);
    expect((await authorize({ client_id: 'someone-else', code_challenge: 'x' })).status).toBe(400);
    expect((await authorize({ code_challenge_method: 'plain', code_challenge: 'x' })).status).toBe(400);
    expect((await authorize({})).status).toBe(400);
    expect((await authorize({ login_hint: 'nobody', code_challenge: 'x' })).status).toBe(400);
  });

  it('renews a session with a refresh token that is rotated: same person and session id, a new token, the old one is dead', async () => {
    const { code, verifier } = await login('auditor', { acr_values: 'aal2' });
    const first = (await (await exchange(code, verifier)).json()) as { id_token: string; refresh_token: string };
    expect(first.refresh_token).toBeTruthy();

    const renewed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT });
    expect(renewed.status).toBe(200);
    const second = (await renewed.json()) as { id_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const before = claimsOf(first.id_token);
    const after = claimsOf(second.id_token);
    expect([after.sub, after.sid, after.acr, after.aud, after.iss]).toEqual([before.sub, before.sid, 'aal2', CLIENT, idp.issuer]);
    expect(after.nonce).toBeUndefined();

    expect((await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: CLIENT })).status).toBe(400);
    // a refusal for the client burns the token too: a refresh token gets one try
    expect((await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: 'someone-else' })).status).toBe(400);
    expect((await token({ grant_type: 'refresh_token', refresh_token: second.refresh_token, client_id: CLIENT })).status).toBe(400);
  });

  it('refuses any grant type other than the authorization code and the refresh token', async () => {
    expect((await token({ grant_type: 'password', username: 'a', password: 'b' })).status).toBe(400);
  });
});
