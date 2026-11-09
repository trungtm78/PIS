import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { KitTable } from '../KitTable';
import { useBackupPage, useCancelBackup, useDecideBackup, useRecordBackup, useRequestBackup } from './hooks';
import { BACKUP_DECIDE, detailKey, BACKUP_READ, BACKUP_RECORD, BACKUP_REQUEST, REASON_MIN, healthTone, kindsFor, refusalOf, statusTone } from './model';
import type { BackupKind, BackupRequestView } from './model';
import '../adm-kit.css';

type Dialog = { kind: 'new' } | { kind: 'decide'; row: BackupRequestView } | { kind: 'cancel'; row: BackupRequestView } | { kind: 'record'; row: BackupRequestView };

/**
 * ADM-32: the backups (HSKT YCK.06). The top shows how the last backups and the last verification are, as the server reads them from the state files the host writes (never a made-up value: no source is UNKNOWN).
 * Below, the manual backup requests: one person asks for a full, differential or incremental backup, a different person allows it, the host runner runs it and the outcome (the pgBackRest label) is recorded. This screen
 * never runs a backup.
 */
export default function BackupsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BackupsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BackupsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const writable = mode !== 'READ_ONLY';
  const page = useBackupPage(holds(BACKUP_READ));
  const queryState = useScreenState({ isLoading: page.isLoading, error: page.error ?? undefined, data: page.data, isEmpty: () => false });
  const state = holds(BACKUP_READ) ? queryState : 'denied';
  const moment = (iso: string): string => (iso === '' ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso)));
  const backupState = page.data?.state;

  return (
    <section className="adm-backups" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.backups.title')}</h1>
          <p>{t('adm.backups.subtitle')}</p>
        </div>
        {holds(BACKUP_REQUEST) && writable ? (
          <button type="button" className="ui-button ui-button--primary" data-action="new" onClick={() => setDialog({ kind: 'new' })}>
            {t('adm.backups.new.action')}
          </button>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void page.refetch()}>
        {backupState === undefined ? null : (
          <SectionCard title={t('adm.backups.state.title')}>
            <p data-testid="backup-health" data-health={backupState.health}>
              <StatusPill tone={healthTone(backupState.health)}>{t(`adm.backups.health.${backupState.health.toLowerCase()}`)}</StatusPill>{' '}
              {backupState.detail === null ? null : <span className="sub">{t(`adm.backups.detail.${detailKey(backupState.detail)}`)}</span>}
            </p>
            <p>{backupState.lastVerifyAt === null ? t('adm.backups.verify.none') : t('adm.backups.verify.at', { at: moment(backupState.lastVerifyAt) })}</p>
            {backupState.backups.length === 0 ? (
              <p data-testid="backup-none">{t('adm.backups.state.empty')}</p>
            ) : (
              <KitTable caption={t('adm.backups.state.caption')} testId="backup-list">
                <thead>
                  <tr>
                    <th scope="col">{t('adm.backups.column.label')}</th>
                    <th scope="col">{t('adm.backups.column.kind')}</th>
                    <th scope="col">{t('adm.backups.column.repository')}</th>
                    <th scope="col">{t('adm.backups.column.finished')}</th>
                    <th scope="col">{t('adm.backups.column.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {backupState.backups.map((entry) => (
                    <tr key={entry.label} data-backup={entry.label}>
                      <td>{entry.label}</td>
                      <td>{t(`adm.backups.kind.${entry.kind}`)}</td>
                      <td>{entry.repository}</td>
                      <td>{moment(entry.finishedAt)}</td>
                      <td>{entry.failed ? t('adm.backups.result.failed') : t('adm.backups.result.ok')}</td>
                    </tr>
                  ))}
                </tbody>
              </KitTable>
            )}
          </SectionCard>
        )}
        <SectionCard title={t('adm.backups.requests.title')}>
          {(page.data?.items ?? []).length === 0 ? (
            <p data-testid="request-none">{t('adm.backups.requests.empty')}</p>
          ) : (
            <KitTable caption={t('adm.backups.requests.caption')} testId="backup-requests">
              <thead>
                <tr>
                  <th scope="col">{t('adm.backups.column.kind')}</th>
                  <th scope="col">{t('adm.backups.column.repository')}</th>
                  <th scope="col">{t('adm.backups.column.reason')}</th>
                  <th scope="col">{t('adm.backups.column.requested')}</th>
                  <th scope="col">{t('adm.backups.column.label')}</th>
                  <th scope="col">{t('adm.backups.column.status')}</th>
                  <th scope="col">{t('adm.backups.column.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {(page.data?.items ?? []).map((row) => (
                  <tr key={row.id} data-request={row.id} data-status={row.status}>
                    <td>{t(`adm.backups.kind.${row.kind}`)}</td>
                    <td>{row.repository}</td>
                    <td>{row.reason}</td>
                    <td>{moment(row.requestedAt)}</td>
                    <td>{row.backupLabel ?? ''}</td>
                    <td>
                      <StatusPill tone={statusTone(row.status)}>{t(`adm.backups.status.${row.status.toLowerCase()}`)}</StatusPill>
                    </td>
                    <td>
                      {row.status === 'Requested' && holds(BACKUP_DECIDE) && writable ? (
                        <button type="button" className="ui-button ui-button--primary ui-button--small" data-action="decide" onClick={() => setDialog({ kind: 'decide', row })}>
                          {t('adm.backups.decide.action')}
                        </button>
                      ) : null}
                      {row.status === 'Requested' && holds(BACKUP_REQUEST) && writable ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="cancel" onClick={() => setDialog({ kind: 'cancel', row })}>
                          {t('adm.backups.cancel.action')}
                        </button>
                      ) : null}
                      {row.status === 'Approved' && holds(BACKUP_RECORD) && writable ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="record" onClick={() => setDialog({ kind: 'record', row })}>
                          {t('adm.backups.record.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
        </SectionCard>
      </StateBoundary>
      {dialog === undefined ? null : <BackupDialog dialog={dialog} onClose={() => setDialog(undefined)} />}
    </section>
  );
}

function BackupDialog({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  const { t } = useTranslation();
  const request = useRequestBackup();
  const decide = useDecideBackup();
  const cancel = useCancelBackup();
  const record = useRecordBackup();
  const [kind, setKind] = useState<BackupKind>('full');
  const [repository, setRepository] = useState(1);
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'approve' | 'reject'>('approve');
  const [outcome, setOutcome] = useState<'completed' | 'failed'>('completed');
  const [label, setLabel] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const action = dialog.kind === 'new' ? request : dialog.kind === 'decide' ? decide : dialog.kind === 'cancel' ? cancel : record;
  const reasonNeeded = dialog.kind === 'new' || dialog.kind === 'cancel' || (dialog.kind === 'decide' && decision === 'reject');
  const minimum = dialog.kind === 'new' ? REASON_MIN : 5;
  const reasonShort = reasonNeeded && reason.trim().length < minimum;
  const labelMissing = dialog.kind === 'record' && outcome === 'completed' && label.trim() === '';
  const noteShort = dialog.kind === 'record' && outcome === 'failed' && reason.trim().length < 5;
  const refusal = action.error === null || action.error === undefined ? undefined : t(`adm.backups.refusal.${refusalOf(action.error)}`);
  const words = { close: t('adm.backups.dialog.close'), cancel: t('adm.backups.dialog.cancel'), pending: t('adm.backups.dialog.pending') };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (action.isPending || reasonShort || labelMissing || noteShort) return;
    const done = { onSuccess: onClose };
    if (dialog.kind === 'new') request.mutate({ kind, repository, reason: reason.trim() }, done);
    else if (dialog.kind === 'decide') decide.mutate({ id: dialog.row.id, version: dialog.row.version, decision, reason: reason.trim() }, done);
    else if (dialog.kind === 'cancel') cancel.mutate({ id: dialog.row.id, version: dialog.row.version, reason: reason.trim() }, done);
    else record.mutate({ id: dialog.row.id, version: dialog.row.version, outcome, label: outcome === 'completed' ? label.trim() : '', note: outcome === 'failed' ? reason.trim() : '' }, done);
  };
  const title = dialog.kind === 'new' ? t('adm.backups.new.title') : dialog.kind === 'decide' ? t('adm.backups.decide.title') : dialog.kind === 'cancel' ? t('adm.backups.cancel.title') : t('adm.backups.record.title');
  const submit = dialog.kind === 'new' ? t('adm.backups.new.submit') : dialog.kind === 'decide' ? t('adm.backups.decide.submit') : dialog.kind === 'cancel' ? t('adm.backups.cancel.submit') : t('adm.backups.record.submit');

  return (
    <CommandFrame title={title} refusal={refusal} pending={action.isPending} submitLabel={submit} words={words} onSubmit={send} onClose={onClose}>
      <fieldset disabled={action.isPending}>
        {dialog.kind === 'new' ? (
          <>
            <Field id="backup-repository" label={t('adm.backups.form.repository')}>
              <select
                id="backup-repository"
                value={repository}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setRepository(next);
                  if (!kindsFor(next).includes(kind)) setKind('full');
                }}
              >
                <option value={1}>{t('adm.backups.repository.operational')}</option>
                <option value={2}>{t('adm.backups.repository.archive')}</option>
              </select>
            </Field>
            <Field id="backup-kind" label={t('adm.backups.form.kind')}>
              <select id="backup-kind" value={kind} onChange={(event) => setKind(event.target.value as BackupKind)}>
                {kindsFor(repository).map((option) => (
                  <option key={option} value={option}>
                    {t(`adm.backups.kind.${option}`)}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}
        {dialog.kind === 'decide' ? (
          <Field id="backup-decision" label={t('adm.backups.form.decision')}>
            <select id="backup-decision" value={decision} onChange={(event) => setDecision(event.target.value as 'approve' | 'reject')}>
              <option value="approve">{t('adm.backups.decision.approve')}</option>
              <option value="reject">{t('adm.backups.decision.reject')}</option>
            </select>
          </Field>
        ) : null}
        {dialog.kind === 'record' ? (
          <>
            <Field id="backup-outcome" label={t('adm.backups.form.outcome')}>
              <select id="backup-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value as 'completed' | 'failed')}>
                <option value="completed">{t('adm.backups.outcome.completed')}</option>
                <option value="failed">{t('adm.backups.outcome.failed')}</option>
              </select>
            </Field>
            {outcome === 'completed' ? (
              <Field id="backup-label" label={t('adm.backups.form.label')} hint={t('adm.backups.form.label.hint')} error={submitted && labelMissing ? t('adm.backups.problem.label') : undefined}>
                <input id="backup-label" value={label} onChange={(event) => setLabel(event.target.value)} />
              </Field>
            ) : null}
          </>
        ) : null}
        {reasonNeeded || (dialog.kind === 'record' && outcome === 'failed') || dialog.kind === 'decide' ? (
          <Field id="backup-reason" label={dialog.kind === 'record' ? t('adm.backups.form.note') : t('adm.backups.form.reason')} error={submitted && (reasonShort || noteShort) ? t('adm.backups.problem.reasonMin', { min: minimum }) : undefined}>
            <textarea id="backup-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
          </Field>
        ) : null}
      </fieldset>
    </CommandFrame>
  );
}
