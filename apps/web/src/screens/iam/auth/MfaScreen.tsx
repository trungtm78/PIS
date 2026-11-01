import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { safeNext } from '../tenant-chooser/candidate-model';
import { AuthFrame } from './AuthFrame';
import { useNow, useOnline } from './hooks';
import { pathOf, stepUpHolds, stepUpUntil, withNext } from './model';

const HOME = 'HOME-01';
const SIGN_IN = 'IAM-01';

/**
 * IAM-02: the second factor (ST-IAM-002, FR-IAM-02). The code, the authenticator or the security key is asked for by the identity provider: this page sends the browser there with `acr_values=aal2` (the step-up of the session)
 * and shows whether the session is aal2 now and until when that counts. Nothing about the factor is typed or kept here.
 */
export default function MfaScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const session = useSession();
  const online = useOnline();
  const [params] = useSearchParams();
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const home = pathOf(HOME);
  const next = safeNext(params.get('next'), home);
  const known = session.status === 'identified' || session.status === 'active' || session.tenant !== undefined;
  const until = stepUpUntil(session.assurance);
  // The clock runs while a step-up counts, so that the screen asks again by itself when the 15 minutes are over, whatever else it is doing.
  const now = useNow(until !== undefined);
  const verified = stepUpHolds(session.assurance, now);

  const verify = async (): Promise<void> => {
    if (asking) return;
    setAsking(true);
    setFailed(false);
    try {
      // With a real sign-in this leaves for the provider and never resolves here; the development session resolves at once.
      await session.requestStepUp?.();
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setAsking(false);
    }
  };

  const state = !online ? 'offline' : !known ? 'signedOut' : failed ? 'error' : asking ? 'loading' : 'default';
  return (
    <AuthFrame route={route} title={t('iam.mfa.page.title')} subtitle={t('iam.mfa.page.subtitle')} footer={t('iam.mfa.footer', { id: route.id, req: route.req ?? '' })}>
      <StateBoundary state={state} onRetry={failed ? () => void verify() : undefined}>
        {verified ? (
          <div className="card" role="status" data-testid="mfa-verified">
            <h2>{t('iam.mfa.verified.title')}</h2>
            <p>{until === undefined ? t('iam.mfa.verified.body') : t('iam.mfa.verified.until', { time: until.toLocaleTimeString('vi-VN') })}</p>
            <div className="formfooter">
              <span />
              <Link className="primary" to={next}>
                {t('iam.mfa.continue.action')}
              </Link>
            </div>
          </div>
        ) : (
          <div className="card">
            <dl>
              <dt>{t('iam.mfa.code.label')}</dt>
              <dd>{t('iam.mfa.code.note')}</dd>
              <dt>{t('iam.mfa.method.label')}</dt>
              <dd>{t('iam.mfa.method.note')}</dd>
              <dt>{t('iam.mfa.device.label')}</dt>
              <dd>{t('iam.mfa.device.note')}</dd>
            </dl>
            <p className="callout" role="note">
              {t('iam.mfa.policy.note')}
            </p>
            <div className="formfooter">
              <span />
              <button type="button" className="primary" disabled={session.requestStepUp === undefined} onClick={() => void verify()}>
                {t('iam.mfa.verify.action')}
              </button>
            </div>
          </div>
        )}
      </StateBoundary>
      {known ? null : (
        <p>
          <Link to={withNext(pathOf(SIGN_IN), next, home)}>{t('iam.mfa.signin.link')}</Link>
        </p>
      )}
    </AuthFrame>
  );
}
