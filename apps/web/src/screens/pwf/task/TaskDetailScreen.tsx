import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { Tabs, useTabParam } from '../../../ui';
import { useScreenState } from '../../../states/useScreenState';
import { AssignmentLedger } from '../assignments/AssignmentLedger';
import { CalendarMissingNote, ProblemBanner } from '../components';
import { useReloadPwf } from '../hooks';
import { assignmentsLink, calendarMissing, describeProblem, workflowLink } from '../model';
import type { Problem, TaskDetail } from '../model';
import { ActionsBar } from './ActionsBar';
import { ExceptionsSection } from './ExceptionsSection';
import { useTask } from './hooks';
import { HistorySection, KpiDenied, KpiSection } from './InsightSections';
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

/** The tabs of a task, in the address as `?view=`: what to do, the legal basis, the schedule with the assignments, the exceptions, the history and the KPI. */
export const TASK_VIEWS = ['todo', 'legal', 'schedule', 'exceptions', 'history', 'kpi'] as const;

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
          {task.data === undefined ? null : <TaskBody task={task.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pwf.task.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function TaskBody({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const { mode } = useSession();
  const reload = useReloadPwf();
  const [dialog, setDialog] = useState<TaskDialog | null>(null);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [prefill, setPrefill] = useState<{ items: string; seq: number } | undefined>(undefined);
  const actions = actionsOf(task, mode === 'READ_ONLY');
  const onResult = (error?: unknown): void => setProblem(error === undefined ? undefined : describeProblem(error));
  const missing = calendarMissing(task);
  const [view, setView] = useTabParam('view', TASK_VIEWS);
  const open = task.checklist.filter((item) => !item.done).length;
  const waiting = task.exceptions.filter((item) => item.status === 'REQUESTED').length;
  return (
    <>
      {missing && task.missing_year !== null ? <CalendarMissingNote years={[task.missing_year]} /> : null}
      <TaskHeader task={task}>
        <ActionsBar task={task} actions={actions} onOpen={setDialog} onWaive={(subject) => {
            setPrefill({ items: subject, seq: (prefill?.seq ?? 0) + 1 });
            setView('exceptions');
          }}
        />
      </TaskHeader>
      {problem === undefined ? null : (
        <ProblemBanner
          problem={problem}
          onReload={() => {
            setProblem(undefined);
            void reload();
          }}
        />
      )}
      <Tabs
        label={t('pwf6.task.tabs.label')}
        testId="task"
        value={view}
        onChange={setView}
        tabs={[
          { id: 'todo', label: t('pwf6.task.tab.todo'), count: open === 0 ? undefined : open, panel: <RequirementsSection task={task} canWork={actions.work} onTick={(itemCode, itemName) => setDialog({ kind: 'tick', itemCode, itemName })} onResult={onResult} /> },
          {
            id: 'legal',
            label: t('pwf6.task.tab.legal'),
            panel:
              task.step === undefined && task.legal_basis === undefined ? (
                <p className="pwf-hint" role="status" data-testid="task-legal-absent">
                  {t('pwf.process.legal.none.text')}
                </p>
              ) : (
                <TaskProcessSection task={task} />
              ),
          },
          {
            id: 'schedule',
            label: t('pwf6.task.tab.schedule'),
            panel: (
              <>
                <ScheduleSection task={task} open />
                <AssignmentLedger taskId={task.id} canAssign={actions.assign} />
                <p>
                  <Link to={assignmentsLink(task.id)}>{t('pwf.task.ledger.link')}</Link>
                </p>
              </>
            ),
          },
          {
            id: 'exceptions',
            label: t('pwf6.task.tab.exceptions'),
            count: waiting === 0 ? undefined : waiting,
            panel: <ExceptionsSection task={task} canRequest={actions.requestException} canDecide={actions.decideException} prefill={prefill} onDecide={(exception, decision) => setDialog({ kind: 'decide', exception, decision })} onResult={onResult} />,
          },
          { id: 'history', label: t('pwf6.task.tab.history'), panel: <HistorySection task={task} open /> },
          // The tab is always there: a person who may not see the KPI of the task is told the scope is hidden (design.md, the state "denied"), never left to think the task has no KPI.
          { id: 'kpi', label: t('pwf6.task.tab.kpi'), panel: task.kpi_results === undefined ? <KpiDenied /> : <KpiSection task={task} /> },
        ]}
      />
      <TaskDialogs task={task} dialog={dialog} onClose={() => setDialog(null)} onResult={onResult} />
    </>
  );
}
