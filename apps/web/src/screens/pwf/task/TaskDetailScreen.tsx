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
import { assignmentsLink, calendarMissing, describeProblem, workflowLink } from '../model';
import type { Problem, TaskDetail } from '../model';
import { ActionsBar } from './ActionsBar';
import { ExceptionsSection } from './ExceptionsSection';
import { useTask } from './hooks';
import { HistorySection, KpiSection } from './InsightSections';
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
  return (
    <>
      {missing && task.missing_year !== null ? <CalendarMissingNote years={[task.missing_year]} /> : null}
      <TaskHeader task={task}>
        <ActionsBar task={task} actions={actions} onOpen={setDialog} onWaive={(subject) => setPrefill({ items: subject, seq: (prefill?.seq ?? 0) + 1 })} />
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
      <RequirementsSection task={task} canWork={actions.work} onTick={(itemCode, itemName) => setDialog({ kind: 'tick', itemCode, itemName })} onResult={onResult} />
      <TaskProcessSection task={task} />
      <ScheduleSection task={task} />
      <ExceptionsSection task={task} canRequest={actions.requestException} canDecide={actions.decideException} prefill={prefill} onDecide={(exception, decision) => setDialog({ kind: 'decide', exception, decision })} onResult={onResult} />
      <AssignmentLedger taskId={task.id} canAssign={actions.assign} />
      <p>
        <Link to={assignmentsLink(task.id)}>{t('pwf.task.ledger.link')}</Link>
      </p>
      <KpiSection task={task} />
      <HistorySection task={task} />
      <TaskDialogs task={task} dialog={dialog} onClose={() => setDialog(null)} onResult={onResult} />
    </>
  );
}
