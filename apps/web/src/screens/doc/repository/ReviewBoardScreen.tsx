import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, StatusPill } from '../../../ui';
import { CommandDialog } from './CommandDialog';
import { useDecideTask, useReview, useReviews, useWithdrawReview } from './hooks';
import { classLabel, eventLabel, reviewStatusLabel, reviewerLabel, stageLabel } from './labels';
import { READ_PERMISSION, boardLink, documentLink, repositoryLink, reviewTone, reviewerTone, stageTone, stamp } from './model';
import type { Reviewer } from './model';
import './repository.css';

const STATUSES = ['IN_REVIEW', 'SUPPLEMENT_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

/**
 * DOC-26: the review board (DOC-2, PD.01). Without a review chosen it lists the rounds of review of the documents the caller may see; with one (`?review=`) it shows the stages of the workflow the round runs by, the reviewers of each
 * stage side by side with what each decided and why, the history of the round and what the caller may do: decide the task they are given, withdraw a round they sent, send a supplement. The engine of ADM judges every decision
 * (the person who sent the version never decides on it); this screen only offers the steps it says the caller may take.
 */
export default function ReviewBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  const [search] = useSearchParams();
  // The dialogs belong to one membership and to the round that is open: a switch of either starts the screen over.
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${search.get('review') ?? ''}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const [search] = useSearchParams();
  const review = search.get('review') ?? undefined;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('doc.repo.board.title')}</h1>
          <p>{t('doc.repo.board.subtitle')}</p>
        </div>
        <div className="actions">
          {review !== undefined && (
            <Link className="ui-button ui-button--outline" to={boardLink()} data-testid="back-list">
              {t('doc.repo.board.backList')}
            </Link>
          )}
          <Link className="ui-button ui-button--outline" to={repositoryLink()}>
            {t('doc.repo.board.toRepository')}
          </Link>
        </div>
      </div>
      {mode === 'READ_ONLY' && (
        <p className="callout" data-testid="readonly-note">
          {t('doc.repo.readonly.mode')}
        </p>
      )}
      {!mayRead ? (
        <>
          <ContextBar items={[{ label: t('doc.repo.context.scope'), value: tenant?.name ?? '–' }]} />
          <p className="callout warning" role="status" data-testid="no-read">
            {t('doc.repo.denied')}
          </p>
        </>
      ) : review === undefined ? (
        <ReviewList />
      ) : (
        <ReviewBoard id={review} frozen={mode === 'READ_ONLY'} />
      )}
      <p className="prototype-note">{t('doc.repo.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ReviewList() {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [status, setStatus] = useState('');
  const list = useReviews({ status }, true);
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: () => false });
  const refreshFailed = list.isError && list.data !== undefined;
  const asOf = pages[0]?.as_of;
  return (
    <>
      <ContextBar items={[{ label: t('doc.repo.context.scope'), value: tenant?.name ?? '–' }]} {...(asOf === undefined ? {} : { asOf: stamp(asOf) })} stale={refreshFailed} />
      <div className="doc2-filters">
        <div className="field">
          <label htmlFor="b-status">{t('doc.repo.field.review')}</label>
          <select id="b-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">{t('doc.repo.filter.any')}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {reviewStatusLabel(t, value)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {refreshFailed && (
        <p className="callout warning" role="status" data-testid="stale-note">
          {t('doc.repo.stale', { time: asOf === undefined ? '' : stamp(asOf) })}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        {items.length === 0 ? (
          <div className="card statecard" role="status" data-testid="empty">
            <h2>{status === '' ? t('doc.repo.board.empty.title') : t('doc.repo.board.emptyFiltered.title')}</h2>
            <p className="muted">{status === '' ? t('doc.repo.board.empty.body') : t('doc.repo.board.emptyFiltered.body')}</p>
          </div>
        ) : (
          <>
            <div className="tablewrap">
              <table aria-label={t('doc.repo.board.aria')} data-testid="reviews">
                <thead>
                  <tr>
                    <th scope="col">{t('doc.repo.col.title')}</th>
                    <th scope="col">{t('doc.repo.col.class')}</th>
                    <th scope="col">{t('doc.repo.field.project')}</th>
                    <th scope="col">{t('doc.repo.col.version')}</th>
                    <th scope="col">{t('doc.repo.board.col.round')}</th>
                    <th scope="col">{t('doc.repo.board.col.status')}</th>
                    <th scope="col">{t('doc.repo.board.col.stage')}</th>
                    <th scope="col">{t('doc.repo.board.col.submitted')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} data-review={item.id} data-status={item.status}>
                      <td>
                        <Link to={boardLink(item.id)} data-open={item.id}>
                          {item.document_title}
                        </Link>
                      </td>
                      <td>{classLabel(t, item.doc_class)}</td>
                      <td>{item.project.code}</td>
                      <td>{t('doc.repo.version.number', { no: item.version_no })}</td>
                      <td>{item.round}</td>
                      <td>
                        <StatusPill tone={reviewTone(item.status)}>{reviewStatusLabel(t, item.status)}</StatusPill>
                      </td>
                      <td>{item.current_stage ?? '—'}</td>
                      <td>
                        {stamp(item.submitted_at)}
                        <div className="muted">{item.submitted_by_name ?? ''}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.hasNextPage && (
              <button type="button" className="ui-button ui-button--outline" data-testid="more" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('doc.repo.list.more')}
              </button>
            )}
          </>
        )}
      </StateBoundary>
    </>
  );
}

type Decision = 'approve' | 'return' | 'reject';
interface Deciding {
  reviewer: Reviewer;
  decision: Decision;
}

function ReviewBoard({ id, frozen }: { id: string; frozen: boolean }) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const query = useReview(id);
  const decide = useDecideTask();
  const withdraw = useWithdrawReview();
  const [deciding, setDeciding] = useState<Deciding | undefined>(undefined);
  const [withdrawing, setWithdrawing] = useState(false);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const reload = (): void => void query.refetch();
  const close = (): void => {
    setDeciding(undefined);
    setWithdrawing(false);
    decide.reset();
    withdraw.reset();
  };
  const stamped = (): string => stamp(new Date().toISOString());

  return (
    <>
      <ContextBar
        items={[
          { label: t('doc.repo.context.scope'), value: tenant?.name ?? '–' },
          { label: t('doc.repo.context.project'), value: data === undefined ? '–' : data.document.project.code },
        ]}
        {...(data === undefined ? {} : { asOf: stamp(data.as_of) })}
        stale={refreshFailed}
      />
      {receipt !== undefined && (
        <p className="callout doc2-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {refreshFailed && (
        <p className="callout warning" role="status" data-testid="stale-note">
          {t('doc.repo.stale', { time: data === undefined ? '' : stamp(data.as_of) })}
        </p>
      )}
      <StateBoundary state={state} onRetry={reload}>
        {data !== undefined && (
          <>
            <section aria-labelledby="review-title" data-testid="review">
              <h2 id="review-title">
                <Link to={documentLink(data.document.id, data.review.version_id)} data-testid="document-link">
                  {data.document.title}
                </Link>
              </h2>
              <p>
                <StatusPill tone={reviewTone(data.review.status)}>{reviewStatusLabel(t, data.review.status)}</StatusPill>{' '}
                <span data-testid="round">{t('doc.repo.board.roundOf', { round: data.review.round, no: data.review.version_no })}</span>
              </p>
              <dl className="doc2-facts">
                <div>
                  <dt>{t('doc.repo.board.col.submitted')}</dt>
                  <dd>{t('doc.repo.board.submittedBy', { name: data.review.submitted_by_name ?? '—', time: stamp(data.review.submitted_at) })}</dd>
                </div>
                {data.review.submit_note !== null && (
                  <div>
                    <dt>{t('doc.repo.board.submitNote')}</dt>
                    <dd>{data.review.submit_note}</dd>
                  </div>
                )}
                {data.review.concluded_at !== null && (
                  <div>
                    <dt>{t('doc.repo.board.concluded')}</dt>
                    <dd data-testid="concluded">{stamp(data.review.concluded_at)}</dd>
                  </div>
                )}
                {data.review.conclusion_note !== null && (
                  <div>
                    <dt>{t('doc.repo.board.conclusionNote')}</dt>
                    <dd data-testid="conclusion">{data.review.conclusion_note}</dd>
                  </div>
                )}
                <div>
                  <dt>{t('doc.repo.board.workflow')}</dt>
                  <dd>{data.workflow_revision === null ? '—' : t('doc.repo.board.revision', { revision: data.workflow_revision })}</dd>
                </div>
                <div>
                  <dt>{t('doc.repo.board.openComments')}</dt>
                  <dd data-testid="open-comments">{data.open_comments}</dd>
                </div>
              </dl>
              {!frozen && (data.actions.withdraw || data.actions.resubmit) && (
                <div className="actions doc2-actions" data-testid="review-actions">
                  {data.actions.withdraw && (
                    <button type="button" className="ui-button ui-button--outline" data-testid="withdraw" onClick={() => setWithdrawing(true)}>
                      {t('doc.repo.action.withdraw')}
                    </button>
                  )}
                  {data.actions.resubmit && (
                    <Link className="ui-button ui-button--primary" to={documentLink(data.document.id)} data-testid="resubmit">
                      {t('doc.repo.board.resubmit')}
                    </Link>
                  )}
                </div>
              )}
            </section>

            <section aria-labelledby="stages-title" data-testid="stages">
              <h2 id="stages-title">{t('doc.repo.board.stages')}</h2>
              {data.stages.length === 0 ? (
                <p className="callout" data-testid="no-stages">
                  {t('doc.repo.board.noStages')}
                </p>
              ) : (
                <ol className="doc2-stages">
                  {data.stages.map((stage) => (
                    <li key={stage.id} className="doc2-stage" data-stage={stage.id} data-state={stage.state}>
                      <div className="doc2-stage-head">
                        <strong>{stage.name}</strong> <StatusPill tone={stageTone(stage.state)}>{stageLabel(t, stage.state)}</StatusPill>{' '}
                        <span className="muted" data-testid={`approvals-${stage.id}`}>
                          {t('doc.repo.board.approvals', { done: stage.approvals, needed: stage.min_approvals })}
                        </span>
                      </div>
                      {stage.reviewers.length === 0 ? (
                        <p className="muted">{t('doc.repo.board.noReviewers')}</p>
                      ) : (
                        <div className="tablewrap">
                          <table aria-label={t('doc.repo.board.reviewersAria', { stage: stage.name })}>
                            <thead>
                              <tr>
                                <th scope="col">{t('doc.repo.board.reviewer')}</th>
                                <th scope="col">{t('doc.repo.board.decision')}</th>
                                <th scope="col">{t('doc.repo.board.reason')}</th>
                                <th scope="col">{t('doc.repo.board.due')}</th>
                                <th scope="col">
                                  <span className="sr-only">{t('doc.repo.versions.col.actions')}</span>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {stage.reviewers.map((reviewer) => (
                                <tr key={reviewer.task_id} data-task={reviewer.task_id} data-state={reviewer.state}>
                                  <td>{reviewer.assignee_name ?? reviewer.assignee_id.slice(0, 8)}</td>
                                  <td>
                                    <StatusPill tone={reviewerTone(reviewer.state)}>{reviewerLabel(t, reviewer.state)}</StatusPill>
                                    {reviewer.decided_at !== null && <div className="muted">{stamp(reviewer.decided_at)}</div>}
                                  </td>
                                  <td>{reviewer.reason ?? '—'}</td>
                                  <td>{reviewer.state === 'PENDING' ? stamp(reviewer.due_at) : '—'}</td>
                                  <td>
                                    {reviewer.can_decide && reviewer.task_version !== null && !frozen && (
                                      <div className="actions">
                                        <button type="button" className="ui-button ui-button--primary ui-button--small" data-decide="approve" onClick={() => setDeciding({ reviewer, decision: 'approve' })}>
                                          {t('doc.repo.board.approve')}
                                        </button>
                                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-decide="return" onClick={() => setDeciding({ reviewer, decision: 'return' })}>
                                          {t('doc.repo.board.return')}
                                        </button>
                                        <button type="button" className="ui-button ui-button--outline ui-button--small" data-decide="reject" onClick={() => setDeciding({ reviewer, decision: 'reject' })}>
                                          {t('doc.repo.board.reject')}
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section aria-labelledby="events-title" data-testid="events">
              <h2 id="events-title">{t('doc.repo.board.history')}</h2>
              <ol>
                {data.events.map((event) => (
                  <li key={event.seq} data-event={event.kind}>
                    {eventLabel(t, event.kind)} <span className="muted">{t('doc.repo.board.eventBy', { name: event.actor_name ?? '—', time: stamp(event.occurred_at) })}</span>
                  </li>
                ))}
              </ol>
            </section>

            {deciding !== undefined && deciding.reviewer.task_version !== null && (
              <CommandDialog
                title={deciding.decision === 'approve' ? t('doc.repo.decide.approveTitle') : deciding.decision === 'return' ? t('doc.repo.decide.returnTitle') : t('doc.repo.decide.rejectTitle')}
                context={[
                  { label: t('doc.repo.field.title'), value: data.document.title },
                  { label: t('doc.repo.board.stage'), value: data.stages.find((stage) => stage.reviewers.some((item) => item.task_id === deciding.reviewer.task_id))?.name ?? '—' },
                ]}
                confirmLabel={deciding.decision === 'approve' ? t('doc.repo.board.approve') : deciding.decision === 'return' ? t('doc.repo.board.return') : t('doc.repo.board.reject')}
                reason={{ label: deciding.decision === 'approve' ? t('doc.repo.decide.noteOptional') : t('doc.repo.decide.reasonRequired'), required: deciding.decision !== 'approve' }}
                pending={decide.isPending}
                error={decide.error ?? undefined}
                onCancel={close}
                onReload={() => {
                  reload();
                  close();
                }}
                onConfirm={(reason) =>
                  decide.mutate(
                    { taskId: deciding.reviewer.task_id, version: deciding.reviewer.task_version ?? 0, decision: deciding.decision, reason },
                    {
                      onSuccess: () => {
                        setDeciding(undefined);
                        setReceipt(t('doc.repo.receipt.decided', { time: stamped() }));
                      },
                    },
                  )
                }
              />
            )}
            {withdrawing && (
              <CommandDialog
                title={t('doc.repo.withdraw.title')}
                context={[
                  { label: t('doc.repo.field.title'), value: data.document.title },
                  { label: t('doc.repo.submit.round'), value: String(data.review.round) },
                ]}
                confirmLabel={t('doc.repo.withdraw.confirm')}
                reason={{ label: t('doc.repo.withdraw.reason'), required: true }}
                pending={withdraw.isPending}
                error={withdraw.error ?? undefined}
                onCancel={close}
                onReload={() => {
                  reload();
                  close();
                }}
                onConfirm={(reason) =>
                  withdraw.mutate(
                    { id: data.review.id, version: data.review.version, reason },
                    {
                      onSuccess: () => {
                        setWithdrawing(false);
                        setReceipt(t('doc.repo.receipt.withdrawn', { time: stamped() }));
                      },
                    },
                  )
                }
              />
            )}
          </>
        )}
      </StateBoundary>
    </>
  );
}
