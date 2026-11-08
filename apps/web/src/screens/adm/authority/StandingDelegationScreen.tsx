import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { useUnits } from '../members/hooks';
import { ReasonDialog, ReviewDialog, StandingDecisionDialog, StandingRequestDialog } from './dialogs';
import { useCancelStandingRequest, usePermanentDelegations, useRevokePermanent, useStandingRequests } from './hooks';
import { delegationStatusLabel, delegationStatusTone, endKindLabel, endReasonLabel, requestStatusLabel, requestStatusTone, scopeKindLabel } from './labels';
import { DELEGATION_CREATE, DELEGATION_READ, daysBetween } from './model';
import type { PermanentView, StandingRequestView } from './model';
import '../adm-kit.css';
import './authority.css';

/**
 * ADM-25: the permanent delegation of approval authority (IAM-2). An ongoing handing over of business permissions that has no end date of its own but says in words when it ends and is reviewed by its delegator by a review
 * date at most a year ahead: it works until that date, and one that is not reviewed in time stops at that instant. The delegator asks, a second person who is neither the delegator nor the delegate approves, and the approval
 * makes the delegation. The tab "requests" is the register of asks and their decisions; "given" and "received" are the delegations themselves, with the review date first and a warning when it falls due within 14 days.
 */
export default function StandingDelegationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <StandingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Tab = 'requests' | 'given' | 'received';
type Dialog = { kind: 'new' } | { kind: 'decide'; request: StandingRequestView } | { kind: 'cancel'; request: StandingRequestView } | { kind: 'review'; delegation: PermanentView } | { kind: 'revoke'; delegation: PermanentView };

function StandingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [tab, setTab] = useState<Tab>('requests');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(DELEGATION_READ);
  const mayCreate = (permissions === undefined || permissions.includes(DELEGATION_CREATE)) && mode !== 'READ_ONLY';
  const requests = useStandingRequests(mayRead && tab === 'requests');
  const delegations = usePermanentDelegations(tab === 'received' ? 'received' : 'given', mayRead && tab !== 'requests');
  const units = useUnits(mayRead);
  const requestState = useScreenState({ isLoading: requests.isLoading, error: requests.error, data: requests.data });
  const delegationState = useScreenState({ isLoading: delegations.isLoading, error: delegations.error, data: delegations.data });
  const state = !mayRead ? 'denied' : tab === 'requests' ? requestState : delegationState;
  const unitName = (id: string): string => units.data?.find((unit) => unit.id === id)?.name ?? id.slice(0, 8);
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  const writable = mode !== 'READ_ONLY';
  const scopeText = (kind: string, ids: string[], periods: string[] | null): string => `${scopeKindLabel(t, kind)}: ${ids.map(unitName).join(', ')}${periods === null ? '' : ` | ${t('adm.authority.column.periods')}: ${periods.join(', ')}`}`;

  return (
    <section className="adm-authority" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.authority.standing.title')}</h1>
          <p>{t('adm.authority.standing.subtitle')}</p>
        </div>
        {mayCreate ? (
          <button type="button" className="ui-button ui-button--primary" data-action="new" onClick={() => setDialog({ kind: 'new' })}>
            {t('adm.authority.standing.new.action')}
          </button>
        ) : null}
      </div>
      <div className="adm-authority-tabs" role="tablist" aria-label={t('adm.authority.standing.tabs')}>
        {(['requests', 'given', 'received'] as const).map((name) => (
          <button key={name} type="button" className="ui-button ui-button--outline" role="tab" aria-selected={tab === name} data-tab={name} onClick={() => setTab(name)}>
            {name === 'requests' ? t('adm.authority.standing.tab.requests') : name === 'given' ? t('adm.authority.standing.tab.given') : t('adm.authority.standing.tab.received')}
          </button>
        ))}
      </div>
      <StateBoundary state={state} onRetry={() => void (tab === 'requests' ? requests.refetch() : delegations.refetch())}>
        {tab === 'requests' ? (
          <SectionCard title={t('adm.authority.standing.tab.requests')}>
            <KitTable caption={t('adm.authority.standing.table.requests')} testId="requests">
              <thead>
                <tr>
                  <th scope="col">{t('adm.authority.column.delegator')}</th>
                  <th scope="col">{t('adm.authority.column.delegate')}</th>
                  <th scope="col">{t('adm.authority.column.permissions')}</th>
                  <th scope="col">{t('adm.authority.column.scope')}</th>
                  <th scope="col">{t('adm.authority.column.review')}</th>
                  <th scope="col">{t('adm.authority.column.endCondition')}</th>
                  <th scope="col">{t('adm.authority.column.status')}</th>
                  <th scope="col">{t('adm.authority.column.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(requests.data ?? []).map((row) => (
                  <tr key={row.id} data-request={row.id} data-status={row.status}>
                    <td>{row.delegatorName}</td>
                    <td>{row.delegateName}</td>
                    <td>{row.permissions.join(', ')}</td>
                    <td>{scopeText(row.scopeKind, row.scopeRefIds, row.periodCodes)}</td>
                    <td>{moment(row.reviewDueAt)}</td>
                    <td>
                      {endKindLabel(t, row.endKind)}
                      <span className="adm-kit-sub">{row.endText}</span>
                    </td>
                    <td>
                      <span data-testid="status">
                        <StatusPill tone={requestStatusTone(row.status)}>{requestStatusLabel(t, row.status)}</StatusPill>
                      </span>
                      {row.decisionReason === null ? null : <span className="adm-kit-sub">{row.decisionReason}</span>}
                      {row.decidedByName === null ? null : <span className="adm-kit-sub">{t('adm.authority.standing.decidedBy', { name: row.decidedByName })}</span>}
                    </td>
                    <td>
                      {row.mayDecide && writable ? (
                        <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="decide" onClick={() => setDialog({ kind: 'decide', request: row })}>
                          {t('adm.authority.standing.decide.action')}
                        </button>
                      ) : null}
                      {row.mayCancel && writable ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="cancel" onClick={() => setDialog({ kind: 'cancel', request: row })}>
                          {t('adm.authority.standing.cancel.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          </SectionCard>
        ) : (
          <SectionCard title={tab === 'given' ? t('adm.authority.standing.tab.given') : t('adm.authority.standing.tab.received')}>
            <KitTable caption={t('adm.authority.standing.table.delegations')} testId="permanent">
              <thead>
                <tr>
                  <th scope="col">{tab === 'given' ? t('adm.authority.column.delegate') : t('adm.authority.column.delegator')}</th>
                  <th scope="col">{t('adm.authority.column.permissions')}</th>
                  <th scope="col">{t('adm.authority.column.scope')}</th>
                  <th scope="col">{t('adm.authority.column.review')}</th>
                  <th scope="col">{t('adm.authority.column.endCondition')}</th>
                  <th scope="col">{t('adm.authority.column.status')}</th>
                  <th scope="col">{t('adm.authority.column.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(delegations.data ?? []).map((row) => (
                  <tr key={row.id} data-delegation={row.id} data-status={row.status} data-due-soon={row.reviewDueSoon ? 'true' : 'false'}>
                    <td>{tab === 'given' ? row.delegateName : row.delegatorName}</td>
                    <td>{row.permissions.join(', ')}</td>
                    <td>{scopeText(row.scopeKind, row.scopeRefIds, row.periodCodes)}</td>
                    <td>
                      <span data-testid="review">{moment(row.reviewDueAt)}</span>
                      {row.status === 'Active' || row.status === 'Scheduled' ? <span className="adm-kit-sub">{t('adm.authority.permanent.daysLeft', { days: daysBetween(new Date().toISOString(), row.reviewDueAt) })}</span> : null}
                      {row.reviewDueSoon ? (
                        <span className="authority-due" role="status" data-testid="due-soon">
                          {t('adm.authority.permanent.dueSoon')}
                        </span>
                      ) : null}
                      <span className="adm-kit-sub">{t('adm.authority.permanent.reviews', { count: row.reviewCount })}</span>
                    </td>
                    <td>
                      {endKindLabel(t, row.endKind)}
                      <span className="adm-kit-sub">{row.endText}</span>
                      {row.endOn === null ? null : <span className="adm-kit-sub">{moment(row.endOn)}</span>}
                    </td>
                    <td>
                      <span data-testid="status">
                        <StatusPill tone={delegationStatusTone(row.status)}>{delegationStatusLabel(t, row.status)}</StatusPill>
                      </span>
                      {row.endReason === null ? null : <span className="adm-kit-sub">{endReasonLabel(t, row.endReason)}</span>}
                    </td>
                    <td>
                      {row.mayReview && writable ? (
                        <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="review" onClick={() => setDialog({ kind: 'review', delegation: row })}>
                          {t('adm.authority.permanent.review.action')}
                        </button>
                      ) : null}
                      {row.mayRevoke && writable ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="revoke" onClick={() => setDialog({ kind: 'revoke', delegation: row })}>
                          {t('adm.authority.permanent.revoke.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          </SectionCard>
        )}
      </StateBoundary>
      {dialog === undefined ? null : <Dialogs dialog={dialog} onClose={() => setDialog(undefined)} />}
    </section>
  );
}

function Dialogs({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  switch (dialog.kind) {
    case 'new':
      return <StandingRequestDialog onClose={onClose} />;
    case 'decide':
      return <StandingDecisionDialog request={dialog.request} onClose={onClose} />;
    case 'cancel':
      return <CancelDialog request={dialog.request} onClose={onClose} />;
    case 'review':
      return <ReviewDialog delegation={dialog.delegation} onClose={onClose} />;
    case 'revoke':
      return <RevokeDialog delegation={dialog.delegation} onClose={onClose} />;
  }
}

function CancelDialog({ request, onClose }: { request: StandingRequestView; onClose: () => void }) {
  const { t } = useTranslation();
  const cancel = useCancelStandingRequest();
  return (
    <ReasonDialog
      title={t('adm.authority.standing.cancel.title')}
      text={t('adm.authority.standing.cancel.text', { name: request.delegateName })}
      submitLabel={t('adm.authority.standing.cancel.submit')}
      pending={cancel.isPending}
      refusal={cancel.isError ? cancel.error : undefined}
      onSubmit={(reason) => cancel.mutate({ id: request.id, version: request.version, reason }, { onSuccess: onClose })}
      onClose={onClose}
    />
  );
}

function RevokeDialog({ delegation, onClose }: { delegation: PermanentView; onClose: () => void }) {
  const { t } = useTranslation();
  const revoke = useRevokePermanent();
  return (
    <ReasonDialog
      title={t('adm.authority.permanent.revoke.title')}
      text={t('adm.authority.permanent.revoke.text', { name: delegation.delegateName })}
      submitLabel={t('adm.authority.permanent.revoke.submit')}
      pending={revoke.isPending}
      refusal={revoke.isError ? revoke.error : undefined}
      onSubmit={(reason) => revoke.mutate({ id: delegation.id, version: delegation.version, reason }, { onSuccess: onClose })}
      onClose={onClose}
    />
  );
}
