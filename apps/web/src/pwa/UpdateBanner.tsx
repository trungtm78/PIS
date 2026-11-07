import { useTranslation } from '../i18n';
import { pwaStore, usePwaState } from './pwa-state';
import './screens/pwa.css';

/**
 * A new version of the application is installed and waiting. It is offered, never applied: the reload that takes it loses what is typed, so it is the
 * person's to choose. Shown on every screen, at the bottom, until the update is taken.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const { updateReady } = usePwaState();
  if (!updateReady) return null;
  return (
    <div className="pwa-update" role="status" data-testid="pwa-update">
      <p>{t('pwa.update.banner.text')}</p>
      <button type="button" className="ui-button ui-button--primary pwa-touch" data-action="apply-update" onClick={() => pwaStore.applyUpdate()}>
        {t('pwa.update.banner.action')}
      </button>
    </div>
  );
}
