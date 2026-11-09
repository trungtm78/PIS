import { useTranslation } from '../i18n';
import { HomeLink } from '../states/ScreenErrorBoundary';

/** The answer for a location that is not in the route table: the standard state card, inside the shell, with the way back. */
export function NotFound() {
  const { t } = useTranslation();
  return (
    <section role="alert" aria-labelledby="not-found-title" className="card statecard" data-state="not-found">
      <div className="stateicon" aria-hidden="true">
        ○
      </div>
      <h1 id="not-found-title">{t('shell.notFound.title')}</h1>
      <p className="muted">{t('shell.notFound.body')}</p>
      <p>
        <HomeLink className="ui-button ui-button--outline">{t('shell.notFound.home')}</HomeLink>
      </p>
    </section>
  );
}
