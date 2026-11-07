import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import './delivery/delivery.css';
import { useEventTypes } from './workflow/hooks';
import { classificationLabel, purposeLabel } from './workflow/labels';
import { PUBLISH_PERMISSION } from './workflow/model';
import { StatusPill } from '../../ui';

/**
 * NOT-05: the catalogue of the event types that may reach people (BR-NOT-15). The platform registers them, a tenant only reads them: the module that owns the type, the purposes a notification of the type may have
 * (BR-NOT-02), how its data is classified (it decides which channels may ever carry the content) and whether the type is still accepted. A workflow is written for an Active type on NOT-06.
 */
export default function EventCatalogueScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const canRead = permissions === undefined || permissions.includes(PUBLISH_PERMISSION);
  const types = useEventTypes(canRead);
  const queryState = useScreenState({ isLoading: types.isLoading, error: types.error, data: types.data });
  // Without the right nothing is requested and the screen is denied, not empty.
  const state = canRead ? queryState : 'denied';
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="not-queue">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('not.catalogue.page.title')}</h1>
          <p>{t('not.catalogue.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <p className="sub">{t('not.catalogue.rule.text')}</p>
        <StateBoundary state={state} onRetry={() => void types.refetch()}>
          <div className="tablewrap">
            <table data-event-types>
              <thead>
                <tr>
                  <th>{t('not.catalogue.col.eventType')}</th>
                  <th>{t('not.catalogue.col.module')}</th>
                  <th>{t('not.catalogue.col.purposes')}</th>
                  <th>{t('not.catalogue.col.classification')}</th>
                  <th>{t('not.catalogue.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {(types.data ?? []).map((entry) => (
                  <tr key={`${entry.eventType}@${entry.schemaVersion}`} data-event-type={entry.eventType} data-active={entry.active}>
                    <td>
                      <code>{entry.eventType}</code>
                    </td>
                    <td>{entry.owningModule}</td>
                    <td>{entry.allowedPurposes.map((purpose) => purposeLabel(t, purpose)).join(', ')}</td>
                    <td>
                      <StatusPill tone={entry.classification === 'PUBLIC' || entry.classification === 'INTERNAL' ? 'neutral' : 'warning'}>{classificationLabel(t, entry.classification)}</StatusPill>
                    </td>
                    <td>
                      <StatusPill tone={entry.active ? 'success' : 'neutral'}>{entry.active ? t('not.catalogue.status.active') : t('not.catalogue.status.deprecated')}</StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateBoundary>
      </div>
    </section>
  );
}
