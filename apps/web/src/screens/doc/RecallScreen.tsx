import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useTimeline } from './drafts/hooks';
import { eventLabel, statusLabel as draftStatusLabel } from './drafts/labels';
import { channelLabel, distributionStatusLabel } from './distribution/labels';
import { queueRows, useCorrect, useRecall, useRecallDocument, useRecallQueue, useReplace, useVoidNumber } from './recall/hooks';
import { effectLabel, problemMessage, reasonMessage, relationLabel, statusLabel, statusPill, textMessage } from './recall/labels';
import { describeProblem } from './recall/problems';
import { MAX_CORRECTION_CHARS, MAX_RECALL_REASON_CHARS, MAX_TITLE_CHARS, MAX_VOID_REASON_CHARS, MIN_CORRECTION_CHARS, MIN_TITLE_CHARS, basisOptions, canRecall, canSupersede, canVoid, isUuid, noticeProgress, reasonProblem, textProblem } from './recall/rules';
import { CORRECT_PERMISSION, QUEUE_STATUSES, RECALL_PERMISSION, REPLACE_PERMISSION, VOID_PERMISSION } from './recall/types';
import './recall/recall.css';

const BACK_PATH = '/doc/doc-10';
const EDITOR_PATH = '/doc/doc-02';
const RECALL_PATH = '/doc/doc-19';
const SHORT_ID = 8;
const shortId = (id: string | null): string => (id === null || id === '' ? '' : id.slice(-SHORT_ID));

type Context = 'recall' | 'void' | 'replace' | 'correct';

/** DOC-19: the leader recalls an issued document and the records manager voids the number of one that cannot be sealed; the timeline says what happened. */
export default function RecallScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The reasons, the basis and the approver being typed belong to one tenant: a switch starts the screen over.
  return <RecallContent key={tenantId ?? 'none'} route={route} />;
}

function RecallContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRecall = holds(RECALL_PERMISSION) && !frozen;
  const mayVoid = holds(VOID_PERMISSION) && !frozen;
  const mayReplace = holds(REPLACE_PERMISSION) && !frozen;
  const mayCorrect = holds(CORRECT_PERMISSION) && !frozen;
  const [recallReason, setRecallReason] = useState('');
  const [basis, setBasis] = useState('');
  const [notify, setNotify] = useState(true);
  const [voidReason, setVoidReason] = useState('');
  const [approver, setApprover] = useState('');
  const [attempted, setAttempted] = useState<Context | undefined>(undefined);
  const [context, setContext] = useState<Context>('recall');
  const [notice, setNotice] = useState<Context | undefined>(undefined);
  // A voided number is taken off the document, so the number the notice names is the one the screen showed when the void was sent.
  const [voidedNumber, setVoidedNumber] = useState<number | null>(null);
  const [replaceReason, setReplaceReason] = useState('');
  const [replaceTitle, setReplaceTitle] = useState('');
  const [correctionText, setCorrectionText] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  // The draft that the last replacement or correction made: the person is sent on to finish it.
  const [drawn, setDrawn] = useState<string | undefined>(undefined);

  const queues = [useRecallQueue(QUEUE_STATUSES[0]), useRecallQueue(QUEUE_STATUSES[1]), useRecallQueue(QUEUE_STATUSES[2]), useRecallQueue(QUEUE_STATUSES[3]), useRecallQueue(QUEUE_STATUSES[4]), useRecallQueue(QUEUE_STATUSES[5]), useRecallQueue(QUEUE_STATUSES[6]), useRecallQueue(QUEUE_STATUSES[7])];
  const queued = queues.flatMap((queue) => queueRows(queue.data)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const moreQueued = queues.some((queue) => queue.hasNextPage);
  const loadingQueued = queues.some((queue) => queue.isFetchingNextPage);
  const loadMoreQueued = (): void => {
    for (const queue of queues) if (queue.hasNextPage) void queue.fetchNextPage();
  };
  const selectedId = params.get('doc') ?? queued[0]?.id;
  const detail = useRecallDocument(selectedId);
  const doc = detail.data;
  const timeline = useTimeline(doc?.documentId);
  const recall = useRecall();
  const voidNumber = useVoidNumber();
  const replace = useReplace();
  const correct = useCorrect();

  const timeOf = (value: string | null): string => (value === null ? t('doc.recall.notice.none') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value)));
  const queueState = useScreenState({ isLoading: queues.some((queue) => queue.isLoading), error: queues.find((queue) => queue.error)?.error ?? null, data: queues.some((queue) => queue.data === undefined) ? undefined : queued });
  const detailState = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: doc });
  const state = selectedId === undefined ? queueState : detailState;

  const failure = context === 'recall' ? recall : context === 'void' ? voidNumber : context === 'replace' ? replace : correct;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  const recallProblem = reasonProblem(recallReason, MAX_RECALL_REASON_CHARS);
  const voidProblem = reasonProblem(voidReason, MAX_VOID_REASON_CHARS);
  const approverInvalid = !isUuid(approver);
  const replaceReasonProblem = reasonProblem(replaceReason, MAX_RECALL_REASON_CHARS);
  const replaceTitleProblem = replaceTitle.trim() === '' ? undefined : textProblem(replaceTitle, MIN_TITLE_CHARS, MAX_TITLE_CHARS);
  const correctionTextProblem = textProblem(correctionText, MIN_CORRECTION_CHARS, MAX_CORRECTION_CHARS);
  const correctionReasonProblem = reasonProblem(correctionReason, MAX_RECALL_REASON_CHARS);

  const choose = (id: string): void => {
    setParams({ doc: id });
    setRecallReason('');
    setBasis('');
    setNotify(true);
    setVoidReason('');
    setApprover('');
    setAttempted(undefined);
    setNotice(undefined);
    setReplaceReason('');
    setReplaceTitle('');
    setCorrectionText('');
    setCorrectionReason('');
    setDrawn(undefined);
    recall.reset();
    voidNumber.reset();
    replace.reset();
    correct.reset();
  };

  const submitRecall = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || recall.isPending || !mayRecall) return;
    if (recallProblem !== undefined) {
      setAttempted('recall');
      return;
    }
    setContext('recall');
    setParams({ doc: doc.id });
    recall.mutate(
      { documentId: doc.id, version: doc.version, reason: recallReason.trim(), basisDocumentId: basis === '' ? undefined : basis, notifyRecipients: notify },
      {
        onSuccess: () => {
          setNotice('recall');
          setRecallReason('');
          setBasis('');
          setAttempted(undefined);
        },
      },
    );
  };

  const submitVoid = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || voidNumber.isPending || !mayVoid) return;
    if (voidProblem !== undefined || approverInvalid) {
      setAttempted('void');
      return;
    }
    setContext('void');
    setParams({ doc: doc.id });
    const number = doc.documentNumber;
    voidNumber.mutate(
      { documentId: doc.id, version: doc.version, reason: voidReason.trim(), approverId: approver.trim().toLowerCase() },
      {
        onSuccess: () => {
          setVoidedNumber(number);
          setNotice('void');
          setVoidReason('');
          setApprover('');
          setAttempted(undefined);
        },
      },
    );
  };

  const submitReplace = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || replace.isPending || !mayReplace) return;
    if (replaceReasonProblem !== undefined || replaceTitleProblem !== undefined) {
      setAttempted('replace');
      return;
    }
    setContext('replace');
    setParams({ doc: doc.id });
    replace.mutate(
      { documentId: doc.id, version: doc.version, reason: replaceReason.trim(), title: replaceTitle.trim() === '' ? undefined : replaceTitle.trim() },
      {
        onSuccess: (answer) => {
          setDrawn(answer.resource_id);
          setNotice('replace');
          setReplaceReason('');
          setReplaceTitle('');
          setAttempted(undefined);
        },
      },
    );
  };

  const submitCorrect = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || correct.isPending || !mayCorrect) return;
    if (correctionTextProblem !== undefined || correctionReasonProblem !== undefined) {
      setAttempted('correct');
      return;
    }
    setContext('correct');
    setParams({ doc: doc.id });
    correct.mutate(
      { documentId: doc.id, version: doc.version, reason: correctionReason.trim(), correctionText: correctionText.trim() },
      {
        onSuccess: (answer) => {
          setDrawn(answer.resource_id);
          setNotice('correct');
          setCorrectionText('');
          setCorrectionReason('');
          setAttempted(undefined);
        },
      },
    );
  };

  const progress = doc === undefined ? undefined : noticeProgress(doc.distributions);
  const symbol = doc?.symbol ?? '';

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="doc-recall">
      <p className="back-link">
        <Link to={BACK_PATH}>
          <span aria-hidden="true">← </span>
          {t('doc.recall.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.recall.page.title')}</h1>
          <p>{t('doc.recall.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="row between">
          <h2>{t('doc.recall.card.title')}</h2>
          {doc === undefined ? null : <span className="pill gray">{t('doc.recall.version.pill', { version: doc.version })}</span>}
        </div>
        <StateBoundary state={state} onRetry={() => void (selectedId === undefined ? Promise.all(queues.map((queue) => queue.refetch())) : detail.refetch())}>
          {doc === undefined ? null : (
            <div data-document-id={doc.id} data-status={doc.status}>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="recall-document">{t('doc.recall.queue.label')}</label>
                  <select id="recall-document" value={doc.id} onChange={(event) => choose(event.target.value)}>
                    {queued.some((row) => row.id === doc.id) ? null : <option value={doc.id}>{doc.title}</option>}
                    {queued.map((row) => (
                      <option key={row.id} value={row.id}>
                        {t('doc.recall.queue.option.text', { title: row.title, status: statusLabel(t, row.status) })}
                      </option>
                    ))}
                  </select>
                  <small>{t('doc.recall.queue.hint')}</small>
                  {moreQueued ? (
                    <button type="button" disabled={loadingQueued} onClick={loadMoreQueued}>
                      {t('doc.recall.queue.more.action')}
                    </button>
                  ) : null}
                </div>
                <div className="field">
                  <span className="label">{t('doc.recall.status.label')}</span>
                  <span className={statusPill(doc.status)} data-testid="document-status">
                    {statusLabel(t, doc.status)}
                  </span>
                  <small data-testid="document-effect">{t('doc.recall.effect.text', { effect: effectLabel(t, doc.effect) })}</small>
                  {doc.symbol === null ? null : <small>{t('doc.recall.symbol.text', { symbol: doc.symbol })}</small>}
                </div>
              </div>

              {doc.status === 'RECALLED' ? (
                <div className="callout warning recall-banner" role="status" data-testid="recall-banner">
                  <strong>{t('doc.recall.banner.title')}</strong>
                  <p>{t('doc.recall.banner.reason', { reason: doc.recallReason ?? '' })}</p>
                  <p className="sub">{t('doc.recall.banner.when', { time: timeOf(doc.recalledAt), by: shortId(doc.recalledBy) })}</p>
                  <p className="sub">{t('doc.recall.banner.number', { symbol })}</p>
                </div>
              ) : null}

              {canRecall(doc.status) ? (
                mayRecall ? (
                  <form onSubmit={submitRecall} noValidate aria-label={t('doc.recall.recall.form')} className="recall-form">
                    <h3>{t('doc.recall.recall.title')}</h3>
                    <p className="callout">{t('doc.recall.recall.hint')}</p>
                    <div className="field">
                      <label htmlFor="recall-reason">{t('doc.recall.recall.reason.label')}</label>
                      <textarea
                        id="recall-reason"
                        rows={3}
                        value={recallReason}
                        aria-invalid={attempted === 'recall' && recallProblem !== undefined}
                        onChange={(event) => setRecallReason(event.target.value)}
                      />
                      {attempted === 'recall' && recallProblem !== undefined ? (
                        <small role="alert" className="field-error">
                          {reasonMessage(t, recallProblem)}
                        </small>
                      ) : (
                        <small>{t('doc.recall.recall.reason.hint')}</small>
                      )}
                    </div>
                    <div className="field">
                      <label htmlFor="recall-basis">{t('doc.recall.recall.basis.label')}</label>
                      <select id="recall-basis" value={basis} onChange={(event) => setBasis(event.target.value)}>
                        <option value="">{t('doc.recall.recall.basis.none')}</option>
                        {basisOptions(queued, doc.documentId).map((row) => (
                          <option key={row.id} value={row.documentId}>
                            {t('doc.recall.queue.option.text', { title: row.title, status: statusLabel(t, row.status) })}
                          </option>
                        ))}
                      </select>
                      <small>{doc.status === 'ARCHIVED' ? t('doc.recall.recall.basis.required') : t('doc.recall.recall.basis.hint')}</small>
                    </div>
                    <div className="check">
                      <input id="recall-notify" type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
                      <label htmlFor="recall-notify">{t('doc.recall.recall.notify.label')}</label>
                    </div>
                    <div className="row gap">
                      <button type="submit" className="primary" disabled={recall.isPending}>
                        {t('doc.recall.recall.submit.action')}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="callout warning" role="status">
                    {frozen ? t('doc.recall.frozen.notice') : t('doc.recall.recall.denied')}
                  </p>
                )
              ) : null}

              {canVoid(doc.status) ? (
                mayVoid ? (
                  <form onSubmit={submitVoid} noValidate aria-label={t('doc.recall.void.form')} className="void-form">
                    <h3>{t('doc.recall.void.title')}</h3>
                    <p className="callout">{t('doc.recall.void.hint', { number: doc.documentNumber ?? '' })}</p>
                    <div className="field">
                      <label htmlFor="void-reason">{t('doc.recall.void.reason.label')}</label>
                      <textarea
                        id="void-reason"
                        rows={3}
                        value={voidReason}
                        aria-invalid={attempted === 'void' && voidProblem !== undefined}
                        onChange={(event) => setVoidReason(event.target.value)}
                      />
                      {attempted === 'void' && voidProblem !== undefined ? (
                        <small role="alert" className="field-error">
                          {reasonMessage(t, voidProblem)}
                        </small>
                      ) : (
                        <small>{t('doc.recall.void.reason.hint')}</small>
                      )}
                    </div>
                    <div className="field">
                      <label htmlFor="void-approver">{t('doc.recall.void.approver.label')}</label>
                      <input id="void-approver" value={approver} aria-invalid={attempted === 'void' && approverInvalid} onChange={(event) => setApprover(event.target.value)} />
                      {attempted === 'void' && approverInvalid ? (
                        <small role="alert" className="field-error">
                          {t('doc.recall.void.approver.invalid')}
                        </small>
                      ) : (
                        <small>{t('doc.recall.void.approver.hint')}</small>
                      )}
                    </div>
                    <div className="row gap">
                      <button type="submit" className="primary" disabled={voidNumber.isPending}>
                        {t('doc.recall.void.submit.action')}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="callout warning" role="status">
                    {frozen ? t('doc.recall.frozen.notice') : t('doc.recall.void.denied')}
                  </p>
                )
              ) : null}

              {canSupersede(doc.status) && (mayReplace || mayCorrect) ? (
                <div className="supersede" data-testid="supersede">
                  <h3>{t('doc.recall.supersede.title')}</h3>
                  <p className="callout">{t('doc.recall.supersede.hint')}</p>
                  {mayReplace ? (
                    <form onSubmit={submitReplace} noValidate aria-label={t('doc.recall.replace.form')} className="replace-form">
                      <h4>{t('doc.recall.replace.title')}</h4>
                      <div className="field">
                        <label htmlFor="replace-title">{t('doc.recall.replace.title.label')}</label>
                        <input id="replace-title" value={replaceTitle} aria-invalid={attempted === 'replace' && replaceTitleProblem !== undefined} onChange={(event) => setReplaceTitle(event.target.value)} />
                        {attempted === 'replace' && replaceTitleProblem !== undefined ? (
                          <small role="alert" className="field-error">
                            {textMessage(t, replaceTitleProblem)}
                          </small>
                        ) : (
                          <small>{t('doc.recall.replace.title.hint')}</small>
                        )}
                      </div>
                      <div className="field">
                        <label htmlFor="replace-reason">{t('doc.recall.replace.reason.label')}</label>
                        <textarea id="replace-reason" rows={3} value={replaceReason} aria-invalid={attempted === 'replace' && replaceReasonProblem !== undefined} onChange={(event) => setReplaceReason(event.target.value)} />
                        {attempted === 'replace' && replaceReasonProblem !== undefined ? (
                          <small role="alert" className="field-error">
                            {reasonMessage(t, replaceReasonProblem)}
                          </small>
                        ) : (
                          <small>{t('doc.recall.replace.reason.hint')}</small>
                        )}
                      </div>
                      <div className="row gap">
                        <button type="submit" className="primary" disabled={replace.isPending}>
                          {t('doc.recall.replace.submit.action')}
                        </button>
                      </div>
                    </form>
                  ) : null}
                  {mayCorrect ? (
                    <form onSubmit={submitCorrect} noValidate aria-label={t('doc.recall.correct.form')} className="correct-form">
                      <h4>{t('doc.recall.correct.title')}</h4>
                      <div className="field">
                        <label htmlFor="correct-text">{t('doc.recall.correct.text.label')}</label>
                        <textarea id="correct-text" rows={3} value={correctionText} aria-invalid={attempted === 'correct' && correctionTextProblem !== undefined} onChange={(event) => setCorrectionText(event.target.value)} />
                        {attempted === 'correct' && correctionTextProblem !== undefined ? (
                          <small role="alert" className="field-error">
                            {textMessage(t, correctionTextProblem)}
                          </small>
                        ) : (
                          <small>{t('doc.recall.correct.text.hint')}</small>
                        )}
                      </div>
                      <div className="field">
                        <label htmlFor="correct-reason">{t('doc.recall.correct.reason.label')}</label>
                        <textarea id="correct-reason" rows={2} value={correctionReason} aria-invalid={attempted === 'correct' && correctionReasonProblem !== undefined} onChange={(event) => setCorrectionReason(event.target.value)} />
                        {attempted === 'correct' && correctionReasonProblem !== undefined ? (
                          <small role="alert" className="field-error">
                            {reasonMessage(t, correctionReasonProblem)}
                          </small>
                        ) : (
                          <small>{t('doc.recall.correct.reason.hint')}</small>
                        )}
                      </div>
                      <div className="row gap">
                        <button type="submit" className="primary" disabled={correct.isPending}>
                          {t('doc.recall.correct.submit.action')}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </div>
              ) : null}

              {notice === undefined ? null : (
                <p className="callout" role="status" data-testid="done-notice">
                  {notice === 'recall'
                    ? t('doc.recall.done.recalled', { symbol })
                    : notice === 'void'
                      ? t('doc.recall.done.voided', { number: voidedNumber ?? '' })
                      : notice === 'replace'
                        ? t('doc.recall.done.replaced')
                        : t('doc.recall.done.corrected')}{' '}
                  {drawn === undefined ? null : <Link to={`${EDITOR_PATH}?doc=${drawn}`}>{t('doc.recall.done.draft.link')}</Link>}
                </p>
              )}
              {problem === undefined ? null : (
                <div className="callout warning" role="alert">
                  <p>{problemMessage(t, problem.reason)}</p>
                </div>
              )}

              {doc.status === 'RECALLED' ? (
                <>
                  <h3>{t('doc.recall.notices.title')}</h3>
                  {progress === undefined || progress.total === 0 ? (
                    <p className="callout">{t('doc.recall.notices.empty')}</p>
                  ) : (
                    <>
                      <p className="sub" data-testid="notice-progress">
                        {t('doc.recall.notices.progress', { noticed: progress.noticed, total: progress.total, calledOff: progress.calledOff })}
                      </p>
                      <div className="tablewrap">
                        <table>
                          <thead>
                            <tr>
                              <th>{t('doc.recall.notices.col.recipient')}</th>
                              <th>{t('doc.recall.notices.col.channel')}</th>
                              <th>{t('doc.recall.notices.col.status')}</th>
                              <th>{t('doc.recall.notices.col.notice')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {doc.distributions.map((row) => (
                              <tr key={row.id} data-distribution-id={row.id} data-status={row.status}>
                                <td>{row.recipientName}</td>
                                <td>{channelLabel(t, row.channel)}</td>
                                <td>{distributionStatusLabel(t, row.status)}</td>
                                <td>{timeOf(row.recallNoticeAt)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              ) : null}

              <h3>{t('doc.recall.relations.title')}</h3>
              {doc.relations.length === 0 ? (
                <p className="muted" data-testid="relations-empty">
                  {t('doc.recall.relations.empty')}
                </p>
              ) : (
                <ol className="history" aria-label={t('doc.recall.relations.title')} data-testid="relations">
                  {doc.relations.map((relation) => (
                    <li key={relation.id} data-kind={relation.kind} data-direction={relation.direction}>
                      <strong>{relationLabel(t, relation.kind, relation.direction)}</strong> · {relation.outgoingDocumentId === null ? relation.title : <Link to={relation.status === 'DRAFT' ? `${EDITOR_PATH}?doc=${relation.outgoingDocumentId}` : `${RECALL_PATH}?doc=${relation.outgoingDocumentId}`}>{relation.title}</Link>}
                      {relation.symbol === null ? null : ` · ${relation.symbol}`}
                      {relation.status === null ? null : <span className="pill"> {draftStatusLabel(t, relation.status)}</span>}
                      {relation.note === null ? null : <div className="sub">{relation.note}</div>}
                    </li>
                  ))}
                </ol>
              )}

              <h3>{t('doc.recall.history.title')}</h3>
              {timeline.data === undefined || timeline.data.events.length === 0 ? (
                <p className="muted">{t('doc.recall.history.empty')}</p>
              ) : (
                <ol className="history" aria-label={t('doc.recall.history.title')}>
                  {timeline.data.events.map((event) => (
                    <li key={event.id} data-kind={event.kind}>
                      <strong>{eventLabel(t, event.kind)}</strong> · {event.occurredAt.slice(0, 16).replace('T', ' ')} · {shortId(event.actorId)}
                      {event.comment === null ? null : <div className="sub">{event.comment}</div>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </StateBoundary>
      </div>
      <p className="prototype-note">{t('doc.recall.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
