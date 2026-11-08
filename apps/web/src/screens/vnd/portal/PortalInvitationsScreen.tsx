import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { vietnamStamp } from '../shared/vnd-model';
import { Empty, Fact, ReadOnlyNote, ReceiptNote, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill, useReceipt, useWriter } from '../shared/vnd-ui';
import { ApproveInvitationDialog, ProposeInvitationDialog, ReasonInvitationDialog } from './portal2-dialogs';
import { useInvitations } from './portal2-hooks';
import { contactBasisLabel, invitationStatusLabel } from './portal2-labels';
import { INVITATION_STATUSES, PORTAL2_PERMISSION, invitationIcon, invitationTone } from './portal2-model';
import type { InvitationLine } from './portal2-model';
import './portal.css';

type Dialog = { kind: 'propose' } | { kind: 'approve'; line: InvitationLine } | { kind: 'reject'; line: InvitationLine } | { kind: 'revoke'; line: InvitationLine };

/**
 * VND-23, the invitations of contractors to the portal through the contractor registry (PORTAL-2). A contractor with no contract is let in by an invitation bound to its registry entry: one person proposes a contact with the
 * proof that the contact is the contractor's, a different person approves, the proposal and the access expire by the rule, and a revocation ends the access at once. The buttons are offered by what the server says the caller
 * may do with each line (the person who proposed cannot approve); the server judges every command again.
 */
export default function PortalInvitationsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const scope = `${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`;
  return <Invitations key={scope} route={route} />;
}

function Invitations({ route }: ScreenProps) {
  const { t } = useTranslation();
  const writer = useWriter();
  const [status, setStatus] = useState('');
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const receipt = useReceipt();
  const query = useInvitations({ status, contractor: '' });
  const page = query.data;
  const state: ScreenState = useScreenState({ isLoading: query.isLoading, error: page === undefined ? query.error : undefined, data: page, isEmpty: (data) => status === '' && (data as { items: unknown[] }).items.length === 0 });
  const refreshFailed = query.isError && page !== undefined;
  const canInvite = writer.can(PORTAL2_PERMISSION.invite);
  const canApprove = writer.can(PORTAL2_PERMISSION.approve);
  const canRevoke = writer.can(PORTAL2_PERMISSION.revoke);
  const done = (what: string): void => {
    setDialog(undefined);
    receipt.show(t('vnd.receipt.done.text', { what, time: vietnamStamp(new Date().toISOString()) }));
  };
  return (
    <Screen route={route}>
      <ScreenHead
        title={t('po2.invitations.page.title')}
        subtitle={t('po2.invitations.page.subtitle')}
        asOf={page?.as_of}
        stale={refreshFailed}
        actions={
          canInvite ? (
            <button type="button" className="ui-button ui-button--primary" data-testid="propose-invitation" onClick={() => setDialog({ kind: 'propose' })}>
              {t('po2.invitations.propose.action')}
            </button>
          ) : undefined
        }
      />
      <ReadOnlyNote show={writer.readOnly} />
      <ReceiptNote text={receipt.receipt} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {page !== undefined && (
          <div className="vnd-page">
            <SectionCard title={t('po2.invitations.rule.title')} status={page.policy.unverified ? <UnverifiedPill /> : undefined}>
              <p className="vnd-note" data-testid="two-person-note">
                {t('po2.invitations.twoPerson.note')}
              </p>
              <dl className="vnd-facts" data-testid="invitation-rule">
                <Fact label={t('po2.invitations.rule.proposalDays.label')} testId="rule-proposal-days">
                  {page.policy.proposal_days}
                </Fact>
                <Fact label={t('po2.invitations.rule.accessDays.label')} testId="rule-access-days">
                  {page.policy.access_days}
                </Fact>
                <Fact label={t('po2.invitations.rule.maxAccounts.label')} testId="rule-max-accounts">
                  {page.policy.max_live_accounts}
                </Fact>
                <Fact label={t('po2.invitations.rule.version.label')} testId="rule-version">
                  {page.policy.version}
                </Fact>
              </dl>
              <dl className="vnd-facts" data-testid="invitation-counts">
                <Fact label={t('po2.invitations.counts.proposed.label')} testId="count-proposed">
                  {page.counts.proposed}
                </Fact>
                <Fact label={t('po2.invitations.counts.approved.label')} testId="count-approved">
                  {page.counts.approved}
                </Fact>
                <Fact label={t('po2.invitations.counts.expired.label')} testId="count-expired">
                  {page.counts.expired}
                </Fact>
                <Fact label={t('po2.invitations.counts.revoked.label')} testId="count-revoked">
                  {page.counts.revoked}
                </Fact>
              </dl>
            </SectionCard>
            <SectionCard title={t('po2.invitations.list.title')}>
              <div className="vnd-filters">
                <label>
                  {t('po2.invitations.filter.status.label')}
                  <select value={status} onChange={(event) => setStatus(event.target.value)}>
                    <option value="">{t('vnp.requests.filter.all.text')}</option>
                    {INVITATION_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {invitationStatusLabel(t, value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {page.items.length === 0 ? (
                <Empty text={t('po2.invitations.filtered.empty.text')} testId="invitations-filtered-empty" />
              ) : (
                <DataTable<InvitationLine>
                  caption={t('po2.invitations.list.caption')}
                  rows={page.items}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-invitation-id': row.id })}
                  columns={[
                    {
                      key: 'contractor',
                      header: t('po2.invitations.column.contractor'),
                      pinned: true,
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{row.contractor_name}</span>
                          <span className="vnd-days">{row.tax_identifier}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'contact',
                      header: t('po2.invitations.column.contact'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{row.contact_name}</span>
                          <span className="vnd-days">{row.contact_email}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'basis',
                      header: t('po2.invitations.column.basis'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{contactBasisLabel(t, row.contact_basis)}</span>
                          {row.basis_reference !== null && row.basis_reference !== undefined && <span className="vnd-days">{row.basis_reference}</span>}
                        </span>
                      ),
                    },
                    {
                      key: 'people',
                      header: t('po2.invitations.column.people'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{t('po2.invitations.proposedBy.text', { name: row.proposed_by_name ?? '–' })}</span>
                          {row.decided_by_name !== null && row.decided_by_name !== undefined && <span className="vnd-days">{t('po2.invitations.decidedBy.text', { name: row.decided_by_name })}</span>}
                        </span>
                      ),
                    },
                    {
                      key: 'dates',
                      header: t('po2.invitations.column.dates'),
                      render: (row) => (
                        <span className="vnd-stack">
                          <span>{t('po2.invitations.proposalExpires.text', { time: vietnamStamp(row.proposal_expires_at) })}</span>
                          {row.access_valid_until !== null && row.access_valid_until !== undefined && <span className="vnd-days">{t('po2.invitations.accessUntil.text', { time: vietnamStamp(row.access_valid_until) })}</span>}
                          {row.revoke_reason !== null && row.revoke_reason !== undefined && <span className="vnd-days">{t('po2.invitations.revokeReason.text', { reason: row.revoke_reason })}</span>}
                        </span>
                      ),
                    },
                    {
                      key: 'status',
                      header: t('po2.invitations.column.status'),
                      render: (row) => (
                        <span data-status={row.effective_status}>
                          <StatusPill tone={invitationTone(row.effective_status)} icon={invitationIcon(row.effective_status)}>
                            {invitationStatusLabel(t, row.effective_status)}
                          </StatusPill>
                        </span>
                      ),
                    },
                    {
                      key: 'actions',
                      header: t('po2.invitations.column.actions'),
                      render: (row) => (
                        <span className="vnd-row">
                          {canApprove && row.actions.approve && (
                            <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="approve" onClick={() => setDialog({ kind: 'approve', line: row })}>
                              {t('po2.invitations.approve.action')}
                            </button>
                          )}
                          {canApprove && row.actions.reject && (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="reject" onClick={() => setDialog({ kind: 'reject', line: row })}>
                              {t('po2.invitations.reject.action')}
                            </button>
                          )}
                          {canRevoke && row.actions.revoke && (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="revoke" onClick={() => setDialog({ kind: 'revoke', line: row })}>
                              {t('po2.invitations.revoke.action')}
                            </button>
                          )}
                        </span>
                      ),
                    },
                  ]}
                />
              )}
            </SectionCard>
          </div>
        )}
      </StateBoundary>
      {dialog?.kind === 'propose' && <ProposeInvitationDialog onClose={() => setDialog(undefined)} onDone={() => done(t('po2.propose.title.text'))} />}
      {dialog?.kind === 'approve' && <ApproveInvitationDialog invitation={dialog.line} onClose={() => setDialog(undefined)} onDone={() => done(t('po2.approve.title.text'))} />}
      {dialog?.kind === 'reject' && <ReasonInvitationDialog mode="reject" invitation={dialog.line} onClose={() => setDialog(undefined)} onDone={() => done(t('po2.reject.title.text'))} />}
      {dialog?.kind === 'revoke' && <ReasonInvitationDialog mode="revoke" invitation={dialog.line} onClose={() => setDialog(undefined)} onDone={() => done(t('po2.revoke.title.text'))} />}
      <ScreenFooter route={route} />
    </Screen>
  );
}
