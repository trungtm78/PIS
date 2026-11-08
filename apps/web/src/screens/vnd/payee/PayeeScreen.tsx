import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import { usePayeeChanges, useProfile } from '../shared/vnd-hooks';
import { changeStatusLabel } from '../shared/vnd-labels';
import { CHANGE_STATUSES, PATHS, PERMISSION, failureStatus, vietnamStamp } from '../shared/vnd-model';
import type { Account, PayeeChange } from '../shared/vnd-model';
import { Empty, PolicyInfo, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useIdParam, useReceipt, useWriter } from '../shared/vnd-ui';
import { AccountsCard, ChainLog, ChangeCard, VerdictBanner } from './payee-parts';
import { ApproveDialog, CallbackDialog, CloseAccountDialog, EndChangeDialog, RequestChangeDialog } from './payee-dialogs';

type Dialog =
  | { kind: 'request' }
  | { kind: 'approve'; change: PayeeChange; role: 'CONTRACT_MATCH' | 'ACCOUNT_MATCH' }
  | { kind: 'callback'; change: PayeeChange }
  | { kind: 'end'; change: PayeeChange; end: 'cancel' | 'reject' }
  | { kind: 'close'; account: Account };

/**
 * VND-04, the accounts contractors are paid on. With a contractor in the address it is that contractor: whether payments are allowed now (a red banner with the reasons when not), the account in force as a masked number with the
 * waiting period, the requests to change it with their three steps (the contract, the account, the call-back to the number on file) and the full chain log. Without one it is the queue of requests of every contractor.
 */
export default function PayeeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const contractor = useIdParam('contractor', 'id');
  const change = useIdParam('change');
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  if (contractor !== undefined) return <ContractorPayee key={`${scope}:${contractor}`} route={route} id={contractor} focus={change} />;
  return <PayeeQueue key={scope} route={route} focus={change} />;
}

/** The dialogs of the commands of a change, shared by the queue and the contractor view. */
function useDialogs() {
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const { t } = useTranslation();
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return { dialog, setDialog, receipt, done };
}

function DialogHost({ dialog, setDialog, done }: { dialog: Dialog | undefined; setDialog: (dialog: Dialog | undefined) => void; done: (what: string) => void }) {
  const { t } = useTranslation();
  const close = (): void => setDialog(undefined);
  switch (dialog?.kind) {
    case 'approve':
      return <ApproveDialog change={dialog.change} role={dialog.role} onClose={close} onDone={() => done(dialog.role === 'CONTRACT_MATCH' ? t('vnd.payee.approve.contract.title') : t('vnd.payee.approve.account.title'))} />;
    case 'callback':
      return <CallbackDialog change={dialog.change} onClose={close} onDone={() => done(t('vnd.payee.callback.title'))} />;
    case 'end':
      return <EndChangeDialog change={dialog.change} kind={dialog.end} onClose={close} onDone={() => done(dialog.end === 'cancel' ? t('vnd.payee.cancel.title') : t('vnd.payee.reject.title'))} />;
    case 'close':
      return <CloseAccountDialog account={dialog.account} onClose={close} onDone={() => done(t('vnd.payee.close.title'))} />;
    default:
      return null;
  }
}

function ContractorPayee({ route, id, focus }: ScreenProps & { id: string; focus: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const query = useProfile(id);
  const { dialog, setDialog, receipt, done } = useDialogs();
  const [requesting, setRequesting] = useState(false);
  const view = query.data;
  const base = useScreenState({ isLoading: query.isLoading, error: view === undefined ? query.error : undefined, data: view, isEmpty: () => false });
  const state: ScreenState = view === undefined && failureStatus(query.error) === 404 ? 'empty' : base;
  const refreshFailed = query.isError && view !== undefined;
  const canAct = !writer.readOnly;
  const ordered = view === undefined ? [] : [...view.payee_changes].sort((a, b) => Number(b.status === 'REQUESTED') - Number(a.status === 'REQUESTED') || b.requested_at.localeCompare(a.requested_at));

  return (
    <Screen route={route}>
      <ScreenHead
        title={t('vnd.payee.page.title')}
        subtitle={view === undefined ? t('vnd.payee.page.subtitle') : t('vnd.payee.page.contractor.text', { name: view.profile.legal_name })}
        asOf={view?.as_of}
        stale={refreshFailed}
        actions={
          <>
            <Link className="ui-button ui-button--outline" to={PATHS.payee()}>
              {t('vnd.payee.queue.link')}
            </Link>
            {view !== undefined && canAct && view.actions.request_payee_change && (
              <button type="button" className="ui-button ui-button--primary" data-testid="request-change" onClick={() => setRequesting(true)}>
                {t('vnd.payee.request.action')}
              </button>
            )}
          </>
        }
        {...(view === undefined ? {} : { items: [{ label: t('vnd.payee.context.contractor.label'), value: view.profile.legal_name }] })}
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {view !== undefined && (
          <div className="vnd-page">
            <VerdictBanner verdict={view.payee_verdict} policy={view.policies.payee} />
            <AccountsCard accounts={view.accounts} asOf={view.as_of} policy={view.policies.payee} canClose={canAct && writer.can(PERMISSION.bankApprove)} onClose={(account) => setDialog({ kind: 'close', account })} />
            <SectionCard title={t('vnd.payee.section.changes.title')} status={view.policies.payee.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note vnd-row">
                <span>{t('vnd.payee.changes.rule.text')}</span>
                <PolicyInfo name={t('vnd.payee.figure.rule.name')} policy={view.policies.payee} />
              </p>
              {ordered.length === 0 ? (
                <Empty text={t('vnd.payee.changes.empty.text')} testId="changes-empty" />
              ) : (
                ordered.map((change) => (
                  <ChangeCard
                    key={change.id}
                    change={change}
                    focus={focus === change.id}
                    showContractor={false}
                    canAct={canAct}
                    onApprove={(item, role) => setDialog({ kind: 'approve', change: item, role })}
                    onCallback={(item) => setDialog({ kind: 'callback', change: item })}
                    onCancel={(item) => setDialog({ kind: 'end', change: item, end: 'cancel' })}
                    onReject={(item) => setDialog({ kind: 'end', change: item, end: 'reject' })}
                  />
                ))
              )}
            </SectionCard>
            <ChainLog events={view.bank_events} />
          </div>
        )}
      </StateBoundary>
      {requesting && view !== undefined && (
        <RequestChangeDialog
          contractorId={view.profile.contractor_id}
          contractorName={view.profile.legal_name}
          onClose={() => setRequesting(false)}
          onDone={() => {
            setRequesting(false);
            receipt.show(t('vnd.receipt.done.text', { what: t('vnd.payee.request.title'), time: vietnamStamp(new Date().toISOString()) }));
          }}
        />
      )}
      <DialogHost dialog={dialog} setDialog={setDialog} done={done} />
      <ScreenFooter route={route} />
    </Screen>
  );
}

function PayeeQueue({ route, focus }: ScreenProps & { focus: string | undefined }) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [status, setStatus] = useState('REQUESTED');
  const query = usePayeeChanges(status, undefined);
  const { dialog, setDialog, receipt, done } = useDialogs();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;

  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd.payee.page.title')} subtitle={t('vnd.payee.queue.subtitle')} asOf={data?.as_of} stale={refreshFailed} />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <SectionCard title={t('vnd.payee.queue.filter.title')}>
        <div className="vnd-filters">
          <label>
            {t('vnd.payee.queue.status.label')}
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">{t('vnd.register.filter.any.option')}</option>
              {CHANGE_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {changeStatusLabel(t, item)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </SectionCard>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <SectionCard title={t('vnd.payee.queue.section.title')} status={data.policy.unverified ? <UnverifiedPill /> : undefined}>
            <p className="vnd-note vnd-row">
              <span>{t('vnd.payee.changes.rule.text')}</span>
              <PolicyInfo name={t('vnd.payee.figure.rule.name')} policy={data.policy} />
            </p>
            {data.items.length === 0 ? (
              <Empty text={status === '' ? t('vnd.payee.queue.empty.text') : t('vnd.payee.queue.emptyFiltered.text')} testId="queue-empty" />
            ) : (
              data.items.map((change) => (
                <ChangeCard
                  key={change.id}
                  change={change}
                  focus={focus === change.id}
                  showContractor
                  canAct={!writer.readOnly}
                  onApprove={(item, role) => setDialog({ kind: 'approve', change: item, role })}
                  onCallback={(item) => setDialog({ kind: 'callback', change: item })}
                  onCancel={(item) => setDialog({ kind: 'end', change: item, end: 'cancel' })}
                  onReject={(item) => setDialog({ kind: 'end', change: item, end: 'reject' })}
                />
              ))
            )}
          </SectionCard>
        )}
      </StateBoundary>
      <DialogHost dialog={dialog} setDialog={setDialog} done={done} />
      <ScreenFooter route={route} />
    </Screen>
  );
}
