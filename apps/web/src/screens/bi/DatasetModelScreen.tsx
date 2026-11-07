import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import '../dis/dis.css';
import { DGV_CATALOGUE_PATH, VERSIONS_PATH } from './dataset-model';
import { useDatasets } from './hooks';
import { badgeLabel, refreshLabel, sourceKindLabel } from './labels';
import './bi-kit.css';

/**
 * BI-07: the sources and the model of the data (ST-BI-002, BI 3 F2): each dataset of BI as a tree: where it comes from, the table it is at the grain of, the dimensions it offers, the joins that were approved for
 * it (nothing else is reachable through it, and no query is typed), when it is refreshed, its entry in the catalogue of DGV, and the version that serves now with its quality badge.
 */
export default function DatasetModelScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ModelContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ModelContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const datasets = useDatasets();
  const state = useScreenState({ isLoading: datasets.isLoading, error: datasets.error, data: datasets.data });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.model.page.title')}</h1>
          <p>{t('bi.model.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void datasets.refetch()}>
        <p className="sub" data-testid="model-rule">
          {t('bi.model.rule')}
        </p>
        {(datasets.data ?? []).map((dataset) => (
          <section key={dataset.id} className="card" aria-labelledby={`dataset-${dataset.id}`} data-dataset-id={dataset.id}>
            <h2 id={`dataset-${dataset.id}`}>
              {dataset.title} <span className="sub">({dataset.code})</span>
            </h2>
            <ul className="mne-lines">
              <li>
                {t('bi.model.source')}: {sourceKindLabel(t, dataset.sourceKind)}
              </li>
              <li>
                {t('bi.model.grain')}: {dataset.grain}
              </li>
              <li data-testid={`dimensions-${dataset.id}`}>
                {t('bi.model.dimensions')}: {dataset.dimensions.length === 0 ? t('bi.model.none') : dataset.dimensions.join(', ')}
              </li>
              <li>
                {t('bi.model.refresh')}: {refreshLabel(t, dataset.refreshPolicy)}
              </li>
              <li>
                {t('bi.model.catalogue')}:{' '}
                {dataset.dgvDatasetId === null ? (
                  t('bi.model.none')
                ) : (
                  <Link to={`${DGV_CATALOGUE_PATH}?dataset=${dataset.dgvDatasetId}`} aria-label={t('bi.model.catalogue.aria', { code: dataset.code })}>
                    {t('bi.model.catalogue.open')}
                  </Link>
                )}
              </li>
              <li data-testid={`latest-${dataset.id}`}>
                {t('bi.model.latest')}: {dataset.latest === null ? t('bi.model.noVersion') : `${dataset.latest.asOfPeriod} · ${badgeLabel(t, dataset.latest.badge)}`}
              </li>
            </ul>
            <h3>{t('bi.model.joins')}</h3>
            {dataset.joins.length === 0 ? (
              <p className="sub">{t('bi.model.noJoins')}</p>
            ) : (
              <ul className="mne-lines" data-testid={`joins-${dataset.id}`}>
                {dataset.joins.map((join) => (
                  <li key={`${join.from}>${join.to}`}>
                    <code>{join.from}</code> → <code>{join.to}</code>
                  </li>
                ))}
              </ul>
            )}
            <Link className="ui-button ui-button--outline" to={`${VERSIONS_PATH}?dataset=${dataset.id}`}>
              {t('bi.model.versions')}
            </Link>
          </section>
        ))}
      </StateBoundary>
    </section>
  );
}
