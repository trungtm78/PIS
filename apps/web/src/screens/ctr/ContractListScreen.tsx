import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { AnalyticsFilters, ReportContext, ReportKpis, ReportTable } from './analytics/components';
import { usePortfolio } from './analytics/hooks';
import { DEFAULT_QUERY, EMPTY_ANALYTICS_FILTER, filterCount } from './analytics/model';
import type { AnalyticsFilter, RowView } from './analytics/model';
import { StatusBadge } from './components';
import { useContracts } from './hooks';
import { ScopeBar } from './kit';
import { typeLabel } from './labels';
import { CREATE_PERMISSION, DRAFT_PATH, amountText, draftLink } from './model';
import type { ContractLine } from './model';
import './ctr.css';

/**
 * CTR-01: the register of contracts in the scope of the signed-in member, read from the portfolio of the server: the filters, the sort, the pages and the totals row are the server's (the total is of everything that
 * matches, not of the page, and it is never added up here). A member the portfolio refuses (a guest contractor is not a reader of the portfolio) is shown the register of their own contracts as before, with no totals.
 */
export default function ContractListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ContractListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

const isRefusal = (error: unknown): boolean => error instanceof ApiError && error.status === 403;

function ContractListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canCreate = (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && mode !== 'READ_ONLY';
  const [filter, setFilter] = useState<AnalyticsFilter>(EMPTY_ANALYTICS_FILTER);
  const [sort, setSort] = useState('code');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [size, setSize] = useState(20);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [index, setIndex] = useState(0);
  const query = { ...DEFAULT_QUERY, filter, sort, direction, limit: size, cursor: cursors[index] ?? null };
  const portfolio = usePortfolio(query);
  const refused = isRefusal(portfolio.error);
  // The register of the member's own contracts is read only when the portfolio is refused.
  const own = useContracts(refused);
  const view = portfolio.data;
  const state = useScreenState({
    isLoading: refused ? own.isLoading : portfolio.isLoading,
    error: refused ? own.error : portfolio.error,
    data: refused ? own.data : view,
    isEmpty: (data) => Array.isArray(data) && data.length === 0,
  });
  const start = (): void => {
    setCursors([null]);
    setIndex(0);
  };
  const change = (next: AnalyticsFilter): void => {
    setFilter(next);
    start();
  };
  const filtered = filterCount(filter) > 0;
  const rows = view?.items ?? [];
  const from = index * size + 1;
  const header = (
    <div className="heading">
      <div>
        <h1 id="screen-title">{t('ctr.list.page.title')}</h1>
        <p>{t('ctr.list.page.subtitle')}</p>
      </div>
      {canCreate ? (
        <Link className="ui-button ui-button--primary" to={DRAFT_PATH}>
          {t('ctr.list.create.action')}
        </Link>
      ) : null}
    </div>
  );
  const footer = <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>;

  if (refused && !isRefusal(own.error)) {
    return (
      <section data-screen-id={route.id} aria-labelledby="screen-title">
        {header}
        <ScopeBar money updatedAt={own.dataUpdatedAt} stale={own.isRefetchError} />
        <StateBoundary state={state} onRetry={() => void own.refetch()}>
          <p className="callout ca1-notice" role="status" data-testid="own-register-note">
            {t('ca1.register.own')}
          </p>
          <OwnRegister contracts={own.data ?? []} />
        </StateBoundary>
        {footer}
      </section>
    );
  }

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {header}
      {view === undefined ? <ScopeBar money /> : <ReportContext context={view.context} updatedAt={portfolio.dataUpdatedAt} onUseLatest={(period) => change({ ...filter, period, asOf: '' })} />}
      <StateBoundary state={state} onRetry={() => void portfolio.refetch()}>
        <AnalyticsFilters
          value={filter}
          onChange={change}
          sort={sort}
          direction={direction}
          sortKeys={['code', 'title', 'project_code', 'contractor_name', 'contract_status', 'contract_value_vnd', 'days_late']}
          onSort={(nextSort, nextDirection) => {
            setSort(nextSort);
            setDirection(nextDirection);
            start();
          }}
          showPeriod={false}
        />
        {view === undefined ? null : (
          <>
            {portfolio.isError ? (
              <p className="callout warning ca1-notice" role="status">
                <StatusPill tone="warning">{t('ca1.refetch.stale')}</StatusPill>
              </p>
            ) : null}
            <ReportKpis view={view} />
            {rows.length === 0 ? (
              <div className="ctr-row-actions">
                <p className="callout" role="status" data-testid={filtered ? 'no-match' : 'no-contracts'}>
                  {filtered ? t('ctr.list.noMatch.notice') : t('ca1.empty.none')}
                </p>
                {filtered ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => change(EMPTY_ANALYTICS_FILTER)}>
                    {t('ui.dataTable.clearFilters')}
                  </button>
                ) : null}
              </div>
            ) : (
              <div data-testid="contracts">
                <ReportTable
                  view={view}
                  caption={t('ctr.list.page.title')}
                  linkOf={(row: RowView) => (
                    <span data-contract-id={row.contractId}>
                      <Link to={draftLink(row.contractId)}>{String(row.cells.code ?? row.contractId)}</Link>
                    </span>
                  )}
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
                <p className="sub" data-testid="totals-note">
                  {t('ca1.register.totals.note', { total: view.totals.rows })}
                </p>
              </div>
            )}
          </>
        )}
      </StateBoundary>
      {footer}
    </section>
  );
}

/** The register of the contracts of a member the portfolio does not serve (a guest contractor): the lines the server shows them, with no total. */
function OwnRegister({ contracts }: { contracts: readonly ContractLine[] }) {
  const { t, locale } = useTranslation();
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const from = pageIndex * pageSize + 1;
  const rows = contracts.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  const columns: DataTableColumn<ContractLine>[] = [
    {
      key: 'code',
      header: t('ctr.list.column.code'),
      pinned: true,
      render: (contract) => (
        <span data-contract-id={contract.id}>
          <Link to={draftLink(contract.id)}>{contract.code}</Link>
        </span>
      ),
    },
    { key: 'title', header: t('ctr.list.column.title'), render: (contract) => contract.title ?? t('ctr.list.none.text') },
    { key: 'project', header: t('ctr.list.column.project'), render: (contract) => contract.projectCode },
    {
      key: 'contractor',
      header: t('ctr.list.column.contractor'),
      render: (contract) => (
        <>
          {contract.contractorName ?? t('ctr.list.none.text')}
          {contract.isJointVenture ? (
            <>
              {' '}
              <StatusPill tone="info">{t('ctr.list.venture.badge')}</StatusPill>
            </>
          ) : null}
        </>
      ),
    },
    { key: 'type', header: t('ctr.list.column.type'), render: (contract) => typeLabel(t, contract.type) },
    { key: 'value', header: t('ctr.list.column.value'), align: 'right', render: (contract) => t('ctr.value.amount', { amount: amountText(contract.contractValueVnd, locale) }) },
    { key: 'due', header: t('ctr.list.column.due'), render: (contract) => contract.completionDue ?? t('ctr.list.none.text') },
    { key: 'status', header: t('ctr.list.column.status'), render: (contract) => <StatusBadge status={contract.status} /> },
  ];
  return (
    <div data-testid="contracts">
      <DataTable
        caption={t('ctr.list.page.title')}
        columns={columns}
        rows={rows}
        rowKey={(contract) => contract.id}
        rowAttrs={(contract) => ({ 'data-contract-id': contract.id })}
        page={{ from, to: from + rows.length - 1, total: contracts.length, size: pageSize, index: pageIndex, onPage: setPageIndex, onSize: (size) => { setPageSize(size); setPageIndex(0); } }}
      />
    </div>
  );
}
