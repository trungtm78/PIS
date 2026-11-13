import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { SectionCard } from '../../../ui';
import { PERMISSIONS, holds } from '../model';
import { usePreference } from './hooks';
import { PreferencePanel } from './PreferencePanel';
import './preference.css';

export interface DeadlinePreferenceCardProps {
  /** Where the full screen PWF-15 is, when the card is not on the phone: the card then links to the preview and to the tasks of the person. */
  fullLink?: string;
}

/**
 * The personal reminders in a card (BR-PWF-23): the levels at which the deadlines of the person's tasks turn green, yellow and red for them, each beside the official one, and the reminder days.
 * The settings of the phone and the notification preferences of the web hold it; the full screen is PWF-15. A person who may not set reminders of their own sees nothing here.
 */
export function DeadlinePreferenceCard({ fullLink }: DeadlinePreferenceCardProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = holds(permissions, PERMISSIONS.preferenceOwn);
  const preference = usePreference(allowed);
  const refused = preference.error instanceof ApiError && preference.error.status === 403;
  if (!allowed || refused) return null;
  return (
    <SectionCard title={t('pwf.pref.card.title')}>
      {preference.isLoading ? (
        <div role="status" aria-busy="true" aria-label={t('states.loading.label')} data-testid="card-loading">
          <span className="ui-skeleton ui-skeleton--line" />
          <span className="ui-skeleton ui-skeleton--line" />
        </div>
      ) : preference.data === undefined ? (
        <p role="alert" data-testid="card-failed">
          {t('pwf.pref.card.failed')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={() => void preference.refetch()}>
            {t('states.retry.action')}
          </button>
        </p>
      ) : (
        <PreferencePanel view={preference.data} compact {...(fullLink === undefined ? {} : { fullLink })} />
      )}
    </SectionCard>
  );
}
