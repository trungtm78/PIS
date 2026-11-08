import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { Figure, InfoRule, Pill, WordSelect, refusalText, shortHash, useCommand, useRead, useRights, vietnamDateTime, vietnamDay, word } from '../docaud-support';
import '../docaud.css';
import { CONTAINER_STATES, NEXT_STATES, PURPOSES, REASON_MIN, UUID, needsReason, stateTone } from './docModel';
import type { Container, ContainerList, ContainerState, Inbox, Purpose, TransmittalList } from './docModel';

const PERMISSION = { manage: 'doc.transmittal.manage', send: 'doc.transmittal.send', answer: 'doc.transmittal.answer' } as const;

interface RegisterForm {
  projectId: string;
  documentId: string;
  documentKind: 'DOCUMENT' | 'PROJECT_DOCUMENT';
  revisionLabel: string;
}

function RegisterDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<RegisterForm>({ projectId: '', documentId: '', documentKind: 'DOCUMENT', revisionLabel: 'A' });
  const [error, setError] = useState<string | undefined>(undefined);
  const register = useCommand<RegisterForm>((client, input, attempt) =>
    client.command('registerDocContainer' as never, { body: { project_id: input.projectId, document_id: input.documentId, document_kind: input.documentKind, revision_label: input.revisionLabel }, attempt } as never),
  );
  const set = (change: Partial<RegisterForm>): void => {
    setError(undefined);
    setForm({ ...form, ...change });
  };
  return (
    <ConfirmDialog
      open
      title={t('gov12da.doc28.register.title')}
      context={[]}
      confirmLabel={t('gov12da.doc28.register.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={register.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        if (!UUID.test(form.projectId) || !UUID.test(form.documentId) || form.revisionLabel.trim() === '') {
          setError(t('gov12da.error.validation.text'));
          return;
        }
        register.mutate({ ...form, revisionLabel: form.revisionLabel.trim() }, { onSuccess: onDone, onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <div className="g12-form">
        <label className="g12-field">
          {t('gov12da.doc28.register.project')}
          <input type="text" value={form.projectId} data-testid="register-project" onChange={(event) => set({ projectId: event.target.value.trim() })} />
        </label>
        <label className="g12-field">
          {t('gov12da.doc28.register.document')}
          <input type="text" value={form.documentId} data-testid="register-document" onChange={(event) => set({ documentId: event.target.value.trim() })} />
        </label>
        <WordSelect id="register-kind" label={t('gov12da.doc28.register.kind')} labelOf={(value) => t(`gov12da.doc.kind.${word(value)}`)} values={['DOCUMENT', 'PROJECT_DOCUMENT']} value={form.documentKind} onChange={(value) => set({ documentKind: value as RegisterForm['documentKind'] })} />
        <label className="g12-field">
          {t('gov12da.doc28.register.revision')}
          <input type="text" maxLength={20} value={form.revisionLabel} data-testid="register-revision" onChange={(event) => set({ revisionLabel: event.target.value })} />
        </label>
      </div>
    </ConfirmDialog>
  );
}

function MoveDialog({ container, onClose, onDone }: { container: Container; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const targets = NEXT_STATES[container.state];
  const [to, setTo] = useState<ContainerState>(targets[0] ?? container.state);
  const [error, setError] = useState<string | undefined>(undefined);
  const move = useCommand<{ to: ContainerState; reason: string | undefined }>((client, input, attempt) =>
    client.command('moveDocContainer' as never, { path: { id: container.id }, ifMatchVersion: container.version, body: { to: input.to, ...(input.reason === undefined ? {} : { reason: input.reason }) }, attempt } as never),
  );
  const reasonAsked = needsReason(container.state, to);
  return (
    <ConfirmDialog
      open
      title={t('gov12da.doc28.move.title', { title: container.title })}
      context={[
        { label: t('gov12da.doc28.col.state'), value: t(`gov12da.doc.state.${container.state.toLowerCase()}`) },
        { label: t('gov12da.doc28.col.revision'), value: container.revision_label },
      ]}
      confirmLabel={t('gov12da.doc28.move.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={move.isPending}
      {...(reasonAsked ? { reason: { label: t('gov12da.common.reason.label'), required: true, minLength: REASON_MIN, hint: t('gov12da.common.reason.hint', { min: REASON_MIN }) } } : {})}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) => move.mutate({ to, reason: reason === undefined || reason.trim() === '' ? undefined : reason.trim() }, { onSuccess: onDone, onError: (failure) => setError(refusalText(t, failure)) })}
    >
      <WordSelect
        id="move-to"
        label={t('gov12da.doc28.move.to')}
        labelOf={(value) => t(`gov12da.doc.state.${word(value)}`)}
        values={targets}
        value={to}
        onChange={(value) => {
          setError(undefined);
          setTo(value as ContainerState);
        }}
      />
    </ConfirmDialog>
  );
}

interface RecipientDraft {
  membershipId: string;
  required: boolean;
}

function SendDialog({ containers, onClose, onDone }: { containers: Container[]; onClose: () => void; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const [number, setNumber] = useState('');
  const [purpose, setPurpose] = useState<Purpose>('FOR_REVIEW');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [recipients, setRecipients] = useState<RecipientDraft[]>([{ membershipId: '', required: true }]);
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<Record<string, unknown>>((client, input, attempt) => client.command('sendDocTransmittal' as never, { body: input, attempt } as never) as Promise<{ resource_id: string }>);
  const clear = (): void => setError(undefined);
  const setRecipient = (index: number, change: Partial<RecipientDraft>): void => {
    clear();
    setRecipients(recipients.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));
  };
  return (
    <ConfirmDialog
      open
      title={t('gov12da.doc28.send.title', { count: containers.length })}
      context={containers.map((container) => ({ label: container.revision_label, value: container.title }))}
      confirmLabel={t('gov12da.doc28.send.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const valid = number.trim().length >= 3 && subject.trim().length >= 3 && recipients.every((entry) => UUID.test(entry.membershipId.trim()));
        const asks = purpose === 'FOR_INFORMATION' || recipients.some((entry) => entry.required);
        if (!valid || !asks) {
          setError(asks ? t('gov12da.error.validation.text') : t('gov12da.doc28.send.noRequired'));
          return;
        }
        const body: Record<string, unknown> = {
          project_id: containers[0]?.project_id,
          number: number.trim(),
          purpose,
          subject: subject.trim(),
          ...(message.trim() === '' ? {} : { message: message.trim() }),
          container_ids: containers.map((container) => container.id),
          recipients: recipients.map((entry) => ({ membership_id: entry.membershipId.trim(), required: entry.required })),
        };
        send.mutate(body, { onSuccess: (result) => onDone((result as { resource_id: string }).resource_id), onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <div className="g12-form">
        <label className="g12-field">
          {t('gov12da.doc28.send.number')}
          <input type="text" value={number} data-testid="send-number" onChange={(event) => { clear(); setNumber(event.target.value); }} />
        </label>
        <WordSelect id="send-purpose" label={t('gov12da.doc28.send.purpose')} labelOf={(value) => t(`gov12da.doc.purpose.${word(value)}`)} values={PURPOSES} value={purpose} onChange={(value) => setPurpose(value as Purpose)} />
        <label className="g12-field">
          {t('gov12da.doc28.send.subject')}
          <input type="text" value={subject} data-testid="send-subject" onChange={(event) => { clear(); setSubject(event.target.value); }} />
        </label>
        <label className="g12-field">
          {t('gov12da.doc28.send.message')}
          <textarea value={message} rows={3} onChange={(event) => setMessage(event.target.value)} />
        </label>
        <fieldset className="g12-recipients">
          <legend>{t('gov12da.doc28.send.recipients')}</legend>
          {recipients.map((entry, index) => (
            <div className="g12-recipients__row" key={index}>
              <input type="text" aria-label={t('gov12da.doc28.send.recipient')} value={entry.membershipId} data-testid={`send-recipient-${index}`} onChange={(event) => setRecipient(index, { membershipId: event.target.value })} />
              <label>
                <input type="checkbox" checked={entry.required} data-testid={`send-required-${index}`} onChange={(event) => setRecipient(index, { required: event.target.checked })} /> {t('gov12da.doc28.send.required')}
              </label>
              {recipients.length > 1 ? (
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setRecipients(recipients.filter((_, at) => at !== index))}>
                  {t('gov12da.doc28.send.remove')}
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="send-add" onClick={() => setRecipients([...recipients, { membershipId: '', required: true }])}>
            {t('gov12da.doc28.send.add')}
          </button>
        </fieldset>
      </div>
    </ConfirmDialog>
  );
}

/**
 * DOC-28, the documents of a project by state (WIP, Shared, Published, Archive) and the transmittals that moved them (G4-11). A document of DOC is registered as a container; it is shared only by a transmittal for review, published
 * only when every required answer approves it and by someone other than its author; the transmittals show how many answers are in and how many are late. The deadlines come from the rule of the day of sending (not confirmed).
 */
export default function ContainerScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <ContainerContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContainerContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const navigate = useNavigate();
  const { holds, frozen } = useRights();
  const [stateFilter, setStateFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'register' | 'send' | undefined>(undefined);
  const [moving, setMoving] = useState<Container | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const project = UUID.test(projectFilter) ? projectFilter : undefined;
  const containers = useRead<ContainerList>('listDocContainers', { query: { state: stateFilter, project_id: project, limit: 100 } });
  const transmittals = useRead<TransmittalList>('listDocTransmittals', { query: { project_id: project, limit: 50 } });
  const inbox = useRead<Inbox>('getDocTransmittalInbox', {}, holds(PERMISSION.answer));
  const data = containers.data;
  const state = useScreenState({ isLoading: containers.isLoading, error: data === undefined ? containers.error : undefined, data, isEmpty: (value) => (value as ContainerList).items.length === 0 });
  const refreshFailed = containers.isError && data !== undefined;
  const mayManage = holds(PERMISSION.manage) && !frozen;
  const maySend = holds(PERMISSION.send) && !frozen;
  const chosen = data?.items.filter((entry) => picked.includes(entry.id)) ?? [];
  const sameProject = chosen.length > 0 && chosen.every((entry) => entry.project_id === chosen[0]?.project_id);
  const asOf = data?.as_of ?? '';
  const overdue = transmittals.data?.items.reduce((sum, entry) => sum + (entry.progress?.overdue ?? 0), 0) ?? 0;
  const counts = CONTAINER_STATES.map((entry) => ({ state: entry, count: data?.items.filter((row) => row.state === entry).length ?? 0 }));

  const columns: DataTableColumn<Container>[] = [
    ...(maySend ? [{ key: 'pick', header: t('gov12da.doc28.col.pick'), render: (row: Container) => <input type="checkbox" aria-label={t('gov12da.doc28.pick.label', { title: row.title })} checked={picked.includes(row.id)} disabled={row.state === 'ARCHIVE'} data-testid={`pick-${row.id}`} onChange={(event) => setPicked(event.target.checked ? [...picked, row.id] : picked.filter((id) => id !== row.id))} /> }] : []),
    { key: 'title', header: t('gov12da.doc28.col.document'), pinned: true, render: (row) => <><strong>{row.title}</strong><div className="g12-muted">{t('gov12da.doc28.col.revision')}: {row.revision_label}</div></> },
    { key: 'state', header: t('gov12da.doc28.col.state'), render: (row) => <StatusPill tone={stateTone(row.state)}>{t(`gov12da.doc.state.${row.state.toLowerCase()}`)}</StatusPill> },
    { key: 'hash', header: t('gov12da.doc28.col.hash'), render: (row) => <code className="g12-hash" title={row.content_sha256}>{shortHash(row.content_sha256)}</code> },
    { key: 'changed', header: t('gov12da.doc28.col.changed'), render: (row) => vietnamDateTime(row.state_changed_at) },
    {
      key: 'action',
      header: t('gov12da.doc28.col.action'),
      render: (row) => (mayManage && NEXT_STATES[row.state].length > 0 ? (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`move-${row.id}`} onClick={() => setMoving(row)}>{t('gov12da.doc28.action.move')}</button>
      ) : <span className="g12-muted">{t('gov12da.doc28.action.none')}</span>),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov12da.doc28.page.title')}</h1>
          <p>{t('gov12da.doc28.page.subtitle')}</p>
        </div>
        <span className="g12-actions">
          {mayManage ? <button type="button" className="ui-button ui-button--primary" data-testid="register-open" onClick={() => setDialog('register')}>{t('gov12da.doc28.register.open')}</button> : null}
          {maySend ? <button type="button" className="ui-button ui-button--primary" data-testid="send-open" disabled={chosen.length === 0 || !sameProject} onClick={() => setDialog('send')}>{t('gov12da.doc28.send.open')}</button> : null}
        </span>
      </div>
      <ContextBar items={[{ label: t('gov12da.common.context.scope'), value: tenant?.name ?? '–' }]} {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })} stale={refreshFailed} />
      {receipt === undefined ? null : (
        <p className="callout" role="status" data-testid="send-receipt">
          {t('gov12da.doc28.receipt.text')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void navigate(`/doc/doc-29?transmittal=${receipt}`)}>{t('gov12da.doc28.receipt.open')}</button>
        </p>
      )}
      {data === undefined ? null : (
        <div className="g12-figures">
          {counts.map((entry) => <Figure key={entry.state} label={t(`gov12da.doc.state.${entry.state.toLowerCase()}`)} value={String(entry.count)} topic="transmittal" asOf={asOf} rule={undefined} testId={`count-${entry.state}`} />)}
          <Figure label={t('gov12da.doc28.figure.overdue')} value={String(overdue)} topic="transmittal" asOf={asOf} rule={undefined} testId="count-overdue" />
        </div>
      )}
      <div className="g12-filter">
        <WordSelect id="filter-state" label={t('gov12da.doc28.filter.state')} labelOf={(value) => t(`gov12da.doc.state.${word(value)}`)} values={CONTAINER_STATES} value={stateFilter} onChange={setStateFilter} any={t('gov12da.common.filter.any')} />
        <label className="g12-field">
          {t('gov12da.doc28.filter.project')}
          <input type="text" value={projectFilter} data-testid="filter-project" onChange={(event) => setProjectFilter(event.target.value.trim())} />
        </label>
      </div>
      <StateBoundary state={state} onRetry={() => void containers.refetch()}>
        {data !== undefined && <DataTable caption={t('gov12da.doc28.table.caption')} columns={columns} rows={data.items} rowKey={(row) => row.id} />}
      </StateBoundary>

      {holds(PERMISSION.answer) && inbox.data !== undefined && inbox.data.items.length > 0 ? (
        <section aria-labelledby="inbox-title" data-testid="inbox">
          <h2 id="inbox-title">{t('gov12da.doc28.inbox.title')}</h2>
          <ul>
            {inbox.data.items.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void navigate(`/doc/doc-29?transmittal=${entry.id}`)}>{entry.number}</button> {entry.subject}{' '}
                <span className="g12-muted">{t('gov12da.doc28.inbox.due', { day: vietnamDay(entry.my_due_on) })}</span> <Pill label={t(`gov12da.doc.review.${word(entry.my_review.state)}`)} tones={entry.my_review.state === 'OVERDUE' ? 'danger' : 'neutral'} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="transmittals-title">
        <h2 id="transmittals-title">{t('gov12da.doc28.transmittals.title')}</h2>
        {transmittals.isLoading ? <p role="status" aria-busy="true">{t('states.loading.label')}</p> : null}
        {transmittals.isError ? <p role="alert">{t('gov12da.doc28.transmittals.error')}</p> : null}
        {transmittals.data !== undefined && transmittals.data.items.length === 0 ? <p className="g12-muted">{t('gov12da.doc28.transmittals.empty')}</p> : null}
        {transmittals.data !== undefined && transmittals.data.items.length > 0 ? (
          <DataTable
            caption={t('gov12da.doc28.transmittals.caption')}
            rows={transmittals.data.items}
            rowKey={(row) => row.id}
            columns={[
              { key: 'number', header: t('gov12da.doc28.tcol.number'), pinned: true, render: (row) => <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${row.number}`} onClick={() => void navigate(`/doc/doc-29?transmittal=${row.id}`)}>{row.number}</button> },
              { key: 'subject', header: t('gov12da.doc28.tcol.subject'), render: (row) => row.subject },
              { key: 'purpose', header: t('gov12da.doc28.tcol.purpose'), render: (row) => t(`gov12da.doc.purpose.${row.purpose.toLowerCase().replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())}`) },
              { key: 'sent', header: t('gov12da.doc28.tcol.sent'), render: (row) => vietnamDay(row.sent_on) },
              {
                key: 'progress',
                header: t('gov12da.doc28.tcol.progress'),
                align: 'right',
                render: (row) => (row.progress === undefined || row.progress === null ? '–' : (
                  <span data-testid={`progress-${row.number}`}>
                    {t('gov12da.doc28.progress.text', { answered: row.progress.answered, required: row.progress.required })}{' '}
                    <InfoRule topic="transmittal" name={t('gov12da.doc28.tcol.progress')} asOf={asOf} rule={{ version: row.rule_version, unverified: row.rule_version === 0 }} />
                  </span>
                )),
              },
              { key: 'late', header: t('gov12da.doc28.tcol.overdue'), align: 'right', render: (row) => row.progress?.overdue ?? 0 },
            ]}
          />
        ) : null}
      </section>

      {dialog === 'register' ? <RegisterDialog onClose={() => setDialog(undefined)} onDone={() => setDialog(undefined)} /> : null}
      {dialog === 'send' ? (
        <SendDialog
          containers={chosen}
          onClose={() => setDialog(undefined)}
          onDone={(id) => {
            setDialog(undefined);
            setPicked([]);
            setReceipt(id);
          }}
        />
      ) : null}
      {moving === undefined ? null : <MoveDialog container={moving} onClose={() => setMoving(undefined)} onDone={() => setMoving(undefined)} />}
      <p className="prototype-note">{t('gov12da.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
