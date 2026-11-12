import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard } from '../../../ui';
import { PERMISSIONS, holds, startLink, taskLink } from '../model';
import type { WorkflowDetail } from '../model';
import { Board } from './Board';
import { GatesPanel } from './Gates';
import { useGates, useSchedule, useTaskPages, useWorkflow } from './hooks';
import { NO_FILTER, calendarYears, gateRows, isStale } from './model';
import type { TaskFilter } from './model';
import { Overview } from './Overview';
import { Gantt, MilestoneTimeline, PhaseStepper, WorkflowTree } from './Views';
import './workflow.css';

/** The project has no workflow yet: the screen says so and, for a person who may start or adopt one, links to the form that does. */
function NoWorkflow({ projectId, canStart }: { projectId: string; canStart: boolean }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('pwf.flow.empty.title')}>
      <p data-testid="no-workflow">{t('pwf.flow.empty.body')}</p>
      {canStart ? (
        <p>
          <Link className="ui-button" to={startLink(projectId)} data-testid="start-link">
            {t('pwf.flow.empty.start.action')}
          </Link>
        </p>
      ) : null}
    </SectionCard>
  );
}

interface LoadedProps {
  detail: WorkflowDetail;
  projectId: string;
  readAt: number;
  refetchFailed: boolean;
  frozen: boolean;
  onReload: () => void;
}

function Loaded({ detail, projectId, readAt, refetchFailed, frozen, onReload }: LoadedProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<TaskFilter>(NO_FILTER);
  const schedule = useSchedule(projectId, true);
  const pages = useTaskPages(projectId, filter, true);
  const targets = useMemo(() => [...new Set(detail.gates.map((gate) => gate.target))], [detail.gates]);
  const gates = useGates(projectId, targets);
  const rows = gateRows(
    detail,
    gates.map((gate) => ({ data: gate.data, failed: gate.isError })),
    t,
  );
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
  const total = pages.data?.pages[pages.data.pages.length - 1]?.total;
  const partial = schedule.isError || pages.isError || gates.some((gate) => gate.isError);
  const stale = refetchFailed || isStale(detail.as_of, readAt);
  const version = t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version });
  const retryAll = (): void => {
    if (schedule.isError) void schedule.refetch();
    if (pages.isError) void pages.refetch();
    for (const gate of gates) if (gate.isError) void gate.refetch();
  };
  const canReschedule = detail.can_propose_reschedule && !frozen;
  return (
    <div data-testid="workflow">
      {partial ? (
        <p className="callout warning pwf-notice" role="alert" data-testid="partial">
          {t('pwf.flow.partial.text')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={retryAll}>
            {t('ui.common.retry')}
          </button>
        </p>
      ) : null}
      {stale ? (
        <p className="callout warning pwf-notice" role="status" data-testid="stale">
          {t('pwf.flow.stale.text', { time: detail.as_of.slice(11, 16) })}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onReload}>
            {t('ui.common.retry')}
          </button>
        </p>
      ) : null}
      <Overview detail={detail} schedule={schedule.data} years={calendarYears(detail, schedule.data)} stale={stale} canReschedule={canReschedule} />
      <PhaseStepper detail={detail} version={version} />
      <WorkflowTree detail={detail} version={version} selectedPhase={filter.phase} onPhase={(phase) => setFilter({ ...filter, phase })} onTask={(id) => navigate(taskLink(id, projectId))} />
      <Gantt detail={detail} version={version} schedule={schedule.data} loading={schedule.isLoading} failed={schedule.isError} onRetry={() => void schedule.refetch()} />
      <MilestoneTimeline detail={detail} version={version} />
      <Board
        detail={detail}
        projectId={projectId}
        items={items}
        total={total}
        loading={pages.isLoading}
        failed={pages.isError}
        hasMore={pages.hasNextPage}
        loadingMore={pages.isFetchingNextPage}
        filter={filter}
        onFilter={setFilter}
        onMore={() => void pages.fetchNextPage()}
        onRetry={() => void pages.refetch()}
      />
      <GatesPanel detail={detail} rows={rows} />
    </div>
  );
}

/** The workflow of one project: its head, phases, tree, schedule, milestones, board and gates. Shared by the tab of PRJ-03 and by the screen PWF-03. */
export function WorkflowBody({ projectId }: { projectId: string }) {
  const { permissions, mode } = useSession();
  const workflow = useWorkflow(projectId);
  const state = useScreenState({ isLoading: workflow.isLoading, error: workflow.data === undefined ? workflow.error : undefined, data: workflow.data, isEmpty: () => false });
  const frozen = mode === 'READ_ONLY';
  const canStart = !frozen && (holds(permissions, PERMISSIONS.workflowManage) || holds(permissions, PERMISSIONS.workflowAdopt));
  return (
    <StateBoundary state={state} onRetry={() => void workflow.refetch()}>
      {workflow.data === undefined ? null : workflow.data === null ? (
        <NoWorkflow projectId={projectId} canStart={canStart} />
      ) : (
        <Loaded detail={workflow.data} projectId={projectId} readAt={workflow.dataUpdatedAt} refetchFailed={workflow.isError} frozen={frozen} onReload={() => void workflow.refetch()} />
      )}
    </StateBoundary>
  );
}
