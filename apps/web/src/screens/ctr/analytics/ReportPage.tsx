import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { StatusPill } from '../../../ui';
import { AnalyticsFilters, BreakdownBars, DefinitionsList, ExportBar, ReportContext, ReportKpis, ReportTable } from './components';
import { usePortfolio, useReport, useScheduleCurve } from './hooks';
import { EvmPanel, LadderPanel, RulesNote, TierSplitPanel } from './money-components';
import { reportLead, reportTitle } from './labels';
import { DEFAULT_QUERY, EMPTY_ANALYTICS_FILTER, PORTFOLIO_PERMISSION, REPORT_LINKS, REPORT_PERMISSION, bytesOfBase64, filterCount, isRegisterReport } from './model';
import type { AnalyticsFilter, RegisterReportCode, ReportCode, RowView } from './model';
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

/** The reports of the registers are read today only: they have no period and no past day. */
const LIVE_ONLY: readonly string[] = ['claims-limitation', 'quality-defects', 'obstacles', 'audit-findings', 'performance-rating'];

/** The words the severity and the state of a record are filtered by, for each register report (the filters the server judges). */
const RECORD_WORDS: Readonly<Record<string, { severities: readonly string[]; states: readonly string[] }>> = {
  'claims-limitation': { severities: [], states: ['OPEN', 'GRANTED', 'PARTLY_GRANTED', 'REJECTED', 'WITHDRAWN'] },
  'quality-defects': { severities: ['CRITICAL', 'MAJOR', 'MINOR'], states: ['OPEN', 'ACTION_ASSIGNED', 'ACTION_SUBMITTED', 'VERIFIED', 'CLOSED', 'REOPENED'] },
  obstacles: { severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], states: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED', 'REOPENED'] },
  'audit-findings': { severities: ['CRITICAL', 'MAJOR', 'MINOR'], states: [] },
  'performance-rating': { severities: [], states: ['NONE', 'PROPOSED', 'NOTIFIED', 'RESPONDED', 'ADOPTED'] },
  'contract-health': { severities: [], states: [] },
};

/** The columns a report can be sorted by: the allowlist of the contracts for the first reports, every column of the table for a register report (the server judges the key). */
export const sortKeysOf = (columns: readonly string[], code?: string): string[] => (code !== undefined && isRegisterReport(code) ? [...columns] : SORTABLE.filter((key) => key === 'code' || columns.includes(key)));

const firstKey = (view: { columns: ReadonlyArray<{ key: string }> } | undefined): string => view?.columns[0]?.key ?? 'code';

/** The screens that hold the detail behind a register report: the scorecard, the payment integrity findings, the settlement, the proposals of a rating. */
function RelatedLinks({ code }: { code: RegisterReportCode }) {
  const { t } = useTranslation();
  const links = REPORT_LINKS[code];
  if (links.length === 0) return null;
  return (
    <p className="sub" data-testid="related-links">
      {t('ca3.related.title')}{' '}
      {links.map((link) => (
        <Link key={link.id} className="ca3-related" to={link.to}>
          {t(`ca3.related.${link.id}`)}
        </Link>
      ))}
    </p>
  );
}

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
  const [sort, setSort] = useState(code === 'claims-limitation' ? 'claim_code' : code === 'quality-defects' ? 'ncr_no' : code === 'obstacles' ? 'issue_code' : code === 'audit-findings' ? 'finding_code' : 'code');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [size, setSize] = useState(20);
  // The cursors of the pages seen: page n is read with the cursor the page before it gave.
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [index, setIndex] = useState(0);
  const query = { ...DEFAULT_QUERY, filter, sort, direction, limit: size, cursor: cursors[index] ?? null };
  const portfolio = usePortfolio(query, allowed && code === 'portfolio-status');
  const report = useReport(code === 'portfolio-status' ? 'bid-variance' : code, query, allowed && code !== 'portfolio-status');
  const curve = useScheduleCurve(query, allowed && code === 'schedule-delay' && report.data !== undefined && report.data.evm?.reason !== 'NOT_IN_SNAPSHOT');
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
      <Link to={code === 'performance-rating' ? `/ctr/ctr-32?contract=${row.contractId}` : `/ctr/ctr-03?id=${row.contractId}`}>{String(row.cells.code ?? row.cells[firstKey(view)] ?? row.contractId)}</Link>
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
      {read.error instanceof ApiError && read.error.code === 'REPORT_SELECTION_TOO_LARGE' ? (
        <p className="callout warning ca1-notice" role="alert" data-testid="selection-too-large">
          {t('ca2.error.tooLarge')}
        </p>
      ) : null}
      <StateBoundary state={forbidden} onRetry={() => void read.refetch()}>
        <AnalyticsFilters
          value={filter}
          onChange={changeFilter}
          sort={sort}
          direction={direction}
          sortKeys={sortKeysOf((view?.columns ?? []).map((column) => column.key), code)}
          showPeriod={!LIVE_ONLY.includes(code)}
          {...(isRegisterReport(code) ? { record: RECORD_WORDS[code] as { severities: readonly string[]; states: readonly string[] } } : {})}
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
            {code === 'schedule-delay' ? <EvmPanel view={view} curve={curve} /> : null}
            {code === 'change-growth' ? <TierSplitPanel view={view} /> : null}
            {code === 'retention-guarantee' ? <LadderPanel view={view} /> : null}
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
            {typeof view.notes.unlinked_open_issues === 'number' && view.notes.unlinked_open_issues > 0 ? (
              <p className="callout ca1-notice" role="status" data-testid="unlinked-note">
                {t('ca3.notes.unlinked', { count: view.notes.unlinked_open_issues })}
              </p>
            ) : null}
            {isRegisterReport(code) ? <RelatedLinks code={code} /> : null}
            <RulesNote rules={view.rules} />
            <DefinitionsList definitions={view.definitions} asOf={view.context.asOf} />
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
