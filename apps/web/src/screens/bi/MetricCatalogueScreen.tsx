import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { DEFINITION_PATH, MANAGE_PERMISSION, ORIGINS, REGISTRATION_PATH, metricFormula } from './bi-model';
import type { MetricOrigin } from './bi-model';
import { useMetrics } from './hooks';
import { aggregationLabel, originLabel, statusLabel } from './labels';

/**
 * BI-05: the catalogue of the metrics (ST-BI-001, BI 3 F1): every revision with its formula, its unit, who owns it, where it comes from (the files of the repository or the tenant) and the commit it came
 * from. A metric of the platform is read-only here: it changes by a change of the files, reviewed in the repository, and a sync.
 */
export default function MetricCatalogueScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // The filter belongs to one member of one tenant: a switch starts the screen over.
  return <CatalogueContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CatalogueContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayDraft = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const [origin, setOrigin] = useState<MetricOrigin | ''>('');
  const metrics = useMetrics();
  const rows = useMemo(() => (metrics.data ?? []).filter((metric) => origin === '' || metric.origin === origin), [metrics.data, origin]);
  const state = useScreenState({ isLoading: metrics.isLoading, error: metrics.error, data: metrics.data });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.catalogue.page.title')}</h1>
          <p>{t('bi.catalogue.page.subtitle')}</p>
        </div>
        <div className="mne-actions">
          <Link className="button" to={REGISTRATION_PATH}>
            {t('bi.catalogue.registration.link')}
          </Link>
          {mayDraft ? (
            <Link className="button" to={DEFINITION_PATH}>
              {t('bi.catalogue.create.link')}
            </Link>
          ) : null}
        </div>
      </div>
      <div className="card">
        <Field id="metric-origin" label={t('bi.catalogue.filter.origin')} error={undefined}>
          <select id="metric-origin" value={origin} onChange={(event) => setOrigin(event.target.value as MetricOrigin | '')}>
            <option value="">{t('bi.catalogue.filter.all')}</option>
            {ORIGINS.map((option) => (
              <option key={option} value={option}>
                {originLabel(t, option)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <StateBoundary state={state} onRetry={() => void metrics.refetch()}>
        <p className="sub" data-testid="metric-readonly-note">
          {t('bi.catalogue.platformNote')}
        </p>
        <table className="table" data-testid="metric-table" aria-label={t('bi.catalogue.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.catalogue.column.code')}</th>
              <th scope="col">{t('bi.catalogue.column.formula')}</th>
              <th scope="col">{t('bi.catalogue.column.unit')}</th>
              <th scope="col">{t('bi.catalogue.column.owner')}</th>
              <th scope="col">{t('bi.catalogue.column.origin')}</th>
              <th scope="col">{t('bi.catalogue.column.commit')}</th>
              <th scope="col">{t('bi.catalogue.column.glossary')}</th>
              <th scope="col">{t('bi.catalogue.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((metric) => (
              <tr key={metric.id} data-metric-id={metric.id} data-origin={metric.origin}>
                <td>
                  <Link to={`${DEFINITION_PATH}?id=${metric.id}`} aria-label={t('bi.catalogue.open.aria', { code: metric.code, revision: metric.revision })}>
                    {metric.code}
                  </Link>{' '}
                  <span className="sub">{t('bi.catalogue.revision', { revision: metric.revision })}</span>
                </td>
                <td>
                  <code>{metricFormula(metric)}</code> <span className="sub">{aggregationLabel(t, metric.aggregationType)}</span>
                </td>
                <td>{metric.unit}</td>
                <td>{metric.ownerId === '' ? t('bi.catalogue.none') : metric.ownerId.slice(0, 8)}</td>
                <td>{originLabel(t, metric.origin)}</td>
                <td>{metric.sourceCommit ?? t('bi.catalogue.none')}</td>
                <td>{metric.glossaryTermId === null ? t('bi.catalogue.none') : metric.glossaryTermId.slice(0, 8)}</td>
                <td>{statusLabel(t, metric.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p data-testid="metric-no-rows">{t('bi.catalogue.noRows')}</p> : null}
      </StateBoundary>
    </section>
  );
}
