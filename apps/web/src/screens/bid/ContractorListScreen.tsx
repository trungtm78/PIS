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
import { RestrictionBadge, VerificationBadge } from './components';
import { useContractors } from './hooks';
import { statusLabel } from './labels';
import { EMPTY_FILTER, MANAGE_PERMISSION, VERIFICATION_STATUSES, filterContractors, profileLink } from './model';
import type { ContractorLine, ListFilter, VerificationStatus } from './model';
import RegisterPanel from './RegisterPanel';
import './bid.css';

/**
 * BID-01: the registry of contractors. A contractor is identified by its tax id, verified on evidence by a person other than the registrant;
 * the tax id is covered unless the caller holds the full right to read. A restriction in force is shown beside the verification (ST-BID-002).
 */
export default function ContractorListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The registry belongs to one membership (a guest sees one contractor, the tax id is covered by right): a switch starts the screen over.
  return <ContractorListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContractorListContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const mayRegister = (permissions === undefined || permissions.includes(MANAGE_PERMISSION)) && mode !== 'READ_ONLY';
  const contractors = useContractors();
  const [filter, setFilter] = useState<ListFilter>(EMPTY_FILTER);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const state = useScreenState({ isLoading: contractors.isLoading, error: contractors.error, data: contractors.data });
  const shown = useMemo(() => filterContractors(contractors.data ?? [], filter), [contractors.data, filter]);
  const applied = (filter.query.trim() === '' ? 0 : 1) + (filter.status === '' ? 0 : 1) + (filter.restrictedOnly ? 1 : 0);
  const change = (next: ListFilter): void => {
    setFilter(next);
    setPageIndex(0);
  };
  const from = pageIndex * pageSize + 1;
  const rows = shown.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  const columns: DataTableColumn<ContractorLine>[] = [
    {
      key: 'taxId',
      header: t('bid.list.column.taxId'),
      pinned: true,
      render: (contractor) => (
        <span>
          <Link to={profileLink(contractor.id)}>
            <code>{contractor.taxIdentifier}</code>
          </Link>
        </span>
      ),
    },
    { key: 'name', header: t('bid.list.column.name'), render: (contractor) => contractor.legalName },
    { key: 'contracts', header: t('bid.list.column.contracts'), align: 'right', render: (contractor) => contractor.contractCount },
    { key: 'verification', header: t('bid.list.column.verification'), render: (contractor) => <VerificationBadge contractor={contractor} /> },
    { key: 'restriction', header: t('bid.list.column.restriction'), render: (contractor) => <RestrictionBadge restriction={contractor.restrictionInForce} /> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.list.page.title')}</h1>
          <p>{t('bid.list.page.subtitle')}</p>
        </div>
      </div>
      <ScopeBar
        extra={[{ label: t('w2pay.bid.ctx.verification'), value: filter.status === '' ? t('w2pay.pay.ctx.all') : statusLabel(t, filter.status) }]}
        updatedAt={contractors.dataUpdatedAt}
        stale={contractors.isRefetchError}
      />
      <StateBoundary state={state} onRetry={() => void contractors.refetch()}>
        <FilterPanel applied={applied}>
          <form className="bid-filters" role="search" aria-label={t('bid.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="contractor-query">{t('bid.list.query.label')}</label>
              <input id="contractor-query" value={filter.query} onChange={(event) => change({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="contractor-status">{t('bid.list.status.label')}</label>
              <select id="contractor-status" value={filter.status} onChange={(event) => change({ ...filter, status: event.target.value as VerificationStatus | '' })}>
                <option value="">{t('bid.list.status.all')}</option>
                {VERIFICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={filter.restrictedOnly} onChange={(event) => change({ ...filter, restrictedOnly: event.target.checked })} />
              {t('bid.list.restricted.label')}
            </label>
          </form>
        </FilterPanel>
        {shown.length === 0 ? (
          <div className="bid-row-actions">
            <p className="callout" role="status" data-testid="no-match">
              {t('bid.list.noMatch.notice')}
            </p>
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => change(EMPTY_FILTER)}>
              {t('ui.dataTable.clearFilters')}
            </button>
          </div>
        ) : (
          <div data-testid="contractors">
            <DataTable
              caption={t('bid.list.page.title')}
              columns={columns}
              rows={rows}
              rowKey={(contractor) => contractor.id}
              rowAttrs={(contractor) => ({ 'data-contractor-id': contractor.id })}
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
        <p className="sub">{t('bid.list.count.text', { count: shown.length })}</p>
      </StateBoundary>
      {mayRegister ? <RegisterPanel /> : null}
      <p className="prototype-note">{t('bid.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
