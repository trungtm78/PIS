import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { TryNumbers } from './TryNumbers';
import { GovernanceLink, OriginBadge, StateNote } from './ind-components';
import { useRules } from './ind-hooks';
import { checkLabel, severityLabel, severityTone, surfaceLabel } from './ind-labels';
import { DASH, PATH_DICTIONARY, PATH_MAPPINGS, vietnamDateTime } from './ind-model';
import type { EntryRule } from './ind-model';
import './ind.css';

/**
 * IND-02: the data entry rules (DL.02). A rule holds the numbers of an entry to an identity of the data at the moment they are typed or loaded: the cumulative is not above the total investment, equity plus
 * borrowings is the total, a closed period is not edited, required fields are given, a value is in its plausible range. Only a version the tenant approved holds an entry; the platform's starting rules are templates
 * (shown as such) that a tenant adopts by approving its own version through the governance rules, so a tenant that configured nothing sees no change in any entry.
 */
export default function EntryRulesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <RulesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RulesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const rules = useRules();
  const state = useScreenState({ isLoading: rules.isLoading, error: rules.data === undefined ? rules.error : undefined, data: rules.data ?? null, isEmpty: () => false });
  const data = rules.data;
  const items = data?.items ?? [];
  const active = items.filter((rule) => rule.active).length;
  const asOf = vietnamDateTime(data?.asOf);

  const columns: Array<DataTableColumn<EntryRule>> = [
    { key: 'code', header: t('ind.rules.column.code'), pinned: true, render: (row) => row.code },
    { key: 'check', header: t('ind.rules.column.check'), render: (row) => checkLabel(t, row.check) },
    {
      key: 'severity',
      header: t('ind.rules.column.severity'),
      render: (row) => (
        <StatusPill tone={severityTone(row.severity)} icon={row.severity === 'BLOCK' ? '✕' : '⚠'}>
          {severityLabel(t, row.severity)}
        </StatusPill>
      ),
    },
    { key: 'fields', header: t('ind.rules.column.fields'), render: (row) => [...row.fields, ...(row.totalField === null ? [] : [t('ind.rules.fields.total', { field: row.totalField })])].join(', ') },
    { key: 'range', header: t('ind.rules.column.range'), render: (row) => (row.min === null && row.max === null ? (row.tolerance === null ? DASH : t('ind.rules.range.tolerance', { n: row.tolerance })) : t('ind.rules.range.between', { min: row.min ?? DASH, max: row.max ?? DASH })) },
    { key: 'surfaces', header: t('ind.rules.column.surfaces'), render: (row) => (row.surfaces === null ? t('ind.rules.surfaces.all') : row.surfaces.map((surface) => surfaceLabel(t, surface)).join(', ')) },
    {
      key: 'state',
      header: t('ind.rules.column.state'),
      render: (row) => (
        <span data-testid="rule-state" data-active={row.active ? 'true' : 'false'}>
          <StatusPill tone={row.active ? 'success' : 'neutral'} icon={row.active ? '✓' : '○'}>
            {row.active ? t('ind.rules.state.active') : t('ind.rules.state.template')}
          </StatusPill>
        </span>
      ),
    },
    { key: 'origin', header: t('ind.rules.column.origin'), render: (row) => <OriginBadge origin={row.origin} unverified={row.unverified} /> },
    { key: 'effective', header: t('ind.rules.column.effective'), render: (row) => (row.effectiveFrom === null ? DASH : `${row.effectiveFrom} → ${row.effectiveTo ?? DASH}`) },
    { key: 'version', header: t('ind.rules.column.version'), align: 'right', render: (row) => (row.version === 0 ? t('ind.rules.column.versionDefault') : `v${row.version}`) },
    { key: 'message', header: t('ind.rules.column.message'), render: (row) => row.message },
  ];

  const body = (() => {
    if (state !== 'default' || data === undefined) {
      return <StateNote state={state === 'default' ? 'error' : state} name="rules" texts={{ loading: t('ind.rules.state.loading'), denied: t('ind.rules.state.denied'), error: t('ind.rules.state.error') }} onRetry={() => void rules.refetch()} />;
    }
    if (items.length === 0) {
      return (
        <p className="callout" role="status" data-testid="rules-empty">
          {t('ind.rules.state.empty')}
        </p>
      );
    }
    return (
      <>
        <p className="sub" data-testid="rules-summary">
          {t('ind.rules.summary.text', { active, templates: items.length - active })}
        </p>
        {active === 0 ? (
          <p className="callout" role="status" data-testid="rules-none-active">
            {t('ind.rules.summary.noneActive')}
          </p>
        ) : null}
        <div data-testid="rules-table">
          <DataTable caption={t('ind.rules.table.caption')} columns={columns} rows={items} rowKey={(row) => row.code} rowAttrs={(row) => ({ 'data-code': row.code, 'data-active': row.active ? 'true' : 'false', 'data-level': row.severity })} />
        </div>
      </>
    );
  })();

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="ind-screen">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ind.rules.page.title')}</h1>
          <p>{t('ind.rules.page.subtitle')}</p>
        </div>
        <div className="ind-links">
          <Link to={PATH_DICTIONARY}>{t('ind.rules.link.dictionary')}</Link>
          <Link to={PATH_MAPPINGS}>{t('ind.rules.link.mappings')}</Link>
        </div>
      </div>
      <ContextBar items={[{ label: t('ind.common.context.scope'), value: tenant?.name ?? '' }]} {...(asOf === '' ? {} : { asOf })} stale={rules.isError && data !== undefined} />
      <SectionCard title={t('ind.rules.list.title')}>
        <p className="sub">{t('ind.rules.list.templateNote')}</p>
        {body}
        <GovernanceLink />
      </SectionCard>
      <TryNumbers surfaces={data?.surfaces ?? []} />
      <p className="prototype-note">{t('ind.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
