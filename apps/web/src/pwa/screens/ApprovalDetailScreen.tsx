import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useOrgUnits } from '../../screens/adm/org-tree/hooks';
import { businessTypeLabel } from '../../screens/adm/approvals/labels';
import { DeadlineCountdown, SectionCard, StatusPill } from '../../ui';
import { clock, todayOf } from '../../ui/alerts/format';
import { useDecideTask } from './approval-hooks';
import { useReportRevision, useStepHistory, useTaskDetail } from './approval-detail-hooks';
import { REPORT_ACCEPT } from './approval-detail-model';
import { DECIDE_PERMISSION, READ_PERMISSION, REFRESH_PROBLEMS, checkComment, describeProblem, mayDecide } from './approval-model';
import type { ApprovalTask, Decision, Problem } from './approval-model';
import { taskStatusLabel } from './approval-labels';
import { problemText } from './approval-problem';
import { EvidenceList, PlanComparison, RevisionComparison, StepHistory, money } from './ApprovalDetailSections';
import { DecisionSheet } from './DecisionSheet';
import { PwaBackLink } from './PwaBackLink';
import './pwa.css';

const QUEUE_PATH = '/m/approvals';

interface Receipt {
  decision: Decision;
  step: string;
  record: string;
  at: Date;
}

/**
 * The detail of one approval task on the phone (PWA-05, YCK.01): what the leader reads before deciding, from the same operations as MOB-24 of the phone
 * application (`get_resources_approval_task_id`, the report revision and the revision before it, the unit) plus the plan the figures rest on and the steps of the
 * approval. The names of the project and the unit stand in place of codes. Each optional part (the report, the revision before it, the steps) is a separate right:
 * a refusal leaves the part out and says so, a lost connection fails the read. Approve and return are sent as in the queue: one request while online, under the
 * version of the task on the screen (If-Match), with the second factor asked for in place and one idempotency key per intention.
 */
export default function ApprovalDetailScreen() {
  const { tenant } = useSession();
  const { taskId = '' } = useParams();
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <DetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}:${taskId}`} taskId={taskId} />;
}

function DetailContent({ taskId }: { taskId: string }) {
  const { t, locale } = useTranslation();
  const session = useSession();
  const { permissions, mode } = session;
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const mayDecideAtAll = permissions === undefined || permissions.includes(DECIDE_PERMISSION);
  const readOnly = mode === 'READ_ONLY';
  const task = useTaskDetail(taskId, mayRead);
  const record = task.data ?? undefined;
  const isReport = record?.businessType === REPORT_ACCEPT && record.resourceId !== '';
  const report = useReportRevision(isReport ? (record?.resourceId ?? null) : null);
  const reportFigures = report.data?.kind === 'ready' ? report.data.figures : undefined;
  const previous = useReportRevision(reportFigures?.supersedesId ?? null);
  const steps = useStepHistory(record?.instanceId ?? null, record !== undefined);
  const units = useOrgUnits();
  const decide = useDecideTask();
  const [acting, setActing] = useState<Decision | undefined>(undefined);
  const [localProblem, setLocalProblem] = useState<'commentRequired' | 'commentTooLong' | undefined>(undefined);
  const [receipt, setReceipt] = useState<Receipt | undefined>(undefined);

  const notFound = task.error instanceof ApiError && task.error.status === 404;
  const unreadable = task.isSuccess && task.data === null;
  const queryState = useScreenState({ isLoading: task.isLoading, error: notFound ? undefined : unreadable ? new Error('the task is not readable') : task.error, data: record, isEmpty: () => false });
  const state = mayRead ? queryState : 'denied';
  const unitName = record?.unitId == null ? undefined : units.data?.find((unit) => unit.id === record.unitId)?.name;
  const recordName = (item: ApprovalTask): string => (reportFigures === undefined ? item.resourceType : `${reportFigures.projectName} · ${reportFigures.periodCode}`);

  const close = (): void => {
    setActing(undefined);
    setLocalProblem(undefined);
    decide.reset();
  };

  const send = (comment: string): void => {
    if (acting === undefined || record === undefined) return;
    const problem = checkComment(acting, comment);
    if (problem !== undefined) {
      setLocalProblem(problem === 'required' ? 'commentRequired' : 'commentTooLong');
      return;
    }
    setLocalProblem(undefined);
    const decision = acting;
    decide.mutate(
      { task: record, decision, comment },
      {
        onSuccess: () => {
          setReceipt({ decision, step: record.stepName, record: recordName(record), at: new Date() });
          close();
        },
      },
    );
  };

  const serverProblem: Problem | undefined = decide.isError ? describeProblem(decide.error) : undefined;
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
          void task.refetch();
        }}
      >
        {t('pwa2.approvalDetail.remedy.reload')}
      </button>
    ) : undefined;

  const today = todayOf(new Date());
  const pending = record?.status === 'Pending';
  const may = record !== undefined && pending && mayDecide(record, readOnly) && mayDecideAtAll && receipt === undefined;

  return (
    <section className="pwa-screen" data-screen-id="PWA-05" aria-labelledby="screen-title">
      <PwaBackLink to={QUEUE_PATH} label={t('pwa2.approvalDetail.back.link')} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa2.approvalDetail.page.title')}</h1>
          <p>{t('pwa2.approvalDetail.page.subtitle')}</p>
        </div>
      </div>
      {notFound ? (
        <div className="card statecard pwa-empty" role="alert" data-testid="not-found">
          <h2>{t('pwa2.approvalDetail.notFound.title')}</h2>
          <p className="muted">{t('pwa2.approvalDetail.notFound.body')}</p>
        </div>
      ) : (
        <StateBoundary state={state} onRetry={() => void task.refetch()}>
          {record === undefined ? null : (
            <>
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
                </div>
              )}
              {pending || receipt !== undefined ? null : (
                <p className="callout warning" role="status" data-testid="not-pending">
                  {t('pwa2.approvalDetail.notPending.note', { status: taskStatusLabel(t, record.status) })}
                </p>
              )}
              {readOnly ? (
                <p className="callout" role="status" data-testid="read-only">
                  {t('pwa.approvals.readOnly.note')}
                </p>
              ) : null}
              <SectionCard
                title={t('pwa2.approvalDetail.summary.title')}
                status={record.overdue ? <StatusPill tone="danger">{t('pwa.approvals.status.late')}</StatusPill> : <StatusPill tone="neutral">{pending ? t('pwa.approvals.status.pending') : taskStatusLabel(t, record.status)}</StatusPill>}
              >
                <dl className="pwa-facts" data-testid="summary">
                  <dt>{t('pwa2.approvalDetail.field.type')}</dt>
                  <dd>{businessTypeLabel(t, record.businessType)}</dd>
                  {reportFigures === undefined ? (
                    <>
                      <dt>{t('pwa.approvals.field.record')}</dt>
                      <dd>{record.resourceType}</dd>
                    </>
                  ) : (
                    <>
                      <dt>{t('pwa2.approvalDetail.field.project')}</dt>
                      <dd data-testid="project-name">
                        {reportFigures.projectCode === '' ? '' : `${reportFigures.projectCode} · `}
                        {reportFigures.projectName}
                      </dd>
                      <dt>{t('pwa2.approvalDetail.field.period')}</dt>
                      <dd>{t('pwa2.approvalDetail.field.revision', { period: reportFigures.periodCode, revision: reportFigures.revision })}</dd>
                    </>
                  )}
                  {unitName === undefined ? null : (
                    <>
                      <dt>{t('pwa.approvals.field.unit')}</dt>
                      <dd data-testid="unit-name">{unitName}</dd>
                    </>
                  )}
                  <dt>{t('pwa.approvals.field.step')}</dt>
                  <dd>{record.stepName === '' ? '—' : record.stepName}</dd>
                  {record.amountVnd === null ? null : (
                    <>
                      <dt>{t('pwa.approvals.field.amount')}</dt>
                      <dd>
                        {money(record.amountVnd, locale)} <span className="pwa-unit">{t('pwa.approvals.unit.vnd')}</span>
                      </dd>
                    </>
                  )}
                  <dt>{t('pwa.approvals.field.due')}</dt>
                  <dd>
                    <DeadlineCountdown dueOn={todayOf(new Date(record.dueAt))} today={today} />
                  </dd>
                </dl>
              </SectionCard>
              <SectionCard title={t('pwa2.approvalDetail.plan.title')}>
                {!isReport ? <p role="status">{t('pwa2.approvalDetail.notReport.note')}</p> : report.isLoading ? <Loading label={t('states.loading.label')} /> : report.data === undefined ? <ReadFailed retry={() => void report.refetch()} /> : <PlanComparison read={report.data} locale={locale} />}
              </SectionCard>
              {reportFigures === undefined ? null : (
                <SectionCard title={t('pwa2.approvalDetail.revision.title')}>
                  {reportFigures.supersedesId !== null && previous.isLoading ? (
                    <Loading label={t('states.loading.label')} />
                  ) : reportFigures.supersedesId !== null && previous.data === undefined ? (
                    <ReadFailed retry={() => void previous.refetch()} />
                  ) : (
                    <RevisionComparison report={reportFigures} previous={previous.data} locale={locale} />
                  )}
                </SectionCard>
              )}
              {!isReport ? null : (
                <SectionCard title={t('pwa2.approvalDetail.evidence.title')}>
                  {report.isLoading ? <Loading label={t('states.loading.label')} /> : report.data === undefined ? <ReadFailed retry={() => void report.refetch()} /> : <EvidenceList read={report.data} />}
                </SectionCard>
              )}
              <SectionCard title={t('pwa2.approvalDetail.steps.title')}>
                {steps.isLoading ? <Loading label={t('states.loading.label')} /> : steps.data === undefined ? <ReadFailed retry={() => void steps.refetch()} /> : <StepHistory read={steps.data} />}
              </SectionCard>
              {may ? (
                <div className="pwa-sticky-actions" data-testid="actions">
                  <button type="button" className="ui-button ui-button--primary pwa-touch" data-action="approve" onClick={() => setActing('approve')}>
                    {t('pwa.approvals.action.approve')}
                  </button>
                  <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="return" onClick={() => setActing('return')}>
                    {t('pwa.approvals.action.return')}
                  </button>
                </div>
              ) : pending && receipt === undefined ? (
                <p className="sub" data-testid="cannot-decide">
                  {t('pwa.approvals.action.cannot')}
                </p>
              ) : null}
            </>
          )}
        </StateBoundary>
      )}
      {acting === undefined || record === undefined ? null : (
        <DecisionSheet
          title={acting === 'approve' ? t('pwa.approvals.sheet.approve.title') : t('pwa.approvals.sheet.return.title')}
          context={[
            { label: t('pwa.approvals.field.step'), value: record.stepName === '' ? '—' : record.stepName },
            { label: t('pwa.approvals.field.record'), value: recordName(record) },
            ...(record.amountVnd === null ? [] : [{ label: t('pwa.approvals.field.amount'), value: `${money(record.amountVnd, locale)} ${t('pwa.approvals.unit.vnd')}` }]),
          ]}
          commentLabel={acting === 'approve' ? t('pwa.approvals.sheet.approve.comment') : t('pwa.approvals.sheet.return.comment')}
          commentRequired={acting === 'return'}
          problem={sheetProblem}
          remedy={remedy}
          pending={decide.isPending}
          submitLabel={acting === 'approve' ? t('pwa.approvals.sheet.approve.submit') : t('pwa.approvals.sheet.return.submit')}
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

function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <span className="ui-skeleton ui-skeleton--line" />
      <span className="ui-skeleton ui-skeleton--line" />
    </div>
  );
}

function ReadFailed({ retry }: { retry: () => void }) {
  const { t } = useTranslation();
  return (
    <p role="alert">
      {t('pwa2.approvalDetail.readFailed.note')}{' '}
      <button type="button" className="ui-button ui-button--outline ui-button--small pwa-touch" onClick={retry}>
        {t('states.retry.action')}
      </button>
    </p>
  );
}
