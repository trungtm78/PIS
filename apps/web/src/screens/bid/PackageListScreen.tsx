import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { PlanStatusBadge } from './plan-components';
import { usePackages } from './plan-hooks';
import { methodLabel, planStatusLabel } from './plan-labels';
import { EMPTY_PACKAGE_FILTER, PLAN_STATUSES, filterPackages, formatVnd, planLink } from './plan-model';
import type { PackageFilter, PlanStatus } from './plan-model';
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

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.packages.page.title')}</h1>
          <p>{t('bid.packages.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void packages.refetch()}>
        <div className="card">
          <form className="bid-filters" role="search" aria-label={t('bid.packages.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="package-query">{t('bid.packages.query.label')}</label>
              <input id="package-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="package-plan-status">{t('bid.packages.planStatus.label')}</label>
              <select id="package-plan-status" value={filter.planStatus} onChange={(event) => setFilter({ ...filter, planStatus: event.target.value as PlanStatus | '' })}>
                <option value="">{t('bid.packages.planStatus.all')}</option>
                {PLAN_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {planStatusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
          </form>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('bid.packages.noMatch.notice')}
            </p>
          ) : (
            <table className="table" data-testid="packages">
              <thead>
                <tr>
                  <th scope="col">{t('bid.packages.column.package')}</th>
                  <th scope="col">{t('bid.packages.column.project')}</th>
                  <th scope="col">{t('bid.packages.column.stage')}</th>
                  <th scope="col">{t('bid.packages.column.period')}</th>
                  <th scope="col">{t('bid.packages.column.plan')}</th>
                  <th scope="col">{t('bid.packages.column.fund')}</th>
                  <th scope="col">{t('bid.packages.column.budget')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr key={item.id} data-package-id={item.id}>
                    <th scope="row">
                      <code>{item.code}</code>
                      <br />
                      {item.title ?? ''}
                      <br />
                      <small className="sub">{methodLabel(t, item.method)}</small>
                    </th>
                    <td>
                      {item.project.code}
                      <br />
                      <small className="sub">{item.project.name}</small>
                    </td>
                    <td>{item.project.status}</td>
                    <td>{item.plannedStartPeriod ?? ''}</td>
                    <td>
                      {item.planId === null || item.planStatus === null ? (
                        <span data-testid="no-plan">{t('bid.packages.noPlan.text')}</span>
                      ) : (
                        <>
                          <Link to={planLink(item.planId)}>{t('bid.packages.revision.link', { revision: item.planRevision ?? 0 })}</Link> <PlanStatusBadge status={item.planStatus} />
                        </>
                      )}
                    </td>
                    <td>{item.fundSourceLabel ?? ''}</td>
                    <td className="num">{formatVnd(item.budgetVnd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="sub">{t('bid.packages.count.text', { count: shown.length })}</p>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('bid.packages.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
