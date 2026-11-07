import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { StatusPill } from '../../../ui';
import { AnalyticsFilters, BreakdownBars, DefinitionsList, ExportBar, ReportContext, ReportKpis, ReportTable } from './components';
import { usePortfolio, useReport } from './hooks';
import { reportLead, reportTitle } from './labels';
import { DEFAULT_QUERY, EMPTY_ANALYTICS_FILTER, PORTFOLIO_PERMISSION, REPORT_PERMISSION, bytesOfBase64, filterCount } from './model';
import type { AnalyticsFilter, ReportCode, RowView } from './model';
import './analytics.css';

export type TableReport = Exclude<ReportCode, 'contractor-concentration'>;

/** The columns a list of the contracts can be sorted by on the server (the allowlist of the API), in the order the screens offer them. */
const SORTABLE = [
  'code',
  'title',
  'project_code',
  'contractor_name',
  'unit_name',
  'contract_status',
  'contract_value_vnd',
  'original_value_vnd',
  'approved_change_delta_vnd',
  'accepted_vnd',
  'paid_vnd',
  'winning_bid_vnd',
  'advance_outstanding_vnd',
  'retention_held_vnd',
  'days_late',
  'original_due_date',
  'max_change_tier',
] as const;

export const sortKeysOf = (columns: readonly string[]): string[] => SORTABLE.filter((key) => key === 'code' || columns.includes(key));

export interface ReportPageProps {
  route: WebRoute;
  code: TableReport;
}

/**
 * One report of the catalogue as a screen (CTR-28 to CTR-30): the context of its numbers (scope, period or day, cut-off day, unit, freshness), the filters the server applies, the indicators of all the contracts that
 * match (each with its "i"), the groups of its breakdown as bars, the table with the totals row the server made, the definitions and the files. Every state has its own face: loading is a skeleton, a refusal is "denied",
 * a failure has a retry, an empty answer says whether the filter or the portfolio is empty, a ledger the reader may not see is a lock with its reason, a frozen period that has a newer revision is stale.
 */
export function ReportPage({ route, code }: ReportPageProps) {
  const { tenant } = useSession();
  // The numbers belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${code}`} route={route} code={code} />;
}

function ReportContent({ route, code }: ReportPageProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const required = code === 'portfolio-status' ? PORTFOLIO_PERMISSION : REPORT_PERMISSION;
  const allowed = permissions === undefined || permissions.includes(required);
  const [filter, setFilter] = useState<AnalyticsFilter>(EMPTY_ANALYTICS_FILTER);
  const [sort, setSort] = useState('code');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [size, setSize] = useState(20);
  // The cursors of the pages seen: page n is read with the cursor the page before it gave.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [index, setIndex] = useState(0);
  const query = { ...DEFAULT_QUERY, filter, sort, direction, limit: size, cursor: cursors[index] ?? null };
  const portfolio = usePortfolio(query, allowed && code === 'portfolio-status');
  const report = useReport(code === 'portfolio-status' ? 'bid-variance' : code, query, allowed && code !== 'portfolio-status');
  const read = code === 'portfolio-status' ? portfolio : report;
  const view = read.data;
  const state = useScreenState({ isLoading: read.isLoading, error: read.error, data: view, isEmpty: () => false });
  const forbidden = !allowed ? 'denied' : state;
  const start = (): void => {
    setCursors([null]);
    setIndex(0);
  };
  const changeFilter = (next: AnalyticsFilter): void => {
    setFilter(next);
    start();
  };
  const filtered = filterCount(filter) > 0;
  const rows = view?.items ?? [];
  const from = index * size + 1;
  const link = (row: RowView) => (
    <span data-contract-id={row.contractId}>
      <Link to={`/ctr/ctr-03?id=${row.contractId}`}>{String(row.cells.code ?? row.contractId)}</Link>
    </span>
  );

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{reportTitle(t, code)}</h1>
          <p>{reportLead(t, code)}</p>
        </div>
        <Link className="ui-button ui-button--outline" to="/ctr/ctr-28">
          {t('ca1.hub.back')}
        </Link>
      </div>
      {view === undefined ? null : <ReportContext context={view.context} updatedAt={read.dataUpdatedAt} onUseLatest={(period) => changeFilter({ ...filter, period, asOf: '' })} />}
      <StateBoundary state={forbidden} onRetry={() => void read.refetch()}>
        <AnalyticsFilters
          value={filter}
          onChange={changeFilter}
          sort={sort}
          direction={direction}
          sortKeys={sortKeysOf((view?.columns ?? []).map((column) => column.key))}
          onSort={(nextSort, nextDirection) => {
            setSort(nextSort);
            setDirection(nextDirection);
            start();
          }}
          actions={view === undefined ? undefined : <ExportBar code={code} query={query} decode={bytesOfBase64} />}
        />
        {view === undefined ? null : (
          <>
            {read.isError ? (
              <p className="callout warning ca1-notice" role="status">
                <StatusPill tone="warning">{t('ca1.refetch.stale')}</StatusPill>
              </p>
            ) : null}
            <ReportKpis view={view} />
            <BreakdownBars view={view} />
            {code === 'schedule-delay' && view.evmStatus === 'UNAVAILABLE' ? (
              <p className="callout ca1-notice" role="status" data-testid="evm-slot">
                {t('ca1.evm.unavailable')}
              </p>
            ) : null}
            {code === 'payment-three-way' && view.paymentClock !== null ? (
              <p className="callout ca1-notice" role="status" data-testid="clock-note">
                {t('ca1.clock.note', { acceptance: view.paymentClock.acceptanceToRequestDays, treasury: view.paymentClock.requestToTreasuryDays })}
              </p>
            ) : null}
            {rows.length === 0 ? (
              <div className="ctr-row-actions" data-testid={filtered ? 'no-match' : 'no-contracts'}>
                <p className="callout" role="status">
                  {filtered ? t('ca1.empty.filtered') : t('ca1.empty.none')}
                </p>
                {filtered ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => changeFilter(EMPTY_ANALYTICS_FILTER)}>
                    {t('ui.dataTable.clearFilters')}
                  </button>
                ) : null}
              </div>
            ) : (
              <div data-testid="report-table">
                <ReportTable
                  view={view}
                  linkOf={link}
                  caption={reportTitle(t, code)}
                  page={{
                    from,
                    to: from + rows.length - 1,
                    total: view.totals.rows,
                    size,
                    index,
                    onPage: (target) => {
                      if (target < index) setIndex(target);
                      else if (target > index && view.nextCursor !== null) {
                        setCursors([...cursors.slice(0, index + 1), view.nextCursor]);
                        setIndex(index + 1);
                      }
                    },
                    onSize: (next) => {
                      setSize(next);
                      start();
                    },
                  }}
                />
              </div>
            )}
            {code === 'portfolio-status' || code === 'bid-variance' ? (
              <p className="sub" data-testid="trend-note">
                {t('ca1.trend.note')} <Link to="/bi/bi-09">{t('ca1.trend.link')}</Link>
              </p>
            ) : null}
            <DefinitionsList definitions={view.definitions} asOf={view.context.asOf} />
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
