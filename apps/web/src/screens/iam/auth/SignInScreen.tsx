import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSignInAttempt } from '../../../session/oidc/useSignInAttempt';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { Field } from '../../mne/components';
import { safeNext } from '../tenant-chooser/candidate-model';
import { AuthFrame } from './AuthFrame';
import { useNow, useOnline } from './hooks';
import { ACCOUNT_MAX_LENGTH, accountProblem, clock, countdownOf, hintOf, lockedUntil, pathOf, reasonOf, withNext } from './model';

const HOME = 'HOME-01';
const RECOVERY = 'IAM-03';

/**
 * IAM-01: the way in (ST-IAM-002, FR-IAM-01). The password is never typed here: the button sends the browser to the identity provider (OIDC Authorization Code + PKCE), and the account typed here only tells the provider whom to
 * expect. A failure says the same thing whatever went wrong, and an account that waits after five wrong passwords shows that neutral message with a countdown, never why. A lapsed session says so above the button.
 */
export default function SignInScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const session = useSession();
  const attempt = useSignInAttempt();
  const location = useLocation();
  const [params] = useSearchParams();
  const online = useOnline();
  const [account, setAccount] = useState('');
  const [starting, setStarting] = useState(false);
  const home = pathOf(HOME);
  const next = safeNext(params.get('next'), home);
  const reason = reasonOf(location.search);
  // The wait is capped once, from the moment the screen first read the address: worked out again at each tick, a deadline further away than the cap would move forward with the clock.
  const waitEnd = useMemo(() => (reason === 'locked' ? lockedUntil(location.search, Date.now()) : undefined), [reason, location.search]);
  const now = useNow(waitEnd !== undefined);
  const waiting = waitEnd !== undefined && waitEnd > now;
  const problem = accountProblem(account);
  const signedIn = session.status === 'identified' || session.status === 'active' || session.tenant !== undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (problem !== undefined) return;
    setStarting(true);
    const loginHint = hintOf(account);
    attempt.start({ returnTo: next, ...(loginHint === undefined ? {} : { loginHint }) });
  };

  const state = !online ? 'offline' : session.signIn === undefined && !signedIn ? 'error' : attempt.failed ? 'error' : starting ? 'loading' : 'default';
  // A lock whose time is unknown or over still gets the neutral message of any failure, never a reason.
  const shown = reason === 'locked' ? 'failed' : reason;
  return (
    <AuthFrame route={route} title={t('iam.signin.page.title')} subtitle={t('iam.signin.page.subtitle')} footer={t('iam.signin.footer', { id: route.id, req: route.req ?? '' })}>
      <StateBoundary state={state} onRetry={attempt.failed ? () => attempt.start({ returnTo: next }) : undefined}>
        {signedIn ? (
          <div className="card" data-testid="signin-already">
            <p>{t('iam.signin.already.body', { name: session.identity?.displayName ?? session.user?.displayName ?? '' })}</p>
            <div className="formfooter">
              {session.signOut === undefined ? null : (
                <button type="button" onClick={() => session.signOut?.()}>
                  {t('iam.signin.signOut.action')}
                </button>
              )}
              <Link className="primary" to={next}>
                {t('iam.signin.continue.action')}
              </Link>
            </div>
          </div>
        ) : waiting ? (
          <div className="card statecard" role="alert" data-testid="signin-locked">
            <div className="stateicon" aria-hidden="true">
              ◷
            </div>
            <h2>{t('iam.signin.failure.title')}</h2>
            <p className="muted">{t('iam.signin.failure.body')}</p>
            <p>
              {t('iam.signin.locked.text')} <strong data-testid="signin-countdown">{clock(countdownOf(waitEnd, now))}</strong>
            </p>
          </div>
        ) : (
          <form className="card" onSubmit={submit} aria-describedby="signin-password-note" noValidate>
            {shown === 'expired' ? (
              <p className="callout warning" role="status" data-testid="signin-expired">
                {t('iam.signin.expired.notice')}
              </p>
            ) : null}
            {shown === 'failed' ? (
              <p className="callout warning" role="alert" data-testid="signin-failed">
                {t('iam.signin.failure.body')}
              </p>
            ) : null}
            <Field
              id="signin-account"
              label={t('iam.signin.account.label')}
              hint={t('iam.signin.account.hint')}
              error={problem === undefined ? undefined : problem === 'tooLong' ? t('iam.signin.account.tooLong') : t('iam.signin.account.invalid')}
            >
              <input
                id="signin-account"
                type="text"
                autoComplete="username"
                maxLength={ACCOUNT_MAX_LENGTH + 1}
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                aria-invalid={problem !== undefined}
              />
            </Field>
            <dl>
              <dt>{t('iam.signin.provider.label')}</dt>
              <dd>{t('iam.signin.provider.value')}</dd>
              <dt>{t('iam.signin.password.label')}</dt>
              <dd id="signin-password-note">{t('iam.signin.password.note')}</dd>
            </dl>
            <div className="formfooter">
              <Link to={withNext(pathOf(RECOVERY), next, home)}>{t('iam.signin.recovery.link')}</Link>
              <button type="submit" className="primary" disabled={problem !== undefined}>
                {t('iam.signin.submit.action')}
              </button>
            </div>
          </form>
        )}
      </StateBoundary>
    </AuthFrame>
  );
}
