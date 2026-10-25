import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { CancelDialog, RecoveryDialog } from './AdvanceDialogs';
import { useAdvances } from './hooks';
import { kindLabel, statusLabel } from './labels';
import { STATUSES, isOverdue, scheduleLink, signedAmountText } from './model';
import type { Advance } from './model';
import '../pay.css';

/**
 * PAY-07: the advances the caller may see and how much of each has come back (ST-PAY-004, PAY 3.2), narrowed by contract and status. For every advance: what was paid, what was recovered, what is
 * still owed, the day it must be recovered by (a land clearance advance has one) and the days it is late, and the share of the work of the member after which it is recovered in full. A person
 * who may record a recovery that no payment makes, or cancel an advance that is only planned, has the buttons; the server judges each command again.
 */
export default function AdvanceListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <AdvanceListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'recovery' | 'cancel'; advance: Advance };

function AdvanceListContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contractId = search.get('contract');
  const status = search.get('status');
  const advances = useAdvances({ contractId, status });
  // The contracts are only the choices of the filter: a reader who may not list them still reads the advances.
  const contracts = useContracts();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: advances.isLoading, error: advances.error, data: advances.data, isEmpty: () => false });
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const writable = mode !== 'READ_ONLY';
  const setFilter = (name: 'contract' | 'status', value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setSearch(next, { replace: true });
  };
  const finished = (message: string) => (): void => {
    setDone(message);
    setDialog(undefined);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.advance.list.title')}</h1>
          <p>{t('pay.advance.list.subtitle')}</p>
        </div>
      </div>
      <article className="card" aria-label={t('pay.advance.list.filter')}>
        <div className="pay-form-grid">
          <label>
            {t('pay.advance.list.contract')}
            <select value={contractId ?? ''} onChange={(event) => setFilter('contract', event.target.value)} data-testid="filter-contract">
              <option value="">{t('pay.advance.list.all')}</option>
              {(contracts.data ?? []).map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('pay.advance.list.status')}
            <select value={status ?? ''} onChange={(event) => setFilter('status', event.target.value)} data-testid="filter-status">
              <option value="">{t('pay.advance.list.all')}</option>
              {STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {statusLabel(t, candidate)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </article>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void advances.refetch()}>
        <article className="card" aria-label={t('pay.advance.list.title')}>
          {(advances.data ?? []).length === 0 ? (
            <p className="sub" data-testid="no-advances">
              {t('pay.advance.list.empty')}
            </p>
          ) : (
            <table className="table" data-testid="advances">
              <thead>
                <tr>
                  <th scope="col">{t('pay.advance.column.contract')}</th>
                  <th scope="col">{t('pay.advance.column.member')}</th>
                  <th scope="col">{t('pay.advance.column.status')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.advance.column.paid')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.advance.column.recovered')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.advance.column.outstanding')}
                  </th>
                  <th scope="col">{t('pay.advance.column.deadline')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.advance.column.threshold')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.advance.column.overdue')}
                  </th>
                  <th scope="col">{t('pay.advance.column.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(advances.data ?? []).map((advance) => (
                  <tr key={advance.id} data-advance={advance.id} data-status={advance.status}>
                    <td>
                      <Link to={scheduleLink(advance.contract.id, advance.id)} data-testid="schedule">
                        {advance.contract.code}
                      </Link>{' '}
                      <span className="sub" data-testid="tranche">
                        {t('pay.advance.tranche', { no: advance.trancheNo, kind: kindLabel(t, advance.kind) })}
                      </span>
                    </td>
                    <td data-testid="member">{advance.party.name ?? advance.party.role}</td>
                    <td>
                      <span className={advance.status === 'CANCELLED' || isOverdue(advance) ? 'pay-badge warning' : 'pay-badge'} data-testid="status">
                        {statusLabel(t, advance.status)}
                      </span>
                    </td>
                    <td className="pay-amount" data-testid="paid">
                      {money(advance.paidVnd)}
                    </td>
                    <td className="pay-amount" data-testid="recovered">
                      {money(advance.recoveredVnd)}
                    </td>
                    <td className="pay-amount" data-testid="outstanding">
                      {money(advance.outstandingVnd)}
                    </td>
                    <td data-testid="deadline">{advance.recoveryDeadline ?? ''}</td>
                    <td className="pay-amount" data-testid="threshold">
                      {t('pay.advance.threshold', { pct: advance.thresholdPct })}
                    </td>
                    <td className="pay-amount" data-testid="overdue">
                      {advance.overdueDays ?? ''}
                    </td>
                    <td>
                      {writable && advance.actions.recordRecovery ? (
                        <button type="button" onClick={() => setDialog({ kind: 'recovery', advance })} data-action="recover">
                          {t('pay.advance.action.recover')}
                        </button>
                      ) : null}{' '}
                      {writable && advance.actions.cancel ? (
                        <button type="button" onClick={() => setDialog({ kind: 'cancel', advance })} data-action="cancel">
                          {t('pay.advance.action.cancel')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </StateBoundary>
      {dialog?.kind === 'recovery' ? <RecoveryDialog advance={dialog.advance} onDone={finished(t('pay.advance.done.recovered'))} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'cancel' ? <CancelDialog advance={dialog.advance} onDone={finished(t('pay.advance.done.cancelled'))} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('pay.advance.list.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
