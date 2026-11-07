import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, FilterPanel } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ScopeBar } from '../ctr/kit';
import { PlanStatusBadge } from './plan-components';
import { usePackages } from './plan-hooks';
import { methodLabel, planStatusLabel } from './plan-labels';
import { EMPTY_PACKAGE_FILTER, PLAN_STATUSES, filterPackages, formatVnd, planLink } from './plan-model';
import type { PackageFilter, PackageLine, PlanStatus } from './plan-model';
import './bid.css';

/**
 * BID-03: the packages of the procurement plans with their project, stage, period, plan revision and fund source. A package belongs to a plan:
 * only a package of the plan in force is organised for selection (BID 3 F1), and the status of its plan is told in words beside it (ST-BID-001).
 */
export default function PackageListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The packages shown depend on the membership (a plan in work is for those who plan and approve): a switch starts the screen over.
  return <PackageListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PackageListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const packages = usePackages();
  const [filter, setFilter] = useState<PackageFilter>(EMPTY_PACKAGE_FILTER);
  const state = useScreenState({ isLoading: packages.isLoading, error: packages.error, data: packages.data });
  const shown = useMemo(() => filterPackages(packages.data ?? [], filter), [packages.data, filter]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const applied = (filter.query.trim() === '' ? 0 : 1) + (filter.planStatus === '' ? 0 : 1);
  const change = (next: PackageFilter): void => {
    setFilter(next);
    setPageIndex(0);
  };
  const from = pageIndex * pageSize + 1;
  const rows = shown.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);

  const columns: DataTableColumn<PackageLine>[] = [
    {
      key: 'package',
      header: t('bid.packages.column.package'),
      pinned: true,
      render: (item) => (
        <span data-package-id={item.id}>
          <code>{item.code}</code>
          <br />
          {item.title ?? ''}
          <br />
          <small className="sub">{methodLabel(t, item.method)}</small>
        </span>
      ),
    },
    {
      key: 'project',
      header: t('bid.packages.column.project'),
      render: (item) => (
        <>
          {item.project.code}
          <br />
          <small className="sub">{item.project.name}</small>
        </>
      ),
    },
    { key: 'stage', header: t('bid.packages.column.stage'), render: (item) => item.project.status },
    { key: 'period', header: t('bid.packages.column.period'), render: (item) => item.plannedStartPeriod ?? '' },
    {
      key: 'plan',
      header: t('bid.packages.column.plan'),
      render: (item) =>
        item.planId === null || item.planStatus === null ? (
          <span data-testid="no-plan">{t('bid.packages.noPlan.text')}</span>
        ) : (
          <>
            <Link to={planLink(item.planId)}>{t('bid.packages.revision.link', { revision: item.planRevision ?? 0 })}</Link> <PlanStatusBadge status={item.planStatus} />
          </>
        ),
    },
    { key: 'fund', header: t('bid.packages.column.fund'), render: (item) => item.fundSourceLabel ?? '' },
    { key: 'budget', header: t('bid.packages.column.budget'), align: 'right', render: (item) => formatVnd(item.budgetVnd) },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.packages.page.title')}</h1>
          <p>{t('bid.packages.page.subtitle')}</p>
        </div>
      </div>
      <ScopeBar
        money
        extra={[{ label: t('w2pay.bid.ctx.planStatus'), value: filter.planStatus === '' ? t('w2pay.pay.ctx.all') : planStatusLabel(t, filter.planStatus) }]}
        updatedAt={packages.dataUpdatedAt}
        stale={packages.isRefetchError}
      />
      <StateBoundary state={state} onRetry={() => void packages.refetch()}>
        <FilterPanel applied={applied} unitLabel={t('w2pay.ctx.unit')}>
          <form className="bid-filters" role="search" aria-label={t('bid.packages.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="package-query">{t('bid.packages.query.label')}</label>
              <input id="package-query" value={filter.query} onChange={(event) => change({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="package-plan-status">{t('bid.packages.planStatus.label')}</label>
              <select id="package-plan-status" value={filter.planStatus} onChange={(event) => change({ ...filter, planStatus: event.target.value as PlanStatus | '' })}>
                <option value="">{t('bid.packages.planStatus.all')}</option>
                {PLAN_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {planStatusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
          </form>
        </FilterPanel>
        {shown.length === 0 ? (
          <div className="bid-row-actions">
            <p className="callout" role="status" data-testid="no-match">
              {t('bid.packages.noMatch.notice')}
            </p>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => change(EMPTY_PACKAGE_FILTER)}>
              {t('ui.dataTable.clearFilters')}
            </button>
          </div>
        ) : (
          <div data-testid="packages">
            <DataTable
              caption={t('bid.packages.page.title')}
              columns={columns}
              rows={rows}
              rowKey={(item) => item.id}
              page={{
                from,
                to: from + rows.length - 1,
                total: shown.length,
                size: pageSize,
                index: pageIndex,
                onPage: setPageIndex,
                onSize: (size) => {
                  setPageSize(size);
                  setPageIndex(0);
                },
              }}
            />
          </div>
        )}
        <p className="sub">{t('bid.packages.count.text', { count: shown.length })}</p>
      </StateBoundary>
      <p className="prototype-note">{t('bid.packages.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
