import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ConfirmDialog, ContextBar, SectionCard, StatusPill } from '../../../ui';
import { useAddItem, useCloseFile, useLogFeedback, useMonitoringFile, useMoveFeedback, useSendNotice, useSetTrigger, useWithdrawItem } from './prjHooks';
import { CHANNELS, PACK_ITEMS, REASON_MIN, REQUIRED_ITEMS, TOPICS, TRIGGERS, dayText, feedbackTone, hasRight, refusalKey, word } from './prjModel';
import type { FeedbackView, FileDetail, PackItem } from './prjModel';
import { DaysText, Facts, Figure, NoticePill, Provenance, ResponsePill } from './prjParts';
import './prj.css';

const LIST_PATH = '/prj/prj-30';
const RESPOND_MIN = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PRJ-31, one community monitoring file: the notice and its deadline, the pack of documents it is made of (linked from DOC by id), and the feedback of the community with its own clock and its answer. The notice is sent only when
 * the pack holds the notice text, the project information and the schedule; a sent notice and the pack of that day do not change; the person who closes an answer is not the person who gave it; the file closes when no feedback waits.
 */
export default function MonitoringDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

interface FormDialogProps {
  title: string;
  confirm: string;
  context: { label: string; value: string }[];
  pending: boolean;
  error: string | undefined;
  reason?: { label: string; required: boolean; minLength: number; hint: string };
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
  children?: ReactNode;
}

function FormDialog({ title, confirm, context, pending, error, reason, onCancel, onConfirm, children }: FormDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open
      title={title}
      context={context}
      confirmLabel={confirm}
      cancelLabel={t('prj.monDetail.dialog.cancel')}
      pending={pending}
      {...(reason === undefined ? {} : { reason })}
      {...(error === undefined ? {} : { error })}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {children}
    </ConfirmDialog>
  );
}

type Dialog =
  | { kind: 'trigger' }
  | { kind: 'notice' }
  | { kind: 'close' }
  | { kind: 'addItem' }
  | { kind: 'withdraw'; item: PackItem }
  | { kind: 'log' }
  | { kind: 'move'; feedback: FeedbackView; move: 'TAKE' | 'RESPOND' | 'CLOSE' | 'REOPEN' | 'DECLINE' };

function DetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [params] = useSearchParams();
  const id = params.get('file') ?? undefined;
  const query = useMonitoringFile(id);
  const data = query.data;
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: id !== undefined && query.isLoading, error: data === undefined ? query.error : undefined, data });
  const refreshFailed = query.isError && data !== undefined;
  const editable = mode !== 'READ_ONLY' && data?.status === 'OPEN';
  const canManage = editable && hasRight(permissions, 'project.monitoring.manage');
  const canLog = editable && hasRight(permissions, 'project.monitoring.feedback');
  const canRespond = hasRight(permissions, 'project.monitoring.respond') && mode !== 'READ_ONLY';
  const me = tenant?.membershipId;

  const trigger = useSetTrigger();
  const notice = useSendNotice();
  const close = useCloseFile();
  const add = useAddItem();
  const withdraw = useWithdrawItem();
  const log = useLogFeedback();
  const move = useMoveFeedback();

  // The fields of the dialogs.
  const [kind, setKind] = useState<string>(TRIGGERS[0]);
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  const [item, setItem] = useState<string>(PACK_ITEMS[0]);
  const [documentId, setDocumentId] = useState('');
  const [documentKind, setDocumentKind] = useState('DOCUMENT');
  const [reference, setReference] = useState('');
  const [channel, setChannel] = useState<string>(CHANNELS[0]);
  const [topic, setTopic] = useState<string>(TOPICS[0]);
  const [label, setLabel] = useState('');
  const [summary, setSummary] = useState('');

  const open = (next: Dialog): void => {
    setError(undefined);
    setDay('');
    setNote('');
    setDocumentId('');
    setReference('');
    setSummary('');
    setLabel('');
    setDialog(next);
  };
  const done = (message: string): void => {
    setDialog(undefined);
    setError(undefined);
    setReceipt(message);
  };
  const refuse = (failure: unknown): void => setError(t(`prj.common.error.${refusalKey(failure)}`));
  const reasonOf = (text: string | undefined): string | undefined => (text === undefined || text.trim() === '' ? undefined : text.trim());

  const file: FileDetail | undefined = data;
  const asOf = file === undefined ? '' : dayText(file.as_of);
  const owner = tenant?.name ?? '–';

  const renderDialog = (current: Dialog, detail: FileDetail): ReactNode => {
    const context = [{ label: t('prj.monDetail.dialog.file'), value: detail.project_code ?? detail.project_id }];
    switch (current.kind) {
      case 'trigger':
        return (
          <FormDialog
            title={t('prj.monDetail.trigger.title')}
            confirm={t('prj.monDetail.trigger.confirm')}
            context={[...context, { label: t('prj.monDetail.trigger.rule'), value: t('prj.monDetail.trigger.rule.value', { days: detail.rule.notice_days_now }) }]}
            pending={trigger.isPending}
            error={error}
            {...(kind === 'MANUAL' ? { reason: { label: t('prj.monDetail.trigger.reason'), required: true, minLength: REASON_MIN, hint: t('prj.monDetail.reason.hint', { min: REASON_MIN }) } } : {})}
            onCancel={() => setDialog(undefined)}
            onConfirm={(reason) => {
              if (day === '') return setError(t('prj.common.error.validationFailed'));
              trigger.mutate({ id: detail.id, version: detail.version, kind, on: day, reason: kind === 'MANUAL' ? reasonOf(reason) : undefined }, { onSuccess: () => done(t('prj.monDetail.receipt.trigger')), onError: refuse });
            }}
          >
            <div className="prj-inline">
              <label>
                {t('prj.monDetail.trigger.kind')}
                <select value={kind} data-testid="trigger-kind" onChange={(event) => setKind(event.target.value)}>
                  {TRIGGERS.map((value) => (
                    <option key={value} value={value}>
                      {t(`prj.mon.trigger.${word(value)}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('prj.monDetail.trigger.day')}
                <input type="date" value={day} data-testid="trigger-day" onChange={(event) => setDay(event.target.value)} />
              </label>
            </div>
          </FormDialog>
        );
      case 'notice':
        return (
          <FormDialog
            title={t('prj.monDetail.notice.title')}
            confirm={t('prj.monDetail.notice.confirm')}
            context={[...context, { label: t('prj.monDetail.notice.due'), value: dayText(detail.notice.due_on) }]}
            pending={notice.isPending}
            error={error}
            onCancel={() => setDialog(undefined)}
            onConfirm={() => {
              if (day === '') return setError(t('prj.common.error.validationFailed'));
              notice.mutate({ id: detail.id, version: detail.version, sentOn: day, note: reasonOf(note) }, { onSuccess: () => done(t('prj.monDetail.receipt.notice')), onError: refuse });
            }}
          >
            <div className="prj-form">
              <label>
                {t('prj.monDetail.notice.sentOn')}
                <input type="date" value={day} data-testid="notice-day" onChange={(event) => setDay(event.target.value)} />
              </label>
              <label>
                {t('prj.monDetail.notice.note')}
                <textarea value={note} data-testid="notice-note" onChange={(event) => setNote(event.target.value)} />
              </label>
            </div>
          </FormDialog>
        );
      case 'close':
        return (
          <FormDialog
            title={t('prj.monDetail.close.title')}
            confirm={t('prj.monDetail.close.confirm')}
            context={[...context, { label: t('prj.monDetail.close.open'), value: String(detail.summary.open) }]}
            pending={close.isPending}
            error={error}
            onCancel={() => setDialog(undefined)}
            onConfirm={() => close.mutate({ id: detail.id, version: detail.version }, { onSuccess: () => done(t('prj.monDetail.receipt.close')), onError: refuse })}
          />
        );
      case 'addItem':
        return (
          <FormDialog
            title={t('prj.monDetail.addItem.title')}
            confirm={t('prj.monDetail.addItem.confirm')}
            context={context}
            pending={add.isPending}
            error={error}
            onCancel={() => setDialog(undefined)}
            onConfirm={() => {
              if (!UUID.test(documentId.trim())) return setError(t('prj.common.error.validationFailed'));
              add.mutate({ id: detail.id, item, documentId: documentId.trim().toLowerCase(), documentKind }, { onSuccess: () => done(t('prj.monDetail.receipt.addItem')), onError: refuse });
            }}
          >
            <div className="prj-form">
              <label>
                {t('prj.monDetail.addItem.item')}
                <select value={item} data-testid="item-kind" onChange={(event) => setItem(event.target.value)}>
                  {PACK_ITEMS.map((value) => (
                    <option key={value} value={value}>
                      {t(`prj.mon.pack.${word(value)}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('prj.monDetail.addItem.document')}
                <input type="text" value={documentId} data-testid="item-document" onChange={(event) => setDocumentId(event.target.value)} />
              </label>
              <label>
                {t('prj.monDetail.addItem.source')}
                <select value={documentKind} onChange={(event) => setDocumentKind(event.target.value)}>
                  <option value="DOCUMENT">{t('prj.monDetail.addItem.source.document')}</option>
                  <option value="PROJECT_DOCUMENT">{t('prj.monDetail.addItem.source.repository')}</option>
                </select>
              </label>
            </div>
          </FormDialog>
        );
      case 'withdraw':
        return (
          <FormDialog
            title={t('prj.monDetail.withdraw.title')}
            confirm={t('prj.monDetail.withdraw.confirm')}
            context={[...context, { label: t('prj.monDetail.withdraw.item'), value: current.item.title }]}
            pending={withdraw.isPending}
            error={error}
            reason={{ label: t('prj.monDetail.withdraw.reason'), required: true, minLength: REASON_MIN, hint: t('prj.monDetail.reason.hint', { min: REASON_MIN }) }}
            onCancel={() => setDialog(undefined)}
            onConfirm={(reason) => withdraw.mutate({ itemId: current.item.id, reason: (reason ?? '').trim() }, { onSuccess: () => done(t('prj.monDetail.receipt.withdraw')), onError: refuse })}
          />
        );
      case 'log':
        return (
          <FormDialog
            title={t('prj.monDetail.log.title')}
            confirm={t('prj.monDetail.log.confirm')}
            context={[...context, { label: t('prj.monDetail.log.rule'), value: t('prj.monDetail.log.rule.value', { days: detail.rule.response_days_now }) }]}
            pending={log.isPending}
            error={error}
            onCancel={() => setDialog(undefined)}
            onConfirm={() => {
              if (reference.trim() === '' || day === '' || summary.trim().length < RESPOND_MIN) return setError(t('prj.common.error.validationFailed'));
              log.mutate({ id: detail.id, reference: reference.trim(), receivedOn: day, channel, topic, fromLabel: reasonOf(label), summary: summary.trim() }, { onSuccess: () => done(t('prj.monDetail.receipt.log')), onError: refuse });
            }}
          >
            <div className="prj-form">
              <label>
                {t('prj.monDetail.log.reference')}
                <input type="text" value={reference} data-testid="log-reference" onChange={(event) => setReference(event.target.value)} />
              </label>
              <label>
                {t('prj.monDetail.log.receivedOn')}
                <input type="date" value={day} data-testid="log-day" onChange={(event) => setDay(event.target.value)} />
              </label>
              <label>
                {t('prj.monDetail.log.channel')}
                <select value={channel} onChange={(event) => setChannel(event.target.value)}>
                  {CHANNELS.map((value) => (
                    <option key={value} value={value}>
                      {t(`prj.mon.channel.${word(value)}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('prj.monDetail.log.topic')}
                <select value={topic} data-testid="log-topic" onChange={(event) => setTopic(event.target.value)}>
                  {TOPICS.map((value) => (
                    <option key={value} value={value}>
                      {t(`prj.mon.topic.${word(value)}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('prj.monDetail.log.from')}
                <input type="text" value={label} onChange={(event) => setLabel(event.target.value)} />
              </label>
              <p className="prj-muted">{t('prj.monDetail.log.noIdentity')}</p>
              <label>
                {t('prj.monDetail.log.summary')}
                <textarea value={summary} data-testid="log-summary" onChange={(event) => setSummary(event.target.value)} />
              </label>
            </div>
          </FormDialog>
        );
      case 'move': {
        const needsText = current.move === 'RESPOND' || current.move === 'DECLINE' || current.move === 'REOPEN';
        const min = current.move === 'RESPOND' ? RESPOND_MIN : REASON_MIN;
        return (
          <FormDialog
            title={t(`prj.monDetail.move.title.${word(current.move)}`)}
            confirm={t(`prj.monDetail.move.confirm.${word(current.move)}`)}
            context={[...context, { label: t('prj.monDetail.move.feedback'), value: current.feedback.reference }]}
            pending={move.isPending}
            error={error}
            {...(needsText ? { reason: { label: t(`prj.monDetail.move.text.${word(current.move)}`), required: true, minLength: min, hint: t('prj.monDetail.reason.hint', { min }) } } : {})}
            onCancel={() => setDialog(undefined)}
            onConfirm={(reason) => move.mutate({ feedback: current.feedback, move: current.move, text: needsText ? reasonOf(reason) : undefined }, { onSuccess: () => done(t(`prj.monDetail.receipt.move.${word(current.move)}`)), onError: refuse })}
          />
        );
      }
    }
  };

  const feedbackActions = (feedback: FeedbackView): ReactNode => {
    if (!canRespond || file === undefined) return null;
    const button = (moveName: 'TAKE' | 'RESPOND' | 'CLOSE' | 'REOPEN' | 'DECLINE', primary = false) => (
      <button key={moveName} type="button" className={`ui-button ${primary ? 'ui-button--primary' : 'ui-button--outline'} ui-button--small`} data-testid={`move-${moveName.toLowerCase()}-${feedback.id}`} onClick={() => open({ kind: 'move', feedback, move: moveName })}>
        {t(`prj.monDetail.move.button.${word(moveName)}`)}
      </button>
    );
    switch (feedback.status) {
      case 'RECEIVED':
        return [button('TAKE', true), button('RESPOND'), button('DECLINE')];
      case 'IN_REVIEW':
        return [button('RESPOND', true), button('DECLINE')];
      case 'RESPONDED':
        return feedback.responded_by === me ? [<span key="same" className="prj-muted" data-testid={`second-person-${feedback.id}`}>{t('prj.monDetail.move.secondPerson')}</span>, button('REOPEN')] : [button('CLOSE', true), button('REOPEN')];
      default:
        return [button('REOPEN')];
    }
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prj.monDetail.page.title')}</h1>
          <p>{file === undefined ? t('prj.monDetail.page.subtitle') : `${file.project_code ?? ''} ${file.project_name ?? ''}`}</p>
        </div>
        <Link className="ui-button ui-button--outline" to={LIST_PATH}>
          {t('prj.monDetail.back')}
        </Link>
      </div>
      <ContextBar
        items={[
          { label: t('prj.monDetail.context.scope'), value: owner },
          { label: t('prj.monDetail.context.status'), value: file === undefined ? '–' : t(`prj.common.file.${file.status.toLowerCase()}`) },
        ]}
        {...(file === undefined ? {} : { asOf })}
        stale={refreshFailed}
      />
      {id === undefined ? <StateBoundary state="empty" /> : null}
      {id === undefined ? null : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {file !== undefined && (
            <>
              {receipt === undefined ? null : (
                <p className="callout" role="status" data-testid="receipt">
                  {receipt}
                </p>
              )}
              <p className="callout" role="note" data-testid="rule-note">
                {file.rule.unverified ? t('prj.monDetail.rule.unverified', { days: file.rule.notice_days_now }) : t('prj.monDetail.rule.confirmed', { days: file.rule.notice_days_now })}
              </p>

              <SectionCard
                title={t('prj.monDetail.notice.section')}
                status={<NoticePill notice={file.notice} />}
                actions={
                  <span className="prj-actions">
                    {canManage && file.trigger === null ? (
                      <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="set-trigger" onClick={() => open({ kind: 'trigger' })}>
                        {t('prj.monDetail.trigger.button')}
                      </button>
                    ) : null}
                    {canManage && file.trigger !== null && file.notice.sent_on === null ? (
                      <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="send-notice" disabled={!file.pack.complete} onClick={() => open({ kind: 'notice' })}>
                        {t('prj.monDetail.notice.button')}
                      </button>
                    ) : null}
                    {canManage ? (
                      <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="close-file" onClick={() => open({ kind: 'close' })}>
                        {t('prj.monDetail.close.button')}
                      </button>
                    ) : null}
                  </span>
                }
              >
                <Facts
                  items={[
                    { label: t('prj.monDetail.fact.trigger'), value: file.trigger === null ? t('prj.monList.noTrigger') : `${t(`prj.mon.trigger.${word(file.trigger.kind)}`)}: ${dayText(file.trigger.on)}`, testId: 'fact-trigger' },
                    {
                      label: t('prj.monDetail.fact.due'),
                      value: (
                        <Figure
                          label=""
                          testId="fact-due"
                          info={
                            <Provenance
                              name={t('prj.mon.info.notice.name')}
                              formula={t('prj.mon.info.notice.formula', { days: file.notice_days ?? 0 })}
                              source={t('prj.mon.info.notice.source')}
                              asOf={asOf}
                              version={file.notice_rule_version ?? 0}
                              unverified={(file.notice_rule_version ?? 0) === 0}
                              owner={owner}
                            />
                          }
                        >
                          {dayText(file.notice.due_on)}
                        </Figure>
                      ),
                    },
                    { label: t('prj.monDetail.fact.left'), value: <DaysText left={file.notice.days_left} late={file.notice.days_late} />, testId: 'fact-left' },
                    { label: t('prj.monDetail.fact.sent'), value: file.notice.sent_on === null ? '–' : `${dayText(file.notice.sent_on)}${file.notice.note === null ? '' : ` - ${file.notice.note}`}`, testId: 'fact-sent' },
                  ]}
                />
                {file.trigger === null || file.trigger.reason === null ? null : <p className="prj-muted">{t('prj.monDetail.fact.reason', { reason: file.trigger.reason })}</p>}
              </SectionCard>

              <SectionCard title={t('prj.monDetail.pack.section')} status={<StatusPill tone={file.pack.complete ? 'success' : 'warning'}>{file.pack.complete ? t('prj.monDetail.pack.complete') : t('prj.monDetail.pack.incomplete')}</StatusPill>} actions={canManage && file.notice.sent_on === null ? <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="add-item" onClick={() => open({ kind: 'addItem' })}>{t('prj.monDetail.addItem.button')}</button> : undefined}>
                <ul className="prj-list" data-testid="pack-list">
                  {PACK_ITEMS.map((name) => {
                    const items = file.pack.items.filter((entry) => entry.item === name);
                    return (
                      <li key={name} className="prj-list__item" data-testid={`pack-${name}`}>
                        <strong>
                          {t(`prj.mon.pack.${word(name)}`)} {REQUIRED_ITEMS.includes(name) ? <span className="prj-muted">{t('prj.monDetail.pack.required')}</span> : null}
                        </strong>
                        {items.length === 0 ? (
                          <span className="prj-muted">{file.pack.required_missing.includes(name) ? t('prj.monDetail.pack.missingRequired') : t('prj.monDetail.pack.missing')}</span>
                        ) : (
                          items.map((entry) => (
                            <span key={entry.id}>
                              {entry.title} <code title={entry.sha256 ?? ''}>{entry.sha256 === null ? '' : entry.sha256.slice(0, 12)}</code>{' '}
                              {canManage && file.notice.sent_on === null ? (
                                <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`withdraw-${entry.id}`} onClick={() => open({ kind: 'withdraw', item: entry })}>
                                  {t('prj.monDetail.withdraw.button')}
                                </button>
                              ) : null}
                            </span>
                          ))
                        )}
                      </li>
                    );
                  })}
                </ul>
              </SectionCard>

              <SectionCard
                title={t('prj.monDetail.feedback.section')}
                actions={canLog ? <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid="log-feedback" onClick={() => open({ kind: 'log' })}>{t('prj.monDetail.log.button')}</button> : undefined}
              >
                <div className="prj-inline">
                  <Figure label={t('prj.monDetail.sum.total')} testId="sum-total">{file.summary.feedback_total}</Figure>
                  <Figure label={t('prj.monDetail.sum.open')} testId="sum-open">{file.summary.open}</Figure>
                  <Figure label={t('prj.monDetail.sum.overdue')} testId="sum-overdue">{file.summary.overdue}</Figure>
                  <Figure
                    label={t('prj.monDetail.sum.onTime')}
                    testId="sum-ontime"
                    info={<Provenance name={t('prj.mon.info.response.name')} formula={t('prj.mon.info.response.formula')} source={t('prj.mon.info.notice.source')} asOf={asOf} version={file.rule.version} unverified={file.rule.unverified} owner={owner} />}
                  >
                    {file.summary.answered_on_time_pct === null ? '–' : `${file.summary.answered_on_time_pct}%`}
                  </Figure>
                </div>
                {file.feedback.length === 0 ? (
                  <p className="prj-muted" data-testid="feedback-empty">
                    {t('prj.monDetail.feedback.empty')}
                  </p>
                ) : (
                  <ul className="prj-list" data-testid="feedback-list">
                    {file.feedback.map((feedback) => (
                      <li key={feedback.id} className="prj-list__item" data-testid={`feedback-${feedback.id}`}>
                        <span>
                          <strong>{feedback.reference}</strong> <StatusPill tone={feedbackTone(feedback.status)}>{t(`prj.mon.feedback.status.${word(feedback.status)}`)}</StatusPill> <ResponsePill response={feedback.response} />
                        </span>
                        <span className="prj-muted">
                          {t(`prj.mon.topic.${word(feedback.topic)}`)} / {t(`prj.mon.channel.${word(feedback.channel)}`)} / {dayText(feedback.received_on)}
                          {feedback.from_label === null ? '' : ` / ${feedback.from_label}`}
                        </span>
                        <span>{feedback.summary}</span>
                        <span className="prj-figure">
                          <span>{t('prj.monDetail.feedback.due', { day: dayText(feedback.response.due_on) })}</span>
                          <Provenance
                            name={t('prj.mon.info.response.name')}
                            formula={t('prj.mon.info.response.formula')}
                            source={t('prj.mon.info.notice.source')}
                            asOf={asOf}
                            version={feedback.rule_version}
                            unverified={feedback.rule_version === 0}
                            owner={owner}
                          />
                          <DaysText left={feedback.response.days_left} late={feedback.response.days_late} />
                        </span>
                        {feedback.response_text === null ? null : (
                          <span data-testid={`answer-${feedback.id}`}>
                            {t('prj.monDetail.feedback.answer', { day: dayText(feedback.responded_on) })} {feedback.response_text}
                          </span>
                        )}
                        {feedback.declined_reason === null ? null : <span>{t('prj.monDetail.feedback.declined', { reason: feedback.declined_reason })}</span>}
                        <span className="prj-actions">{feedbackActions(feedback)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
              {dialog === undefined ? null : renderDialog(dialog, file)}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('prj.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
