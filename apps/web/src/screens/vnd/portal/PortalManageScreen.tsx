import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import type { ScreenState } from '../../../states/StateBoundary';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { dayText, failureStatus, vietnamStamp } from '../shared/vnd-model';
import { CountInfo, Empty, Fact, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useReceipt, useWriter } from '../shared/vnd-ui';
import { AcceptRequestDialog, CreateRequestDialog, ReturnRequestDialog } from './portal-dialogs';
import { useReconfirmations, useStaffRequests } from './portal-hooks';
import { reconfirmStateLabel, requestKindLabel, requestStatusLabel } from './portal-labels';
import { PORTAL_PERMISSION, RECONFIRM_STATES, REQUEST_KINDS, REQUEST_STATUSES, answeredLate, requestStatusIcon, requestStatusTone } from './portal-model';
import type { ReconfirmationLine, StaffRequest } from './portal-model';
import { ReconfirmPill, RequestClockCell } from './portal-ui';
import './portal.css';

type Dialog = { kind: 'create' } | { kind: 'accept'; request: StaffRequest } | { kind: 'return'; request: StaffRequest } | { kind: 'cancel'; request: StaffRequest };
type Tab = 'requests' | 'reconfirmations';

/**
 * VND-20, the management of the contractor portal by staff: the requests sent to contractors with their time limits and answers (accept, return with a reason, cancel with a reason), and the yearly re-confirmation of the
 * profile of every contractor. A lapsed re-confirmation is shown, never a block: the register keeps working with the contractor.
 */
export default function PortalManageScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Manage key={scope} route={route} />;
}

function Manage({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [tab, setTab] = useState<Tab>('requests');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const canManage = !writer.readOnly && writer.can(PORTAL_PERMISSION.manage);
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnp.manage.page.title')}
        subtitle={t('vnp.manage.page.subtitle')}
        actions={
          canManage ? (
            <button type="button" className="ui-button ui-button--primary" data-testid="create-request" onClick={() => setDialog({ kind: 'create' })}>
              {t('vnp.manage.create.action')}
            </button>
          ) : undefined
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      <div className="portal-nav" role="group" aria-label={t('vnp.manage.tabs.label')}>
        <button type="button" className="ui-button ui-button--outline" aria-pressed={tab === 'requests'} data-testid="tab-requests" onClick={() => setTab('requests')}>
          {t('vnp.manage.tab.requests')}
        </button>
        <button type="button" className="ui-button ui-button--outline" aria-pressed={tab === 'reconfirmations'} data-testid="tab-reconfirmations" onClick={() => setTab('reconfirmations')}>
          {t('vnp.manage.tab.reconfirmations')}
        </button>
      </div>
      {tab === 'requests' ? (
        <RequestsTab canManage={canManage} onAccept={(request) => setDialog({ kind: 'accept', request })} onReturn={(request) => setDialog({ kind: 'return', request })} onCancel={(request) => setDialog({ kind: 'cancel', request })} />
      ) : (
        <ReconfirmationsTab />
      )}
      {dialog?.kind === 'create' && <CreateRequestDialog onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.create.title.text'))} />}
      {dialog?.kind === 'accept' && <AcceptRequestDialog request={dialog.request} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.accept.title.text'))} />}
      {dialog?.kind === 'return' && <ReturnRequestDialog mode="return" request={dialog.request} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.return.title.text'))} />}
      {dialog?.kind === 'cancel' && <ReturnRequestDialog mode="cancel" request={dialog.request} onClose={() => setDialog(undefined)} onDone={() => done(t('vnp.cancel.title.text'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

function RequestsTab({ canManage, onAccept, onReturn, onCancel }: { canManage: boolean; onAccept: (request: StaffRequest) => void; onReturn: (request: StaffRequest) => void; onCancel: (request: StaffRequest) => void }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState({ status: '', kind: '', contractor: '' });
  const query = useStaffRequests(filters);
  const page = query.data;
  const filtered = filters.status !== '' || filters.kind !== '' || filters.contractor !== '';
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: page === undefined ? query.error : undefined, data: page, isEmpty: (data) => !filtered && (data as { items: unknown[] }).items.length === 0 });
  const refreshFailed = query.isError && page !== undefined;
  return (
    <>
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {page !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnp.manage.counts.title')} status={<UnverifiedPill />}>
              <dl className="vnd-facts" data-testid="request-counts">
                <Fact label={t('vnp.manage.counts.open.label')} testId="count-open">
                  {page.counts.open}
                </Fact>
                <Fact label={t('vnp.manage.counts.responded.label')} testId="count-responded">
                  {page.counts.responded}
                </Fact>
                <Fact label={t('vnp.manage.counts.overdue.label')} testId="count-overdue">
                  {page.counts.overdue}
                </Fact>
                <Fact label={t('vnp.manage.counts.inTime.label')} testId="count-in-time">
                  <span className="vnd-with-info">
                    {page.in_time_pct === null ? t('vnp.manage.counts.none.text') : `${page.in_time_pct}%`}
                    <CountInfo name={t('vnp.manage.counts.inTime.label')} formula={t('vnp.manage.counts.inTime.formula')} source={t('vnp.manage.counts.inTime.source')} asOf={page.as_of} unverified />
                  </span>
                </Fact>
              </dl>
            </SectionCard>
            <SectionCard title={t('vnp.manage.requests.title')}>
              <div className="vnd-filters">
                <label>
                  {t('vnp.requests.filter.status.label')}
                  <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
                    <option value="">{t('vnp.requests.filter.all.text')}</option>
                    {REQUEST_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {requestStatusLabel(t, value)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('vnp.manage.filter.kind.label')}
                  <select value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value })}>
                    <option value="">{t('vnp.requests.filter.all.text')}</option>
                    {REQUEST_KINDS.map((value) => (
                      <option key={value} value={value}>
                        {requestKindLabel(t, value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {page.items.length === 0 ? (
                <Empty text={t('vnp.requests.filtered.empty.text')} testId="manage-filtered-empty" />
              ) : (
                <DataTable<StaffRequest>
                  caption={t('vnp.manage.requests.caption')}
                  rows={page.items}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-request-id': row.id })}
                  columns={[
                    { key: 'contractor', header: t('vnp.manage.column.contractor'), pinned: true, render: (row) => row.contractor_name },
                    {
                      key: 'request',
                      header: t('vnp.manage.column.request'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{row.title}</span>
                          <span className="vnd-days">{requestKindLabel(t, row.kind)}</span>
                        </span>
                      ),
                    },
                    { key: 'clock', header: t('vnp.manage.column.clock'), render: (row) => <RequestClockCell clock={row.clock} dueAt={row.due_at} asOf={page.as_of} /> },
                    {
                      key: 'status',
                      header: t('vnp.manage.column.status'),
                      render: (row) => (
                        <StatusPill tone={requestStatusTone(row.status)} icon={requestStatusIcon(row.status)}>
                          {requestStatusLabel(t, row.status)}
                        </StatusPill>
                      ),
                    },
                    {
                      key: 'answer',
                      header: t('vnp.manage.column.answer'),
                      render: (row) =>
                        row.response_text === null ? (
                          '–'
                        ) : (
                          <span className="vnd-stack" data-testid="staff-answer">
                            <span>{row.response_text}</span>
                            {answeredLate(row) && <span className="portal-late">{t('vnp.requests.late.label')}</span>}
                          </span>
                        ),
                    },
                    {
                      key: 'actions',
                      header: t('vnp.manage.column.actions'),
                      render: (row) =>
                        canManage ? (
                          <span className="vnd-row">
                            {row.status === 'RESPONDED' && (
                              <>
                                <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="accept" onClick={() => onAccept(row)}>
                                  {t('vnp.manage.accept.action')}
                                </button>
                                <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="return" onClick={() => onReturn(row)}>
                                  {t('vnp.manage.return.action')}
                                </button>
                              </>
                            )}
                            {(row.status === 'OPEN' || row.status === 'RESPONDED') && (
                              <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="cancel" onClick={() => onCancel(row)}>
                                {t('vnp.manage.cancel.action')}
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
    </>
  );
}

function ReconfirmationsTab() {
  const { t } = useTranslation();
  const [state, setState] = useState('');
  const query = useReconfirmations(state);
  const page = query.data;
  const screenState: ScreenState = useScreenState({ isLoading: query.isLoading, error: page === undefined ? query.error : undefined, data: page, isEmpty: (data) => state === '' && (data as { items: unknown[] }).items.length === 0 });
  const refreshFailed = query.isError && page !== undefined;
  const notFound = page === undefined && failureStatus(query.error) === 404;
  return (
    <>
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={notFound ? 'empty' : screenState} onRetry={() => void query.refetch()}>
        {page !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('vnp.manage.reconfirm.counts.title')} status={page.policy.unverified ? <UnverifiedPill /> : undefined}>
              <dl className="vnd-facts" data-testid="reconfirm-counts">
                <Fact label={t('vnp.manage.reconfirm.current.label')} testId="rc-current">
                  <span className="vnd-with-info">
                    {page.current_pct === null ? t('vnp.manage.counts.none.text') : `${page.current_pct}%`}
                    <PolicyInfo name={t('vnp.manage.reconfirm.current.label')} policy={page.policy} />
                  </span>
                </Fact>
                {RECONFIRM_STATES.map((value) => (
                  <Fact key={value} label={reconfirmStateLabel(t, value)} testId={`rc-state-${value.toLowerCase()}`}>
                    {countOf(page.counts, value)}
                  </Fact>
                ))}
              </dl>
            </SectionCard>
            <SectionCard title={t('vnp.manage.reconfirm.title')}>
              <div className="vnd-filters">
                <label>
                  {t('vnp.manage.reconfirm.filter.label')}
                  <select value={state} onChange={(event) => setState(event.target.value)}>
                    <option value="">{t('vnp.requests.filter.all.text')}</option>
                    {RECONFIRM_STATES.map((value) => (
                      <option key={value} value={value}>
                        {reconfirmStateLabel(t, value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {page.items.length === 0 ? (
                <Empty text={t('vnp.requests.filtered.empty.text')} testId="reconfirm-filtered-empty" />
              ) : (
                <DataTable<ReconfirmationLine>
                  caption={t('vnp.manage.reconfirm.caption')}
                  rows={page.items}
                  rowKey={(row) => row.contractor_id}
                  rowAttrs={(row) => ({ 'data-contractor-id': row.contractor_id })}
                  columns={[
                    {
                      key: 'contractor',
                      header: t('vnp.manage.column.contractor'),
                      pinned: true,
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{row.contractor_name}</span>
                          <span className="vnd-days">{row.tax_identifier}</span>
                        </span>
                      ),
                    },
                    { key: 'state', header: t('vnp.manage.column.status'), render: (row) => <ReconfirmPill state={row.state} /> },
                    { key: 'due', header: t('vnp.manage.reconfirm.column.due'), render: (row) => (row.due_on === null ? '–' : dayText(row.due_on)) },
                    { key: 'last', header: t('vnp.manage.reconfirm.column.last'), render: (row) => (row.last_confirmed_at === null ? t('vnp.home.reconfirm.never.text') : vietnamStamp(row.last_confirmed_at)) },
                    { key: 'declaration', header: t('vnp.manage.reconfirm.column.declaration'), render: (row) => row.declaration_version ?? '–' },
                  ]}
                />
              )}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
    </>
  );
}

function countOf(counts: { current: number; due_soon: number; overdue: number; lapsed: number; never: number }, state: (typeof RECONFIRM_STATES)[number]): number {
  switch (state) {
    case 'CURRENT':
      return counts.current;
    case 'DUE_SOON':
      return counts.due_soon;
    case 'OVERDUE':
      return counts.overdue;
    case 'LAPSED':
      return counts.lapsed;
    case 'NEVER':
      return counts.never;
  }
}
