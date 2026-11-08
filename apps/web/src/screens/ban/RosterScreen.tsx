import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { clockText } from '../home/overview-model';
import { EmptyReason, Guarded, roleLabelOf } from './components';
import { useRoster } from './hooks';
import { PERMISSION, dayText, may, missingRole } from './model';
import type { Member, Roster } from './model';
import { AppointDialog, EndDialog, RegisterDialog } from './roster-dialogs';

type Committee = Roster['committees'][number];
type Dialog = { kind: 'register' } | { kind: 'appoint'; committee: Committee } | { kind: 'end'; member: Member };

/**
 * BAN-06, the committees and their places: who holds which place, from which agency, by which decision, from and until when, whether a second factor is required of them, and whether the system role that gives the right was
 * granted (the roster records appointments; what a person may do is the grant of IAM, so a place without the grant is a warning). Places are appointed and ended, never removed; an ended place says why.
 */
export default function RosterScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Guarded route={route} permission={PERMISSION.read} title={t('ban.ros.page.title')} subtitle={t('ban.ros.page.subtitle')}>
      <RosterContent />
    </Guarded>
  );
}

function RosterContent() {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const query = useRoster();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const manage = may(permissions, PERMISSION.manage);
  const done = (text: string): void => {
    setDialog(undefined);
    setReceipt(text);
  };

  const columns: DataTableColumn<Member>[] = [
    {
      key: 'person',
      header: t('ban.ros.col.person'),
      pinned: true,
      render: (member) => (
        <div>
          <strong>{member.display_name ?? member.membership_id}</strong>
          {missingRole(member) ? (
            <div data-testid={`role-missing-${member.id}`}>
              <StatusPill tone="warning" icon="▲">
                {t('ban.ros.roleMissing.label')}
              </StatusPill>
              <div className="ban-muted">{t('ban.ros.roleMissing.text')}</div>
            </div>
          ) : null}
        </div>
      ),
    },
    { key: 'role', header: t('ban.ros.col.role'), render: (member) => <strong>{roleLabelOf(t, member.committee_role)}</strong> },
    { key: 'agency', header: t('ban.ros.col.agency'), render: (member) => (member.agency_code === null && member.agency_name === null ? '–' : [member.agency_code, member.agency_name].filter((part) => part !== null).join(' · ')) },
    { key: 'decision', header: t('ban.ros.col.decision'), render: (member) => member.decision_ref ?? '–' },
    { key: 'days', header: t('ban.ros.col.days'), render: (member) => (member.valid_until === null ? t('ban.ros.days.open', { from: dayText(member.valid_from) }) : t('ban.ros.days.range', { from: dayText(member.valid_from), until: dayText(member.valid_until) })) },
    {
      key: 'mfa',
      header: t('ban.ros.col.mfa'),
      render: (member) =>
        member.mfa_required ? (
          <StatusPill tone="info" icon="◆">
            {t('ban.ros.mfa.required')}
          </StatusPill>
        ) : (
          t('ban.ros.mfa.notRequired')
        ),
    },
    {
      key: 'status',
      header: t('ban.ros.col.status'),
      render: (member) =>
        member.status === 'ACTIVE' ? (
          <StatusPill tone="success" icon="●">
            {t('ban.ros.status.active')}
          </StatusPill>
        ) : (
          <div>
            <StatusPill tone="neutral" icon="○">
              {t('ban.ros.status.ended')}
            </StatusPill>
            <div className="ban-muted">{t('ban.ros.ended.text', { day: dayText(member.ended_at), reason: member.end_reason ?? '–' })}</div>
          </div>
        ),
    },
    {
      key: 'actions',
      header: t('ban.ros.col.actions'),
      render: (member) =>
        manage && member.status === 'ACTIVE' ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`end-${member.id}`} onClick={() => setDialog({ kind: 'end', member })}>
            {t('ban.ros.end.action')}
          </button>
        ) : (
          <span className="ban-muted">–</span>
        ),
    },
  ];

  return (
    <>
      <ContextBar items={[{ label: t('ban.dash.context.scope'), value: tenant?.name ?? '–' }]} {...(query.dataUpdatedAt > 0 ? { asOf: clockText(query.dataUpdatedAt) } : {})} stale={query.isError && data !== undefined} />
      {data === undefined ? null : (
        <p className="callout" role="note" data-testid="roster-classification">
          {t('ban.ros.classification.text', { level: data.classification })}
        </p>
      )}
      {manage ? (
        <div className="ban-actions">
          <button type="button" className="ui-button ui-button--primary" data-testid="register-open" onClick={() => setDialog({ kind: 'register' })}>
            {t('ban.ros.register.action')}
          </button>
        </div>
      ) : null}
      {receipt === undefined ? null : (
        <p className="callout" role="status" data-testid="roster-receipt">
          {receipt}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : data.committees.length === 0 ? (
          <EmptyReason text={manage ? t('ban.ros.empty.manage.text') : t('ban.ros.empty.read.text')} testId="roster-empty" />
        ) : (
          data.committees.map((committee) => (
            <SectionCard
              key={committee.id}
              title={`${committee.code} · ${committee.name}`}
              status={
                committee.status === 'ACTIVE' ? (
                  <StatusPill tone="success" icon="●">
                    {t('ban.ros.status.active')}
                  </StatusPill>
                ) : (
                  <StatusPill tone="neutral" icon="○">
                    {t('ban.ros.status.ended')}
                  </StatusPill>
                )
              }
              actions={
                manage && committee.status === 'ACTIVE' ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`appoint-open-${committee.id}`} onClick={() => setDialog({ kind: 'appoint', committee })}>
                    {t('ban.ros.appoint.action')}
                  </button>
                ) : undefined
              }
            >
              <div data-testid={`committee-${committee.id}`}>
                <p className="ban-muted">{committee.legal_basis === null ? t('ban.ros.basis.none') : t('ban.ros.basis.text', { basis: committee.legal_basis })}</p>
                {committee.members.length === 0 ? <EmptyReason text={t('ban.ros.members.empty.text')} testId={`members-empty-${committee.id}`} /> : <DataTable caption={t('ban.ros.table.caption', { name: committee.name })} columns={columns} rows={committee.members} rowKey={(member) => member.id} />}
              </div>
            </SectionCard>
          ))
        )}
      </StateBoundary>
      {dialog?.kind === 'register' ? <RegisterDialog onClose={() => setDialog(undefined)} onDone={done} /> : null}
      {dialog?.kind === 'appoint' ? <AppointDialog committeeId={dialog.committee.id} committeeName={dialog.committee.name} onClose={() => setDialog(undefined)} onDone={done} /> : null}
      {dialog?.kind === 'end' ? <EndDialog member={dialog.member} onClose={() => setDialog(undefined)} onDone={done} /> : null}
    </>
  );
}
