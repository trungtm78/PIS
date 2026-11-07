import { useTranslation } from '../../i18n';
import './alerts.css';

/** The place of a form whose policy is still being read: a skeleton, never a form with made-up lists. */
export function PolicyLoading() {
  const { t } = useTranslation();
  return (
    <div className="mv-alert-skeleton" role="status" aria-busy="true" aria-label={t('alerts.dialog.policyLoading')} data-testid="policy-loading">
      <span className="mv-alert-skeleton__row" />
      <span className="mv-alert-skeleton__row" />
    </div>
  );
}

/** The policy could not be read: the error says so and the retry is in place. */
export function PolicyFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mv-alert-banner" data-tone="danger" role="alert" data-testid="policy-error">
      <span>{t('alerts.dialog.policyFailed')}</span>{' '}
      <button type="button" className="mv-alert-link" onClick={onRetry}>
        {t('alerts.error.retry')}
      </button>
    </div>
  );
}
