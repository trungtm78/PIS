import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { ActingDecisionDialog, ActingRequestDialog, ReasonDialog } from './dialogs';
import { useActingGrants, useCancelActing, useRevokeActing } from './hooks';
import { phaseLabel, phaseTone } from './labels';
import { ACTING_MAX_HOURS, ACTING_READ, ACTING_REQUEST, minutesLeft } from './model';
import type { ActingView } from './model';
import '../adm-kit.css';
import './authority.css';

/**
 * ADM-26: an administrator acting on behalf of a person (IAM-2). The administrator asks, naming the person, the few permissions of theirs they need (data entry only: never a decision, a signature or the administration of
 * access) and a reason; a second person who is neither of the two approves; the grant then works for the hours asked (at most 8 from the approval) and ends by the clock or when it is revoked. While it works every audit
 * row of the administrator carries "acting as" the person, which this screen says out loud so nobody does it by accident. The banner of a grant in force counts the minutes that are left.
 */
export default function ActingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ActingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'new' } | { kind: 'decide'; grant: ActingView } | { kind: 'cancel'; grant: ActingView } | { kind: 'revoke'; grant: ActingView };

function ActingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(ACTING_READ);
  const mayRequest = (permissions === undefined || permissions.includes(ACTING_REQUEST)) && mode !== 'READ_ONLY';
  const grants = useActingGrants(mayRead);
  const queryState = useScreenState({ isLoading: grants.isLoading, error: grants.error, data: grants.data });
  const state = mayRead ? queryState : 'denied';
  const writable = mode !== 'READ_ONLY';
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  const active = (grants.data ?? []).filter((grant) => grant.phase === 'ACTIVE');

  return (
    <section className="adm-authority" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.authority.acting.title')}</h1>
          <p>{t('adm.authority.acting.subtitle', { hours: ACTING_MAX_HOURS })}</p>
        </div>
        {mayRequest ? (
          <button type="button" className="ui-button ui-button--primary" data-action="new" onClick={() => setDialog({ kind: 'new' })}>
            {t('adm.authority.acting.new.action')}
          </button>
        ) : null}
      </div>
      {active.map((grant) => (
        <p key={grant.id} className="callout warning authority-acting-banner" role="status" data-testid="acting-banner" data-acting={grant.id}>
          {t('adm.authority.acting.banner', { subject: grant.subjectName, minutes: minutesLeft(grant.windowEnd, new Date()) })}
        </p>
      ))}
      <StateBoundary state={state} onRetry={() => void grants.refetch()}>
        <SectionCard title={t('adm.authority.acting.table.title')}>
          <KitTable caption={t('adm.authority.acting.table.caption')} testId="acting">
            <thead>
              <tr>
                <th scope="col">{t('adm.authority.acting.column.subject')}</th>
                <th scope="col">{t('adm.authority.acting.column.requester')}</th>
                <th scope="col">{t('adm.authority.column.permissions')}</th>
                <th scope="col">{t('adm.authority.acting.column.window')}</th>
                <th scope="col">{t('adm.authority.column.reason')}</th>
                <th scope="col">{t('adm.authority.column.status')}</th>
                <th scope="col">{t('adm.authority.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {(grants.data ?? []).map((row) => (
                <tr key={row.id} data-grant={row.id} data-phase={row.phase}>
                  <td>{row.subjectName}</td>
                  <td>{row.requesterName}</td>
                  <td>
                    {row.permissions.map((permission) => (
                      <code key={permission} className="authority-permission">
                        {permission}
                      </code>
                    ))}
                    {row.periodCodes === null ? null : <span className="adm-kit-sub">{row.periodCodes.join(', ')}</span>}
                  </td>
                  <td>
                    {row.windowStart === null || row.windowEnd === null ? t('adm.authority.acting.hours', { hours: row.hours }) : `${moment(row.windowStart)} - ${moment(row.windowEnd)}`}
                    {row.decidedByName === null ? null : <span className="adm-kit-sub">{t('adm.authority.acting.approvedBy', { name: row.decidedByName })}</span>}
                  </td>
                  <td>{row.phase === 'REVOKED' && row.revokeReason !== null ? row.revokeReason : (row.decisionReason ?? row.reason)}</td>
                  <td>
                    <span data-testid="status">
                      <StatusPill tone={phaseTone(row.phase)}>{phaseLabel(t, row.phase)}</StatusPill>
                    </span>
                  </td>
                  <td>
                    {row.mayDecide && writable ? (
                      <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="decide" onClick={() => setDialog({ kind: 'decide', grant: row })}>
                        {t('adm.authority.acting.decide.action')}
                      </button>
                    ) : null}
                    {row.mayCancel && writable ? (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="cancel" onClick={() => setDialog({ kind: 'cancel', grant: row })}>
                        {t('adm.authority.acting.cancel.action')}
                      </button>
                    ) : null}
                    {row.mayRevoke && writable ? (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="revoke" onClick={() => setDialog({ kind: 'revoke', grant: row })}>
                        {t('adm.authority.acting.revoke.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </KitTable>
        </SectionCard>
        <p className="sub" data-testid="acting-note">
          {t('adm.authority.acting.note')}
        </p>
      </StateBoundary>
      {dialog === undefined ? null : <Dialogs dialog={dialog} onClose={() => setDialog(undefined)} />}
    </section>
  );
}

function Dialogs({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  switch (dialog.kind) {
    case 'new':
      return <ActingRequestDialog onClose={onClose} />;
    case 'decide':
      return <ActingDecisionDialog grant={dialog.grant} onClose={onClose} />;
    case 'cancel':
      return <CancelDialog grant={dialog.grant} onClose={onClose} />;
    case 'revoke':
      return <RevokeDialog grant={dialog.grant} onClose={onClose} />;
  }
}

function CancelDialog({ grant, onClose }: { grant: ActingView; onClose: () => void }) {
  const { t } = useTranslation();
  const cancel = useCancelActing();
  return (
    <ReasonDialog
      title={t('adm.authority.acting.cancel.title')}
      text={t('adm.authority.acting.cancel.text', { name: grant.subjectName })}
      submitLabel={t('adm.authority.acting.cancel.submit')}
      pending={cancel.isPending}
      refusal={cancel.isError ? cancel.error : undefined}
      onSubmit={(reason) => cancel.mutate({ id: grant.id, version: grant.version, reason }, { onSuccess: onClose })}
      onClose={onClose}
    />
  );
}

function RevokeDialog({ grant, onClose }: { grant: ActingView; onClose: () => void }) {
  const { t } = useTranslation();
  const revoke = useRevokeActing();
  return (
    <ReasonDialog
      title={t('adm.authority.acting.revoke.title')}
      text={t('adm.authority.acting.revoke.text', { name: grant.subjectName })}
      submitLabel={t('adm.authority.acting.revoke.submit')}
      pending={revoke.isPending}
      refusal={revoke.isError ? revoke.error : undefined}
      onSubmit={(reason) => revoke.mutate({ id: grant.id, version: grant.version, reason }, { onSuccess: onClose })}
      onClose={onClose}
    />
  );
}
