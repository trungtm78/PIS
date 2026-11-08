import { useState } from 'react';
import { ApiError } from '@machvon/api-client';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { sourceLabel } from '../../ui/alerts/AlertRow';
import { useFeedbackQueue, useFeedbackStats, useReviewFeedback } from './hooks';
import { FEEDBACK_STATUSES } from './model';
import type { Feedback, FeedbackStatus, TypeStat } from './model';
import { Provenance, feedbackReasonLabel, feedbackStatusLabel, when } from './parts';

const REVIEW = 'alert.feedback.review';
type Move = 'ACCEPT_FOR_TUNING' | 'REJECT' | 'MARK_DUPLICATE';

/**
 * HOME-30: the reports "this alert is wrong" that wait for the owners of the alert types. Each report has its reason, the words of the reporter and how long it has waited; the owner accepts it for tuning (a proposal that goes
 * through the governance rules), rejects it with the reason the alert is right, or marks it as a duplicate. Nothing here hides or silences an alert, and the reviewer is never the reporter. The unhelpful share of each type is
 * beside the queue with its formula and the line at which a type goes into review.
 */
export default function AlertFeedbackQueueScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <QueueContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function QueueContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const session = useSession();
  const [status, setStatus] = useState<FeedbackStatus | ''>('PENDING');
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1];
  const queue = useFeedbackQueue(status === '' ? undefined : status, cursor);
  const stats = useFeedbackStats();
  const review = useReviewFeedback();
  const [pending, setPending] = useState<{ item: Feedback; move: Move } | null>(null);
  const answer = queue.data;
  const state = useScreenState({ isLoading: queue.isLoading, error: answer === undefined ? queue.error : undefined, data: answer, isEmpty: () => false });
  const stale = answer !== undefined && queue.isError;
  const items = answer?.items ?? [];
  const mayReview = session.permissions?.includes(REVIEW) === true;

  const columns: DataTableColumn<Feedback>[] = [
    { key: 'type', header: t('gov10.feedback.column.type'), pinned: true, render: (row) => <><strong>{row.alertType}</strong> <span className="dis-code">{sourceLabel(t, row.source)}</span></> },
    { key: 'reason', header: t('gov10.feedback.column.reason'), render: (row) => feedbackReasonLabel(t, row.reason) },
    { key: 'note', header: t('gov10.feedback.column.note'), render: (row) => row.note ?? '—' },
    { key: 'status', header: t('gov10.feedback.column.status'), render: (row) => <StatusPill tone={row.status === 'PENDING' ? 'warning' : 'neutral'}>{feedbackStatusLabel(t, row.status)}</StatusPill> },
    { key: 'created', header: t('gov10.feedback.column.created'), render: (row) => <time dateTime={row.createdAt}>{when(row.createdAt)}</time> },
    {
      key: 'actions',
      header: t('gov10.feedback.column.actions'),
      render: (row) =>
        mayReview && row.status === 'PENDING' ? (
          <span className="gov10-actions">
            <button type="button" className="mv-alert-button" onClick={() => open(row, 'ACCEPT_FOR_TUNING')}>
              {t('gov10.feedback.action.accept')}
            </button>
            <button type="button" className="mv-alert-button" onClick={() => open(row, 'REJECT')}>
              {t('gov10.feedback.action.reject')}
            </button>
            <button type="button" className="mv-alert-button" onClick={() => open(row, 'MARK_DUPLICATE')}>
              {t('gov10.feedback.action.duplicate')}
            </button>
          </span>
        ) : (
          '—'
        ),
    },
  ];
  const statColumns: DataTableColumn<TypeStat>[] = [
    { key: 'type', header: t('gov10.feedback.stats.type'), pinned: true, render: (row) => row.alertType },
    { key: 'reports', header: t('gov10.feedback.stats.reports'), align: 'right', render: (row) => String(row.reports) },
    { key: 'shown', header: t('gov10.feedback.stats.shown'), align: 'right', render: (row) => String(row.shown) },
    { key: 'share', header: t('gov10.feedback.stats.share'), align: 'right', render: (row) => (row.sharePct === null ? t('gov10.feedback.stats.noShare') : `${row.sharePct}%`) },
    { key: 'review', header: t('gov10.feedback.stats.review'), render: (row) => (row.needsReview ? <StatusPill tone="warning">{t('gov10.feedback.stats.needsReview')}</StatusPill> : '—') },
  ];

  function open(item: Feedback, move: Move): void {
    review.reset();
    setPending({ item, move });
  }
  const confirm = (reason?: string): void => {
    if (pending === null) return;
    const { item, move } = pending;
    if (move === 'MARK_DUPLICATE' && duplicateTarget(items, item) === undefined) return;
    review.mutate(
      { id: item.id, version: item.version, move, ...(move === 'REJECT' ? { reviewNote: reason } : {}), ...(move === 'ACCEPT_FOR_TUNING' ? { proposalNote: reason } : {}), ...(move === 'MARK_DUPLICATE' ? { duplicateOfId: duplicateTarget(items, item) } : {}) },
      { onSuccess: () => setPending(null) },
    );
  };
  const refusal = review.error instanceof ApiError ? (review.error.code === 'SELF_APPROVAL_DENIED' ? t('gov10.feedback.error.self') : review.error.code === 'VERSION_CONFLICT' ? t('gov10.feedback.error.conflict') : t('gov10.feedback.error.refused')) : review.isError ? t('gov10.feedback.error.refused') : undefined;
  const noTarget = pending !== null && pending.move === 'MARK_DUPLICATE' && duplicateTarget(items, pending.item) === undefined;
  const title = pending === null ? '' : pending.move === 'ACCEPT_FOR_TUNING' ? t('gov10.feedback.action.accept') : pending.move === 'REJECT' ? t('gov10.feedback.action.reject') : t('gov10.feedback.action.duplicate');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('gov10.feedback.title')}</h1>
          <p>{t('gov10.feedback.subtitle')}</p>
        </div>
      </div>
      <div className="gov10-stack">
        <p className="gov10-notice" data-testid="feedback-notice">
          {t('gov10.feedback.notice')}
        </p>
        <ContextBar items={[{ label: t('gov10.feedback.ctx.shown'), value: String(items.length) }]} {...(answer === undefined || answer.asOf === '' ? {} : { asOf: when(answer.asOf) })} stale={stale} />
        <div className="gov10-filters">
          <label>
            <span>{t('gov10.feedback.filter.status')}</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as FeedbackStatus | '');
                setCursors([]);
              }}
            >
              <option value="">{t('gov10.feedback.filter.all')}</option>
              {FEEDBACK_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {feedbackStatusLabel(t, entry)}
                </option>
              ))}
            </select>
          </label>
          <Link to="/home/home-31" className="mv-alert-link">
            {t('gov10.feedback.reportLink')}
          </Link>
        </div>
        {stale ? (
          <p className="gov10-notice gov10-notice--warn" role="status" data-testid="feedback-stale">
            {t('gov10.feedback.stale')}{' '}
            <button type="button" className="mv-alert-link" onClick={() => void queue.refetch()}>
              {t('gov10.retry')}
            </button>
          </p>
        ) : null}
        <StateBoundary state={state} onRetry={() => void queue.refetch()}>
          {items.length === 0 ? (
            <p className="gov10-notice" role="status" data-testid="feedback-empty">
              {status === 'PENDING' ? t('gov10.feedback.empty.pending') : t('gov10.feedback.empty.filtered')}
            </p>
          ) : (
            <>
              <DataTable caption={t('gov10.feedback.title')} columns={columns} rows={items} rowKey={(row) => row.id} />
              <nav className="gov10-pager" aria-label={t('gov10.pager.label')}>
                <button type="button" className="mv-alert-button" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>
                  {t('gov10.pager.previous')}
                </button>
                <button type="button" className="mv-alert-button" disabled={answer?.nextCursor === null || answer?.nextCursor === undefined} onClick={() => answer?.nextCursor == null || setCursors([...cursors, answer.nextCursor])}>
                  {t('gov10.pager.next')}
                </button>
              </nav>
            </>
          )}
        </StateBoundary>
        <SectionCard
          title={t('gov10.feedback.stats.title')}
          status={
            <Provenance name={t('gov10.feedback.stats.title')} formula={t('gov10.feedback.stats.formula', { line: stats.data?.reviewLinePct ?? 30, min: stats.data?.minShown ?? 10 })} source={t('gov10.feedback.stats.source')} asOf={stats.data?.asOf ?? null} version={t('gov10.info.versionDefault')} unverified={stats.data?.unverified ?? true} owner={t('gov10.feedback.stats.owner')} />
          }
        >
          {stats.isLoading ? (
            <div className="skeleton" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
          ) : stats.data === undefined ? (
            <p role="alert" data-testid="stats-error">
              {t('gov10.feedback.stats.failed')}{' '}
              <button type="button" className="mv-alert-link" onClick={() => void stats.refetch()}>
                {t('gov10.retry')}
              </button>
            </p>
          ) : stats.data.items.length === 0 ? (
            <p className="gov10-notice" role="status" data-testid="stats-empty">
              {t('gov10.feedback.stats.empty')}
            </p>
          ) : (
            <DataTable caption={t('gov10.feedback.stats.title')} columns={statColumns} rows={stats.data.items} rowKey={(row) => row.alertType} />
          )}
        </SectionCard>
        {pending === null ? null : (
          <ConfirmDialog
            open
            title={title}
            context={[
              { label: t('gov10.feedback.column.type'), value: pending.item.alertType },
              { label: t('gov10.feedback.column.reason'), value: feedbackReasonLabel(t, pending.item.reason) },
            ]}
            confirmLabel={title}
            cancelLabel={t('gov10.cancel')}
            pending={review.isPending}
            onConfirm={confirm}
            onCancel={() => setPending(null)}
            {...(pending.move === 'MARK_DUPLICATE' ? {} : { reason: { label: pending.move === 'REJECT' ? t('gov10.feedback.reasonReject') : t('gov10.feedback.reasonProposal'), required: true, minLength: pending.move === 'REJECT' ? 5 : 0, hint: t('gov10.feedback.reasonHint') } })}
            {...(noTarget ? { error: t('gov10.feedback.error.noDuplicate') } : refusal === undefined ? {} : { error: refusal })}
          />
        )}
      </div>
    </section>
  );
}

/** The other pending report of the same type that the duplicate points at: the oldest one that is not this one (a duplicate is a report of the same type). */
function duplicateTarget(items: readonly Feedback[], item: Feedback): string | undefined {
  return items.find((other) => other.id !== item.id && other.alertType === item.alertType && other.status === 'PENDING')?.id;
}
