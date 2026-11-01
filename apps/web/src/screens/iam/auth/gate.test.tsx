import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { renderApp } from '../../../test/render';

const word = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const SCREENS = {
  'IAM-01': () => import('./SignInScreen'),
  'IAM-02': () => import('./MfaScreen'),
  'IAM-03': () => import('./RecoveryScreen'),
  'HOME-01': () => Promise.resolve({ default: () => <p>home</p> }),
  'IAM-04': () => Promise.resolve({ default: () => <p>chooser</p> }),
};
const signedOut = { status: 'signedOut' as const, tenant: undefined, signIn: vi.fn(() => Promise.resolve()) };

afterEach(() => cleanup());

describe('the sign-in screens in the application (ST-IAM-002)', () => {
  it('open for somebody who is not signed in, where every other screen shows the way in', async () => {
    renderApp('/iam/iam-01', { tenants: [], session: signedOut, screens: SCREENS });
    expect(await screen.findByLabelText(word('iam.signin.account.label'))).toBeTruthy();
    cleanup();
    renderApp('/iam/iam-03', { tenants: [], session: signedOut, screens: SCREENS });
    expect(await screen.findByRole('button', { name: word('iam.recovery.start.action') })).toBeTruthy();
    cleanup();
    renderApp('/home/home-01', { tenants: [], session: signedOut, screens: SCREENS });
    expect(await screen.findByRole('button', { name: word('session.oidc.signIn.action') })).toBeTruthy();
    expect(screen.queryByText('home')).toBeNull();
  });

  it('open for somebody who is known but has not chosen a tenant, without sending them to the chooser', async () => {
    renderApp('/iam/iam-02', { tenants: [], session: { status: 'identified', tenant: undefined, identity: { subject: 's', displayName: 'An' }, requestStepUp: vi.fn() }, screens: SCREENS });
    expect(await screen.findByRole('button', { name: word('iam.mfa.verify.action') })).toBeTruthy();
    expect(screen.queryByText('chooser')).toBeNull();
  });
});
