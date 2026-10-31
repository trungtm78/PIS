import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { queueRows, useAcknowledge, useDispatch, useDistributionDocument, useDistributionQueue, useIssue, useRetry } from './distribution/hooks';
import { channelLabel, distributionPill, distributionStatusLabel, errorLabel, overrideMessage, problemMessage, statusLabel } from './distribution/labels';
import { describeProblem } from './distribution/problems';
import type { ProblemContext } from './distribution/problems';
import { MAX_REFERENCE_CHARS, canAcknowledge, canRetry, channelsFor, defaultChannelOf, defaultReceiptTime, instantOf, localInputOf, overrideProblem, progressOf, rowOf } from './distribution/rules';
import { CONFIRM_LEGAL_PERMISSION, DISTRIBUTE_PERMISSION, ISSUE_PERMISSION, QUEUE_STATUSES } from './distribution/types';
import type { DispatchChannel, DistributionRow } from './distribution/types';
import './distribution/distribution.css';

interface Choice {
  checked: boolean;
  channel: DispatchChannel | undefined;
  acknowledgementRequired: boolean;
}

const NO_CHOICE: Choice = { checked: false, channel: undefined, acknowledgementRequired: true };

/** DOC-08: the clerk issues a sealed document after its signatures were verified again, sends it to its recipients and follows the receipts. */
export default function DistributionScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The reason, the choices of recipients and the receipt being typed belong to one tenant: a switch starts the screen over.
  return <DistributionContent key={tenantId ?? 'none'} route={route} />;
}

function DistributionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const canIssue = holds(ISSUE_PERMISSION) && !frozen;
  const canDistribute = holds(DISTRIBUTE_PERMISSION) && !frozen;
  const canConfirm = holds(CONFIRM_LEGAL_PERMISSION);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [distributeNow, setDistributeNow] = useState(false);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [receiptFor, setReceiptFor] = useState<string | undefined>(undefined);
  const [receiptAt, setReceiptAt] = useState('');
  const [receiptRef, setReceiptRef] = useState('');
  const [context, setContext] = useState<ProblemContext>('issue');
  const [notice, setNotice] = useState<'issued' | 'sent' | undefined>(undefined);

  const queues = [useDistributionQueue(QUEUE_STATUSES[0]), useDistributionQueue(QUEUE_STATUSES[1]), useDistributionQueue(QUEUE_STATUSES[2]), useDistributionQueue(QUEUE_STATUSES[3])];
  const queued = queues.flatMap((queue) => queueRows(queue.data)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const moreQueued = queues.some((queue) => queue.hasNextPage);
  const loadingQueued = queues.some((queue) => queue.isFetchingNextPage);
  const loadMoreQueued = (): void => {
    for (const queue of queues) if (queue.hasNextPage) void queue.fetchNextPage();
  };
  const selectedId = params.get('doc') ?? queued[0]?.id;
  const detail = useDistributionDocument(selectedId);
  const doc = detail.data;
  const issue = useIssue();
  const dispatch = useDispatch();
  const acknowledge = useAcknowledge();
  const retry = useRetry();

  const timeOf = (value: string | null): string => (value === null ? t('doc.distribution.row.waiting') : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value)));
  const queueState = useScreenState({ isLoading: queues.some((queue) => queue.isLoading), error: queues.find((queue) => queue.error)?.error ?? null, data: queues.some((queue) => queue.data === undefined) ? undefined : queued });
  const detailState = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: doc });
  const state = selectedId === undefined ? queueState : detailState;

  const failure = context === 'issue' ? issue : context === 'dispatch' ? dispatch : context === 'acknowledge' ? acknowledge : retry;
  const problem = failure.isError ? describeProblem(failure.error, context) : undefined;
  const reasonProblem = doc === undefined ? undefined : overrideProblem(doc.rendersWatermarked, reason);
  const progress = doc === undefined ? undefined : progressOf(doc.distributions);

  const choose = (id: string): void => {
    setParams({ doc: id });
    setReason('');
    setAttempted(false);
    setChoices({});
    setReceiptFor(undefined);
    setNotice(undefined);
    for (const mutation of [issue, dispatch, acknowledge, retry]) mutation.reset();
  };

  const submitIssue = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || issue.isPending || !canIssue) return;
    if (reasonProblem !== undefined) {
      setAttempted(true);
      return;
    }
    setContext('issue');
    setParams({ doc: doc.id });
    issue.mutate(
      { documentId: doc.id, version: doc.version, overrideReason: doc.rendersWatermarked ? reason.trim() : undefined, distributeNow: distributeNow && canDistribute },
      {
        onSuccess: () => {
          setNotice('issued');
          setReason('');
          setAttempted(false);
        },
      },
    );
  };

  const choiceOf = (index: number): Choice => choices[index] ?? NO_CHOICE;
  const change = (index: number, patch: Partial<Choice>): void => setChoices((current) => ({ ...current, [index]: { ...(current[index] ?? NO_CHOICE), ...patch } }));
  const chosen = doc === undefined ? [] : doc.recipients.flatMap((recipient, index) => (choiceOf(index).checked ? [{ recipient, choice: choiceOf(index) }] : []));

  const submitDispatch = (event: FormEvent): void => {
    event.preventDefault();
    if (doc === undefined || dispatch.isPending || !canDistribute || chosen.length === 0) return;
    setContext('dispatch');
    setParams({ doc: doc.id });
    dispatch.mutate(
      {
        documentId: doc.id,
        version: doc.version,
        entries: chosen.map(({ recipient, choice }) => ({
          kind: recipient.kind,
          name: recipient.name,
          code: recipient.code,
          unitId: recipient.unitId,
          channel: choice.channel ?? defaultChannelOf(recipient),
          acknowledgementRequired: choice.acknowledgementRequired,
        })),
      },
      {
        onSuccess: () => {
          setNotice('sent');
          setChoices({});
        },
      },
    );
  };

  const openReceipt = (row: DistributionRow): void => {
    setReceiptFor(row.id);
    setReceiptAt(localInputOf(defaultReceiptTime(row, new Date())));
    setReceiptRef('');
    acknowledge.reset();
  };

  const submitReceipt = (event: FormEvent, row: DistributionRow): void => {
    event.preventDefault();
    const at = instantOf(receiptAt);
    if (acknowledge.isPending || !canDistribute || at === undefined) return;
    setContext('acknowledge');
    const reference = receiptRef.trim();
    acknowledge.mutate({ distributionId: row.id, version: row.version, acknowledgedAt: at, externalRef: reference === '' ? undefined : reference }, { onSuccess: () => setReceiptFor(undefined) });
  };

  const sendAgain = (row: DistributionRow): void => {
    if (retry.isPending || !canDistribute) return;
    setContext('retry');
    retry.mutate({ distributionId: row.id, version: row.version });
  };

  const sealed = doc?.status === 'SEALED';
  const issuedOut = doc !== undefined && (doc.status === 'ISSUED' || doc.status === 'DELIVERED' || doc.status === 'CORRECTED');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.distribution.page.title')}</h1>
          <p>{t('doc.distribution.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="row between">
          <h2>{t('doc.distribution.card.title')}</h2>
          {doc === undefined ? null : <span className="pill gray">{t('doc.distribution.version.pill', { version: doc.version })}</span>}
        </div>
        <StateBoundary state={state} onRetry={() => void (selectedId === undefined ? Promise.all(queues.map((queue) => queue.refetch())) : detail.refetch())}>
          {doc === undefined ? null : (
            <div data-document-id={doc.id} data-status={doc.status}>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="distribution-document">{t('doc.distribution.queue.label')}</label>
                  <select id="distribution-document" value={doc.id} onChange={(event) => choose(event.target.value)}>
                    {queued.some((row) => row.id === doc.id) ? null : <option value={doc.id}>{doc.title}</option>}
                    {queued.map((row) => (
                      <option key={row.id} value={row.id}>
                        {t('doc.distribution.queue.option.text', { title: row.title, status: statusLabel(t, row.status) })}
                      </option>
                    ))}
                  </select>
                  <small>{t('doc.distribution.queue.hint')}</small>
                  {moreQueued ? (
                    <button type="button" disabled={loadingQueued} onClick={loadMoreQueued}>
                      {t('doc.distribution.queue.more.action')}
                    </button>
                  ) : null}
                </div>
                <div className="field">
                  <span className="label">{t('doc.distribution.status.label')}</span>
                  <span className={doc.status === 'SEALED' ? 'pill warn' : 'pill'} data-testid="document-status">
                    {statusLabel(t, doc.status)}
                  </span>
                  {doc.symbol === null ? null : <small>{t('doc.distribution.symbol.text', { symbol: doc.symbol })}</small>}
                </div>
              </div>

              {sealed ? (
                <form onSubmit={submitIssue} noValidate aria-label={t('doc.distribution.issue.form')} className="issue-form">
                  <h3>{t('doc.distribution.issue.title')}</h3>
                  <p className="callout">{t('doc.distribution.issue.hint')}</p>
                  {doc.rendersWatermarked ? (
                    <div className="field">
                      <p className="callout warning" role="note">
                        {t('doc.distribution.watermark.notice')}
                      </p>
                      <label htmlFor="distribution-reason">{t('doc.distribution.reason.label')}</label>
                      <textarea
                        id="distribution-reason"
                        rows={3}
                        value={reason}
                        disabled={!canIssue || !canConfirm}
                        aria-invalid={attempted && reasonProblem !== undefined}
                        onChange={(event) => setReason(event.target.value)}
                      />
                      {attempted && reasonProblem !== undefined ? (
                        <small role="alert" className="field-error">
                          {overrideMessage(t, reasonProblem)}
                        </small>
                      ) : (
                        <small>{canConfirm ? t('doc.distribution.reason.hint') : t('doc.distribution.reason.denied')}</small>
                      )}
                    </div>
                  ) : null}
                  {canDistribute ? (
                    <div className="check">
                      <input id="distribution-now" type="checkbox" checked={distributeNow} onChange={(event) => setDistributeNow(event.target.checked)} />
                      <label htmlFor="distribution-now">{t('doc.distribution.now.label')}</label>
                    </div>
                  ) : null}
                  {canIssue ? (
                    <div className="row gap">
                      <button type="submit" className="primary" disabled={issue.isPending || (doc.rendersWatermarked && !canConfirm)}>
                        {t('doc.distribution.issue.action')}
                      </button>
                      {doc.currentVersionId === null ? null : <Link to={`/doc/doc-07?version=${doc.currentVersionId}`}>{t('doc.distribution.verify.link')}</Link>}
                    </div>
                  ) : (
                    <p className="callout warning" role="status">
                      {frozen ? t('doc.distribution.frozen.notice') : t('doc.distribution.denied.issue')}
                    </p>
                  )}
                </form>
              ) : null}

              {doc.status !== 'SEALED' && doc.documentNumber !== null ? (
                <p className="callout" role="status">
                  {t('doc.distribution.issued.notice', { symbol: doc.symbol ?? '', time: timeOf(doc.issuedAt) })}
                </p>
              ) : null}
              {doc.overrideReason === null ? null : (
                <p className="callout warning" role="note">
                  {t('doc.distribution.override.notice', { reason: doc.overrideReason })}
                </p>
              )}

              {issuedOut && canDistribute ? (
                <form onSubmit={submitDispatch} noValidate aria-label={t('doc.distribution.dispatch.form')} className="dispatch-form">
                  <h3>{t('doc.distribution.dispatch.title')}</h3>
                  <p className="sub">{t('doc.distribution.dispatch.hint')}</p>
                  {doc.recipients.length === 0 ? (
                    <p className="callout warning">{t('doc.distribution.dispatch.none')}</p>
                  ) : (
                    <div className="tablewrap">
                      <table>
                        <thead>
                          <tr>
                            <th>{t('doc.distribution.dispatch.col.recipient')}</th>
                            <th>{t('doc.distribution.dispatch.col.channel')}</th>
                            <th>{t('doc.distribution.dispatch.col.receipt')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {doc.recipients.map((recipient, index) => {
                            const choice = choiceOf(index);
                            const channel = choice.channel ?? defaultChannelOf(recipient);
                            const existing = rowOf(doc.distributions, recipient, channel);
                            return (
                              <tr key={`${recipient.kind}:${recipient.name}`} data-recipient={recipient.name}>
                                <td>
                                  <label className="check">
                                    <input
                                      type="checkbox"
                                      checked={choice.checked && existing === undefined}
                                      disabled={existing !== undefined}
                                      aria-label={t('doc.distribution.dispatch.select.label', { name: recipient.name })}
                                      onChange={(event) => change(index, { checked: event.target.checked })}
                                    />
                                    <span>{recipient.name}</span>
                                  </label>
                                  {existing === undefined ? null : <small>{t('doc.distribution.dispatch.sent.hint', { status: distributionStatusLabel(t, existing.status) })}</small>}
                                </td>
                                <td>
                                  <select
                                    value={channel}
                                    aria-label={t('doc.distribution.dispatch.channel.label', { name: recipient.name })}
                                    onChange={(event) => change(index, { channel: event.target.value as DispatchChannel })}
                                  >
                                    {channelsFor(recipient).map((option) => (
                                      <option key={option} value={option}>
                                        {channelLabel(t, option)}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td>
                                  <label className="check">
                                    <input
                                      type="checkbox"
                                      checked={choice.acknowledgementRequired}
                                      aria-label={t('doc.distribution.dispatch.receipt.label', { name: recipient.name })}
                                      onChange={(event) => change(index, { acknowledgementRequired: event.target.checked })}
                                    />
                                    <span>{t('doc.distribution.dispatch.receipt.text')}</span>
                                  </label>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <button type="submit" className="primary" disabled={dispatch.isPending || chosen.length === 0}>
                    {t('doc.distribution.dispatch.action')}
                  </button>
                </form>
              ) : null}

              {notice === undefined ? null : (
                <p className="callout" role="status">
                  {notice === 'issued' ? t('doc.distribution.done.issued') : t('doc.distribution.done.sent')}
                </p>
              )}
              {problem === undefined ? null : (
                <div className="callout warning" role="alert">
                  <p>{problemMessage(t, problem.reason)}</p>
                  {problem.findings.length === 0 ? null : <p className="sub">{t('doc.distribution.problem.findings', { findings: problem.findings.join(', ') })}</p>}
                </div>
              )}

              <h3>{t('doc.distribution.table.title')}</h3>
              {progress === undefined || progress.total === 0 ? null : (
                <p className="sub" data-testid="progress">
                  {t('doc.distribution.progress.text', { reached: progress.reached, total: progress.total, acknowledged: progress.acknowledged })}
                </p>
              )}
              {doc.distributions.length === 0 ? (
                <p className="callout">{sealed ? t('doc.distribution.table.notIssued') : t('doc.distribution.table.empty')}</p>
              ) : (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('doc.distribution.table.col.recipient')}</th>
                        <th>{t('doc.distribution.table.col.channel')}</th>
                        <th>{t('doc.distribution.table.col.status')}</th>
                        <th>{t('doc.distribution.table.col.sentAt')}</th>
                        <th>{t('doc.distribution.table.col.receipt')}</th>
                        <th>{t('doc.distribution.table.col.error')}</th>
                        <th>{t('doc.distribution.table.col.resend')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {doc.distributions.flatMap((row) => [
                        <tr key={row.id} data-distribution-id={row.id} data-status={row.status}>
                          <td>
                            {row.recipientName}
                            {row.acknowledgementRequired ? null : <small>{t('doc.distribution.table.copy')}</small>}
                          </td>
                          <td>{channelLabel(t, row.channel)}</td>
                          <td>
                            <span className={distributionPill(row.status)}>{distributionStatusLabel(t, row.status)}</span>
                          </td>
                          <td>{timeOf(row.sentAt)}</td>
                          <td>{timeOf(row.acknowledgedAt)}</td>
                          <td>{row.errorCode === null ? null : errorLabel(t, row.errorCode)}</td>
                          <td>
                            {canDistribute && canRetry(row) ? (
                              <button type="button" disabled={retry.isPending} onClick={() => sendAgain(row)}>
                                {t('doc.distribution.row.retry.action')}
                              </button>
                            ) : null}
                            {canDistribute && canAcknowledge(row) ? (
                              <button type="button" onClick={() => openReceipt(row)}>
                                {t('doc.distribution.row.receipt.action')}
                              </button>
                            ) : null}
                          </td>
                        </tr>,
                        receiptFor === row.id ? (
                          <tr key={`${row.id}:receipt`} data-receipt-for={row.id}>
                            <td colSpan={7}>
                              <form onSubmit={(event) => submitReceipt(event, row)} noValidate aria-label={t('doc.distribution.receipt.form')} className="receipt-form">
                                <div className="formgrid">
                                  <div className="field">
                                    <label htmlFor="receipt-at">{t('doc.distribution.receipt.time.label')}</label>
                                    <input id="receipt-at" type="datetime-local" step={1} value={receiptAt} onChange={(event) => setReceiptAt(event.target.value)} />
                                  </div>
                                  <div className="field">
                                    <label htmlFor="receipt-ref">{t('doc.distribution.receipt.ref.label')}</label>
                                    <input id="receipt-ref" maxLength={MAX_REFERENCE_CHARS} value={receiptRef} onChange={(event) => setReceiptRef(event.target.value)} />
                                  </div>
                                </div>
                                <div className="row gap">
                                  <button type="submit" className="primary" disabled={acknowledge.isPending || instantOf(receiptAt) === undefined}>
                                    {t('doc.distribution.receipt.submit.action')}
                                  </button>
                                  <button type="button" onClick={() => setReceiptFor(undefined)}>
                                    {t('doc.distribution.receipt.cancel.action')}
                                  </button>
                                </div>
                              </form>
                            </td>
                          </tr>
                        ) : null,
                      ])}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="callout">{t('doc.distribution.note.text')}</p>
            </div>
          )}
        </StateBoundary>
      </div>
      <p className="prototype-note">{t('doc.distribution.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
