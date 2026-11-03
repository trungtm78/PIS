import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { createLoginStore } from '../../../session/oidc/client';
import type { OidcEndpoints } from '../../../session/oidc/client';
import OidcSessionProvider from '../../../session/oidc/OidcSessionProvider';
import { useSession } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import MfaScreen from './MfaScreen';
import { routeOf } from './test-support';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const CONFIG = { issuer: 'https://idp.test/realms/m', clientId: 'machvon-web', redirectUri: 'https://app.test/auth/callback' };
const ENDPOINTS: OidcEndpoints = { authorization_endpoint: 'https://idp.test/auth', token_endpoint: 'https://idp.test/token' };
const MFA = routeOf('IAM-02', 'FR-IAM-02');

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${part({ alg: 'ES256' })}.${part(claims)}.sig`;
}

let session: SessionValue;
function Capture() {
  session = useSession();
  return null;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The screen under the real provider, the identity provider answering at the token endpoint with the claims the test gives. */
async function backFromTheProvider(claims: Record<string, unknown>): Promise<string[]> {
  const redirected: string[] = [];
  const store = createLoginStore(window.sessionStorage);
  const idToken = jwt({ sub: 'u1', name: 'Nguyễn An', nonce: 'nonce-1', exp: nowSeconds() + 600, ...claims });
  const tokenFetch = (() => Promise.resolve(new Response(JSON.stringify({ id_token: idToken, expires_in: 600 }), { status: 200, headers: { 'content-type': 'application/json' } }))) as typeof fetch;
  render(
    <OidcSessionProvider config={CONFIG} endpoints={ENDPOINTS} loginStore={store} redirect={(url) => redirected.push(url)} tokenFetch={tokenFetch}>
      <MemoryRouter initialEntries={['/iam/iam-02?next=/prj/prj-01']}>
        <Capture />
        <MfaScreen route={MFA} />
      </MemoryRouter>
    </OidcSessionProvider>,
  );
  store.save({ state: 'state-1', nonce: 'nonce-1', verifier: 'verifier-1', returnTo: '/iam/iam-02' });
  await act(async () => {
    await session.completeSignIn?.('?code=c1&state=state-1');
  });
  return redirected;
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe('AC-ST-IAM-002-4: UAT-PLAN-44 IAM-02 under the real sign-in (the ID token of the provider carries the assurance)', () => {
  it('offers Continue, not another verification, when the provider returned the person with an aal2 acr', async () => {
    await backFromTheProvider({ acr: 'aal2', auth_time: nowSeconds() - 30 });
    expect(session.assurance?.level).toBe('aal2');
    expect(await screen.findByTestId('mfa-verified')).toBeTruthy();
    expect(screen.getByRole('link', { name: word('iam.mfa.continue.action') }).getAttribute('href')).toBe('/prj/prj-01');
    expect(screen.queryByRole('button', { name: word('iam.mfa.verify.action') })).toBeNull();
  });

  it('counts two kinds of factor in amr as the second factor', async () => {
    await backFromTheProvider({ amr: ['pwd', 'otp'], auth_time: nowSeconds() - 30 });
    expect(await screen.findByTestId('mfa-verified')).toBeTruthy();
  });

  it.each([
    ['no acr or amr', {}],
    ['an aal1 acr', { acr: 'aal1', auth_time: 1 }],
    ['an aal2 acr and no time of authentication', { acr: 'aal2' }],
    ['an aal2 acr from more than fifteen minutes ago', { acr: 'aal2', auth_time: nowSeconds() - 20 * 60 }],
  ])('offers the verification, which asks the provider for aal2, when the token carries %s', async (_name, claims) => {
    const redirected = await backFromTheProvider(claims);
    expect(screen.queryByTestId('mfa-verified')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: word('iam.mfa.verify.action') }));
    await waitFor(() => expect(redirected).toHaveLength(1));
    expect(new URL(redirected[0] as string).searchParams.get('acr_values')).toBe('aal2');
  });

  it('forgets the assurance with the sign-out', async () => {
    await backFromTheProvider({ acr: 'aal2', auth_time: nowSeconds() - 30 });
    act(() => session.signOut?.());
    expect(session.assurance).toBeUndefined();
  });
});
