import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { StatusBadge } from './components';
import { useContracts } from './hooks';
import { statusLabel, typeLabel } from './labels';
import { CONTRACT_STATUSES, CREATE_PERMISSION, DRAFT_PATH, EMPTY_FILTER, amountText, draftLink, filterContracts } from './model';
import type { ContractStatus, ListFilter } from './model';
import './ctr.css';

/** CTR-01: the register of contracts in the scope of the signed-in member, with the project, the contractor, the value and the status. */
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
  const state = useScreenState({ isLoading: contracts.isLoading, error: contracts.error, data: contracts.data });
  const shown = useMemo(() => filterContracts(contracts.data ?? [], filter), [contracts.data, filter]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.list.page.title')}</h1>
          <p>{t('ctr.list.page.subtitle')}</p>
        </div>
        {canCreate ? (
          <Link className="button primary" to={DRAFT_PATH}>
            {t('ctr.list.create.action')}
          </Link>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void contracts.refetch()}>
        <div className="card">
          <form className="ctr-filters" role="search" aria-label={t('ctr.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="contract-query">{t('ctr.list.query.label')}</label>
              <input id="contract-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="contract-status">{t('ctr.list.status.label')}</label>
              <select id="contract-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as ContractStatus | '' })}>
                <option value="">{t('ctr.list.status.all')}</option>
                {CONTRACT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
          </form>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('ctr.list.noMatch.notice')}
            </p>
          ) : (
            <table className="table" data-testid="contracts">
              <thead>
                <tr>
                  <th scope="col">{t('ctr.list.column.code')}</th>
                  <th scope="col">{t('ctr.list.column.title')}</th>
                  <th scope="col">{t('ctr.list.column.project')}</th>
                  <th scope="col">{t('ctr.list.column.contractor')}</th>
                  <th scope="col">{t('ctr.list.column.type')}</th>
                  <th scope="col">{t('ctr.list.column.value')}</th>
                  <th scope="col">{t('ctr.list.column.due')}</th>
                  <th scope="col">{t('ctr.list.column.status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((contract) => (
                  <tr key={contract.id} data-contract-id={contract.id}>
                    <th scope="row">
                      <Link to={draftLink(contract.id)}>{contract.code}</Link>
                    </th>
                    <td>{contract.title ?? t('ctr.list.none.text')}</td>
                    <td>{contract.projectCode}</td>
                    <td>
                      {contract.contractorName ?? t('ctr.list.none.text')}
                      {contract.isJointVenture ? <span className="ctr-badge"> {t('ctr.list.venture.badge')}</span> : null}
                    </td>
                    <td>{typeLabel(t, contract.type)}</td>
                    <td className="ctr-amount">{t('ctr.value.amount', { amount: amountText(contract.contractValueVnd, locale) })}</td>
                    <td>{contract.completionDue ?? t('ctr.list.none.text')}</td>
                    <td>
                      <StatusBadge status={contract.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('ctr.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
