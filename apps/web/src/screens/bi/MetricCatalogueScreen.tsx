import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { DEFINITION_PATH, MANAGE_PERMISSION, ORIGINS, REGISTRATION_PATH, metricFormula } from './bi-model';
import type { Metric, MetricOrigin } from './bi-model';
import { useMetrics } from './hooks';
import { aggregationLabel, originLabel, statusLabel } from './labels';
import { metricStatusTone } from './tones';
import './bi.css';
import './bi-kit.css';

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
  const { permissions, mode, tenant } = useSession();
  const mayDraft = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const [origin, setOrigin] = useState<MetricOrigin | ''>('');
  const metrics = useMetrics();
  const rows = useMemo(() => (metrics.data ?? []).filter((metric) => origin === '' || metric.origin === origin), [metrics.data, origin]);
  const state = useScreenState({ isLoading: metrics.isLoading, error: metrics.error, data: metrics.data });
  const columns = useMemo(() => metricColumns(t), [t]);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.catalogue.page.title')}</h1>
          <p>{t('bi.catalogue.page.subtitle')}</p>
        </div>
        <div className="mne-actions">
          <Link className="ui-button ui-button--outline" to={REGISTRATION_PATH}>
            {t('bi.catalogue.registration.link')}
          </Link>
          {mayDraft ? (
            <Link className="ui-button ui-button--outline" to={DEFINITION_PATH}>
              {t('bi.catalogue.create.link')}
            </Link>
          ) : null}
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('bi.catalogue.ctx.scope'), value: tenant?.name ?? t('bi.catalogue.ctx.scope.all') },
          { label: t('bi.catalogue.ctx.count'), value: String(rows.length) },
        ]}
        {...(metrics.dataUpdatedAt > 0 ? { asOf: new Date(metrics.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <FilterPanel applied={origin === '' ? 0 : 1}>
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
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void metrics.refetch()}>
        <p className="sub" data-testid="metric-readonly-note">
          {t('bi.catalogue.platformNote')}
        </p>
        <DataTable
          caption={t('bi.catalogue.table.aria')}
          columns={columns}
          rows={rows}
          rowKey={(metric) => metric.id}
          emptyKind={origin === '' ? 'none' : 'filtered'}
          onClearFilters={() => setOrigin('')}
        />
        {rows.length === 0 ? (
          <p className="ui-sr-only" data-testid="metric-no-rows">
            {t('bi.catalogue.noRows')}
          </p>
        ) : null}
      </StateBoundary>
    </section>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** The columns of the catalogue: the code (a link to the definition, with its revision) stays pinned, the state is a pill. */
function metricColumns(t: Translate): DataTableColumn<Metric>[] {
  const none = t('bi.catalogue.none');
  return [
    {
      key: 'code',
      header: t('bi.catalogue.column.code'),
      pinned: true,
      render: (metric) => (
        <>
          <Link to={`${DEFINITION_PATH}?id=${metric.id}`} aria-label={t('bi.catalogue.open.aria', { code: metric.code, revision: metric.revision })}>
            {metric.code}
          </Link>{' '}
          <span className="sub">{t('bi.catalogue.revision', { revision: metric.revision })}</span>
        </>
      ),
    },
    {
      key: 'formula',
      header: t('bi.catalogue.column.formula'),
      render: (metric) => (
        <>
          <code>{metricFormula(metric)}</code> <span className="sub">{aggregationLabel(t, metric.aggregationType)}</span>
        </>
      ),
    },
    { key: 'unit', header: t('bi.catalogue.column.unit'), render: (metric) => metric.unit },
    { key: 'owner', header: t('bi.catalogue.column.owner'), render: (metric) => (metric.ownerId === '' ? none : metric.ownerId.slice(0, 8)) },
    { key: 'origin', header: t('bi.catalogue.column.origin'), render: (metric) => originLabel(t, metric.origin) },
    { key: 'commit', header: t('bi.catalogue.column.commit'), render: (metric) => metric.sourceCommit ?? none },
    { key: 'glossary', header: t('bi.catalogue.column.glossary'), render: (metric) => (metric.glossaryTermId === null ? none : metric.glossaryTermId.slice(0, 8)) },
    { key: 'status', header: t('bi.catalogue.column.status'), render: (metric) => <StatusPill tone={metricStatusTone(metric.status)}>{statusLabel(t, metric.status)}</StatusPill> },
  ];
}
