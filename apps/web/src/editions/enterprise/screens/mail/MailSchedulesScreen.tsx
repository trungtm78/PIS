import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../../../ui';
import type { DataTableColumn } from '../../../../ui';
import { vietnamStamp } from '../shared/format';
import { useCreateMailSchedule, useMailSchedules, useMailings, useRetireMailSchedule } from './hooks';
import type { Mailing, MailSchedule } from './hooks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ['XLSX', 'DOCX', 'PDF'] as const;
const NEVER_EMPTY = (): boolean => false;

/**
 * RML-01: the e-mail schedules of issued report forms and the log of what they sent (ENT-4d, HSKT BC.02 "gui bao cao tu dong qua email theo lich"). A schedule names a form, a cron, a file format and the members who
 * receive it; it sends the issued copies made after it was made, once to each recipient, with the SHA-256 of the file in the message. A schedule never changes: to change it, retire it and make another. The log says what
 * happened to every message, including why one was not sent.
 */
export default function MailSchedulesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <MailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const schedules = useMailSchedules();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const log = useMailings(chosen);
  const create = useCreateMailSchedule();
  const retire = useRetireMailSchedule();
  const [layout, setLayout] = useState('');
  const [cron, setCron] = useState('0 8 6 * *');
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('XLSX');
  const [recipients, setRecipients] = useState('');
  const [note, setNote] = useState('');
  const [retiring, setRetiring] = useState<MailSchedule | undefined>(undefined);
  const data = schedules.data;
  const state = useScreenState({ isLoading: schedules.isLoading, error: data === undefined ? schedules.error : undefined, data, isEmpty: NEVER_EMPTY });
  const ids = recipients.split(/[\s,;]+/).filter((id) => id !== '');
  const valid = layout.trim() !== '' && cron.trim() !== '' && ids.length > 0 && ids.every((id) => UUID.test(id));
  const failure = create.error instanceof ApiError ? create.error : undefined;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    create.mutate({ layout_code: layout.trim(), cron: cron.trim(), format, recipients: ids, ...(note.trim() === '' ? {} : { note: note.trim() }) }, { onSuccess: () => { setLayout(''); setRecipients(''); setNote(''); } });
  };

  const statusText = (status: string): string => (status === 'ACTIVE' ? t('ent.mail.status.active') : t('ent.mail.status.retired'));
  const mailingText = (status: Mailing['status']): string =>
    status === 'SENT' ? t('ent.mail.log.sent') : status === 'FAILED' ? t('ent.mail.log.failed') : status === 'REFUSED' ? t('ent.mail.log.refused') : status === 'UNKNOWN' ? t('ent.mail.log.unknown') : status === 'SKIPPED' ? t('ent.mail.log.skipped') : t('ent.mail.log.sending');

  const scheduleColumns: DataTableColumn<MailSchedule>[] = [
    { key: 'layout', header: t('ent.mail.col.form'), pinned: true, render: (row) => row.layout_code },
    { key: 'cron', header: t('ent.mail.col.cron'), render: (row) => `${row.cron} (${row.timezone ?? ''})` },
    { key: 'format', header: t('ent.mail.col.format'), render: (row) => row.format },
    { key: 'recipients', header: t('ent.mail.col.recipients'), align: 'right', render: (row) => String(row.recipient_count ?? row.recipient_ids?.length ?? 0) },
    { key: 'last', header: t('ent.mail.col.lastRun'), render: (row) => (row.last_run_at === null || row.last_run_at === undefined ? t('ent.mail.never.text') : vietnamStamp(row.last_run_at)) },
    { key: 'status', header: t('ent.mail.col.status'), render: (row) => <StatusPill tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>{statusText(row.status)}</StatusPill> },
    {
      key: 'actions',
      header: t('ent.mail.col.actions'),
      render: (row) => (
        <span className="ent-mail-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setChosen(row.id)} aria-pressed={chosen === row.id}>
            {t('ent.mail.log.action')}
          </button>
          {row.status === 'ACTIVE' && data?.may_manage === true ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setRetiring(row)}>
              {t('ent.mail.retire.action')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  const logColumns: DataTableColumn<Mailing>[] = [
    { key: 'issue', header: t('ent.mail.col.copy'), pinned: true, render: (row) => row.issue_id.slice(0, 8) },
    { key: 'recipient', header: t('ent.mail.col.recipient'), render: (row) => row.recipient_id.slice(0, 8) },
    { key: 'file', header: t('ent.mail.col.file'), render: (row) => row.file_name ?? '' },
    { key: 'sha', header: t('ent.mail.col.sha'), render: (row) => (row.file_sha256 === null || row.file_sha256 === undefined ? '' : <code title={row.file_sha256}>{row.file_sha256.slice(0, 16)}</code>) },
    { key: 'status', header: t('ent.mail.col.status'), render: (row) => mailingText(row.status) },
    { key: 'attempts', header: t('ent.mail.col.attempts'), align: 'right', render: (row) => String(row.attempts) },
    { key: 'code', header: t('ent.mail.col.code'), render: (row) => row.error_code ?? '' },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ent.mail.page.title')}</h1>
          <p>{t('ent.mail.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('ent.mail.ctx.scope'), value: tenant?.name ?? '' }, { label: t('ent.mail.ctx.zone'), value: 'Asia/Ho_Chi_Minh' }]} />
      <StateBoundary state={state} onRetry={() => void schedules.refetch()}>
        {data === undefined ? null : (
          <>
            {data.may_manage === true ? (
              <SectionCard title={t('ent.mail.form.title')}>
                <form onSubmit={submit} data-testid="mail-form" className="ent-mail-form">
                  <label htmlFor="mail-layout">{t('ent.mail.form.layout')}</label>
                  <input id="mail-layout" value={layout} onChange={(event) => setLayout(event.target.value)} />
                  <label htmlFor="mail-cron">{t('ent.mail.form.cron')}</label>
                  <input id="mail-cron" value={cron} onChange={(event) => setCron(event.target.value)} />
                  <label htmlFor="mail-format">{t('ent.mail.form.format')}</label>
                  <select id="mail-format" value={format} onChange={(event) => setFormat(event.target.value as (typeof FORMATS)[number])}>
                    {FORMATS.map((one) => (
                      <option key={one} value={one}>
                        {one}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="mail-recipients">{t('ent.mail.form.recipients')}</label>
                  <textarea id="mail-recipients" value={recipients} onChange={(event) => setRecipients(event.target.value)} aria-describedby="mail-recipients-hint" />
                  <p id="mail-recipients-hint" className="muted">
                    {t('ent.mail.form.recipients.hint')}
                  </p>
                  <label htmlFor="mail-note">{t('ent.mail.form.note')}</label>
                  <textarea id="mail-note" value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
                  {failure === undefined ? null : (
                    <p role="alert" data-testid="mail-error">
                      {t('ent.mail.form.error', { code: failure.code })}
                    </p>
                  )}
                  <button type="submit" className="ui-button" disabled={!valid || create.isPending}>
                    {t('ent.mail.form.submit')}
                  </button>
                </form>
              </SectionCard>
            ) : null}
            <SectionCard title={t('ent.mail.schedules.title')}>
              <DataTable caption={t('ent.mail.schedules.caption')} columns={scheduleColumns} rows={data.items} rowKey={(row) => row.id} state={data.items.length === 0 ? 'empty' : 'ready'} />
            </SectionCard>
            <SectionCard title={t('ent.mail.log.title')}>
              {log.data === undefined ? (
                <p role="status">{log.isError ? t('ent.mail.log.error') : t('ent.mail.log.loading')}</p>
              ) : (
                <DataTable caption={t('ent.mail.log.caption')} columns={logColumns} rows={log.data.items} rowKey={(row) => row.id} state={log.data.items.length === 0 ? 'empty' : 'ready'} />
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
      <ConfirmDialog
        open={retiring !== undefined}
        title={t('ent.mail.retire.title')}
        context={[{ label: t('ent.mail.col.form'), value: retiring?.layout_code ?? '' }]}
        confirmLabel={t('ent.mail.retire.confirm')}
        cancelLabel={t('ent.mail.retire.cancel')}
        reason={{ label: t('ent.mail.retire.reason'), required: true, minLength: 10 }}
        pending={retire.isPending}
        onCancel={() => setRetiring(undefined)}
        onConfirm={(reason) => {
          if (retiring === undefined || reason === undefined) return;
          retire.mutate({ id: retiring.id, version: retiring.version, reason: reason.trim() }, { onSuccess: () => setRetiring(undefined) });
        }}
      />
      <p className="prototype-note">{t('ent.mail.footer.text', { id: route.id })}</p>
    </section>
  );
}
