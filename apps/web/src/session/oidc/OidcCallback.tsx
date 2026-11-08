import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import { useSession } from '../SessionContext';
import { OidcError } from './client';
import { useSignInAttempt } from './useSignInAttempt';

const CHOOSER = 'IAM-04';
/** The one address that may be reached before a tenant is chosen: the accept page of an invitation, whose invitee may have no membership yet. Exactly this shape of same-origin relative path, nothing else. */
const INVITATION_RETURN = /^\/invitations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/accept(\?[A-Za-z0-9_=&%.~-]*)?$/i;

/**
 * The address the identity provider sends the browser back to: it finishes the sign-in with the query of the address
 * (once, even if the component mounts twice) and continues at the tenant chooser, which then continues at the screen
 * the person came for (a sign-in started at the chooser itself returns to it unchanged). A refusal shows a fixed message; nothing the provider or the address said is repeated.
 */
export function OidcCallback() {
  const { t } = useTranslation();
  const { completeSignIn, signIn } = useSession();
  const retry = useSignInAttempt();
  const location = useLocation();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failure, setFailure] = useState<OidcError | undefined>(undefined);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (completeSignIn === undefined) {
      setFailure(new OidcError('callback_invalid'));
      return;
    }
    completeSignIn(location.search).then(
      ({ returnTo }) => {
        const chooser = routeById(CHOOSER)?.path ?? '/';
        // A second-factor sign-in that started at the chooser returns to it as it was, with its own `next`.
        const atChooser = returnTo === chooser || returnTo.startsWith(`${chooser}?`);
        // An invitee may hold no membership, and the chooser only goes on after a membership is selected: the accept page is reached directly.
        if (INVITATION_RETURN.test(returnTo)) navigate(returnTo, { replace: true });
        else navigate(atChooser ? returnTo : `${chooser}?next=${encodeURIComponent(returnTo)}`, { replace: true });
      },
      (error: unknown) => setFailure(error instanceof OidcError ? error : new OidcError('callback_invalid')),
    );
  }, [completeSignIn, location.search, navigate]);

  if (failure === undefined) {
    return (
      <div className="card" role="status" aria-busy="true" aria-label={t('session.oidc.callback.loading.label')}>
        <div className="skeleton" />
      </div>
    );
  }
  const unreachable = retry.failed || failure.code === 'discovery_failed' || failure.code === 'token_exchange_failed';
  return (
    <div className="card statecard" role="alert">
      <div className="stateicon" aria-hidden="true">
        !
      </div>
      <h1>{unreachable ? t('session.oidc.unavailable.title') : t('session.oidc.callback.error.title')}</h1>
      <p className="muted">{unreachable ? t('session.oidc.unavailable.body') : t('session.oidc.callback.error.body')}</p>
      {signIn === undefined ? null : (
        <button type="button" className="primary" onClick={() => retry.start({ returnTo: '/' })}>
          {t('session.oidc.callback.retry.action')}
        </button>
      )}
    </div>
  );
}
