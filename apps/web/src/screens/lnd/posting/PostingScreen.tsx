import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useHouseholds } from '../household/hooks';
import { timerLabel } from '../labels';
import { todayInVietnam } from '../model';
import { planStatusLabel } from '../plan/labels';
import { usePlans } from '../plan/hooks';
import { PLANS_PATH, formatVnd } from '../plan/model';
import type { PlanLine } from '../plan/model';
import { useProjectOptions } from '../read-hooks';
import { ApproveDialog, CloseDialog, FeedbackDialog, HandleDialog, PostDialog } from './dialogs';
import { usePlanFeedback, usePlanTimers } from './hooks';
import { feedbackChannelLabel, feedbackStatusLabel, timerStatusLabel } from './labels';
import { canApproveIt, canApprovePlan, canPost, canWritePosting, daysLeft, handlesFeedback, postingElapsed, postingPlans, takesFeedback } from './model';
import type { FeedbackLine, PlanTimers } from './model';
import '../lnd.css';

type Dialog = { kind: 'post'; plan: PlanLine } | { kind: 'feedback'; plan: PlanLine } | { kind: 'handle'; plan: PlanLine; feedback: FeedbackLine } | { kind: 'close'; plan: PlanLine } | { kind: 'approve'; plan: PlanLine };

/**
 * LND-06: the posting of a plan to the households for the days of the rule, the opinions on it and the approval (ST-LND-006, BR-LND-02, UAT-AC377). The plans of a project that can be posted, are posted, have closed their
 * posting or were approved are listed; the one that is open shows its dates, what is left of the days, the opinions counted and each opinion with its handling. The posting is closed only once its days are over, and a plan is
 * approved only when every opinion is handled and by someone other than the drafter. The server counts the days and judges every request again.
 */
export default function PostingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The plans and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <PostingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PostingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project') ?? undefined;
  const planId = params.get('plan') ?? undefined;
  const today = todayInVietnam();
  const projects = useProjectOptions();
  const plans = usePlans(projectId);
  const mayWrite = canWritePosting(permissions, mode);
  const mayApprove = canApprovePlan(permissions, mode);
  const households = useHouseholds(mayWrite && projectId !== undefined ? projectId : undefined);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const shown = useMemo(() => postingPlans(plans.data ?? []), [plans.data]);
  const selected = shown.find((plan) => plan.id === planId);
  const timers = usePlanTimers(selected?.id);
  const feedback = usePlanFeedback(selected?.id);
  const state = useScreenState({ isLoading: plans.isLoading, error: plans.error, data: plans.data, isEmpty: () => false });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="lnd-back-link">
        <Link to={projectId === undefined ? PLANS_PATH : `${PLANS_PATH}?project=${projectId}`}>
          <span aria-hidden="true">← </span>
          {t('lnd.posting.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('lnd.posting.page.title')}</h1>
          <p>{t('lnd.posting.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="privacy-note">
        {t('lnd.posting.privacy.note')}
      </p>
      <div className="card">
        <div className="field">
          <label htmlFor="posting-project">{t('lnd.posting.project.label')}</label>
          <select id="posting-project" value={projectId ?? ''} onChange={(event) => setParams(event.target.value === '' ? {} : { project: event.target.value })}>
            <option value="">{t('lnd.posting.project.choose')}</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.code} · ${project.name}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      {projectId === undefined ? (
        <p className="callout" role="status" data-testid="choose-project">
          {t('lnd.posting.project.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void plans.refetch()}>
          <div className="card">
            {shown.length === 0 ? (
              <p className="callout" role="status" data-testid="no-plans">
                {t('lnd.posting.empty.notice')}
              </p>
            ) : (
              <table className="table" data-testid="plans">
                <thead>
                  <tr>
                    <th scope="col">{t('lnd.posting.column.code')}</th>
                    <th scope="col">{t('lnd.posting.column.revision')}</th>
                    <th scope="col">{t('lnd.posting.column.grand')}</th>
                    <th scope="col">{t('lnd.posting.column.status')}</th>
                    <th scope="col">{t('lnd.posting.column.start')}</th>
                    <th scope="col">{t('lnd.posting.column.end')}</th>
                    <th scope="col">{t('lnd.posting.column.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((plan) => (
                    <PlanRow
                      key={plan.id}
                      plan={plan}
                      open={plan.id === selected?.id}
                      canPostIt={mayWrite && canPost(plan)}
                      onOpen={() => setParams({ project: projectId, plan: plan.id })}
                      onPost={() => setDialog({ kind: 'post', plan })}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {selected === undefined ? null : (
            <PostingDetail
              plan={selected}
              today={today}
              timers={timers.data}
              timersFailed={timers.isError}
              feedback={feedback.data ?? []}
              feedbackLoading={feedback.isLoading}
              feedbackFailed={feedback.isError}
              canRecord={mayWrite && takesFeedback(selected)}
              canHandle={mayWrite && handlesFeedback(selected)}
              canClose={mayWrite && selected.status === 'POSTING'}
              canApproveIt={mayApprove && canApproveIt(selected)}
              onRecord={() => setDialog({ kind: 'feedback', plan: selected })}
              onHandle={(line) => setDialog({ kind: 'handle', plan: selected, feedback: line })}
              onClosePosting={() => setDialog({ kind: 'close', plan: selected })}
              onApprove={() => setDialog({ kind: 'approve', plan: selected })}
            />
          )}
        </StateBoundary>
      )}
      {dialog?.kind === 'post' ? <PostDialog plan={dialog.plan} today={today} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'feedback' ? <FeedbackDialog plan={dialog.plan} households={households.data ?? []} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'handle' ? <HandleDialog plan={dialog.plan} feedback={dialog.feedback} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'close' ? <CloseDialog plan={dialog.plan} onClose={() => setDialog(undefined)} /> : null}
      {dialog?.kind === 'approve' ? <ApproveDialog plan={dialog.plan} today={today} onClose={() => setDialog(undefined)} /> : null}
      <p className="prototype-note">{t('lnd.posting.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

interface RowProps {
  plan: PlanLine;
  open: boolean;
  canPostIt: boolean;
  onOpen(): void;
  onPost(): void;
}

function PlanRow({ plan, open, canPostIt, onOpen, onPost }: RowProps) {
  const { t } = useTranslation();
  const none = t('lnd.posting.value.none');
  return (
    <tr data-plan-id={plan.id} aria-selected={open}>
      <th scope="row">{plan.planCode}</th>
      <td data-testid="revision">{plan.revision}</td>
      <td className="lnd-numeric" data-testid="total-grand">
        {formatVnd(plan.grandTotalVnd)}
      </td>
      <td>
        <span className="lnd-badge" data-testid="status">
          {planStatusLabel(t, plan.status)}
        </span>
      </td>
      <td data-testid="start">{plan.postingStartedOn ?? none}</td>
      <td data-testid="end">{plan.postingEndsOn ?? none}</td>
      <td>
        <button type="button" className="button" aria-label={t('lnd.posting.open.aria', { code: plan.planCode, revision: plan.revision })} onClick={onOpen}>
          {t('lnd.posting.open.action')}
        </button>
        {canPostIt ? (
          <button type="button" className="button" aria-label={t('lnd.posting.post.aria', { code: plan.planCode, revision: plan.revision })} onClick={onPost}>
            {t('lnd.posting.post.action')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

interface DetailProps {
  plan: PlanLine;
  today: string;
  timers: PlanTimers | undefined;
  timersFailed: boolean;
  feedback: readonly FeedbackLine[];
  feedbackLoading: boolean;
  feedbackFailed: boolean;
  canRecord: boolean;
  canHandle: boolean;
  canClose: boolean;
  canApproveIt: boolean;
  onRecord(): void;
  onHandle(line: FeedbackLine): void;
  onClosePosting(): void;
  onApprove(): void;
}

function PostingDetail({ plan, today, timers, timersFailed, feedback, feedbackLoading, feedbackFailed, canRecord, canHandle, canClose, canApproveIt: mayApproveIt, onRecord, onHandle, onClosePosting, onApprove }: DetailProps) {
  const { t } = useTranslation();
  const none = t('lnd.posting.value.none');
  const elapsed = postingElapsed(plan, today);
  const left = daysLeft(plan, today);
  return (
    <div className="card" data-testid="posting-detail">
      <h2>{t('lnd.posting.detail.title', { code: plan.planCode, revision: plan.revision })}</h2>
      <div className="actions">
        {canRecord ? (
          <button type="button" className="button" onClick={onRecord}>
            {t('lnd.posting.feedback.action')}
          </button>
        ) : null}
        {canClose ? (
          <button type="button" className="button" disabled={!elapsed} onClick={onClosePosting}>
            {t('lnd.posting.close.action')}
          </button>
        ) : null}
        {mayApproveIt ? (
          <button type="button" className="primary" onClick={onApprove}>
            {t('lnd.posting.approve.action')}
          </button>
        ) : null}
      </div>
      {canClose && !elapsed && plan.postingEndsOn !== null ? (
        <p className="callout" role="status" data-testid="close-hint">
          {t('lnd.posting.close.hint', { date: plan.postingEndsOn })}
        </p>
      ) : null}
      {timersFailed ? (
        <p className="callout warning" role="alert" data-testid="timers-failed">
          {t('lnd.posting.timers.failed')}
        </p>
      ) : (
        <div className="lnd-tiles">
          <div className="lnd-tile" data-testid="tile-start">
            <span>{t('lnd.posting.tile.start')}</span>
            <strong>{plan.postingStartedOn ?? none}</strong>
          </div>
          <div className="lnd-tile" data-testid="tile-end">
            <span>{t('lnd.posting.tile.end')}</span>
            <strong>{plan.postingEndsOn ?? none}</strong>
          </div>
          <div className="lnd-tile" data-testid="tile-left">
            <span>{t('lnd.posting.tile.left')}</span>
            <strong>{plan.status === 'POSTING' && left !== null ? left : none}</strong>
          </div>
          <div className="lnd-tile" data-testid="tile-open">
            <span>{t('lnd.posting.tile.open')}</span>
            <strong>{timers?.feedbackOpen ?? none}</strong>
          </div>
          <div className="lnd-tile" data-testid="tile-handled">
            <span>{t('lnd.posting.tile.handled')}</span>
            <strong>{timers?.feedbackHandled ?? none}</strong>
          </div>
        </div>
      )}
      {plan.postingPlaceText === null ? null : (
        <p data-testid="place">
          {t('lnd.posting.place.text', { place: plan.postingPlaceText })}
        </p>
      )}
      {(timers?.deadlines ?? []).map((deadline) => (
        <p key={deadline.id} data-testid="timer" data-timer-code={deadline.timerCode}>
          {t('lnd.posting.timer.text', {
            timer: timerLabel(t, deadline.timerCode),
            days: deadline.daysApplied,
            due: deadline.dueOn,
            status: timerStatusLabel(t, deadline.status),
          })}
          {deadline.legalBasis === null ? null : <small className="sub">{` ${deadline.legalBasis}`}</small>}
        </p>
      ))}
      {plan.feedbackSummary === null ? null : (
        <p data-testid="summary">
          {t('lnd.posting.summary.text', { summary: plan.feedbackSummary })}
        </p>
      )}
      {plan.approvedOn === null || plan.paymentDueOn === null ? null : (
        <p data-testid="approval">
          {t('lnd.posting.approval.text', { approved: plan.approvedOn, due: plan.paymentDueOn })}
        </p>
      )}
      {feedbackFailed ? (
        <p className="callout warning" role="alert" data-testid="feedback-failed">
          {t('lnd.posting.feedbackList.failed')}
        </p>
      ) : feedbackLoading ? (
        <p role="status">{t('lnd.posting.feedbackList.loading')}</p>
      ) : feedback.length === 0 ? (
        <p className="callout" role="status" data-testid="feedback-empty">
          {t('lnd.posting.feedbackList.empty')}
        </p>
      ) : (
        <table className="table" data-testid="feedback">
          <thead>
            <tr>
              <th scope="col">{t('lnd.posting.feedbackColumn.household')}</th>
              <th scope="col">{t('lnd.posting.feedbackColumn.channel')}</th>
              <th scope="col">{t('lnd.posting.feedbackColumn.summary')}</th>
              <th scope="col">{t('lnd.posting.feedbackColumn.recorded')}</th>
              <th scope="col">{t('lnd.posting.feedbackColumn.status')}</th>
              <th scope="col">{t('lnd.posting.feedbackColumn.handling')}</th>
              <th scope="col">{t('lnd.posting.feedbackColumn.action')}</th>
            </tr>
          </thead>
          <tbody>
            {feedback.map((line) => (
              <tr key={line.id} data-feedback-id={line.id}>
                <th scope="row">{line.householdCode ?? t('lnd.posting.feedback.nobody')}</th>
                <td>{feedbackChannelLabel(t, line.channel)}</td>
                <td>{line.summary}</td>
                <td>{line.recordedOn}</td>
                <td>
                  <span className="lnd-badge" data-testid="feedback-status">
                    {feedbackStatusLabel(t, line.status)}
                  </span>
                </td>
                <td data-testid="handling">{line.handlingNote === null ? none : t('lnd.posting.handling.text', { date: line.handledOn ?? '', note: line.handlingNote })}</td>
                <td>
                  {canHandle && line.status === 'OPEN' ? (
                    <button type="button" className="button" aria-label={t('lnd.posting.handle.aria', { household: line.householdCode ?? t('lnd.posting.feedback.nobody') })} onClick={() => onHandle(line)}>
                      {t('lnd.posting.handle.action')}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
