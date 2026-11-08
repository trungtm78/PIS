import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { useSubcontracts } from '../security/security-hooks';
import { PERMISSION, isUuid, money, primeBelowFloor, shareText, subcontractOverDeclared, subcontractTone } from '../security/security-model';
import type { PendingConfirmation, Subcontract, SubcontractList } from '../security/security-model';
import { camel, dayText, vietnamStamp } from '../shared/vnd-model';
import { ClockCell, Empty, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { ApproveDialog, DeclareDialog, PaymentDialog, ProposeDialog, RejectDialog, TerminateDialog } from './subcontract-dialogs';

type Dialog = { kind: 'declare' } | { kind: 'propose' } | { kind: 'approve' | 'reject' | 'terminate'; row: Subcontract } | { kind: 'pay'; row: Subcontract; request: string };

/**
 * VND-10, the subcontracts of a contract. The law forbids the prime to hand over more than the part its bid named, so the screen sets the sum of the approved shares beside the share the bid declared and the share the prime must
 * keep. A subcontract is proposed, approved by another person (with a reasoned exception when it passes the declaration, if the rule allows), and ends terminated or rejected. After each paid payment request the prime records
 * what it paid each subcontractor; a record that is due and not made is shown with its clock. The numbers come from the rule `VENDOR_SUBCONTRACT`, which is a starting value nobody confirmed.
 */
export default function SubcontractScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const contract = useIdParam('contract', 'id');
  return <SubcontractContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} contract={contract} />;
}

function SubcontractContent({ route, contract }: ScreenProps & { contract: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [typed, setTyped] = useState(contract ?? '');
  const [chosen, setChosen] = useState<string | undefined>(contract !== undefined && isUuid(contract) ? contract : undefined);
  const query = useSubcontracts(chosen);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const data = query.data;
  const state = useScreenState({ isLoading: chosen !== undefined && query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  const canWrite = writer.can(PERMISSION.subcontractWrite);
  const canApprove = writer.can(PERMISSION.subcontractApprove);
  const canPay = writer.can(PERMISSION.subcontractPay);

  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.subcontract.page.title')}
        subtitle={t('vnd.subcontract.page.subtitle')}
        asOf={data?.as_of}
        stale={refreshFailed}
        actions={
          <>
            {canWrite && (
              <button type="button" className="ui-button ui-button--outline" data-testid="declare-bid" onClick={() => setDialog({ kind: 'declare' })}>
                {t('vnd.subcontract.declare.action')}
              </button>
            )}
            {canWrite && data !== undefined && (
              <button type="button" className="ui-button ui-button--primary" data-testid="propose-subcontract" onClick={() => setDialog({ kind: 'propose' })}>
                {t('vnd.subcontract.propose.action')}
              </button>
            )}
          </>
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <form
        className="vnd-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setChosen(isUuid(typed) ? typed.trim() : undefined);
        }}
      >
        <label>
          {t('vnd.subcontract.filter.contract.label')}
          <input type="text" value={typed} onChange={(event) => setTyped(event.target.value)} aria-invalid={typed !== '' && !isUuid(typed)} />
        </label>
        <button type="submit" className="ui-button ui-button--primary ui-button--small" data-testid="load-contract" disabled={!isUuid(typed)}>
          {t('vnd.subcontract.filter.load.action')}
        </button>
      </form>
      {chosen === undefined ? (
        <Empty text={t('vnd.subcontract.choose.text')} testId="choose-contract" />
      ) : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {data !== undefined && (
            <div className="vnd-page">
              <Summary data={data} />
              <SectionCard title={t('vnd.subcontract.section.items.title')} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
                <DataTable<Subcontract>
                  caption={t('vnd.subcontract.table.caption')}
                  rows={data.items}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-subcontract-id': row.id })}
                  state={data.items.length === 0 ? 'empty' : 'ready'}
                  emptyKind="none"
                  severity={(row) => (row.over_paid > 0 || (row.exception_approved && row.state === 'APPROVED') ? 'ACTION' : null)}
                  columns={[
                    {
                      key: 'subcontractor',
                      header: t('vnd.subcontract.column.subcontractor'),
                      pinned: true,
                      render: (row) => (
                        <span className="vnd-stack">
                          <Link to={`/vnd/vnd-02?contractor=${row.subcontractor_id}`}>{row.subcontractor_name}</Link>
                          <span className="vnd-days">{row.scope}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'value',
                      header: t('vnd.subcontract.column.value'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{money(row.value)}</span>
                          <span className="vnd-days">{shareText(row.share_pct)}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'bid',
                      header: t('vnd.subcontract.column.bid'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <StatusPill tone={row.declared_in_bid ? 'success' : 'warning'}>{row.declared_in_bid ? t('vnd.subcontract.bid.named.name') : t('vnd.subcontract.bid.notNamed.name')}</StatusPill>
                          {row.findings.map((finding) => (
                            <span key={finding} className="vnd-days">
                              {t(`vnd.subcontract.finding.${camel(finding)}.name`)}
                            </span>
                          ))}
                        </span>
                      ),
                    },
                    {
                      key: 'state',
                      header: t('vnd.subcontract.column.state'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <StatusPill tone={subcontractTone(row.state)}>{t(`vnd.subcontract.state.${camel(row.state)}.name`)}</StatusPill>
                          {row.exception_approved && <StatusPill tone="warning">{t('vnd.subcontract.exception.badge')}</StatusPill>}
                          {row.exception_reason !== null && <span className="vnd-days">{row.exception_reason}</span>}
                          {row.decision_reason !== null && <span className="vnd-days">{row.decision_reason}</span>}
                        </span>
                      ),
                    },
                    {
                      key: 'paid',
                      header: t('vnd.subcontract.column.paid'),
                      render: (row) => (
                        <span className="vnd-stack" data-testid="paid-cell">
                          <span>{money(row.paid_total)}</span>
                          {row.over_paid > 0 && <StatusPill tone="danger">{t('vnd.subcontract.overPaid.text', { amount: money(row.over_paid) })}</StatusPill>}
                          {row.payments.map((payment) => (
                            <span key={payment.id} className="vnd-days" data-testid="payment-line">
                              {t('vnd.subcontract.payment.line.text', { amount: money(payment.paid_amount), day: dayText(payment.paid_on), reference: payment.reference })}
                              {payment.confirmed_by_subcontractor ? ` ${t('vnd.subcontract.payment.confirmed.badge')}` : ''}
                            </span>
                          ))}
                        </span>
                      ),
                    },
                    {
                      key: 'actions',
                      header: t('vnd.subcontract.column.actions'),
                      render: (row) => (
                        <span className="vnd-row">
                          {!writer.readOnly && row.may_approve && (
                            <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="approve-subcontract" onClick={() => setDialog({ kind: 'approve', row })}>
                              {t('vnd.subcontract.approve.action')}
                            </button>
                          )}
                          {!writer.readOnly && canWrite && row.state === 'PROPOSED' && (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="reject-subcontract" onClick={() => setDialog({ kind: 'reject', row })}>
                              {t('vnd.subcontract.reject.action')}
                            </button>
                          )}
                          {!writer.readOnly && canApprove && row.state === 'APPROVED' && (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="terminate-subcontract" onClick={() => setDialog({ kind: 'terminate', row })}>
                              {t('vnd.subcontract.terminate.action')}
                            </button>
                          )}
                          {!writer.readOnly && canPay && row.state === 'APPROVED' && (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="record-payment" onClick={() => setDialog({ kind: 'pay', row, request: '' })}>
                              {t('vnd.subcontract.payment.action')}
                            </button>
                          )}
                        </span>
                      ),
                    },
                  ]}
                />
              </SectionCard>
              <Pending pending={data.pending} asOf={data.as_of} canPay={canPay && !writer.readOnly} items={data.items} onRecord={(row, request) => setDialog({ kind: 'pay', row, request })} />
            </div>
          )}
        </StateBoundary>
      )}
      {dialog?.kind === 'declare' && <DeclareDialog initialPackage="" initialContractor={data?.prime_contractor_id ?? ''} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.subcontract.declare.title'))} />}
      {dialog?.kind === 'propose' && chosen !== undefined && data !== undefined && (
        <ProposeDialog contractId={chosen} contractValue={data.contract_value} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.subcontract.propose.title'))} />
      )}
      {dialog?.kind === 'approve' && <ApproveDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.subcontract.approve.title'))} />}
      {dialog?.kind === 'reject' && <RejectDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.subcontract.reject.title'))} />}
      {dialog?.kind === 'terminate' && <TerminateDialog row={dialog.row} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.subcontract.terminate.title'))} />}
      {dialog?.kind === 'pay' && <PaymentDialog row={dialog.row} initialRequest={dialog.request} onClose={() => setDialog(undefined)} onDone={() => done(t('vnd.subcontract.payment.title'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}

/** The sum of the approved shares against the declaration of the bid and the floor of the prime: three numbers on one line, each with its "i". */
function Summary({ data }: { data: SubcontractList }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd.subcontract.section.summary.title')}>
      <p className="vnd-note vnd-row" data-testid="subcontract-rule">
        <span>{t('vnd.subcontract.rule.text')}</span>
        <PolicyInfo name={t('vnd.subcontract.figure.rule.name')} policy={data.policy} />
      </p>
      <dl className="vnd-facts" data-testid="subcontract-summary">
        <div className="vnd-fact">
          <dt>{t('vnd.subcontract.summary.value.label')}</dt>
          <dd data-testid="contract-value">
            {data.contract_code} {money(data.contract_value)}
          </dd>
        </div>
        <div className="vnd-fact">
          <dt>{t('vnd.subcontract.summary.declared.label')}</dt>
          <dd data-testid="declared-share">{data.declaration === null ? t('vnd.subcontract.summary.noDeclaration.text') : shareText(data.declaration.declared_share_pct)}</dd>
        </div>
        <div className="vnd-fact">
          <dt>{t('vnd.subcontract.summary.total.label')}</dt>
          <dd data-testid="total-share" data-over={subcontractOverDeclared(data) ? 'true' : 'false'}>
            {shareText(data.total_share_pct)}
            {subcontractOverDeclared(data) && data.total_share_pct > 0 && <StatusPill tone="warning">{t('vnd.subcontract.summary.over.badge')}</StatusPill>}
          </dd>
        </div>
        <div className="vnd-fact">
          <dt>{t('vnd.subcontract.summary.prime.label')}</dt>
          <dd data-testid="prime-share" data-below={primeBelowFloor(data) ? 'true' : 'false'}>
            {shareText(data.prime_share_pct)} / {shareText(data.prime_min_share_pct)}
            {primeBelowFloor(data) && <StatusPill tone="danger">{t('vnd.subcontract.summary.floor.badge')}</StatusPill>}
          </dd>
        </div>
      </dl>
    </SectionCard>
  );
}

/** The payment requests that were paid and whose payment to a subcontractor nobody recorded, each with its clock. */
function Pending({ pending, asOf, canPay, items, onRecord }: { pending: PendingConfirmation[]; asOf: string; canPay: boolean; items: Subcontract[]; onRecord: (row: Subcontract, request: string) => void }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('vnd.subcontract.section.pending.title')}>
      {pending.length === 0 ? (
        <Empty text={t('vnd.subcontract.pending.empty.text')} testId="pending-empty" />
      ) : (
        <ul className="vnd-list" data-testid="pending-list">
          {pending.map((one) => {
            const row = items.find((item) => item.id === one.subcontract_id);
            return (
              <li key={`${one.subcontract_id}:${one.payment_request_id}`} data-clock={one.clock}>
                <span>{t('vnd.subcontract.pending.line.text', { name: one.subcontractor_name, day: dayText(one.paid_on) })}</span> <ClockCell clock={one.clock === 'NOT_REQUIRED' ? 'ON_TIME' : one.clock} dueAt={`${one.paid_on}T00:00:00.000Z`} asOf={asOf} />{' '}
                {canPay && row !== undefined && (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="record-pending" onClick={() => onRecord(row, one.payment_request_id)}>
                    {t('vnd.subcontract.payment.action')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="vnd-days">{t('vnd.subcontract.pending.note')}</p>
    </SectionCard>
  );
}
