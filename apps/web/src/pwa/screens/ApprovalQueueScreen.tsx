import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useOrgUnits } from '../../screens/adm/org-tree/hooks';
import { BUSINESS_TYPES, businessTypeLabel } from '../../screens/adm/approvals/labels';
import { DeadlineCountdown, StatusPill } from '../../ui';
import { clock, todayOf } from '../../ui/alerts/format';
import { Link } from 'react-router-dom';
import { useApprovalQueue, useDecideTask } from './approval-hooks';
import { useReportNames } from './approval-detail-hooks';
import { DECIDE_PERMISSION, NO_FILTER, PERIOD_FILTER, READ_PERMISSION, REFRESH_PROBLEMS, applyFilter, checkComment, describeProblem, mayDecide } from './approval-model';
import type { ApprovalTask, Decision, Problem, QueueFilter } from './approval-model';
import { problemText } from './approval-problem';
import { DecisionSheet } from './DecisionSheet';
import { PwaBackLink } from './PwaBackLink';
import './pwa.css';

/** How old the list may be before the screen says so (the list is read again when the page comes back to the front). */
export const STALE_AFTER_MS = 5 * 60_000;
/** How many cards have the name of their record read (one read each). */
const NAMED_CARDS = 20;
const START_PATH = '/m';

interface Receipt {
  decision: Decision;
  step: string;
  record: string;
  at: Date;
}

/**
 * The approval queue of the period data on the phone (PWA-02, YCK.01): the tasks waiting for the person, the late ones first, each decided here with
 * the comment the decision needs: approve (the comment is optional) or return for correction (the comment says why). It reads and writes through the same
 * API as the approval inbox of the phone application and the approval monitor of ADM-18 (`get_resources_approval_task`, `decideApprovalTask`); a decision
 * is one request sent while the page is online, under the version of the task on the screen, never queued and never sent from a notification.
 */
export default function ApprovalQueueScreen() {
  const { tenant } = useSession();
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <QueueContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} />;
}

function QueueContent() {
  const { t, locale } = useTranslation();
  const session = useSession();
  const { permissions, mode } = session;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const mayDecideAtAll = permissions === undefined || permissions.includes(DECIDE_PERMISSION);
  const readOnly = mode === 'READ_ONLY';
  const queue = useApprovalQueue(mayRead);
  const units = useOrgUnits();
  const decide = useDecideTask();
  const [filter, setFilter] = useState<QueueFilter>(NO_FILTER);
  const [acting, setActing] = useState<{ task: ApprovalTask; decision: Decision } | undefined>(undefined);
  const [localProblem, setLocalProblem] = useState<Problem | 'commentRequired' | 'commentTooLong' | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  // The age of the list is judged against a clock that ticks, so "Stale figures" appears without a click.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const tasks = queue.data ?? [];
  // A failed reading of a list the screen already has is a stale list, not an empty screen (partial/stale of design.md).
  // An empty list is this screen's own card (nothing waits, or the filter found nothing), not the standard empty state.
  const queryState = useScreenState({ isLoading: queue.isLoading, error: queue.data === undefined ? queue.error : undefined, data: queue.data, isEmpty: () => false });
  const state = mayRead ? queryState : 'denied';
  const shown = applyFilter(tasks, filter);
  // The project of a report is named on its card (only the first cards are read: each name is one read of the report, kept for the page).
  const names = useReportNames(shown.slice(0, NAMED_CARDS));
  const recordName = (task: ApprovalTask): string => {
    const name = names.get(task.resourceId);
    return name === undefined ? task.resourceType : `${name.project} · ${name.period}`;
  };
  const late = tasks.filter((task) => task.overdue).length;
  const today = todayOf(new Date(now));
  const staleList = queue.data !== undefined && (queue.isError || now - queue.dataUpdatedAt > STALE_AFTER_MS);
  const unitName = (id: string | null): string | undefined => (id === null ? undefined : units.data?.find((unit) => unit.id === id)?.name);
  const money = (value: string | null): string | null => (value === null ? null : new Intl.NumberFormat(locale).format(Number(value)));

  const close = (): void => {
    setActing(undefined);
    setLocalProblem(undefined);
    decide.reset();
  };

  const send = (comment: string): void => {
    if (acting === undefined) return;
    const problem = checkComment(acting.decision, comment);
    if (problem !== undefined) {
      setLocalProblem(problem === 'required' ? 'commentRequired' : 'commentTooLong');
      return;
    }
    setLocalProblem(undefined);
    const { task, decision } = acting;
    decide.mutate(
      { task, decision, comment },
      {
        onSuccess: () => {
          setReceipt({ decision, step: task.stepName, record: recordName(task), at: new Date() });
          close();
        },
      },
    );
  };

  const serverProblem = decide.isError ? describeProblem(decide.error) : undefined;
  const sheetProblem =
    localProblem === 'commentRequired'
      ? t('pwa.approvals.problem.commentRequired')
      : localProblem === 'commentTooLong'
        ? t('pwa.approvals.problem.commentTooLong')
        : serverProblem === undefined
          ? undefined
          : problemText(t, serverProblem);
  const remedy =
    serverProblem === 'stepUp' ? (
      <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="step-up" onClick={() => void session.requestStepUp?.()}>
        {t('pwa.approvals.remedy.stepUp')}
      </button>
    ) : serverProblem !== undefined && REFRESH_PROBLEMS.includes(serverProblem) ? (
      <button
        type="button"
        className="ui-button ui-button--outline pwa-touch"
        data-action="reload"
        onClick={() => {
          close();
          void queue.refetch();
        }}
      >
        {t('pwa.approvals.remedy.reload')}
      </button>
    ) : undefined;

  const kinds = [
    { value: '', label: t('pwa.approvals.filter.all') },
    { value: PERIOD_FILTER, label: t('pwa.approvals.filter.period') },
    ...BUSINESS_TYPES.map((type) => ({ value: type.code, label: businessTypeLabel(t, type.code) })),
  ];

  return (
    <section className="pwa-screen" data-screen-id="PWA-02" aria-labelledby="screen-title">
      <PwaBackLink to={START_PATH} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa.approvals.page.title')}</h1>
          <p>{t('pwa.approvals.page.subtitle')}</p>
        </div>
      </div>
      {receipt === undefined ? null : (
        <div className="callout pwa-receipt" role="status" data-testid="receipt">
          <strong>{receipt.decision === 'approve' ? t('pwa.approvals.receipt.approved') : t('pwa.approvals.receipt.returned')}</strong>
          <dl className="pwa-facts">
            <dt>{t('pwa.approvals.receipt.record')}</dt>
            <dd>{receipt.record}</dd>
            <dt>{t('pwa.approvals.receipt.step')}</dt>
            <dd>{receipt.step}</dd>
            <dt>{t('pwa.approvals.receipt.time')}</dt>
            <dd>{clock(receipt.at)}</dd>
          </dl>
          <p>{receipt.decision === 'approve' ? t('pwa.approvals.receipt.nextApproved') : t('pwa.approvals.receipt.nextReturned')}</p>
          <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={() => setReceipt(undefined)}>
            {t('pwa.approvals.receipt.dismiss')}
          </button>
        </div>
      )}
      <StateBoundary state={state} onRetry={() => void queue.refetch()}>
        {readOnly ? (
          <p className="callout" role="status" data-testid="read-only">
            {t('pwa.approvals.readOnly.note')}
          </p>
        ) : null}
        {staleList ? (
          <p className="callout warning" role="status" data-testid="stale">
            {t('pwa.approvals.stale.note', { time: clock(new Date(queue.dataUpdatedAt)) })}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={() => void queue.refetch()}>
              {t('states.retry.action')}
            </button>
          </p>
        ) : null}
        <div className="pwa-filters">
          <div className="field">
            <label htmlFor="pwa-approvals-kind">{t('pwa.approvals.filter.kind')}</label>
            <select id="pwa-approvals-kind" value={filter.kind} onChange={(event) => setFilter({ ...filter, kind: event.target.value })}>
              {kinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </div>
          <label className="pwa-check" htmlFor="pwa-approvals-late">
            <input type="checkbox" id="pwa-approvals-late" checked={filter.onlyOverdue} onChange={(event) => setFilter({ ...filter, onlyOverdue: event.target.checked })} />
            <span>{t('pwa.approvals.filter.late')}</span>
          </label>
        </div>
        <p className="sub" data-testid="counts">
          {t('pwa.approvals.counts.line', { open: tasks.length, late })}
          {' · '}
          {t('pwa.approvals.counts.updated', { time: clock(new Date(queue.dataUpdatedAt)) })}
        </p>
        {shown.length === 0 ? (
          <div className="card statecard pwa-empty" role="status" data-testid="empty" data-kind={tasks.length === 0 ? 'none' : 'filtered'}>
            <h2>{tasks.length === 0 ? t('pwa.approvals.empty.none.title') : t('pwa.approvals.empty.filtered.title')}</h2>
            <p className="muted">{tasks.length === 0 ? t('pwa.approvals.empty.none.body') : t('pwa.approvals.empty.filtered.body')}</p>
            {tasks.length === 0 ? null : (
              <button type="button" className="ui-button ui-button--outline pwa-touch" onClick={() => setFilter(NO_FILTER)}>
                {t('pwa.approvals.empty.filtered.clear')}
              </button>
            )}
          </div>
        ) : (
          <ul className="pwa-cards" aria-label={t('pwa.approvals.list.aria')}>
            {shown.map((task) => {
              const amount = money(task.amountVnd);
              const unit = unitName(task.unitId);
              const may = mayDecide(task, readOnly) && mayDecideAtAll;
              return (
                <li key={task.id} className="pwa-card" data-task={task.id} data-overdue={task.overdue ? 'yes' : 'no'}>
                  <div className="pwa-card-head">
                    <h2>{businessTypeLabel(t, task.businessType)}</h2>
                    <span className="pwa-pills">
                      {task.overdue ? <StatusPill tone="danger">{t('pwa.approvals.status.late')}</StatusPill> : <StatusPill tone="neutral">{t('pwa.approvals.status.pending')}</StatusPill>}
                      {task.escalated ? <StatusPill tone="warning">{t('pwa.approvals.status.escalated')}</StatusPill> : null}
                    </span>
                  </div>
                  <dl className="pwa-facts">
                    <dt>{t('pwa.approvals.field.step')}</dt>
                    <dd>{task.stepName === '' ? '—' : task.stepName}</dd>
                    <dt>{t('pwa.approvals.field.record')}</dt>
                    <dd data-testid="record-name">{recordName(task)}</dd>
                    {unit === undefined ? null : (
                      <>
                        <dt>{t('pwa.approvals.field.unit')}</dt>
                        <dd>{unit}</dd>
                      </>
                    )}
                    {amount === null ? null : (
                      <>
                        <dt>{t('pwa.approvals.field.amount')}</dt>
                        <dd>
                          {amount} <span className="pwa-unit">{t('pwa.approvals.unit.vnd')}</span>
                        </dd>
                      </>
                    )}
                    <dt>{t('pwa.approvals.field.due')}</dt>
                    <dd>
                      <DeadlineCountdown dueOn={todayOf(new Date(task.dueAt))} today={today} />
                    </dd>
                  </dl>
                  <Link to={`/m/approvals/${task.id}`} className="ui-button ui-button--outline pwa-touch" data-action="detail">
                    {t('pwa2.approvals.action.detail')}
                  </Link>
                  {may ? (
                    <div className="pwa-actions">
                      <button type="button" className="ui-button ui-button--primary pwa-touch" data-action="approve" onClick={() => setActing({ task, decision: 'approve' })}>
                        {t('pwa.approvals.action.approve')}
                      </button>
                      <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="return" onClick={() => setActing({ task, decision: 'return' })}>
                        {t('pwa.approvals.action.return')}
                      </button>
                    </div>
                  ) : (
                    <p className="sub" data-testid="cannot-decide">
                      {t('pwa.approvals.action.cannot')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </StateBoundary>
      {acting === undefined ? null : (
        <DecisionSheet
          title={acting.decision === 'approve' ? t('pwa.approvals.sheet.approve.title') : t('pwa.approvals.sheet.return.title')}
          context={[
            { label: t('pwa.approvals.field.step'), value: acting.task.stepName === '' ? '—' : acting.task.stepName },
            { label: t('pwa.approvals.field.record'), value: recordName(acting.task) },
            ...(acting.task.amountVnd === null ? [] : [{ label: t('pwa.approvals.field.amount'), value: `${money(acting.task.amountVnd) ?? ''} ${t('pwa.approvals.unit.vnd')}` }]),
          ]}
          commentLabel={acting.decision === 'approve' ? t('pwa.approvals.sheet.approve.comment') : t('pwa.approvals.sheet.return.comment')}
          commentRequired={acting.decision === 'return'}
          problem={sheetProblem}
          remedy={remedy}
          pending={decide.isPending}
          submitLabel={acting.decision === 'approve' ? t('pwa.approvals.sheet.approve.submit') : t('pwa.approvals.sheet.return.submit')}
          cancelLabel={t('pwa.approvals.sheet.cancel')}
          pendingLabel={t('pwa.approvals.sheet.pending')}
          requiredLabel={t('pwa.approvals.sheet.required')}
          onSubmit={send}
          onCancel={close}
        />
      )}
    </section>
  );
}
