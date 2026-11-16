import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { ScrollRegion } from '../../scroll-region';
import { TaskName } from '../codes';
import { ProblemBanner } from '../components';
import { useReloadPwf } from '../hooks';
import { statusWord } from '../labels';
import { describeProblem, taskLink } from '../model';
import type { Problem, Schedule, WorkflowDetail, WorkflowTask } from '../model';
import { LegalBasisList } from '../process/LegalBasisList';
import { stepStatusWord } from '../process/labels';
import { stepIcon, stepTone } from '../process/model';
import type { WorkflowStep } from '../process/model';
import { statusTone } from '../task/model';
import { BlockedByCell, DeadlineCell, RemainingCell, UnitHolderCell } from '../task-cells';
import { healthOf } from './model';
import { RowActions } from './RowActions';
import { blockedByOf, phaseRows, stepDue, worstBandTask } from './step-table-model';
import type { Capabilities, StepEntry } from './step-table-model';
import './step-table.css';

const statusIcon = (task: WorkflowTask): string => (task.status === 'DONE' ? '✓' : task.status === 'IN_PROGRESS' ? '◐' : task.status === 'AWAITING_APPROVAL' ? '…' : task.status === 'ON_HOLD' ? '⏸' : task.status === 'CANCELLED' ? '✕' : '○');

interface Props {
  detail: WorkflowDetail;
  projectId: string;
  schedule: Schedule | undefined;
  can: Capabilities;
}

interface RowProps {
  task: WorkflowTask;
  /** The step the row stands for (a step with one task is this row); null for a child row and for a task of no step. */
  step: WorkflowStep | null;
  number: string;
  child: boolean;
  projectId: string;
  can: Capabilities;
  tasks: ReadonlyMap<string, WorkflowTask>;
  schedule: Schedule | undefined;
  asOf: string;
  onResult: (error?: unknown) => void;
}

/** A row of one task: the step itself when it has one task, a child row when the step has several. Every cell is the server's reading of the task; nothing is counted here. */
function TaskRow({ task, step, number, child, projectId, can, tasks, schedule, asOf, onResult }: RowProps) {
  const { t } = useTranslation();
  return (
    <tr className="pwfp-row" data-level={child ? '3' : '2'} data-task={task.task_code} data-health={healthOf(task)} data-unclaimed={task.unclaimed === true ? 'true' : undefined}>
      <td className="pwfp-num" data-label={t('pwfp.table.col.number')}>
        {number}
      </td>
      <th scope="row" className="pwfp-name">
        <span className="pwf-outline__name">
          <TaskName name={task.name} code={task.task_code}>
            <Link to={taskLink(task.id, projectId)}>{task.name}</Link>
          </TaskName>
          {task.critical ? <span className="pwf-outline__critical">{t('pwf6.flow.critical.mark')}</span> : null}
        </span>
        <StepLegal step={step} />
      </th>
      <td data-label={t('pwfp.table.col.owner')}>
        <UnitHolderCell task={task} />
      </td>
      <td data-label={t('pwfp.table.col.due')}>
        <DeadlineCell task={task} />
      </td>
      <td data-label={t('pwfp.table.col.remaining')}>
        <RemainingCell task={task} asOf={asOf} />
      </td>
      <td data-label={t('pwfp.table.col.state')}>
        <StatusPill tone={statusTone(task.status)} icon={statusIcon(task)}>
          {task.excluded ? t('pwf.process.task.excluded.word') : statusWord(t, task.status)}
        </StatusPill>
      </td>
      <td data-label={t('pwfp.table.col.blocked')}>
        <BlockedByCell blocks={blockedByOf(task, tasks, schedule)} />
      </td>
      <td className="pwfp-action" data-label={t('pwfp.table.col.action')}>
        <RowActions task={task} projectId={projectId} can={can} onResult={onResult} />
      </td>
    </tr>
  );
}

/** The legal grounds of a step, one click away under its name (R45): a ground that lapsed is announced at the top of the page and named here. */
function StepLegal({ step }: { step: WorkflowStep | null }) {
  const { t } = useTranslation();
  if (step === null || step.legal_basis.length === 0) return null;
  return (
    <details className="pwfp-legal">
      <summary>{t('pwf.process.step.legal.summary', { count: step.legal_basis.length })}</summary>
      <LegalBasisList basis={step.legal_basis} of={step.name} testId={`step-legal-${step.code}`} />
    </details>
  );
}

interface StepRowProps {
  entry: StepEntry;
  open: boolean;
  onToggle: () => void;
  asOf: string;
}

/** The row of a step with several tasks: its name and how many of its tasks are done, who it is for, when it is due and the worst official colour of its tasks; the tasks are the child rows under it. */
function StepSummaryRow({ entry, open, onToggle, asOf }: StepRowProps) {
  const { t } = useTranslation();
  const step = entry.step;
  const worst = worstBandTask(entry.tasks);
  const done = entry.tasks.filter((task) => task.status === 'DONE').length;
  const lead = entry.tasks.map((task) => task.receiving_unit_name ?? null).find((name) => name !== null) ?? null;
  const due = stepDue(entry);
  return (
    <tr className="pwfp-row pwfp-row--step" data-level="2" data-step={step?.code} data-health={worst === null ? 'none' : healthOf(worst)}>
      <td className="pwfp-num" data-label={t('pwfp.table.col.number')}>
        {entry.number}
      </td>
      <th scope="row" className="pwfp-name">
        <button type="button" className="pwf-outline__toggle" aria-expanded={open} aria-label={t('pwfp.table.step.toggle.aria', { name: step?.name ?? '' })} onClick={onToggle}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {step?.name}
        </button>
        <span className="pwf-hint pwfp-name__meta">{t('pwfp.table.step.tasks.text', { done, total: entry.tasks.length })}</span>
        <StepLegal step={step} />
      </th>
      <td data-label={t('pwfp.table.col.owner')}>{lead === null ? null : <span className="pwfp-unit__name">{lead}</span>}</td>
      <td data-label={t('pwfp.table.col.due')}>
        <DeadlineCell task={{ status: 'NOT_STARTED', state: 'SCHEDULED', missing_year: null, planned_finish: due }} />
      </td>
      <td data-label={t('pwfp.table.col.remaining')}>{worst === null ? null : <RemainingCell task={worst} asOf={asOf} />}</td>
      <td data-label={t('pwfp.table.col.state')}>
        {step === null ? null : (
          <StatusPill tone={stepTone(step.status)} icon={stepIcon(step.status)}>
            {stepStatusWord(t, step.status)}
          </StatusPill>
        )}
      </td>
      <td />
      <td />
    </tr>
  );
}

/**
 * PWF-03, view "Bảng bước": the phases as band rows and, under each, its steps one to a row with who it is for and who holds it, the committed deadline, how long is left in the official colour, its state, what blocks it and the one
 * action the person may take on the row. A step with several tasks opens into child rows. It reads the one response of the workflow (and the schedule for the task a step waits on): no request per row.
 */
export function StepTable({ detail, projectId, schedule, can }: Props) {
  const { t } = useTranslation();
  const reload = useReloadPwf();
  const phases = phaseRows(detail);
  const tasks = new Map(detail.tasks.map((task) => [task.task_code, task]));
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  // A step in progress opens by itself; a person's own choice flips that for the step.
  const isOpen = (entry: StepEntry): boolean => (entry.step?.status === 'IN_PROGRESS') !== toggled.has(entry.key);
  const flip = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const onResult = (error?: unknown): void => {
    if (error === undefined) {
      setProblem(undefined);
      return;
    }
    const found = describeProblem(error);
    setProblem(found);
    // Somebody took it first: the table is read again so that it shows who holds it.
    if (found.kind === 'alreadyClaimed') void reload();
  };
  const total = phases.reduce((sum, phase) => sum + phase.entries.length, 0);
  return (
    <SectionCard title={t('pwfp.table.title')}>
      {problem === undefined ? null : (
        <ProblemBanner
          problem={problem}
          onReload={() => {
            setProblem(undefined);
            void reload();
          }}
        />
      )}
      {total === 0 ? (
        <p className="callout" role="status" data-testid="steps-empty">
          {t('pwf.flow.tree.empty.text')}
        </p>
      ) : (
        <div className="pwf-free pwfp-table-wrap" data-testid="step-table">
          <ScrollRegion label={t('pwfp.table.caption.text')}>
            <table className="pwfp-table">
              <caption className="ui-sr-only">{t('pwfp.table.caption.text')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('pwfp.table.col.number')}</th>
                  <th scope="col">{t('pwfp.table.col.step')}</th>
                  <th scope="col">{t('pwfp.table.col.owner')}</th>
                  <th scope="col">{t('pwfp.table.col.due')}</th>
                  <th scope="col">{t('pwfp.table.col.remaining')}</th>
                  <th scope="col">{t('pwfp.table.col.state')}</th>
                  <th scope="col">{t('pwfp.table.col.blocked')}</th>
                  <th scope="col">{t('pwfp.table.col.action')}</th>
                </tr>
              </thead>
              {phases.map((phase) => {
                const shut = closed.has(phase.code);
                return (
                  <tbody key={phase.code} data-phase={phase.code}>
                    <tr className="pwfp-phase" data-level="1" data-current={phase.current}>
                      <th scope="rowgroup" colSpan={8}>
                        <button type="button" className="pwf-outline__toggle" aria-expanded={!shut} onClick={() => setClosed(flip(closed, phase.code))}>
                          <span aria-hidden="true">{shut ? '▸' : '▾'}</span> {t('pwfp.table.phase.text', { order: phase.order, name: phase.name })}
                        </button>
                        <span className="pwf-hint pwfp-phase__meta">{phase.requiredTotal === 0 ? t('pwfp.table.phase.noRequired.text') : t('pwfp.table.phase.done.text', { done: phase.requiredDone, total: phase.requiredTotal })}</span>
                        {phase.current ? (
                          <StatusPill tone="info" icon="◐">
                            {t('pwfp.table.phase.current.word')}
                          </StatusPill>
                        ) : null}
                      </th>
                    </tr>
                    {shut
                      ? null
                      : phase.entries.flatMap((entry) => {
                          const rowProps = { projectId, can, tasks, schedule, asOf: detail.as_of, onResult };
                          const only = entry.tasks[0];
                          if (entry.tasks.length === 1 && only !== undefined) return [<TaskRow key={entry.key} task={only} step={entry.step} number={entry.number} child={false} {...rowProps} />];
                          const open = isOpen(entry);
                          return [
                            <StepSummaryRow key={entry.key} entry={entry} open={open} onToggle={() => setToggled(flip(toggled, entry.key))} asOf={detail.as_of} />,
                            ...(open ? entry.tasks.map((task, index) => <TaskRow key={task.id} task={task} step={null} number={`${entry.number}.${index + 1}`} child {...rowProps} />) : []),
                          ];
                        })}
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
