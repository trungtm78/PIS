import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { useContracts } from '../../ctr/hooks';
import { ScopeBar, sumAmounts } from '../../ctr/kit';
import { CancelDialog, RecoveryDialog } from './AdvanceDialogs';
import { useAdvances } from './hooks';
import { kindLabel, statusLabel } from './labels';
import { STATUSES, isOverdue, scheduleLink, signedAmountText } from './model';
import type { Advance } from './model';

type AdvanceStatus = (typeof STATUSES)[number];
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

  const rows = advances.data ?? [];
  const filtered = contractId !== null || status !== null;
  const standing = rows.filter((advance) => advance.status !== 'CANCELLED');
  const figures = t('w2pay.pay.advance.group.figures');
  const columns: DataTableColumn<Advance>[] = [
    {
      key: 'contract',
      header: t('pay.advance.column.contract'),
      pinned: true,
      render: (advance) => (
        <span data-advance={advance.id} data-status={advance.status}>
          <Link to={scheduleLink(advance.contract.id, advance.id)} data-testid="schedule">
            {advance.contract.code}
          </Link>{' '}
          <span className="sub" data-testid="tranche">
            {t('pay.advance.tranche', { no: advance.trancheNo, kind: kindLabel(t, advance.kind) })}
          </span>
        </span>
      ),
    },
    { key: 'member', header: t('pay.advance.column.member'), render: (advance) => <span data-testid="member">{advance.party.name ?? advance.party.role}</span> },
    {
      key: 'status',
      header: t('pay.advance.column.status'),
      render: (advance) => (
        <span data-testid="status">
          <StatusPill tone={advanceTone(advance)}>{statusLabel(t, advance.status)}</StatusPill>
        </span>
      ),
    },
    { key: 'paid', header: t('pay.advance.column.paid'), group: figures, align: 'right', render: (advance) => <span data-testid="paid">{money(advance.paidVnd)}</span> },
    { key: 'recovered', header: t('pay.advance.column.recovered'), group: figures, align: 'right', render: (advance) => <span data-testid="recovered">{money(advance.recoveredVnd)}</span> },
    { key: 'outstanding', header: t('pay.advance.column.outstanding'), group: figures, align: 'right', render: (advance) => <span data-testid="outstanding">{money(advance.outstandingVnd)}</span> },
    { key: 'deadline', header: t('pay.advance.column.deadline'), render: (advance) => <span data-testid="deadline">{advance.recoveryDeadline ?? ''}</span> },
    {
      key: 'threshold',
      header: t('pay.advance.column.threshold'),
      align: 'right',
      render: (advance) => <span data-testid="threshold">{t('pay.advance.threshold', { pct: advance.thresholdPct })}</span>,
    },
    { key: 'overdue', header: t('pay.advance.column.overdue'), align: 'right', render: (advance) => <span data-testid="overdue">{advance.overdueDays ?? ''}</span> },
    {
      key: 'actions',
      header: t('pay.advance.column.actions'),
      render: (advance) => (
        <div className="pay-row-actions">
          {writable && advance.actions.recordRecovery ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'recovery', advance })} data-action="recover">
              {t('pay.advance.action.recover')}
            </button>
          ) : null}
          {writable && advance.actions.cancel ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'cancel', advance })} data-action="cancel">
              {t('pay.advance.action.cancel')}
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.advance.list.title')}</h1>
          <p>{t('pay.advance.list.subtitle')}</p>
        </div>
      </div>
      <ScopeBar
        money
        extra={[
          { label: t('w2pay.pay.ctx.contract'), value: (contracts.data ?? []).find((contract) => contract.id === contractId)?.code ?? (contractId === null ? t('w2pay.pay.ctx.all') : contractId) },
          { label: t('w2pay.pay.ctx.status'), value: STATUSES.find((candidate) => candidate === status) === undefined ? t('w2pay.pay.ctx.all') : statusLabel(t, status as AdvanceStatus) },
        ]}
        updatedAt={advances.dataUpdatedAt}
        stale={advances.isRefetchError}
      />
      <FilterPanel applied={[contractId, status].filter((value) => value !== null).length} unitLabel={t('w2pay.ctx.unit')}>
        <div className="pay-form-grid" role="group" aria-label={t('pay.advance.list.filter')}>
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
      </FilterPanel>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void advances.refetch()}>
        {rows.length === 0 ? (
          <div className="pay-row-actions">
            <p className="sub" data-testid="no-advances">
              {t('pay.advance.list.empty')}
            </p>
            {filtered ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setSearch(new URLSearchParams(), { replace: true })}>
                {t('ui.dataTable.clearFilters')}
              </button>
            ) : null}
          </div>
        ) : (
          <div data-testid="advances">
            <DataTable
              caption={t('pay.advance.list.title')}
              columns={columns}
              rows={rows}
              rowKey={(advance) => advance.id}
              rowAttrs={(advance) => ({ 'data-advance': advance.id, 'data-status': advance.status })}
              totalsLabel={t('w2pay.pay.advance.totals')}
              totals={{
                paid: money(sumAmounts(standing.map((advance) => advance.paidVnd))),
                recovered: money(sumAmounts(standing.map((advance) => advance.recoveredVnd))),
                outstanding: money(sumAmounts(standing.map((advance) => advance.outstandingVnd))),
              }}
            />
            <p className="sub" data-testid="totals-note">
              {t('w2pay.pay.advance.totals.note', { standing: standing.length, total: rows.length })}
            </p>
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'recovery' ? <RecoveryDialog advance={dialog.advance} onDone={finished(t('pay.advance.done.recovered'))} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'cancel' ? <CancelDialog advance={dialog.advance} onDone={finished(t('pay.advance.done.cancelled'))} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('pay.advance.list.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The state of an advance as a pill: what was cancelled or is late is a warning, what is back in full is green, what is still being recovered is blue. */
function advanceTone(advance: Advance): Tone {
  if (advance.status === 'CANCELLED' || isOverdue(advance)) return 'warning';
  if (advance.status === 'FULLY_RECOVERED') return 'success';
  return advance.status === 'PLANNED' ? 'neutral' : 'info';
}
