import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { useRedFlagIndicators } from './hooks';
import type { Indicator } from './model';
import { Provenance, indicatorLabel } from './parts';

const KNOBS = ['threshold', 'threshold_vnd', 'margin_pct', 'min_count', 'window_days', 'weight'] as const;

/**
 * AUD-16: the registry of the red-flag indicators. Each indicator has its id in the OCP catalogue, the data it reads, its formula in words, its source, the day its numbers were taken, the thresholds the rule gives it today (read
 * from the governance rule, never from the screen) and its legal status: a number nobody confirmed says "default, not confirmed". Indicators of the vendor side that other lanes register later appear here in the same shape.
 */
export default function RedFlagRegistryScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <RegistryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RegistryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const query = useRedFlagIndicators();
  const rows = query.data ?? [];
  const state = useScreenState({ isLoading: query.isLoading, error: query.data === undefined ? query.error : undefined, data: query.data, isEmpty: (data) => Array.isArray(data) && data.length === 0 });
  const columns: DataTableColumn<Indicator>[] = [
    {
      key: 'indicator',
      header: t('gov10.red.registry.indicator'),
      pinned: true,
      render: (row) => (
        <>
          <strong>{indicatorLabel(t, row.code)}</strong> <span className="dis-code">{row.ocpId}</span>
          {row.vendorSide ? <StatusPill tone="info">{t('gov10.red.registry.vendorSide')}</StatusPill> : null}
        </>
      ),
    },
    { key: 'data', header: t('gov10.red.registry.data'), render: (row) => row.dataSources.join('; ') },
    {
      key: 'formula',
      header: t('gov10.red.registry.formula'),
      render: (row) => (
        <>
          {row.formula}{' '}
          <Provenance
            name={indicatorLabel(t, row.code)}
            formula={row.formula}
            source={row.source}
            asOf={row.indicatorAsOf}
            version={row.ruleVersion === null || row.ruleVersion === 0 ? t('gov10.info.versionDefault') : t('gov10.info.versionRule', { version: row.ruleVersion })}
            unverified={row.unverified}
            owner={t('gov10.red.owner')}
          />
        </>
      ),
    },
    {
      key: 'thresholds',
      header: t('gov10.red.registry.thresholds'),
      render: (row) => (row.params === null ? '—' : KNOBS.filter((knob) => row.params?.[knob] !== undefined).map((knob) => `${knob}: ${String(row.params?.[knob])}`).join(', ')),
    },
    { key: 'asOf', header: t('gov10.red.registry.asOf'), render: (row) => row.indicatorAsOf },
    {
      key: 'legal',
      header: t('gov10.red.registry.legal'),
      render: (row) => <StatusPill tone={row.unverified ? 'warning' : 'success'}>{row.unverified ? t('gov10.red.registry.unverified') : t('gov10.red.registry.verified')}</StatusPill>,
    },
    { key: 'enabled', header: t('gov10.red.registry.enabled'), render: (row) => (row.enabled ? t('gov10.red.registry.on') : t('gov10.red.registry.off')) },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov10.red.registry.title')}</h1>
          <p>{t('gov10.red.registry.subtitle')}</p>
        </div>
        <Link to="/aud/aud-14" className="mv-alert-link">
          {t('gov10.red.back')}
        </Link>
      </div>
      <div className="gov10-stack">
        <p className="gov10-notice">{t('gov10.red.notice')}</p>
        <ContextBar items={[{ label: t('gov10.red.registry.count'), value: String(rows.length) }]} />
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          <DataTable caption={t('gov10.red.registry.title')} columns={columns} rows={rows} rowKey={(row) => row.code} />
        </StateBoundary>
      </div>
    </section>
  );
}
