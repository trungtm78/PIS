import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import '../dis/dis.css';
import { CATALOGUE_PATH, registrationsOf } from './bi-model';
import { useMetrics } from './hooks';

/**
 * BI-15: what the files of the repository brought into the registry (ST-BI-001, BI 3 F1): for each commit that did, how many metrics it added, how many revisions it made, how many of what it brought
 * are retired now and how many are in force. The registry keeps the commit and the hash of each definition; the log of the syncs themselves (the hash of the bundle, a refused sync and its error) has
 * no read in the contract yet, and the screen says so where those columns would be.
 */
export default function RegistrationScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <RegistrationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RegistrationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const metrics = useMetrics();
  const registrations = useMemo(() => registrationsOf(metrics.data ?? []), [metrics.data]);
  const state = useScreenState({ isLoading: metrics.isLoading, error: metrics.error, data: metrics.data === undefined ? undefined : registrations });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.registration.page.title')}</h1>
          <p>{t('bi.registration.page.subtitle')}</p>
        </div>
        <Link className="button" to={CATALOGUE_PATH}>
          {t('bi.registration.back')}
        </Link>
      </div>
      <StateBoundary state={state} onRetry={() => void metrics.refetch()}>
        <table className="table" data-testid="registration-table" aria-label={t('bi.registration.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.registration.column.commit')}</th>
              <th scope="col">{t('bi.registration.column.hash')}</th>
              <th scope="col">{t('bi.registration.column.added')}</th>
              <th scope="col">{t('bi.registration.column.revised')}</th>
              <th scope="col">{t('bi.registration.column.retired')}</th>
              <th scope="col">{t('bi.registration.column.inForce')}</th>
              <th scope="col">{t('bi.registration.column.status')}</th>
              <th scope="col">{t('bi.registration.column.error')}</th>
            </tr>
          </thead>
          <tbody>
            {registrations.map((entry) => (
              <tr key={entry.sourceCommit} data-commit={entry.sourceCommit}>
                <td>
                  <code>{entry.sourceCommit}</code>
                </td>
                <td className="sub">{t('bi.registration.noLog')}</td>
                <td>{entry.added}</td>
                <td>{entry.revised}</td>
                <td>{entry.retired}</td>
                <td>{entry.inForce}</td>
                <td>{t('bi.registration.status.applied')}</td>
                <td className="sub">{t('bi.registration.noLog')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </StateBoundary>
    </section>
  );
}
