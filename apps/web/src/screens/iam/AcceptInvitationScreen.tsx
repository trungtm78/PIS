import { ApiError, newCommandAttempt } from '@machvon/api-client';
import type { CommandAttempt } from '@machvon/api-client';
import { useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useApiClient } from '../../api/ApiClientContext';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import { useSession } from '../../session/SessionContext';
import { useSignInAttempt } from '../../session/oidc/useSignInAttempt';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The contract asks for a token of at least 32 characters; a shorter one is a broken link, said before anything is sent. */
export const TOKEN_MIN = 32;
const CHOOSER = 'IAM-04';

type Phase = 'ready' | 'sending' | 'done' | 'failed';

/** The words of a refusal: the three codes the operation names, a missing invitation, a lapsed session, and anything else. */
export function refusalOf(error: unknown): 'expired' | 'email' | 'quota' | 'missing' | 'session' | 'other' {
  if (!(error instanceof ApiError)) return 'other';
  if (error.code === 'INVITATION_EXPIRED') return 'expired';
  if (error.code === 'INVITATION_EMAIL_MISMATCH') return 'email';
  if (error.code === 'QUOTA_EXCEEDED') return 'quota';
  if (error.status === 404 || error.code === 'RESOURCE_NOT_FOUND') return 'missing';
  if (error.status === 401 || error.code === 'SESSION_EXPIRED') return 'session';
  return 'other';
}

/**
 * The page an invited person opens from the email (IAM 3.3): outside the shell, because the person has no tenant yet. The link carries the invitation and its one-time token (valid 7 days). The person signs in first
 * with the identity provider, then accepts on purpose with one click; the server checks that the signed-in email is the invited one. The intention keeps one idempotency key, so a second click or a retry after a lost
 * answer does not accept twice. On success the token leaves the address and the person goes on to choose the tenant.
 */
export default function AcceptInvitationScreen() {
  const { t } = useTranslation();
  const { invitationId = '' } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const session = useSession();
  const client = useApiClient();
  const signIn = useSignInAttempt();
  const [phase, setPhase] = useState<Phase>('ready');
  const [failure, setFailure] = useState<ReturnType<typeof refusalOf>>('other');
  const attempt = useRef<CommandAttempt | undefined>(undefined);
  const token = search.get('token') ?? '';
  const sound = UUID.test(invitationId) && token.length >= TOKEN_MIN;
  const needsSignIn = session.status === 'signedOut' && session.signIn !== undefined;
  const chooser = routeById(CHOOSER)?.path ?? '/';

  const accept = async (): Promise<void> => {
    if (phase === 'sending') return;
    setPhase('sending');
    attempt.current ??= newCommandAttempt();
    try {
      if (session.acceptInvitation !== undefined) await session.acceptInvitation(invitationId, token);
      else await client.command('acceptInvitation', { path: { invitationId }, body: { token }, attempt: attempt.current });
      attempt.current = undefined;
      setPhase('done');
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) attempt.current = undefined;
      setFailure(refusalOf(error));
      setPhase('failed');
    }
  };

  const message = (): string => {
    switch (failure) {
      case 'expired':
        return t('misc.invite.error.expired');
      case 'email':
        return t('misc.invite.error.email');
      case 'quota':
        return t('misc.invite.error.quota');
      case 'missing':
        return t('misc.invite.error.missing');
      case 'session':
        return t('misc.invite.error.session');
      default:
        return t('misc.invite.error.other');
    }
  };

  return (
    <main className="card statecard" data-screen-id="IAM-INVITE" aria-labelledby="invite-title">
      <h1 id="invite-title">{t('misc.invite.title')}</h1>
      {!sound && (
        <p role="alert" data-testid="invite-invalid">
          {t('misc.invite.invalid')}
        </p>
      )}
      {sound && phase !== 'done' && (
        <>
          <p>{t('misc.invite.body')}</p>
          {needsSignIn ? (
            <>
              <p className="muted">{t('misc.invite.signIn.hint')}</p>
              {signIn.failed && (
                <p role="alert" data-testid="invite-signin-failed">
                  {t('session.oidc.unavailable.body')}
                </p>
              )}
              <button type="button" className="primary" data-testid="invite-signin" onClick={() => signIn.start({ returnTo: `${location.pathname}${location.search}` })}>
                {t('misc.invite.signIn.action')}
              </button>
            </>
          ) : (
            <button type="button" className="primary" disabled={phase === 'sending'} aria-busy={phase === 'sending'} data-testid="invite-accept" onClick={() => void accept()}>
              {phase === 'sending' ? t('misc.invite.accepting') : t('misc.invite.accept')}
            </button>
          )}
          {phase === 'failed' && (
            <p role="alert" data-testid="invite-error" data-failure={failure}>
              {message()}
            </p>
          )}
        </>
      )}
      {phase === 'done' && (
        <div role="status" data-testid="invite-done">
          <p>{t('misc.invite.done')}</p>
          <Link className="primary" to={chooser} replace data-testid="invite-next">
            {t('misc.invite.next')}
          </Link>
        </div>
      )}
    </main>
  );
}
