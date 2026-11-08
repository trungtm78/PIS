import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { Figure, InfoRule, WordSelect, refusalText, useCommand, useRead, useRights, vietnamDay, vietnamDateTime, word } from '../docaud-support';
import '../docaud.css';
import { MOVES, NOTE_MIN, UUID, WHISTLE_STATUSES, moveNeedsNote } from './audModel';
import type { Whistle, WhistleClock, WhistleDetail, WhistleList, WhistleMove, WhistleSummary } from './audModel';

const PERMISSION = { handle: 'aud.whistle.handle' } as const;
const clockTone = (state: WhistleClock['acknowledge_state']): Tone => (state === 'OVERDUE' || state === 'DONE_LATE' ? 'danger' : state === 'DONE_ON_TIME' ? 'success' : 'neutral');

function MoveDialog({ report, onClose }: { report: WhistleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const moves = MOVES[report.status];
  const [move, setMove] = useState<WhistleMove>(moves[0] ?? 'ACKNOWLEDGE');
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<{ move: WhistleMove; note: string | undefined }>((client, input, attempt) =>
    client.command('moveWhistleReport' as never, { path: { id: report.id }, ifMatchVersion: report.version, body: { move: input.move, ...(input.note === undefined ? {} : { note: input.note }) }, attempt } as never),
  );
  const asked = moveNeedsNote(move);
  return (
    <ConfirmDialog
      open
      title={t('gov12da.aud18.move.title')}
      context={[{ label: t('gov12da.aud18.col.status'), value: t(`gov12da.aud.whistle.${word(report.status)}`) }]}
      confirmLabel={t('gov12da.aud18.move.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      {...(asked ? { reason: { label: t('gov12da.aud18.move.note'), required: true, minLength: NOTE_MIN, hint: t('gov12da.aud18.move.noteHint', { min: NOTE_MIN }) } } : {})}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(note) => send.mutate({ move, note: note === undefined || note.trim() === '' ? undefined : note.trim() }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) })}
    >
      <WordSelect id="move-choice" label={t('gov12da.aud18.move.choice')} labelOf={(value) => t(`gov12da.aud.move.${word(value)}`)} values={moves} value={move} onChange={(value) => { setError(undefined); setMove(value as WhistleMove); }} />
    </ConfirmDialog>
  );
}

function SubjectDialog({ report, onClose }: { report: WhistleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState(report.subject_unit_id ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<string | null>((client, input, attempt) => client.command('assignWhistleSubject' as never, { path: { id: report.id }, ifMatchVersion: report.version, body: { unit_id: input }, attempt } as never));
  return (
    <ConfirmDialog
      open
      title={t('gov12da.aud18.subject.title')}
      context={[]}
      confirmLabel={t('gov12da.aud18.subject.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const value = unit.trim();
        if (value !== '' && !UUID.test(value)) {
          setError(t('gov12da.error.validation.text'));
          return;
        }
        send.mutate(value === '' ? null : value.toLowerCase(), { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <label className="g12-field">
        {t('gov12da.aud18.subject.unit')}
        <input type="text" value={unit} data-testid="subject-unit" onChange={(event) => { setError(undefined); setUnit(event.target.value); }} />
      </label>
      <p className="g12-muted">{t('gov12da.aud18.subject.hint')}</p>
    </ConfirmDialog>
  );
}

function ReplyDialog({ report, onClose }: { report: WhistleDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<string>((client, input, attempt) => client.command('replyToWhistleReporter' as never, { path: { id: report.id }, body: { body: input }, attempt } as never));
  return (
    <ConfirmDialog
      open
      title={t('gov12da.aud18.reply.title')}
      context={[]}
      confirmLabel={t('gov12da.aud18.reply.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      reason={{ label: t('gov12da.aud18.reply.body'), required: true, minLength: 1 }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(body) => send.mutate((body ?? '').trim(), { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) })}
    />
  );
}

/**
 * AUD-18, the anonymous reports (G4-12) for the auditors who handle them. A report has no identity of the reporter: no name, address or device exists to show, and the reporter knows it only by a code that is shown once. Two
 * clocks run from the day it was received (to acknowledge it, and to settle it). A handler of the unit the report is about is told it does not exist. A resolution or a dismissal says why, in words the reporter reads.
 */
export default function WhistleScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <WhistleContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WhistleContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const navigate = useNavigate();
  const { holds, frozen } = useRights();
  const [params] = useSearchParams();
  const id = params.get('report') ?? undefined;
  const [statusFilter, setStatusFilter] = useState('');
  const [dialog, setDialog] = useState<'move' | 'subject' | 'reply' | undefined>(undefined);
  const summary = useRead<WhistleSummary>('getWhistleSummary');
  const list = useRead<WhistleList>('listWhistleReports', { query: { status: statusFilter, limit: 100 } }, id === undefined);
  const one = useRead<WhistleDetail>('getWhistleReport', { path: { id: id ?? '' } }, id !== undefined);
  const query = id === undefined ? list : one;
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => id === undefined && (value as WhistleList).items.length === 0 });
  const refreshFailed = query.isError && data !== undefined;
  const mayHandle = holds(PERMISSION.handle) && !frozen;
  const detail = id === undefined ? undefined : one.data;
  const asOf = data?.as_of ?? '';
  const unverified = { version: 0, unverified: true };

  const clocks = (clock: WhistleClock) => (
    <>
      <span data-testid="clock-ack">{vietnamDay(clock.acknowledge_due_on)} <StatusPill tone={clockTone(clock.acknowledge_state)}>{t(`gov12da.aud.clock.${word(clock.acknowledge_state)}`)}</StatusPill></span>{' '}
      <span data-testid="clock-resolve">{vietnamDay(clock.resolve_due_on)} <StatusPill tone={clockTone(clock.resolve_state)}>{t(`gov12da.aud.clock.${word(clock.resolve_state)}`)}</StatusPill></span>
    </>
  );
  const columns: DataTableColumn<Whistle>[] = [
    { key: 'received', header: t('gov12da.aud18.col.received'), pinned: true, render: (row) => <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${row.id}`} onClick={() => void navigate(`/aud/aud-18?report=${row.id}`)}>{vietnamDay(row.received_on)}</button> },
    { key: 'category', header: t('gov12da.aud18.col.category'), render: (row) => t(`gov12da.aud.category.${word(row.category)}`) },
    { key: 'status', header: t('gov12da.aud18.col.status'), render: (row) => <StatusPill tone={row.status === 'RESOLVED' ? 'success' : row.status === 'DISMISSED' ? 'neutral' : 'info'}>{t(`gov12da.aud.whistle.${word(row.status)}`)}</StatusPill> },
    { key: 'ack', header: t('gov12da.aud18.col.ack'), render: (row) => <span data-testid={`ack-${row.id}`}>{vietnamDay(row.clock.acknowledge_due_on)} <StatusPill tone={clockTone(row.clock.acknowledge_state)}>{t(`gov12da.aud.clock.${word(row.clock.acknowledge_state)}`)}</StatusPill> <InfoRule topic="whistle" name={t('gov12da.aud18.col.ack')} asOf={asOf} rule={unverified} /></span> },
    { key: 'resolve', header: t('gov12da.aud18.col.resolve'), render: (row) => <span>{vietnamDay(row.clock.resolve_due_on)} <StatusPill tone={clockTone(row.clock.resolve_state)}>{t(`gov12da.aud.clock.${word(row.clock.resolve_state)}`)}</StatusPill> <InfoRule topic="whistle" name={t('gov12da.aud18.col.resolve')} asOf={asOf} rule={unverified} /></span> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov12da.aud18.page.title')}</h1>
          <p>{t('gov12da.aud18.page.subtitle')}</p>
        </div>
        {id === undefined ? null : <button type="button" className="ui-button ui-button--outline" data-testid="back" onClick={() => void navigate('/aud/aud-18')}>{t('gov12da.aud18.back')}</button>}
      </div>
      <ContextBar items={[{ label: t('gov12da.common.context.scope'), value: tenant?.name ?? '–' }]} {...(asOf === '' ? {} : { asOf: vietnamDateTime(asOf) })} stale={refreshFailed} />
      <p className="callout" role="note" data-testid="anonymous-note">{t('gov12da.aud18.note.anonymous')}</p>
      {summary.data === undefined ? null : (
        <div className="g12-figures">
          <Figure label={t('gov12da.aud18.figure.open')} value={String(summary.data.open)} topic="whistle" asOf={summary.data.as_of} rule={unverified} testId="figure-open" />
          <Figure label={t('gov12da.aud18.figure.ackOverdue')} value={String(summary.data.acknowledge_overdue)} topic="whistle" asOf={summary.data.as_of} rule={unverified} testId="figure-ack-overdue" />
          <Figure label={t('gov12da.aud18.figure.resolveOverdue')} value={String(summary.data.resolve_overdue)} topic="whistle" asOf={summary.data.as_of} rule={unverified} testId="figure-resolve-overdue" />
        </div>
      )}
      {id === undefined ? (
        <div className="g12-filter">
          <WordSelect id="filter-status" label={t('gov12da.aud18.filter.status')} labelOf={(value) => t(`gov12da.aud.whistle.${word(value)}`)} values={WHISTLE_STATUSES} value={statusFilter} onChange={setStatusFilter} any={t('gov12da.common.filter.any')} />
        </div>
      ) : null}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {id === undefined && list.data !== undefined ? <DataTable caption={t('gov12da.aud18.table.caption')} columns={columns} rows={list.data.items} rowKey={(row) => row.id} /> : null}
        {detail === undefined ? null : (
          <>
            <dl className="g12-facts">
              <div><dt>{t('gov12da.aud18.col.category')}</dt><dd>{t(`gov12da.aud.category.${word(detail.category)}`)}</dd></div>
              <div><dt>{t('gov12da.aud18.col.status')}</dt><dd data-testid="detail-status">{t(`gov12da.aud.whistle.${word(detail.status)}`)}</dd></div>
              <div><dt>{t('gov12da.aud18.col.received')}</dt><dd>{vietnamDay(detail.received_on)}</dd></div>
              <div><dt>{t('gov12da.aud18.fact.clocks')}</dt><dd>{clocks(detail.clock)}</dd></div>
              <div><dt>{t('gov12da.aud18.fact.unit')}</dt><dd data-testid="detail-unit">{detail.subject_unit_id ?? t('gov12da.aud18.fact.noUnit')}</dd></div>
              {detail.public_note === null ? null : <div><dt>{t('gov12da.aud18.fact.note')}</dt><dd>{detail.public_note}</dd></div>}
            </dl>
            <h2>{t('gov12da.aud18.body.title')}</h2>
            <p className="callout" data-testid="detail-body">{detail.body}</p>
            <h2>{t('gov12da.aud18.thread.title')}</h2>
            {detail.thread.length === 0 ? <p className="g12-muted">{t('gov12da.aud18.thread.empty')}</p> : (
              <ul className="g12-thread" data-testid="thread">
                {detail.thread.map((message) => (
                  <li key={message.seq} className={`g12-thread__item${message.sender === 'HANDLER' ? ' g12-thread__item--handler' : ''}`}>
                    <strong>{t(`gov12da.aud.sender.${word(message.sender)}`)}</strong> <span className="g12-muted">{vietnamDay(message.sent_on)}</span>
                    <p>{message.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {mayHandle ? (
              <span className="g12-actions">
                {MOVES[detail.status].length > 0 ? <button type="button" className="ui-button ui-button--primary" data-testid="move-open" onClick={() => setDialog('move')}>{t('gov12da.aud18.move.open')}</button> : null}
                {detail.status !== 'RESOLVED' && detail.status !== 'DISMISSED' ? <button type="button" className="ui-button ui-button--outline" data-testid="subject-open" onClick={() => setDialog('subject')}>{t('gov12da.aud18.subject.open')}</button> : null}
                {detail.status !== 'RESOLVED' && detail.status !== 'DISMISSED' ? <button type="button" className="ui-button ui-button--outline" data-testid="reply-open" onClick={() => setDialog('reply')}>{t('gov12da.aud18.reply.open')}</button> : null}
              </span>
            ) : null}
          </>
        )}
      </StateBoundary>
      {dialog === 'move' && detail !== undefined ? <MoveDialog report={detail} onClose={() => setDialog(undefined)} /> : null}
      {dialog === 'subject' && detail !== undefined ? <SubjectDialog report={detail} onClose={() => setDialog(undefined)} /> : null}
      {dialog === 'reply' && detail !== undefined ? <ReplyDialog report={detail} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('gov12da.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
