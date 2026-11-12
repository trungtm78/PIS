import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DayStrip, ProcessTree, SectionCard, Stepper, Timeline } from '../../../ui';
import { dayText, taskLink, todayInVietnam } from '../model';
import type { Schedule, WorkflowDetail } from '../model';
import { WorkflowInfo } from './figures';
import { ganttBars, ganttMarks, ganttRange, milestoneGroups, phaseOfNode, stepperSteps, taskIdOfNode, treeNodes } from './model';

interface Common {
  detail: WorkflowDetail;
  version: string;
}

/** The phases of the workflow in order, each with how many of its required tasks are done (the open phase is the first one that still has a required task to do). */
export function PhaseStepper({ detail, version }: Common) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('pwf.flow.section.phases.title')} status={<WorkflowInfo figure="phase" asOf={detail.as_of} version={version} />}>
      <Stepper steps={stepperSteps(detail, t)} label={t('pwf.flow.stepper.label')} />
    </SectionCard>
  );
}

interface TreeProps extends Common {
  selectedPhase: string;
  onPhase: (code: string) => void;
  onTask: (taskId: string) => void;
}

/** The phases and the tasks in them as one tree with the health of each (late, needs attention, on hold, fine); a press on a task opens it, a press on a phase filters the board to it. */
export function WorkflowTree({ detail, selectedPhase, onPhase, onTask }: TreeProps) {
  const { t } = useTranslation();
  const nodes = useMemo(() => treeNodes(detail, t), [detail, t]);
  const select = (id: string): void => {
    const task = taskIdOfNode(id);
    if (task !== undefined) onTask(task);
    else {
      const phase = phaseOfNode(id);
      if (phase !== undefined) onPhase(phase === selectedPhase ? '' : phase);
    }
  };
  return (
    <SectionCard title={t('pwf.flow.section.tree.title')}>
      <p className="sub">{t('pwf.flow.tree.help.text')}</p>
      <ProcessTree
        nodes={nodes}
        edges={[]}
        selectedId={selectedPhase === '' ? undefined : `phase:${selectedPhase}`}
        onSelect={select}
        state={nodes.length === 0 ? 'empty' : 'ready'}
        caption={t('pwf.flow.tree.caption.text')}
        emptyText={t('pwf.flow.tree.empty.text')}
        storageKey="pwf-03"
        unitWord={t('pwf.flow.tree.unit.word')}
      />
    </SectionCard>
  );
}

interface GanttProps extends Common {
  schedule: Schedule | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}

/** The tasks the schedule puts on a day: those that start and those that finish on it. */
function DayTasks({ schedule, day }: { schedule: Schedule; day: string }) {
  const { t } = useTranslation();
  const starting = schedule.tasks.filter((task) => task.start === day);
  const finishing = schedule.tasks.filter((task) => task.finish === day);
  const names = (tasks: Schedule['tasks']): string => tasks.map((task) => task.task_code).join(', ');
  return (
    <p className="sub" data-testid="day-tasks" role="status">
      {t('pwf.flow.gantt.day.text', { day: dayText(day), starting: starting.length === 0 ? t('pwf.flow.gantt.dayNone.text') : names(starting), finishing: finishing.length === 0 ? t('pwf.flow.gantt.dayNone.text') : names(finishing) })}
    </p>
  );
}

/** The schedule as bars: solid is the current schedule, dashed the first baseline; the critical path is named in text under it. */
export function Gantt({ detail, version, schedule, loading, failed, onRetry }: GanttProps) {
  const { t } = useTranslation();
  const [day, setDay] = useState<string | undefined>(undefined);
  const range = schedule === undefined ? null : ganttRange(schedule);
  const marks = schedule === undefined ? { changes: [], deadlines: [] } : ganttMarks(schedule);
  const bars = schedule === undefined ? [] : ganttBars(schedule, detail.tasks, t);
  return (
    <SectionCard title={t('pwf.flow.section.gantt.title')} status={<WorkflowInfo figure="critical" asOf={schedule?.as_of ?? detail.as_of} version={version} />}>
      <p className="sub">{t('pwf.flow.gantt.help.text')}</p>
      <DayStrip
        from={range?.from ?? ''}
        to={range?.to ?? ''}
        changes={marks.changes}
        deadlines={marks.deadlines}
        today={todayInVietnam()}
        selectedDay={day}
        onSelectDay={setDay}
        bars={bars}
        state={loading ? 'loading' : failed ? 'error' : range === null ? 'empty' : 'ready'}
        onRetry={onRetry}
      />
      {schedule !== undefined && day !== undefined ? <DayTasks schedule={schedule} day={day} /> : null}
      {schedule === undefined ? null : (
        <p data-testid="critical-path">
          <strong>{t('pwf.flow.gantt.path.label')}</strong> {schedule.critical_path.length === 0 ? t('pwf.flow.gantt.pathNone.text') : schedule.critical_path.join(' → ')}
        </p>
      )}
    </SectionCard>
  );
}

/** The milestones in the order of their dates, each with its official colour in words. */
export function MilestoneTimeline({ detail, version }: Common) {
  const { t } = useTranslation();
  const groups = useMemo(() => milestoneGroups(detail, t), [detail, t]);
  return (
    <SectionCard title={t('pwf.flow.section.milestones.title')} status={<WorkflowInfo figure="bands" asOf={detail.as_of} version={version} />}>
      {groups.length === 0 ? (
        <p className="callout" role="status" data-testid="no-milestones">
          {t('pwf.flow.timeline.empty.text')}
        </p>
      ) : (
        <Timeline groups={groups} order="asc" caption={t('pwf.flow.timeline.caption.text')} today={todayInVietnam()} />
      )}
    </SectionCard>
  );
}

/** A link to the task of a gate or a card, in the one place the address is built. */
export function TaskLink({ id, projectId, children }: { id: string; projectId: string; children: string }) {
  return <Link to={taskLink(id, projectId)}>{children}</Link>;
}
