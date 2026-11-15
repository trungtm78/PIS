import { useTranslation } from '../../i18n';
import { VersionLabel } from '../../shell/NewVersionBar';
import { useSignInAttempt } from './useSignInAttempt';

export { SIGNED_OUT_PATH } from './signed-out-path';

/**
 * The page of a person who SIGNED OUT (not of a session that lapsed): it says so, offers the way back in, and shows nothing of the application (no menu, no name of an
 * organisation). The sign-in that follows asks the provider for the password again, because the provider ended its session too.
 */
export function SignedOutPage() {
  const { t } = useTranslation();
  const attempt = useSignInAttempt();
  return (
    <main className="signed-out-page">
      <div className="card statecard" role="status">
        <h1>{attempt.failed ? t('session.oidc.unavailable.title') : t('session.signedOut.title')}</h1>
        <p className="muted">{attempt.failed ? t('session.oidc.unavailable.body') : t('session.signedOut.body')}</p>
        <button type="button" className="primary" onClick={() => attempt.start({ returnTo: '/' })}>
          {t('session.oidc.signIn.action')}
        </button>
        <p>
          <VersionLabel />
        </p>
      </div>
    </main>
  );
}
