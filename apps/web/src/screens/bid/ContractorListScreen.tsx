import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { RestrictionBadge, VerificationBadge } from './components';
import { useContractors } from './hooks';
import { statusLabel } from './labels';
import { EMPTY_FILTER, MANAGE_PERMISSION, VERIFICATION_STATUSES, filterContractors, profileLink } from './model';
import type { ListFilter, VerificationStatus } from './model';
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
  const state = useScreenState({ isLoading: contractors.isLoading, error: contractors.error, data: contractors.data });
  const shown = useMemo(() => filterContractors(contractors.data ?? [], filter), [contractors.data, filter]);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.list.page.title')}</h1>
          <p>{t('bid.list.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void contractors.refetch()}>
        <div className="card">
          <form className="bid-filters" role="search" aria-label={t('bid.list.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="contractor-query">{t('bid.list.query.label')}</label>
              <input id="contractor-query" value={filter.query} onChange={(event) => setFilter({ ...filter, query: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="contractor-status">{t('bid.list.status.label')}</label>
              <select id="contractor-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as VerificationStatus | '' })}>
                <option value="">{t('bid.list.status.all')}</option>
                {VERIFICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(t, status)}
                  </option>
                ))}
              </select>
            </div>
            <label className="check">
              <input type="checkbox" checked={filter.restrictedOnly} onChange={(event) => setFilter({ ...filter, restrictedOnly: event.target.checked })} />
              {t('bid.list.restricted.label')}
            </label>
          </form>
          {shown.length === 0 ? (
            <p className="callout" role="status" data-testid="no-match">
              {t('bid.list.noMatch.notice')}
            </p>
          ) : (
            <table className="table" data-testid="contractors">
              <thead>
                <tr>
                  <th scope="col">{t('bid.list.column.taxId')}</th>
                  <th scope="col">{t('bid.list.column.name')}</th>
                  <th scope="col">{t('bid.list.column.contracts')}</th>
                  <th scope="col">{t('bid.list.column.verification')}</th>
                  <th scope="col">{t('bid.list.column.restriction')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((contractor) => (
                  <tr key={contractor.id} data-contractor-id={contractor.id}>
                    <th scope="row">
                      <Link to={profileLink(contractor.id)}>
                        <code>{contractor.taxIdentifier}</code>
                      </Link>
                    </th>
                    <td>{contractor.legalName}</td>
                    <td>{contractor.contractCount}</td>
                    <td>
                      <VerificationBadge contractor={contractor} />
                    </td>
                    <td>
                      <RestrictionBadge restriction={contractor.restrictionInForce} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="sub">{t('bid.list.count.text', { count: shown.length })}</p>
        </div>
      </StateBoundary>
      {mayRegister ? <RegisterPanel /> : null}
      <p className="prototype-note">{t('bid.list.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
