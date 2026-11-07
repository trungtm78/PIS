import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { StatusBadge } from './components';
import { useContracts } from './hooks';
import { ScopeBar, sumAmounts } from './kit';
import { statusLabel, typeLabel } from './labels';
import { CONTRACT_STATUSES, CREATE_PERMISSION, DRAFT_PATH, EMPTY_FILTER, amountText, draftLink, filterContracts } from './model';
import type { ContractLine, ContractStatus, ListFilter } from './model';
import './ctr.css';

/** A contract that was cancelled or ended early adds nothing to what the register is worth. */
const STANDING = (contract: ContractLine): boolean => contract.status !== 'CANCELLED' && contract.status !== 'TERMINATED';

/**
 * CTR-01: the register of contracts in the scope of the signed-in member, with the project, the contractor, the value and the status. The total row adds up the value of the contracts that
 * are shown and still stand (not cancelled, not terminated) and says how many they are.
 */
export default function ContractListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ContractListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContractListContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const canCreate = (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && mode !== 'READ_ONLY';
  const contracts = useContracts();
  const [filter, setFilter] = useState<ListFilter>(EMPTY_FILTER);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const state = useScreenState({ isLoading: contracts.isLoading, error: contracts.error, data: contracts.data });
  const shown = useMemo(() => filterContracts(contracts.data ?? [], filter), [contracts.data, filter]);
  const standing = shown.filter(STANDING);
  const applied = (filter.query.trim() === '' ? 0 : 1) + (filter.status === '' ? 0 : 1);
  const change = (next: ListFilter): void => {
    setFilter(next);
    setPageIndex(0);
  };
  const from = pageIndex * pageSize + 1;
  const rows = shown.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
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
    <section data-screen-id={route.id} aria-labelledby="screen-title">
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
      <ScopeBar
        money
        extra={[{ label: t('w2pay.ctr.ctx.status'), value: filter.status === '' ? t('w2pay.pay.ctx.all') : statusLabel(t, filter.status) }]}
        updatedAt={contracts.dataUpdatedAt}
        stale={contracts.isRefetchError}
      />
      <StateBoundary state={state} onRetry={() => void contracts.refetch()}>
        <FilterPanel applied={applied} unitLabel={t('w2pay.ctx.unit')}>
          <form className="ctr-filters" role="search" aria-label={t('ctr.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="contract-query">{t('ctr.list.query.label')}</label>
              <input id="contract-query" value={filter.query} onChange={(event) => change({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="contract-status">{t('ctr.list.status.label')}</label>
              <select id="contract-status" value={filter.status} onChange={(event) => change({ ...filter, status: event.target.value as ContractStatus | '' })}>
                <option value="">{t('ctr.list.status.all')}</option>
                {CONTRACT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
          </form>
        </FilterPanel>
        {shown.length === 0 ? (
          <div className="ctr-row-actions">
            <p className="callout" role="status" data-testid="no-match">
              {t('ctr.list.noMatch.notice')}
            </p>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => change(EMPTY_FILTER)}>
              {t('ui.dataTable.clearFilters')}
            </button>
          </div>
        ) : (
          <div data-testid="contracts">
            <DataTable
              caption={t('ctr.list.page.title')}
              columns={columns}
              rows={rows}
              rowKey={(contract) => contract.id}
              totalsLabel={t('w2pay.ctr.list.totals')}
              totals={{ value: t('ctr.value.amount', { amount: amountText(sumAmounts(standing.map((contract) => contract.contractValueVnd)), locale) }) }}
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
            <p className="sub" data-testid="totals-note">
              {t('w2pay.ctr.list.totals.note', { standing: standing.length, total: shown.length })}
            </p>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
