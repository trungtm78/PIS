import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSignInAttempt } from '../../../session/oidc/useSignInAttempt';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { safeNext } from '../tenant-chooser/candidate-model';
import { AuthFrame } from './AuthFrame';
import { useOnline } from './hooks';
import { pathOf, withNext } from './model';

const HOME = 'HOME-01';
const SIGN_IN = 'IAM-01';

/**
 * IAM-03: recovering access (ST-IAM-002, FR-IAM-03). A forgotten password is reset on the identity provider's own page, which answers the same whether the e-mail address is known or not (BR-IAM-12); this page says so
 * and leads there. A lost second factor is reset by a tenant administrator after verifying the person, with an audit entry: this page never offers to do that itself, and it never asks for or repeats an address.
 */
export default function RecoveryScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { signIn } = useSession();
  const attempt = useSignInAttempt();
  const online = useOnline();
  const [params] = useSearchParams();
  const home = pathOf(HOME);
  const next = safeNext(params.get('next'), home);
  const state = !online ? 'offline' : signIn === undefined || attempt.failed ? 'error' : 'default';
  return (
    <AuthFrame route={route} title={t('iam.recovery.page.title')} subtitle={t('iam.recovery.page.subtitle')} footer={t('iam.recovery.footer', { id: route.id, req: route.req ?? '' })}>
      <StateBoundary state={state} onRetry={attempt.failed ? () => attempt.start({ returnTo: next }) : undefined}>
        <div className="card">
          <p className="callout" role="note" data-testid="recovery-neutral">
            {t('iam.recovery.neutral.note')}
          </p>
          <dl>
            <dt>{t('iam.recovery.email.label')}</dt>
            <dd>{t('iam.recovery.email.note')}</dd>
            <dt>{t('iam.recovery.code.label')}</dt>
            <dd>{t('iam.recovery.code.note')}</dd>
            <dt>{t('iam.recovery.channel.label')}</dt>
            <dd>{t('iam.recovery.channel.note')}</dd>
          </dl>
          <p>{t('iam.recovery.mfa.note')}</p>
          <div className="formfooter">
            <Link to={withNext(pathOf(SIGN_IN), next, home)}>{t('iam.recovery.back.link')}</Link>
            <button type="button" className="primary" onClick={() => attempt.start({ returnTo: next })}>
              {t('iam.recovery.start.action')}
            </button>
          </div>
        </div>
      </StateBoundary>
    </AuthFrame>
  );
}
