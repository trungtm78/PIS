import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import type { Tone } from '../../../ui';
import { ScrollRegion } from '../../scroll-region';
import { RoleName, Named } from '../codes';
import { BandBadge, CalendarMissingCell, Meter } from '../components';
import { statusWord } from '../labels';
import { calendarMissing, dayText, hasBand, taskLink } from '../model';
import type { WorkflowDetail, WorkflowTask } from '../model';
import { stepStatusWord } from '../process/labels';
import { phaseGroups, stepIcon, stepTone } from '../process/model';
import type { PhaseGroup } from '../process/model';
import { healthOf } from './model';

interface Props {
  detail: WorkflowDetail;
  projectId: string;
  selectedPhase: string;
  onPhase: (code: string) => void;
}

const statusTone = (task: WorkflowTask): Tone => (task.status === 'DONE' ? 'success' : task.status === 'IN_PROGRESS' || task.status === 'AWAITING_APPROVAL' ? 'info' : 'neutral');
const statusIcon = (task: WorkflowTask): string => (task.status === 'DONE' ? '✓' : task.status === 'IN_PROGRESS' ? '◐' : task.status === 'AWAITING_APPROVAL' ? '…' : task.status === 'ON_HOLD' ? '⏸' : task.status === 'CANCELLED' ? '✕' : '○');

/** A workflow read from before steps existed has phases and tasks only: every task is then a loose task of its phase. */
function groupsOf(detail: WorkflowDetail): PhaseGroup[] {
  const withSteps = phaseGroups(detail);
  if (withSteps.length > 0) return withSteps;
  return [...detail.phases]
    .sort((a, b) => a.order - b.order)
    .map((phase) => ({ code: phase.code, name: phase.name, order: phase.order, requiredTotal: phase.required_total, requiredDone: phase.required_done, steps: [], loose: detail.tasks.filter((task) => task.phase_code === phase.code) }));
}

function TaskRow({ task, projectId }: { task: WorkflowTask; projectId: string }) {
  const { t } = useTranslation();
  const missing = calendarMissing(task);
  return (
    <tr className="pwf-outline__task" data-level="3" data-task={task.task_code} data-health={healthOf(task)}>
      <th scope="row">
        <span className="pwf-outline__name">
          <Link to={taskLink(task.id, projectId)}>{task.name}</Link>
          <span className="pwf-code">{task.task_code}</span>
          {task.critical ? <span className="pwf-outline__critical">{t('pwf6.flow.critical.mark')}</span> : null}
        </span>
      </th>
      <td>
        <span className="pwf-pills">
          <StatusPill tone={statusTone(task)} icon={statusIcon(task)}>
            {task.excluded ? t('pwf.process.task.excluded.word') : statusWord(t, task.status)}
          </StatusPill>
          {hasBand(task) && task.band.band !== 'NONE' ? <BandBadge band={task.band} /> : null}
        </span>
      </td>
      <td className="pwf-num">{missing ? <CalendarMissingCell year={task.missing_year} /> : task.planned_finish === null ? null : dayText(task.planned_finish)}</td>
      <td>{task.assignee === null ? <span className="pwf-hint">{t('pwf.flow.board.unassigned.text')}</span> : task.assignee.display_name}</td>
      <td>{(task.checklist_total ?? 0) > 0 ? <Meter done={task.checklist_done ?? 0} total={task.checklist_total ?? 0} label={t('pwf6.outline.checklist.label')} testId={`checklist-${task.task_code}`} /> : null}</td>
    </tr>
  );
}

/**
 * The workflow as one readable tree in a table: phase, step, task, each tier with its own progress (required tasks of a phase, tasks of a step, checklist of a task), its state, its day and who answers for it.
 * A phase opens and closes; the button of a phase filters the board below to it. It replaces the node canvas, which could not hold a workflow of thirty tasks.
 */
export function WorkflowOutline({ detail, projectId, selectedPhase, onPhase }: Props) {
  const { t } = useTranslation();
  const groups = groupsOf(detail);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (code: string): void => {
    const next = new Set(closed);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setClosed(next);
  };
  const allClosed = groups.length > 0 && groups.every((group) => closed.has(group.code));
  return (
    <SectionCard
      title={t('pwf.flow.section.tree.title')}
      actions={
        groups.length === 0 ? undefined : (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="outline-toggle-all" onClick={() => setClosed(allClosed ? new Set() : new Set(groups.map((group) => group.code)))}>
            {allClosed ? t('pwf6.outline.expandAll.action') : t('pwf6.outline.collapseAll.action')}
          </button>
        )
      }
    >
      {groups.length === 0 ? (
        <p className="callout" role="status" data-testid="outline-empty">
          {t('pwf.flow.tree.empty.text')}
        </p>
      ) : (
        <div className="pwf-free" data-testid="outline">
          <ScrollRegion label={t('pwf.flow.tree.caption.text')}>
            <table className="pwf-outline">
              <caption className="sr-only">{t('pwf.flow.tree.caption.text')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('pwf6.outline.col.item')}</th>
                  <th scope="col">{t('pwf6.outline.col.state')}</th>
                  <th scope="col">{t('pwf6.outline.col.due')}</th>
                  <th scope="col">{t('pwf6.outline.col.owner')}</th>
                  <th scope="col">{t('pwf6.outline.col.progress')}</th>
                </tr>
              </thead>
              {groups.map((phase) => {
                const tasks = [...phase.steps.flatMap((group) => group.tasks), ...phase.loose].filter((task) => !task.excluded);
                const late = tasks.filter((task) => healthOf(task) === 'late').length;
                const open = !closed.has(phase.code);
                const selected = selectedPhase === phase.code;
                return (
                  <tbody key={phase.code} data-phase={phase.code}>
                    <tr className="pwf-outline__phase" data-level="1" data-node-id={`phase:${phase.code}`}>
                      <th scope="row">
                        <button type="button" className="pwf-outline__toggle" aria-expanded={open} onClick={() => toggle(phase.code)}>
                          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {phase.order}. {phase.name}
                        </button>
                      </th>
                      <td>
                        {late > 0 ? (
                          <StatusPill tone="danger" icon="⛔">
                            {t('pwf6.outline.late.text', { count: late })}
                          </StatusPill>
                        ) : phase.requiredTotal > 0 && phase.requiredDone >= phase.requiredTotal ? (
                          <StatusPill tone="success" icon="✓">
                            {t('pwf6.outline.phaseDone.word')}
                          </StatusPill>
                        ) : null}
                      </td>
                      <td className="pwf-num">{t('pwf6.outline.count.text', { count: tasks.length })}</td>
                      <td>
                        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={selected} data-action={`filter-phase-${phase.code}`} onClick={() => onPhase(selected ? '' : phase.code)}>
                          {selected ? t('pwf6.outline.unfilter.action') : t('pwf6.outline.filter.action')}
                        </button>
                      </td>
                      <td>
                        <Meter done={phase.requiredDone} total={phase.requiredTotal} label={t('pwf.process.progress.required.label')} />
                      </td>
                    </tr>
                    {open
                      ? phase.steps.map(({ step, tasks: own }) => [
                          <tr key={step.code} className="pwf-outline__step" data-level="2" data-step={step.code}>
                            <th scope="row">
                              <span className="pwf-outline__name">
                                {phase.order}.{step.order} {step.name}
                              </span>
                            </th>
                            <td>
                              <StatusPill tone={stepTone(step.status)} icon={stepIcon(step.status)}>
                                {stepStatusWord(t, step.status)}
                              </StatusPill>
                            </td>
                            <td className="pwf-num">{step.planned_finish === null ? null : dayText(step.planned_finish)}</td>
                            <td>{step.responsible_role === null ? null : <RoleName code={step.responsible_role} />}</td>
                            <td>
                              <Meter done={step.task_done} total={step.task_total} label={t('pwf.process.progress.tasks.label')} />
                            </td>
                          </tr>,
                          ...own.map((task) => <TaskRow key={task.id} task={task} projectId={projectId} />),
                        ])
                      : null}
                    {open && phase.loose.length > 0 && phase.steps.length > 0 ? (
                      <tr className="pwf-outline__step" data-level="2">
                        <th scope="row" colSpan={5}>
                          <Named name={t('pwf.process.steps.loose.text')} />
                        </th>
                      </tr>
                    ) : null}
                    {open ? phase.loose.map((task) => <TaskRow key={task.id} task={task} projectId={projectId} />) : null}
                  </tbody>
                );
              })}
            </table>
          </ScrollRegion>
        </div>
      )}
    </SectionCard>
  );
}
