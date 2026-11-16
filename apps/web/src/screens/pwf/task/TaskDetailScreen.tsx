import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { AssignmentLedger } from '../assignments/AssignmentLedger';
import { CalendarMissingNote, ProblemBanner } from '../components';
import { useReloadPwf } from '../hooks';
import { PERMISSIONS, assignmentsLink, calendarMissing, describeProblem, holds, workflowLink } from '../model';
import type { Problem, TaskDetail } from '../model';
import { ActionsBar } from './ActionsBar';
import { ExceptionsSection } from './ExceptionsSection';
import { FoldBlock } from './FoldBlock';
import { useClaimTask, useTask } from './hooks';
import { HistorySection, KpiPanel } from './InsightSections';
import { actionsOf } from './model';
import { RequirementsSection } from './RequirementsSection';
import { ScheduleSection } from './ScheduleSection';
import { TaskDialogs } from './TaskDialogs';
import type { TaskDialog } from './TaskDialogs';
import { TaskProcessSection } from '../process/TaskProcessSection';
import { TaskHeader } from './TaskHeader';
import '../pwf.css';
import './task.css';

const NEVER_EMPTY = (): boolean => false;

/** PWF-04: one task of a project workflow (`?id=` is the task, `?project=` the project it belongs to, for the way back). */
export default function TaskDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <TaskDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TaskDetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const taskId = params.get('id');
  const projectId = params.get('project');
  const task = useTask(taskId);
  const state = useScreenState({ isLoading: task.isLoading, error: task.error, data: task.data, isEmpty: NEVER_EMPTY });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {projectId === null ? null : (
        <p className="prj-back-link">
          <Link to={workflowLink(projectId)}>{t('pwf.task.back.link')}</Link>
        </p>
      )}
      {taskId === null ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{t('pwf.task.screen.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-task">
            {t('pwf.task.noTask.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void task.refetch()}>
          {task.data === undefined ? null : <TaskBody task={task.data} projectId={projectId} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pwf.task.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function TaskBody({ task, projectId }: { task: TaskDetail; projectId: string | null }) {
  const { t } = useTranslation();
  const { mode, permissions } = useSession();
  const reload = useReloadPwf();
  const claim = useClaimTask();
  const [dialog, setDialog] = useState<TaskDialog | null>(null);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [prefill, setPrefill] = useState<{ items: string; seq: number } | undefined>(undefined);
  // The blocks that are closed until asked for; a waiver started from the completion check opens the exceptions.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string, open: boolean): void => {
    const next = new Set(opened);
    if (open) next.add(id);
    else next.delete(id);
    setOpened(next);
  };
  const readOnly = mode === 'READ_ONLY';
  const actions = actionsOf(task, readOnly);
  const onResult = (error?: unknown): void => setProblem(error === undefined ? undefined : describeProblem(error));
  const missing = calendarMissing(task);
  const open = task.checklist.filter((item) => !item.done).length;
  const waiting = task.exceptions.filter((item) => item.status === 'REQUESTED').length;
  const onClaim = (): void =>
    claim.mutate(
      { id: task.id },
      {
        onSuccess: () => onResult(),
        onError: (error) => {
          const found = describeProblem(error);
          onResult(error);
          // Somebody took it first: the page is read again so that it shows who holds it.
          if (found.kind === 'alreadyClaimed') void reload();
        },
      },
    );
  return (
    <>
      {missing && task.missing_year !== null ? <CalendarMissingNote years={[task.missing_year]} /> : null}
      <TaskHeader task={task} />
      {problem === undefined ? null : (
        <ProblemBanner
          problem={problem}
          onReload={() => {
            setProblem(undefined);
            void reload();
          }}
        />
      )}
      <section className="pwft-todo" aria-labelledby="todo-title" data-testid="task-todo">
        <h2 id="todo-title" className="pwft-todo__title">
          {t('pwft.todo.title')}
          {open === 0 ? null : <span className="ui-tabs__count">{open}</span>}
        </h2>
        <RequirementsSection task={task} canWork={actions.work} onTick={(itemCode, itemName) => setDialog({ kind: 'tick', itemCode, itemName })} onResult={onResult} />
      </section>
      <FoldBlock id="schedule" title={t('pwft.block.schedule.title')} note={task.finish_variance_days !== null && task.finish_variance_days > 0 ? <span className="pwf-late">{t('pwf6.task.variance.late', { days: task.finish_variance_days })}</span> : undefined} open={opened.has('schedule')} onToggle={(value) => toggle('schedule', value)}>
        <ScheduleSection task={task} />
        <AssignmentLedger taskId={task.id} canAssign={actions.assign} />
        <p>
          <Link to={assignmentsLink(task.id)}>{t('pwf.task.ledger.link')}</Link>
        </p>
      </FoldBlock>
      <FoldBlock id="legal" title={t('pwft.block.legal.title')} open={opened.has('legal')} onToggle={(value) => toggle('legal', value)}>
        {task.step === undefined && task.legal_basis === undefined ? (
          <p className="pwf-hint" role="status" data-testid="task-legal-absent">
            {t('pwf.process.legal.none.text')}
          </p>
        ) : (
          <TaskProcessSection task={task} />
        )}
      </FoldBlock>
      <FoldBlock id="exceptions" title={t('pwft.block.exceptions.title')} note={waiting === 0 ? undefined : t('pwft.block.exceptions.waiting.text', { count: waiting })} open={opened.has('exceptions') || prefill !== undefined} onToggle={(value) => toggle('exceptions', value)}>
        <ExceptionsSection task={task} canRequest={actions.requestException} canDecide={actions.decideException} prefill={prefill} onDecide={(exception, decision) => setDialog({ kind: 'decide', exception, decision })} onResult={onResult} />
      </FoldBlock>
      <FoldBlock id="history" title={t('pwft.block.history.title')} note={<span className="pwf-hint">{t('pwf6.task.history.count', { count: task.history.length })}</span>} open={opened.has('history')} onToggle={(value) => toggle('history', value)}>
        <HistorySection task={task} />
      </FoldBlock>
      {/* The block is always there: a person who may not see the KPI of the task is told the scope is hidden (design.md, the state "denied"), never left to think the task has no KPI. The results are read when it is opened. */}
      <FoldBlock id="kpi" title={t('pwft.block.kpi.title')} open={opened.has('kpi')} onToggle={(value) => toggle('kpi', value)}>
        <KpiPanel taskId={task.id} active={opened.has('kpi')} />
      </FoldBlock>
      <ActionsBar
        task={task}
        actions={actions}
        onOpen={setDialog}
        onWaive={(subject) => {
          setPrefill({ items: subject, seq: (prefill?.seq ?? 0) + 1 });
          toggle('exceptions', true);
        }}
        onClaim={onClaim}
        claiming={claim.isPending}
        projectId={projectId}
        canPropose={holds(permissions, PERMISSIONS.schedulePropose, readOnly)}
      />
      <TaskDialogs task={task} dialog={dialog} onClose={() => setDialog(null)} onResult={onResult} />
    </>
  );
}
