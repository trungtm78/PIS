import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { dayText, vietnamStamp } from '../../vnd/shared/vnd-model';
import { Empty, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, useReceipt, useWriter } from '../../vnd/shared/vnd-ui';
import { CheckOutcomeDialog, RecordOutcomeDialog } from './outcome-dialogs';
import { useOutcomes } from './outcome-hooks';
import { decisionLabel, outcomeStatusLabel } from './outcome-labels';
import { OUTCOME_PERMISSION, OUTCOME_STATUSES, feedsFigures, outcomeIcon, outcomeTone } from './outcome-model';
import type { OutcomeLine } from './outcome-model';

type Dialog = { kind: 'record' } | { kind: 'confirm'; line: OutcomeLine } | { kind: 'return'; line: OutcomeLine };

/**
 * BID-34, the outcomes of the petitions of contractors (PORTAL-2). The petition module records that a petition was answered; here one person records what the authority decided (upheld, rejected, withdrawn) with the reference of
 * the decision and a different person confirms it or returns it with a reason. Only confirmed decisions enter the dispute figures of the contractor register (VND-22), so the share of petitions upheld is over decisions only.
 */
export default function PetitionOutcomesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Outcomes key={scope} route={route} />;
}

function Outcomes({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [search] = useSearchParams();
  const petition = search.get('petition') ?? '';
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const query = useOutcomes({ status, petition });
  const list = query.data;
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: list === undefined ? query.error : undefined, data: list, isEmpty: () => false });
  const refreshFailed = query.isError && list !== undefined;
  const canRecord = writer.can(OUTCOME_PERMISSION.record);
  const canConfirm = writer.can(OUTCOME_PERMISSION.confirm);
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('bid34.page.title')}
        subtitle={t('bid34.page.subtitle')}
        asOf={list?.as_of}
        stale={refreshFailed}
        actions={
          canRecord ? (
            <button type="button" className="ui-button ui-button--primary" data-testid="record-outcome" onClick={() => setDialog({ kind: 'record' })}>
              {t('bid34.record.action')}
            </button>
          ) : undefined
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {list !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('bid34.list.title')}>
              <p className="vnd-note" data-testid="figures-note">
                {t('bid34.figures.note')}
              </p>
              <div className="vnd-filters">
                <label>
                  {t('bid34.filter.status.label')}
                  <select value={status} onChange={(event) => setStatus(event.target.value)}>
                    <option value="">{t('bid34.filter.all.text')}</option>
                    {OUTCOME_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {outcomeStatusLabel(t, value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {list.items.length === 0 ? (
                <Empty text={t('bid34.empty.text')} testId="outcomes-empty" />
              ) : (
                <DataTable<OutcomeLine>
                  caption={t('bid34.list.caption')}
                  rows={list.items}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-outcome-id': row.id })}
                  columns={[
                    {
                      key: 'package',
                      header: t('bid34.column.package'),
                      pinned: true,
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{row.package.code}</span>
                          <span className="vnd-days">{row.contractor.legal_name}</span>
                        </span>
                      ),
                    },
                    { key: 'outcome', header: t('bid34.column.outcome'), render: (row) => decisionLabel(t, row.outcome) },
                    {
                      key: 'decision',
                      header: t('bid34.column.decision'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{row.decision_ref}</span>
                          <span className="vnd-days">{dayText(row.decision_on)}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'people',
                      header: t('bid34.column.people'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{t('bid34.recordedBy.text', { name: row.recorded_by_name ?? '–' })}</span>
                          {row.checked_by_name !== null && row.checked_by_name !== undefined && <span className="vnd-days">{t('bid34.checkedBy.text', { name: row.checked_by_name })}</span>}
                          {row.return_reason !== null && row.return_reason !== undefined && <span className="vnd-days">{t('bid34.returnReason.text', { reason: row.return_reason })}</span>}
                        </span>
                      ),
                    },
                    {
                      key: 'status',
                      header: t('bid34.column.status'),
                      render: (row) => (
                        <span className="vnd-stack" data-status={row.status}>
                          <StatusPill tone={outcomeTone(row.status)} icon={outcomeIcon(row.status)}>
                            {outcomeStatusLabel(t, row.status)}
                          </StatusPill>
                          {feedsFigures(row.status) && <span className="vnd-days">{t('bid34.feeds.text')}</span>}
                        </span>
                      ),
                    },
                    {
                      key: 'actions',
                      header: t('bid34.column.actions'),
                      render: (row) =>
                        canConfirm && row.actions.confirm ? (
                          <span className="vnd-row">
                            <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="confirm" onClick={() => setDialog({ kind: 'confirm', line: row })}>
                              {t('bid34.confirm.action')}
                            </button>
                            {row.actions.return && (
                              <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="return" onClick={() => setDialog({ kind: 'return', line: row })}>
                                {t('bid34.return.action')}
                              </button>
                            )}
                          </span>
                        ) : null,
                    },
                  ]}
                />
              )}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'record' && <RecordOutcomeDialog petitionId={petition === '' ? undefined : petition} onClose={() => setDialog(undefined)} onDone={() => done(t('bid34.record.title.text'))} />}
      {dialog?.kind === 'confirm' && <CheckOutcomeDialog mode="confirm" line={dialog.line} onClose={() => setDialog(undefined)} onDone={() => done(t('bid34.confirm.title.text'))} />}
      {dialog?.kind === 'return' && <CheckOutcomeDialog mode="return" line={dialog.line} onClose={() => setDialog(undefined)} onDone={() => done(t('bid34.return.title.text'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}
