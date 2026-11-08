import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../../ui';
import { Figure, InfoRule, Pill, WordSelect, refusalText, useCommand, useRead, useRights, vietnamDateTime, vietnamDay, word } from '../docaud-support';
import '../docaud.css';
import { ANSWERS, REASON_MIN } from './docModel';
import type { Answer, Recipient, TransmittalDetail, TransmittalList } from './docModel';

const PERMISSION = { send: 'doc.transmittal.send', answer: 'doc.transmittal.answer' } as const;

function AnswerDialog({ transmittal, onClose }: { transmittal: TransmittalDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState<Answer>('APPROVED');
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<{ answer: Answer; comment: string | undefined }>((client, input, attempt) =>
    client.command('answerDocTransmittal' as never, { path: { id: transmittal.id }, body: { answer: input.answer, ...(input.comment === undefined ? {} : { comment: input.comment }) }, attempt } as never),
  );
  const commentAsked = answer === 'REJECTED' || answer === 'APPROVED_WITH_COMMENTS';
  return (
    <ConfirmDialog
      open
      title={t('gov12da.doc29.answer.title', { number: transmittal.number })}
      context={[{ label: t('gov12da.doc29.fact.subject'), value: transmittal.subject }]}
      confirmLabel={t('gov12da.doc29.answer.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      {...(commentAsked ? { reason: { label: t('gov12da.doc29.answer.comment'), required: true, minLength: REASON_MIN, hint: t('gov12da.common.reason.hint', { min: REASON_MIN }) } } : {})}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(comment) => send.mutate({ answer, comment: comment === undefined || comment.trim() === '' ? undefined : comment.trim() }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) })}
    >
      <WordSelect id="answer-choice" label={t('gov12da.doc29.answer.choice')} labelOf={(value) => t(`gov12da.doc.answer.${word(value)}`)} values={ANSWERS} value={answer} onChange={(value) => { setError(undefined); setAnswer(value as Answer); }} />
    </ConfirmDialog>
  );
}

function ExtendDialog({ transmittal, recipient, onClose }: { transmittal: TransmittalDetail; recipient: Recipient; onClose: () => void }) {
  const { t } = useTranslation();
  const [dueOn, setDueOn] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const send = useCommand<{ dueOn: string; reason: string }>((client, input, attempt) =>
    client.command('extendDocTransmittal' as never, { path: { id: transmittal.id }, body: { recipient_id: recipient.id, due_on: input.dueOn, reason: input.reason }, attempt } as never),
  );
  return (
    <ConfirmDialog
      open
      title={t('gov12da.doc29.extend.title', { number: transmittal.number })}
      context={[{ label: t('gov12da.doc29.col.due'), value: vietnamDay(recipient.due_on) }]}
      confirmLabel={t('gov12da.doc29.extend.confirm')}
      cancelLabel={t('gov12da.common.action.cancel')}
      pending={send.isPending}
      reason={{ label: t('gov12da.common.reason.label'), required: true, minLength: REASON_MIN, hint: t('gov12da.common.reason.hint', { min: REASON_MIN }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
          setError(t('gov12da.error.validation.text'));
          return;
        }
        send.mutate({ dueOn, reason: (reason ?? '').trim() }, { onSuccess: onClose, onError: (failure) => setError(refusalText(t, failure)) });
      }}
    >
      <label className="g12-field">
        {t('gov12da.doc29.extend.day')}
        <input type="date" value={dueOn} data-testid="extend-day" onChange={(event) => { setError(undefined); setDueOn(event.target.value); }} />
      </label>
    </ConfirmDialog>
  );
}

/**
 * DOC-29, one transmittal (G4-11): what was sent with the hash that each recipient saw, who must answer, by which day, what they answered, the one extension a sender may give and the transmittal that replaces it. A sent
 * transmittal is never edited; a person answers only a transmittal that names them, once. Without a transmittal in the address the screen lists them.
 */
export default function TransmittalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <TransmittalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TransmittalContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const navigate = useNavigate();
  const { holds, frozen, membershipId } = useRights();
  const [params] = useSearchParams();
  const id = params.get('transmittal') ?? undefined;
  const list = useRead<TransmittalList>('listDocTransmittals', { query: { limit: 100 } }, id === undefined);
  const one = useRead<TransmittalDetail>('getDocTransmittal', { path: { id: id ?? '' } }, id !== undefined);
  const query = id === undefined ? list : one;
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => 'items' in (value as object) && (value as TransmittalList).items !== undefined && Array.isArray((value as TransmittalList).items) && (value as TransmittalList).items.length === 0 && id === undefined });
  const refreshFailed = query.isError && data !== undefined;
  const [answering, setAnswering] = useState(false);
  const [extending, setExtending] = useState<Recipient | undefined>(undefined);
  const detail = id === undefined ? undefined : one.data;
  const mine = detail?.recipients.find((entry) => entry.recipient_id === membershipId);
  const mayAnswer = mine !== undefined && mine.answer === null && holds(PERMISSION.answer) && !frozen && detail?.superseded_by_id === null;
  const mayExtend = detail !== undefined && detail.sent_by === membershipId && holds(PERMISSION.send) && !frozen && detail.superseded_by_id === null;
  const asOf = detail?.as_of ?? list.data?.as_of ?? '';
  const rule = detail === undefined ? undefined : { version: detail.rule_version, unverified: detail.rule_version === 0 };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov12da.doc29.page.title')}</h1>
          <p>{t('gov12da.doc29.page.subtitle')}</p>
        </div>
        {mayAnswer ? <button type="button" className="ui-button ui-button--primary" data-testid="answer-open" onClick={() => setAnswering(true)}>{t('gov12da.doc29.answer.open')}</button> : null}
      </div>
      <ContextBar items={[{ label: t('gov12da.common.context.scope'), value: tenant?.name ?? '–' }]} {...(asOf === '' ? {} : { asOf: vietnamDateTime(asOf) })} stale={refreshFailed} />
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {id === undefined && list.data !== undefined ? (
          <DataTable
            caption={t('gov12da.doc29.list.caption')}
            rows={list.data.items}
            rowKey={(row) => row.id}
            columns={[
              { key: 'number', header: t('gov12da.doc29.fact.number'), pinned: true, render: (row) => <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${row.number}`} onClick={() => void navigate(`/doc/doc-29?transmittal=${row.id}`)}>{row.number}</button> },
              { key: 'subject', header: t('gov12da.doc29.fact.subject'), render: (row) => row.subject },
              { key: 'sent', header: t('gov12da.doc29.fact.sent'), render: (row) => vietnamDay(row.sent_on) },
            ]}
          />
        ) : null}
        {detail === undefined ? null : (
          <>
            <dl className="g12-facts">
              <div><dt>{t('gov12da.doc29.fact.number')}</dt><dd data-testid="fact-number">{detail.number}</dd></div>
              <div><dt>{t('gov12da.doc29.fact.purpose')}</dt><dd>{t(`gov12da.doc.purpose.${detail.purpose.toLowerCase().replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())}`)}</dd></div>
              <div><dt>{t('gov12da.doc29.fact.subject')}</dt><dd>{detail.subject}</dd></div>
              <div><dt>{t('gov12da.doc29.fact.sent')}</dt><dd>{vietnamDay(detail.sent_on)}</dd></div>
              <div>
                <dt>{t('gov12da.doc29.fact.days')}</dt>
                <dd data-testid="fact-days">{detail.review_days === null ? '–' : t('gov12da.doc29.days.text', { days: detail.review_days })} <InfoRule topic="transmittal" name={t('gov12da.doc29.fact.days')} asOf={asOf} rule={rule} /></dd>
              </div>
              {detail.message === null ? null : <div><dt>{t('gov12da.doc29.fact.message')}</dt><dd>{detail.message}</dd></div>}
              {detail.supersedes_id === null ? null : <div><dt>{t('gov12da.doc29.fact.supersedes')}</dt><dd><button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void navigate(`/doc/doc-29?transmittal=${detail.supersedes_id}`)}>{t('gov12da.doc29.fact.openOld')}</button></dd></div>}
              {detail.superseded_by_id === null ? null : (
                <div>
                  <dt>{t('gov12da.doc29.fact.supersededBy')}</dt>
                  <dd data-testid="superseded"><StatusPill tone="warning">{t('gov12da.doc29.fact.replaced')}</StatusPill> <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void navigate(`/doc/doc-29?transmittal=${detail.superseded_by_id}`)}>{t('gov12da.doc29.fact.openNew')}</button></dd>
                </div>
              )}
            </dl>
            <div className="g12-figures">
              <Figure label={t('gov12da.doc29.figure.answered')} value={t('gov12da.doc28.progress.text', { answered: detail.progress.answered, required: detail.progress.required })} topic="transmittal" asOf={asOf} rule={rule} testId="figure-answered" />
              <Figure label={t('gov12da.doc29.figure.rejected')} value={String(detail.progress.rejected)} topic="transmittal" asOf={asOf} rule={rule} testId="figure-rejected" />
              <Figure label={t('gov12da.doc29.figure.overdue')} value={String(detail.progress.overdue)} topic="transmittal" asOf={asOf} rule={rule} testId="figure-overdue" />
            </div>
            <h2>{t('gov12da.doc29.items.title')}</h2>
            <DataTable
              caption={t('gov12da.doc29.items.caption')}
              rows={detail.items}
              rowKey={(row) => row.id}
              columns={[
                { key: 'title', header: t('gov12da.doc29.col.document'), pinned: true, render: (row) => <><strong>{row.title}</strong><div className="g12-muted">{row.revision_label}</div></> },
                { key: 'hash', header: t('gov12da.doc29.col.hash'), render: (row) => <code className="g12-hash" data-testid={`hash-${row.id}`}>{row.content_sha256}</code> },
              ]}
            />
            <h2>{t('gov12da.doc29.recipients.title')}</h2>
            <DataTable
              caption={t('gov12da.doc29.recipients.caption')}
              rows={detail.recipients}
              rowKey={(row) => row.id}
              columns={[
                { key: 'who', header: t('gov12da.doc29.col.recipient'), pinned: true, render: (row) => <><code className="g12-hash">{row.recipient_id}</code>{row.recipient_id === membershipId ? <> <StatusPill tone="info">{t('gov12da.doc29.col.you')}</StatusPill></> : null}</> },
                { key: 'required', header: t('gov12da.doc29.col.required'), render: (row) => (row.required ? t('gov12da.common.yes') : t('gov12da.common.no')) },
                { key: 'due', header: t('gov12da.doc29.col.due'), render: (row) => <span data-testid={`due-${row.id}`}>{vietnamDay(row.extended_due_on ?? row.due_on)}{row.extended_due_on === null ? null : <span className="g12-muted"> {t('gov12da.doc29.col.extended', { day: vietnamDay(row.due_on) })}</span>}</span> },
                { key: 'review', header: t('gov12da.doc29.col.review'), render: (row) => <Pill label={t(`gov12da.doc.review.${word(row.review.state)}`)} tones={row.review.state === 'OVERDUE' || row.review.state === 'ANSWERED_LATE' ? 'danger' : row.review.state === 'ANSWERED_ON_TIME' ? 'success' : row.review.state === 'DUE_SOON' ? 'warning' : 'neutral'} /> },
                { key: 'answer', header: t('gov12da.doc29.col.answer'), render: (row) => (row.answer === null ? '–' : <><strong>{t(`gov12da.doc.answer.${row.answer.toLowerCase().replace(/_(\w)/g, (_m, c: string) => c.toUpperCase())}`)}</strong>{row.answer_comment === null ? null : <div className="g12-muted">{row.answer_comment}</div>}<div className="g12-muted">{vietnamDay(row.answered_on)}</div></>) },
                {
                  key: 'action',
                  header: t('gov12da.doc29.col.action'),
                  render: (row) => (mayExtend && row.answer === null && row.due_on !== null && row.extended_due_on === null ? (
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`extend-${row.id}`} onClick={() => setExtending(row)}>{t('gov12da.doc29.extend.open')}</button>
                  ) : <span className="g12-muted">{t('gov12da.doc28.action.none')}</span>),
                },
              ]}
            />
          </>
        )}
      </StateBoundary>
      {answering && detail !== undefined ? <AnswerDialog transmittal={detail} onClose={() => setAnswering(false)} /> : null}
      {extending !== undefined && detail !== undefined ? <ExtendDialog transmittal={detail} recipient={extending} onClose={() => setExtending(undefined)} /> : null}
      <p className="prototype-note">{t('gov12da.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
