import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip, KpiTile, StatusPill } from '../../../ui';
import { SeverityBadge } from '../../../ui/alerts';
import { LegalChip } from './components';
import { useAlertTypes } from './hooks';
import { severityText } from './labels';
import { READ_PERMISSION, REVIEW_SOON_DAYS, dayText, daysToReview, hasNoExpectedAction, isUuid, textParam } from './model';
import type { AlertTypeRow } from './model';
import '../adm-kit.css';
import './governance.css';

/**
 * ADM-23: the registry of alert types (G0-3). Each type of alert says who owns it, what is expected, what happens if it is not done, how fast it must be answered, why it exists and when it is next reviewed. A type
 * with no expected action can only be Watch (watch) and says so; a type past its review day is marked and counted. The list is what governs today: the rule the tenant approved, or the type that ships with the
 * platform (with its version and whether the numbers were confirmed). Filter by source or owner; open a type to see its versions.
 */
export default function AlertTypeRegistryScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <RegistryContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RegistryContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const [params] = useSearchParams();
  const rawUnit = textParam(params.get('unit_id'));
  const unitId = rawUnit !== undefined && isUuid(rawUnit) ? rawUnit : undefined;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const registry = useAlertTypes(unitId, mayRead);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [owner, setOwner] = useState('');
  const [onlyReview, setOnlyReview] = useState(false);
  const [onlyNoAction, setOnlyNoAction] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const queryState = useScreenState({ isLoading: registry.isLoading, error: registry.error, data: registry.data, isEmpty: (data) => (data as { items: unknown[] }).items.length === 0 });
  const state = mayRead ? queryState : 'denied';
  const all = registry.data?.items ?? [];
  const today = registry.data?.asOf ?? '';
  const reviewIn = (row: AlertTypeRow): number | null => daysToReview(row.reviewOn, today);
  const needsReview = (row: AlertTypeRow): boolean => row.reviewOverdue || ((reviewIn(row) ?? Number.POSITIVE_INFINITY) <= REVIEW_SOON_DAYS);
  const sources = [...new Set(all.flatMap((row) => (row.source === null ? [] : [row.source])))].sort();
  const owners = [...new Set(all.flatMap((row) => (row.owner === null ? [] : [row.owner])))].sort();
  const needle = search.trim().toLowerCase();
  const rows = all.filter((row) => (source === '' || row.source === source) && (owner === '' || row.owner === owner) && (!onlyReview || needsReview(row)) && (!onlyNoAction || hasNoExpectedAction(row)) && (needle === '' || row.code.toLowerCase().includes(needle)));
  const applied = (search.trim() === '' ? 0 : 1) + (source === '' ? 0 : 1) + (owner === '' ? 0 : 1) + (onlyReview ? 1 : 0) + (onlyNoAction ? 1 : 0);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const index = Math.min(pageIndex, pageCount - 1);
  const pageRows = rows.slice(index * pageSize, index * pageSize + pageSize);
  const noAction = all.filter(hasNoExpectedAction).length;
  const overdue = all.filter((row) => row.reviewOverdue).length;
  const soon = all.filter((row) => !row.reviewOverdue && (reviewIn(row) ?? Number.POSITIVE_INFINITY) <= REVIEW_SOON_DAYS).length;
  const own = all.filter((row) => row.ruleSource === 'RULE').length;
  const clear = (): void => {
    setSearch('');
    setSource('');
    setOwner('');
    setOnlyReview(false);
    setOnlyNoAction(false);
    setPageIndex(0);
  };
  const reset = <T,>(set: (value: T) => void) => (value: T): void => {
    set(value);
    setPageIndex(0);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gova1.alerts.title')}</h1>
          <p>{t('gova1.alerts.subtitle')}</p>
        </div>
        <nav className="gova1-links" aria-label={t('gova1.links.label')}>
          <Link to="/adm/adm-19" data-testid="link-catalogue">
            {t('gova1.detail.link.catalogue')}
          </Link>
        </nav>
      </div>
      <ContextBar
        items={[{ label: t('gova1.ctx.scope'), value: tenant?.name ?? t('gova1.ctx.scopeAll') }, ...(unitId === undefined ? [] : [{ label: t('gova1.ctx.unit'), value: unitId.slice(0, 8) }])]}
        {...(today === '' ? {} : { asOf: dayText(today) })}
      />
      <StateBoundary state={state} onRetry={() => void registry.refetch()}>
        <KpiStrip label={t('gova1.alerts.kpi.label')}>
          <KpiTile label={t('gova1.alerts.kpi.types')} value={String(all.length)} />
          <KpiTile label={t('gova1.alerts.kpi.own')} value={String(own)} sub={t('gova1.alerts.kpi.own.sub')} />
          <KpiTile label={t('gova1.alerts.kpi.noAction')} value={String(noAction)} sub={t('gova1.alerts.kpi.noAction.sub')} tone={noAction > 0 ? 'info' : 'default'} />
          <KpiTile label={t('gova1.alerts.kpi.overdue')} value={String(overdue)} sub={t('gova1.alerts.kpi.overdue.sub')} tone={overdue > 0 ? 'danger' : 'default'} />
          <KpiTile label={t('gova1.alerts.kpi.soon')} value={String(soon)} sub={t('gova1.alerts.kpi.soon.sub', { days: REVIEW_SOON_DAYS })} tone={soon > 0 ? 'warning' : 'default'} />
        </KpiStrip>
        <FilterPanel applied={applied} actions={applied > 0 ? <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={clear} data-testid="clear">{t('gova1.filter.clear')}</button> : undefined}>
          <div className="field">
            <label htmlFor="gova1-search">{t('gova1.alerts.filter.search')}</label>
            <input id="gova1-search" type="search" value={search} onChange={(event) => reset(setSearch)(event.target.value)} data-testid="search" />
          </div>
          <div className="field">
            <label htmlFor="gova1-source">{t('gova1.alerts.filter.source')}</label>
            <select id="gova1-source" value={source} onChange={(event) => reset(setSource)(event.target.value)} data-testid="source">
              <option value="">{t('gova1.filter.all')}</option>
              {sources.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="gova1-owner">{t('gova1.alerts.filter.owner')}</label>
            <select id="gova1-owner" value={owner} onChange={(event) => reset(setOwner)(event.target.value)} data-testid="owner">
              <option value="">{t('gova1.filter.all')}</option>
              {owners.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="gova1-review">
              <input id="gova1-review" type="checkbox" checked={onlyReview} onChange={(event) => reset(setOnlyReview)(event.target.checked)} data-testid="only-review" /> {t('gova1.alerts.filter.review', { days: REVIEW_SOON_DAYS })}
            </label>
          </div>
          <div className="field">
            <label htmlFor="gova1-noaction">
              <input id="gova1-noaction" type="checkbox" checked={onlyNoAction} onChange={(event) => reset(setOnlyNoAction)(event.target.checked)} data-testid="only-no-action" /> {t('gova1.alerts.filter.noAction')}
            </label>
          </div>
        </FilterPanel>
        <DataTable<AlertTypeRow>
          caption={t('gova1.alerts.table.caption')}
          rows={pageRows}
          rowKey={(row) => row.code}
          rowAttrs={(row) => ({ 'data-code': row.code })}
          state={rows.length === 0 ? 'empty' : 'ready'}
          emptyKind={applied > 0 ? 'filtered' : 'none'}
          onClearFilters={clear}
          page={{ from: rows.length === 0 ? 0 : index * pageSize + 1, to: Math.min(rows.length, index * pageSize + pageSize), total: rows.length, size: pageSize, index, onPage: setPageIndex, onSize: (size) => { setPageSize(size); setPageIndex(0); } }}
          columns={[
            {
              key: 'code',
              header: t('gova1.alerts.col.code'),
              pinned: true,
              render: (row) => (
                <>
                  <Link to={`/adm/adm-20?type=ALERT_TYPE&code=${encodeURIComponent(row.code)}${unitId === undefined ? '' : `&unit_id=${unitId}`}`} data-testid={`open-${row.code}`}>
                    {row.code}
                  </Link>
                  {row.enabled === false ? (
                    <span className="adm-kit-sub">
                      <StatusPill tone="neutral" icon="■">
                        {t('gova1.alerts.disabled')}
                      </StatusPill>
                    </span>
                  ) : null}
                </>
              ),
            },
            { key: 'source', header: t('gova1.alerts.col.source'), render: (row) => row.source ?? t('gova1.common.none') },
            { key: 'owner', header: t('gova1.alerts.col.owner'), render: (row) => row.owner ?? t('gova1.common.none') },
            {
              key: 'action',
              header: t('gova1.alerts.col.action'),
              render: (row) =>
                row.expectedAction === null ? (
                  <span data-testid={`no-action-${row.code}`}>
                    <StatusPill tone={row.defaultSeverity === 'WATCH' ? 'info' : 'danger'} icon={row.defaultSeverity === 'WATCH' ? 'ⓘ' : '⚠'}>
                      {row.defaultSeverity === 'WATCH' ? t('gova1.alerts.noAction') : t('gova1.alerts.noActionWrong')}
                    </StatusPill>
                  </span>
                ) : (
                  <span className="gova1-wrap">{row.expectedAction}</span>
                ),
            },
            { key: 'consequence', header: t('gova1.alerts.col.consequence'), render: (row) => <span className="gova1-wrap">{row.consequence ?? t('gova1.common.none')}</span> },
            { key: 'hours', header: t('gova1.alerts.col.hours'), align: 'right', render: (row) => (row.responseHours === null ? t('gova1.common.none') : String(row.responseHours)) },
            { key: 'severity', header: t('gova1.alerts.col.severity'), render: (row) => (row.defaultSeverity === null ? t('gova1.common.none') : <SeverityBadge severity={row.defaultSeverity} label={severityText(t, row.defaultSeverity)} />) },
            { key: 'why', header: t('gova1.alerts.col.why'), render: (row) => <span className="gova1-wrap">{row.reasonToExist ?? t('gova1.common.none')}</span> },
            {
              key: 'review',
              header: t('gova1.alerts.col.review'),
              render: (row) => {
                const days = reviewIn(row);
                return (
                  <>
                    {row.reviewOn === null ? t('gova1.common.none') : dayText(row.reviewOn)}
                    {row.reviewOverdue ? (
                      <span className="adm-kit-sub" data-testid={`overdue-${row.code}`}>
                        <StatusPill tone="danger" icon="⚠">
                          {t('gova1.alerts.review.overdue', { days: days === null ? 0 : Math.abs(days) })}
                        </StatusPill>
                      </span>
                    ) : days !== null && days <= REVIEW_SOON_DAYS ? (
                      <span className="adm-kit-sub" data-testid={`soon-${row.code}`}>
                        <StatusPill tone="warning" icon="◷">
                          {t('gova1.alerts.review.soon', { days })}
                        </StatusPill>
                      </span>
                    ) : null}
                  </>
                );
              },
            },
            {
              key: 'rule',
              header: t('gova1.alerts.col.rule'),
              render: (row) => (
                <>
                  {row.ruleSource === 'RULE' ? t('gova1.detail.force.rule', { version: row.version }) : t('gova1.detail.force.default')}
                  {row.unverified ? (
                    <span className="adm-kit-sub">
                      <LegalChip status="UNVERIFIED" />
                    </span>
                  ) : null}
                </>
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
