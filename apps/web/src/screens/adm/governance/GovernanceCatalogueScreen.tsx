import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, KpiTile, StatusPill } from '../../../ui';
import { LegalChip } from './components';
import { useCatalogue } from './hooks';
import { READ_PERMISSION, dayText, forceCounts, isUnverified, momentText } from './model';
import type { RuleTypeEntry } from './model';
import '../adm-kit.css';
import './governance.css';

/**
 * ADM-19: the catalogue of governance rules (G0-1). Each kind of rule the platform knows (thresholds, definitions, policies, the alert types) with the module that answers for it, the number of codes under it, how many
 * codes already use a rule the tenant approved and how many still use the default that ships with the platform, and whether the numbers were confirmed: a type or a default that was not confirmed with the law or the
 * customer says "chưa kiểm chứng" here and on every screen that shows the number. A rule type is opened to see its codes, the rule in force beside the default, and the versions.
 */
export default function GovernanceCatalogueScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <CatalogueContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CatalogueContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, permissions } = useSession();
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const catalogue = useCatalogue(mayRead);
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState('');
  const [onlyUnverified, setOnlyUnverified] = useState(false);
  const queryState = useScreenState({ isLoading: catalogue.isLoading, error: catalogue.error, data: catalogue.data, isEmpty: (data) => Array.isArray(data) && data.length === 0 });
  const state = mayRead ? queryState : 'denied';
  const all = catalogue.data ?? [];
  const owners = [...new Set(all.flatMap((entry) => (entry.ownerModule === null ? [] : [entry.ownerModule])))].sort();
  const needle = search.trim().toLowerCase();
  const rows = all.filter((entry) => (owner === '' || entry.ownerModule === owner) && (!onlyUnverified || isUnverified(entry)) && (needle === '' || entry.ruleType.toLowerCase().includes(needle) || entry.codes.some((code) => code.code.toLowerCase().includes(needle))));
  const applied = (search.trim() === '' ? 0 : 1) + (owner === '' ? 0 : 1) + (onlyUnverified ? 1 : 0);
  const totals = all.reduce(
    (sum, entry) => {
      const counts = forceCounts(entry);
      return { codes: sum.codes + entry.codes.length, rules: sum.rules + counts.rules, defaults: sum.defaults + counts.defaults, unverified: sum.unverified + (isUnverified(entry) ? 1 : 0) };
    },
    { codes: 0, rules: 0, defaults: 0, unverified: 0 },
  );
  const clear = (): void => {
    setSearch('');
    setOwner('');
    setOnlyUnverified(false);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gova1.catalogue.title')}</h1>
          <p>{t('gova1.catalogue.subtitle')}</p>
        </div>
        <nav className="gova1-links" aria-label={t('gova1.links.label')}>
          <Link to="/adm/adm-23" data-testid="link-alert-types">
            {t('gova1.catalogue.link.alerts')}
          </Link>
        </nav>
      </div>
      <ContextBar items={[{ label: t('gova1.ctx.scope'), value: tenant?.name ?? t('gova1.ctx.scopeAll') }]} {...(catalogue.dataUpdatedAt > 0 ? { asOf: momentText(new Date(catalogue.dataUpdatedAt).toISOString(), locale) } : {})} />
      <StateBoundary state={state} onRetry={() => void catalogue.refetch()}>
        <KpiStrip label={t('gova1.catalogue.kpi.label')}>
          <KpiTile label={t('gova1.catalogue.kpi.types')} value={String(all.length)} />
          <KpiTile label={t('gova1.catalogue.kpi.codes')} value={String(totals.codes)} />
          <KpiTile label={t('gova1.catalogue.kpi.rules')} value={String(totals.rules)} sub={t('gova1.catalogue.kpi.rules.sub')} />
          <KpiTile label={t('gova1.catalogue.kpi.defaults')} value={String(totals.defaults)} sub={t('gova1.catalogue.kpi.defaults.sub')} tone={totals.defaults > 0 ? 'warning' : 'default'} />
          <KpiTile label={t('gova1.catalogue.kpi.unverified')} value={String(totals.unverified)} sub={t('gova1.catalogue.kpi.unverified.sub')} tone={totals.unverified > 0 ? 'warning' : 'default'} />
        </KpiStrip>
        <FilterPanel applied={applied} actions={applied > 0 ? <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={clear} data-testid="clear">{t('gova1.filter.clear')}</button> : undefined}>
          <div className="field">
            <label htmlFor="gova1-search">{t('gova1.catalogue.filter.search')}</label>
            <input id="gova1-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="search" />
          </div>
          <div className="field">
            <label htmlFor="gova1-owner">{t('gova1.catalogue.filter.owner')}</label>
            <select id="gova1-owner" value={owner} onChange={(event) => setOwner(event.target.value)} data-testid="owner">
              <option value="">{t('gova1.filter.all')}</option>
              {owners.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="gova1-unverified">
              <input id="gova1-unverified" type="checkbox" checked={onlyUnverified} onChange={(event) => setOnlyUnverified(event.target.checked)} data-testid="only-unverified" /> {t('gova1.catalogue.filter.unverified')}
            </label>
          </div>
        </FilterPanel>
        <DataTable<RuleTypeEntry>
          caption={t('gova1.catalogue.table.caption')}
          rows={rows}
          rowKey={(row) => row.ruleType}
          rowAttrs={(row) => ({ 'data-rule-type': row.ruleType })}
          state={rows.length === 0 ? 'empty' : 'ready'}
          emptyKind={applied > 0 ? 'filtered' : 'none'}
          onClearFilters={clear}
          columns={[
            {
              key: 'type',
              header: t('gova1.catalogue.col.type'),
              pinned: true,
              render: (row) => (
                <>
                  <Link to={`/adm/adm-20?type=${encodeURIComponent(row.ruleType)}`} data-testid={`open-${row.ruleType}`}>
                    {row.ruleType}
                  </Link>
                  {row.registered ? null : (
                    <span className="adm-kit-sub">
                      <StatusPill tone="warning" icon="⚠">
                        {t('gova1.catalogue.unregistered')}
                      </StatusPill>
                    </span>
                  )}
                </>
              ),
            },
            { key: 'owner', header: t('gova1.catalogue.col.owner'), render: (row) => (row.ownerModule === null ? t('gova1.common.none') : <><strong>{row.ownerModule}</strong>{row.modules.length > 0 ? <span className="adm-kit-sub">{t('gova1.catalogue.readBy', { modules: row.modules.join(', ') })}</span> : null}</>) },
            { key: 'codes', header: t('gova1.catalogue.col.codes'), align: 'right', render: (row) => String(row.codes.length) },
            { key: 'rules', header: t('gova1.catalogue.col.rules'), align: 'right', render: (row) => String(forceCounts(row).rules) },
            { key: 'defaults', header: t('gova1.catalogue.col.defaults'), align: 'right', render: (row) => String(forceCounts(row).defaults) },
            { key: 'legal', header: t('gova1.catalogue.col.legal'), render: (row) => (isUnverified(row) ? <LegalChip status="UNVERIFIED" /> : row.legalStatus === null ? t('gova1.common.none') : <LegalChip status={row.legalStatus} />) },
            {
              key: 'source',
              header: t('gova1.catalogue.col.source'),
              render: (row) =>
                row.source === null ? (
                  t('gova1.common.none')
                ) : (
                  <span className="gova1-wrap">
                    {row.source}
                    <span className="adm-kit-sub">{t('gova1.catalogue.asOf', { day: dayText(row.asOf) })}</span>
                    {row.formula === null ? null : <span className="adm-kit-sub">{t('gova1.catalogue.formula', { formula: row.formula })}</span>}
                  </span>
                ),
            },
          ]}
        />
        <p className="adm-kit-foot" data-testid="footer">
          {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
        </p>
      </StateBoundary>
    </section>
  );
}
