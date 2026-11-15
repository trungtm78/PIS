import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useSignInAttempt } from './useSignInAttempt';

/** The query mark the error page of the provider adds to its way back. */
export const FRESH_SIGN_IN = 'signin';

/** The address without the mark, so that the person lands where they were going and a reload does not start again. */
export function withoutFreshMark(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(FRESH_SIGN_IN);
  const rest = params.toString();
  return `${pathname}${rest === '' ? '' : `?${rest}`}`;
}

/** What a signed-out visitor sees instead of a screen: the standard card of the lapsed session, with the way back in. */
export function SignInGate() {
  const { t } = useTranslation();
  const attempt = useSignInAttempt();
  const location = useLocation();
  // The error page of the provider sends a person back with `?signin=fresh` (a session of the provider that no longer works, for example of an account that was removed):
  // the sign-in then starts at once and asks the provider for a new sign-in, whatever its cookies say. Started once, and the mark is not carried on.
  const fresh = new URLSearchParams(location.search).get(FRESH_SIGN_IN) === 'fresh';
  const started = useRef(false);
  const start = attempt.start;
  useEffect(() => {
    if (!fresh || started.current) return;
    started.current = true;
    start({ returnTo: withoutFreshMark(location.pathname, location.search), prompt: 'login' });
  }, [fresh, start, location.pathname, location.search]);
  return (
    <div className="card statecard" role="alert">
      <div className="stateicon" aria-hidden="true">
        {attempt.failed ? '!' : '◷'}
      </div>
      <h1>{attempt.failed ? t('session.oidc.unavailable.title') : t('states.signedOut.title')}</h1>
      <p className="muted">{attempt.failed ? t('session.oidc.unavailable.body') : t('states.signedOut.body')}</p>
      <button type="button" className="primary" onClick={() => attempt.start({ returnTo: withoutFreshMark(location.pathname, location.search) })}>
        {t('session.oidc.signIn.action')}
      </button>
    </div>
  );
}
