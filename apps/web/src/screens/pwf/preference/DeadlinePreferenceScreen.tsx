import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import { PERMISSIONS, holds } from '../model';
import { usePreference } from './hooks';
import { MyTasksSection } from './MyTasksSection';
import { PreferencePanel } from './PreferencePanel';
import './preference.css';

/** The full screen of the notification preferences, where the personal reminders are linked from (NOT-03). */
const NOTIFICATION_PREFERENCES_PATH = '/not/not-03';

/**
 * PWF-15, "My deadline reminders": the levels at which the deadlines of the person's tasks turn green, yellow and red for them (for example green from 5 days, yellow from 2, red below 1), each written beside the official level,
 * the reminder days, and what the numbers do at each number of days left, in words and glyphs. A level may only be the same as the official one or earlier (R40): the person is warned earlier, never later, and the official alerts,
 * the escalation and the KPI do not change. Under it, the tasks of the person with the real due date, the official colour and, when it differs, the colour of their own setting.
 */
export default function DeadlinePreferenceScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ScreenContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ScreenContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const mayEdit = holds(permissions, PERMISSIONS.preferenceOwn);
  const mayReadTasks = holds(permissions, PERMISSIONS.taskWork);
  const preference = usePreference(mayEdit);
  const state = useScreenState({ isLoading: preference.isLoading, error: preference.error, data: preference.data, isEmpty: () => false });
  const screenState = mayEdit ? state : 'denied';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwf.pref.title.text')}</h1>
          <p>{t('pwf.pref.subtitle.text')}</p>
        </div>
        <nav aria-label={t('pwf.pref.links.label')}>
          <Link to={NOTIFICATION_PREFERENCES_PATH} data-testid="link-notifications">
            {t('pwf.pref.notifications.link')}
          </Link>
        </nav>
      </div>
      <StateBoundary state={screenState} onRetry={() => void preference.refetch()}>
        <SectionCard title={t('pwf.pref.levels.title')}>{preference.data === undefined ? null : <PreferencePanel view={preference.data} compact={false} />}</SectionCard>
        {mayReadTasks ? <MyTasksSection /> : null}
      </StateBoundary>
      <p className="prototype-note" data-testid="footer">
        {t('pwf.pref.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}
