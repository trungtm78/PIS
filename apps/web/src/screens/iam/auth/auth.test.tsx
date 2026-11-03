import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import OidcSessionProvider from '../../../session/oidc/OidcSessionProvider';
import { useSession } from '../../../session/SessionContext';
import type { SessionValue } from '../../../session/SessionContext';
import MfaScreen from './MfaScreen';
import RecoveryScreen from './RecoveryScreen';
import SignInScreen from './SignInScreen';
import { useNow, useOnline } from './hooks';
import { TENANT, mountAuth, routeOf } from './test-support';

const word = (key: string, params: Record<string, string> = {}): string => ((vi_ as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '');
const SIGN_IN = routeOf('IAM-01', 'FR-IAM-01');
const MFA = routeOf('IAM-02', 'FR-IAM-02');
const RECOVERY = routeOf('IAM-03', 'FR-IAM-03');
const NEUTRAL = word('iam.signin.failure.body');
const setOnline = (value: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setOnline(true);
});

describe('AC-ST-IAM-002-3: UI-IAM-01 IAM-01: sign in (ST-IAM-002)', () => {
  it('labels every control, names the fields of the screen and never asks for the password', () => {
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn: vi.fn(() => Promise.resolve()) });
    expect(screen.getByRole('heading', { name: word('iam.signin.page.title') })).toBeTruthy();
    expect(screen.getByLabelText(word('iam.signin.account.label'))).toBeTruthy();
    expect(screen.getByText(word('iam.signin.password.label'))).toBeTruthy();
    expect(screen.getByText(word('iam.signin.provider.label'))).toBeTruthy();
    expect(screen.queryByLabelText(word('iam.signin.password.label'))).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getByRole('button', { name: word('iam.signin.submit.action') })).toBeTruthy();
    expect(screen.getByRole('link', { name: word('iam.signin.recovery.link') }).getAttribute('href')).toBe('/iam/iam-03');
    expect(screen.getByText(word('iam.signin.footer', { id: 'IAM-01', req: 'FR-IAM-01' }))).toBeTruthy();
  });

  it('sends the browser to the provider with the account as a hint and the screen it came for', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, '/iam/iam-01?next=/prj/prj-01');
    fireEvent.change(screen.getByLabelText(word('iam.signin.account.label')), { target: { value: ' an@pmu.gov.vn ' } });
    fireEvent.click(screen.getByRole('button', { name: word('iam.signin.submit.action') }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/prj/prj-01', loginHint: 'an@pmu.gov.vn' });
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it('sends no hint for an empty account and ignores a next address that leaves the site', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, '/iam/iam-01?next=//evil.example');
    fireEvent.click(screen.getByRole('button', { name: word('iam.signin.submit.action') }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/home/home-01' });
  });

  it('does not leave for the provider while the account is not usable', () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn });
    const input = screen.getByLabelText(word('iam.signin.account.label'));
    fireEvent.change(input, { target: { value: 'an van' } });
    expect(screen.getByRole('alert').textContent).toContain(word('iam.signin.account.invalid'));
    expect((screen.getByRole('button', { name: word('iam.signin.submit.action') }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(signIn).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'a'.repeat(300) } });
    expect(screen.getByRole('alert').textContent).toContain(word('iam.signin.account.tooLong'));
  });

  it('shows the error state when the provider cannot be reached and starts again on retry', async () => {
    const signIn = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn });
    fireEvent.click(screen.getByRole('button', { name: word('iam.signin.submit.action') }));
    await screen.findByText(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(2));
    expect(signIn).toHaveBeenLastCalledWith({ returnTo: '/home/home-01' });
  });

  it('shows the error state when the build has no identity provider and nobody is signed in', () => {
    mountAuth(<SignInScreen route={SIGN_IN} />);
    expect(screen.getByText(word('states.error.title'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: word('iam.signin.submit.action') })).toBeNull();
  });

  it('shows the offline state, and the form again when the browser is back online', () => {
    setOnline(false);
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn: vi.fn(() => Promise.resolve()) });
    expect(screen.getByText(word('states.offline.title'))).toBeTruthy();
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('button', { name: word('iam.signin.submit.action') })).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(word('states.offline.title'))).toBeTruthy();
  });

  it('tells a lapsed session above the button, and a failed sign-in with the one neutral message', () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, '/iam/iam-01?reason=expired');
    expect(screen.getByTestId('signin-expired').textContent).toBe(word('iam.signin.expired.notice'));
    cleanup();
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, '/iam/iam-01?reason=failed');
    expect(screen.getByTestId('signin-failed').textContent).toBe(NEUTRAL);
    cleanup();
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, '/iam/iam-01');
    expect(screen.queryByTestId('signin-expired')).toBeNull();
    expect(screen.queryByTestId('signin-failed')).toBeNull();
  });

  it('counts down to a fixed deadline when the wait asked for is longer than the cap, and lets the person in at that deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    const until = Math.floor(Date.now() / 1000) + 3 * 3600;
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn: vi.fn(() => Promise.resolve()) }, `/iam/iam-01?reason=locked&until=${until}`);
    expect(screen.getByTestId('signin-countdown').textContent).toBe('15:00');
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(screen.getByTestId('signin-countdown').textContent).toBe('05:00');
    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 1000);
    });
    expect(screen.queryByTestId('signin-locked')).toBeNull();
    expect(screen.getByRole('button', { name: word('iam.signin.submit.action') })).toBeTruthy();
  });

  it('AC-ST-IAM-002-1: shows the same neutral message with a countdown while the account waits, and the form once the wait is over (UAT-AC124)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    const until = Math.floor(Date.now() / 1000) + 90;
    const signIn = vi.fn(() => Promise.resolve());
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, `/iam/iam-01?reason=locked&until=${until}`);
    expect(screen.getByTestId('signin-locked').textContent).toContain(NEUTRAL);
    expect(screen.getByTestId('signin-countdown').textContent).toBe('01:30');
    expect(screen.queryByRole('button', { name: word('iam.signin.submit.action') })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByTestId('signin-countdown').textContent).toBe('01:00');
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.queryByTestId('signin-locked')).toBeNull();
    expect(screen.getByRole('button', { name: word('iam.signin.submit.action') })).toBeTruthy();
  });

  it('gives a lock whose end is unknown the neutral message of any failure, without a countdown', () => {
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn: vi.fn(() => Promise.resolve()) }, '/iam/iam-01?reason=locked');
    expect(screen.queryByTestId('signin-locked')).toBeNull();
    expect(screen.getByTestId('signin-failed').textContent).toBe(NEUTRAL);
  });

  it('offers to continue or sign out to somebody who is already signed in', () => {
    const signOut = vi.fn();
    mountAuth(
      <SignInScreen route={SIGN_IN} />,
      { status: 'active', identity: { subject: 's', displayName: 'Nguyễn An' }, signIn: vi.fn(() => Promise.resolve()), signOut },
      '/iam/iam-01?next=/prj/prj-01',
    );
    expect(screen.getByTestId('signin-already').textContent).toContain('Nguyễn An');
    expect(screen.getByRole('link', { name: word('iam.signin.continue.action') }).getAttribute('href')).toBe('/prj/prj-01');
    fireEvent.click(screen.getByRole('button', { name: word('iam.signin.signOut.action') }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('names a development session by its user and offers no sign-out it cannot do', () => {
    mountAuth(<SignInScreen route={SIGN_IN} />, { tenant: TENANT, user: { displayName: 'Clerk', initials: 'CK' } });
    expect(screen.getByTestId('signin-already').textContent).toContain('Clerk');
    expect(screen.queryByRole('button', { name: word('iam.signin.signOut.action') })).toBeNull();
  });

  it('names nobody when the session knows no name', () => {
    mountAuth(<SignInScreen route={SIGN_IN} />, { tenant: TENANT });
    expect(screen.getByTestId('signin-already').textContent).toBe(`${word('iam.signin.already.body', { name: '' })}${word('iam.signin.continue.action')}`);
  });
});

describe('AC-ST-IAM-002-3, AC-ST-IAM-002-4: IAM-02: the second factor (ST-IAM-002)', () => {
  const signedIn: Partial<SessionValue> = { status: 'identified', identity: { subject: 's', displayName: 'An' } };

  it('names the fields, is labelled and asks the provider for the step-up', async () => {
    const requestStepUp = vi.fn(() => new Promise<void>(() => undefined));
    mountAuth(<MfaScreen route={MFA} />, { ...signedIn, requestStepUp });
    expect(screen.getByText(word('iam.mfa.code.label'))).toBeTruthy();
    expect(screen.getByText(word('iam.mfa.method.label'))).toBeTruthy();
    expect(screen.getByText(word('iam.mfa.device.label'))).toBeTruthy();
    expect(document.querySelector('input')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: word('iam.mfa.verify.action') }));
    await waitFor(() => expect(requestStepUp).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status', { name: word('states.loading.label') })).toBeTruthy();
  });

  it('is one step-up however often the button is pressed while it is asked', async () => {
    let finish: () => void = () => undefined;
    const requestStepUp = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    mountAuth(<MfaScreen route={MFA} />, { ...signedIn, requestStepUp });
    const button = screen.getByRole('button', { name: word('iam.mfa.verify.action') });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(requestStepUp).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(screen.getByRole('button', { name: word('iam.mfa.verify.action') })).toBeTruthy();
  });

  it('shows the error state when the step-up fails and asks again on retry', async () => {
    const requestStepUp = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockImplementation(() => new Promise<void>(() => undefined));
    mountAuth(<MfaScreen route={MFA} />, { ...signedIn, requestStepUp });
    fireEvent.click(screen.getByRole('button', { name: word('iam.mfa.verify.action') }));
    await screen.findByText(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(requestStepUp).toHaveBeenCalledTimes(2));
  });

  it('leaves the state alone when the screen is gone before the step-up fails', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const requestStepUp = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const view = mountAuth(<MfaScreen route={MFA} />, { ...signedIn, requestStepUp });
    fireEvent.click(screen.getByRole('button', { name: word('iam.mfa.verify.action') }));
    view.unmount();
    await act(async () => {
      fail(new Error('late'));
    });
    expect(requestStepUp).toHaveBeenCalledTimes(1);
  });

  it('cannot ask when the session has no way to step up', () => {
    mountAuth(<MfaScreen route={MFA} />, signedIn);
    expect((screen.getByRole('button', { name: word('iam.mfa.verify.action') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the session is aal2, until when, and continues at the screen it came from', () => {
    const aal2At = new Date(Date.now() - 60_000);
    mountAuth(<MfaScreen route={MFA} />, { ...signedIn, assurance: { level: 'aal2', aal2At }, requestStepUp: vi.fn() }, '/iam/iam-02?next=/adm/adm-03');
    const verified = screen.getByTestId('mfa-verified');
    expect(verified.textContent).toContain(word('iam.mfa.verified.until', { time: new Date(aal2At.getTime() + 15 * 60_000).toLocaleTimeString('vi-VN') }));
    expect(screen.getByRole('link', { name: word('iam.mfa.continue.action') }).getAttribute('href')).toBe('/adm/adm-03');
  });

  it('says only that the session is aal2 when it does not know when', () => {
    mountAuth(<MfaScreen route={MFA} />, { ...signedIn, assurance: { level: 'aal2' } });
    expect(screen.getByTestId('mfa-verified').textContent).toContain(word('iam.mfa.verified.body'));
  });

  it('asks again by itself when the page stays open past the 15 minutes of the step-up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    const aal2At = new Date(Date.now() - 60_000);
    mountAuth(<MfaScreen route={MFA} />, { ...signedIn, assurance: { level: 'aal2', aal2At }, requestStepUp: vi.fn() });
    expect(screen.getByTestId('mfa-verified')).toBeTruthy();
    expect(screen.queryByRole('button', { name: word('iam.mfa.verify.action') })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(13 * 60_000);
    });
    expect(screen.getByTestId('mfa-verified')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(screen.queryByTestId('mfa-verified')).toBeNull();
    expect(screen.getByRole('button', { name: word('iam.mfa.verify.action') })).toBeTruthy();
  });

  it('asks again once the step-up of 15 minutes is over', () => {
    mountAuth(<MfaScreen route={MFA} />, { ...signedIn, assurance: { level: 'aal2', aal2At: new Date(Date.now() - 16 * 60_000) }, requestStepUp: vi.fn() });
    expect(screen.queryByTestId('mfa-verified')).toBeNull();
    expect(screen.getByRole('button', { name: word('iam.mfa.verify.action') })).toBeTruthy();
  });

  it('keeps the destination in the way back to the sign-in, and drops one that leads off the site', () => {
    mountAuth(<MfaScreen route={MFA} />, {}, '/iam/iam-02?next=/prj/prj-01');
    expect(screen.getByRole('link', { name: word('iam.mfa.signin.link') }).getAttribute('href')).toBe('/iam/iam-01?next=%2Fprj%2Fprj-01');
    cleanup();
    mountAuth(<MfaScreen route={MFA} />, {}, '/iam/iam-02?next=https://evil.example/x');
    expect(screen.getByRole('link', { name: word('iam.mfa.signin.link') }).getAttribute('href')).toBe('/iam/iam-01');
  });

  it('shows the signed-out state with the way to sign in when nobody is signed in', () => {
    mountAuth(<MfaScreen route={MFA} />);
    expect(screen.getByText(word('states.signedOut.title'))).toBeTruthy();
    expect(screen.getByRole('link', { name: word('iam.mfa.signin.link') }).getAttribute('href')).toBe('/iam/iam-01');
  });

  it('shows the offline state', () => {
    setOnline(false);
    mountAuth(<MfaScreen route={MFA} />, signedIn);
    expect(screen.getByText(word('states.offline.title'))).toBeTruthy();
  });

  it('accepts a development session that holds a tenant', () => {
    mountAuth(<MfaScreen route={MFA} />, { tenant: TENANT, requestStepUp: vi.fn() });
    expect(screen.getByRole('button', { name: word('iam.mfa.verify.action') })).toBeTruthy();
    expect(screen.queryByRole('link', { name: word('iam.mfa.signin.link') })).toBeNull();
  });
});

describe('the destination asked for, from the sign-in to the recovery and back', () => {
  it('carries the destination to the recovery, keeps it on the way back and returns to it after the recovery', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, '/iam/iam-01?next=/prj/prj-01');
    const toRecovery = screen.getByRole('link', { name: word('iam.signin.recovery.link') }).getAttribute('href') as string;
    expect(toRecovery).toBe('/iam/iam-03?next=%2Fprj%2Fprj-01');
    cleanup();
    mountAuth(<RecoveryScreen route={RECOVERY} />, { signIn }, toRecovery);
    const back = screen.getByRole('link', { name: word('iam.recovery.back.link') }).getAttribute('href') as string;
    expect(back).toBe('/iam/iam-01?next=%2Fprj%2Fprj-01');
    fireEvent.click(screen.getByRole('button', { name: word('iam.recovery.start.action') }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ returnTo: '/prj/prj-01' }));
    cleanup();
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn }, back);
    expect(screen.getByRole('link', { name: word('iam.signin.recovery.link') }).getAttribute('href')).toBe(toRecovery);
  });

  it('drops a destination that leads off the site, along the whole way', () => {
    mountAuth(<SignInScreen route={SIGN_IN} />, { signIn: vi.fn(() => Promise.resolve()) }, '/iam/iam-01?next=https://evil.example/x');
    expect(screen.getByRole('link', { name: word('iam.signin.recovery.link') }).getAttribute('href')).toBe('/iam/iam-03');
    cleanup();
    mountAuth(<RecoveryScreen route={RECOVERY} />, { signIn: vi.fn(() => Promise.resolve()) }, '/iam/iam-03?next=//evil.example/x');
    expect(screen.getByRole('link', { name: word('iam.recovery.back.link') }).getAttribute('href')).toBe('/iam/iam-01');
  });
});

describe('AC-ST-IAM-002-5: UI-IAM-03 IAM-03: recover access (ST-IAM-002)', () => {
  it('names the fields, says the answer is the same for every address, and asks for no address', () => {
    mountAuth(<RecoveryScreen route={RECOVERY} />, { signIn: vi.fn(() => Promise.resolve()) });
    expect(screen.getByText(word('iam.recovery.email.label'))).toBeTruthy();
    expect(screen.getByText(word('iam.recovery.code.label'))).toBeTruthy();
    expect(screen.getByText(word('iam.recovery.channel.label'))).toBeTruthy();
    expect(screen.getByTestId('recovery-neutral').textContent).toBe(word('iam.recovery.neutral.note'));
    expect(document.querySelector('input')).toBeNull();
    expect(screen.getByRole('link', { name: word('iam.recovery.back.link') }).getAttribute('href')).toBe('/iam/iam-01');
  });

  it('leads to the provider and comes back to the screen it was asked for', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountAuth(<RecoveryScreen route={RECOVERY} />, { signIn }, '/iam/iam-03?next=/prj/prj-01');
    fireEvent.click(screen.getByRole('button', { name: word('iam.recovery.start.action') }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ returnTo: '/prj/prj-01' }));
  });

  it('shows the error state when the provider cannot be reached, and tries again on retry', async () => {
    const signIn = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    mountAuth(<RecoveryScreen route={RECOVERY} />, { signIn });
    fireEvent.click(screen.getByRole('button', { name: word('iam.recovery.start.action') }));
    await screen.findByText(word('states.error.title'));
    fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(2));
  });

  it('shows the error state without an identity provider, and the offline state offline', () => {
    mountAuth(<RecoveryScreen route={RECOVERY} />);
    expect(screen.getByText(word('states.error.title'))).toBeTruthy();
    cleanup();
    setOnline(false);
    mountAuth(<RecoveryScreen route={RECOVERY} />, { signIn: vi.fn(() => Promise.resolve()) });
    expect(screen.getByText(word('states.offline.title'))).toBeTruthy();
  });
});

describe('the hooks of the sign-in screens', () => {
  it('follows the browser between online and offline, and stops listening when it is gone', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    function Probe() {
      return <span data-testid="online">{String(useOnline())}</span>;
    }
    const view = render(<Probe />);
    expect(screen.getByTestId('online').textContent).toBe('true');
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('online').textContent).toBe('false');
    view.unmount();
    expect(removed).toHaveBeenCalledWith('online', expect.any(Function));
    removed.mockRestore();
  });

  it('ticks every second while active and not at all otherwise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    function Probe({ active }: { active: boolean }) {
      return <span data-testid="now">{useNow(active)}</span>;
    }
    const view = render(<Probe active />);
    const first = Number(screen.getByTestId('now').textContent);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(Number(screen.getByTestId('now').textContent)).toBe(first + 3000);
    view.rerender(<Probe active={false} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(Number(screen.getByTestId('now').textContent)).toBe(first + 3000);
  });
});

describe('the login hint reaches the provider', () => {
  const endpoints = { authorization_endpoint: 'https://idp.example/auth', token_endpoint: 'https://idp.example/token' };
  const config = { issuer: 'https://idp.example', clientId: 'machvon-web', redirectUri: 'http://localhost/auth/callback' };

  function Starter({ hint }: { hint: string | undefined }) {
    const { signIn } = useSession();
    return (
      <button type="button" onClick={() => void signIn?.({ returnTo: '/', ...(hint === undefined ? {} : { loginHint: hint }) })}>
        start
      </button>
    );
  }

  it('adds login_hint to the authorization request when the person gave an account, and nothing otherwise', async () => {
    const redirect = vi.fn();
    const store = { save: vi.fn(), take: vi.fn() };
    const random = (): Uint8Array => new Uint8Array(32).fill(7);
    for (const hint of ['an@pmu.gov.vn', '', undefined]) {
      redirect.mockClear();
      const view = render(
        <OidcSessionProvider config={config} endpoints={endpoints} redirect={redirect} loginStore={store} random={random}>
          <Starter hint={hint} />
        </OidcSessionProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'start' }));
      await waitFor(() => expect(redirect).toHaveBeenCalledTimes(1));
      const url = new URL(redirect.mock.calls[0]?.[0] as string);
      expect(url.searchParams.get('login_hint')).toBe(hint === undefined || hint === '' ? null : hint);
      view.unmount();
    }
  });
});

describe('a route that names no requirement', () => {
  it('still shows the footer of each screen', () => {
    for (const [Screen, id] of [
      [SignInScreen, 'IAM-01'],
      [MfaScreen, 'IAM-02'],
      [RecoveryScreen, 'IAM-03'],
    ] as const) {
      mountAuth(<Screen route={{ ...routeOf(id, 'FR'), req: null }} />, { signIn: vi.fn(() => Promise.resolve()) });
      expect(document.querySelector('.prototype-note')?.textContent).toContain(id);
      cleanup();
    }
  });

  it('leaves the retry out of the error state of a build without an identity provider', () => {
    mountAuth(<RecoveryScreen route={RECOVERY} />);
    expect(screen.queryByRole('button', { name: word('states.retry.action') })).toBeNull();
  });
});
