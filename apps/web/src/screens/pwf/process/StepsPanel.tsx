import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { RoleName, versionText } from '../codes';
import { BandBadge } from '../components';
import { statusWord } from '../labels';
import { dayText, hasBand, taskLink } from '../model';
import type { WorkflowDetail, WorkflowTask } from '../model';
import { LegalBasisList } from './LegalBasisList';
import { selectionModeWord, stepStatusWord } from './labels';
import { attentionCount, percentOf, phaseGroups, stepIcon, stepTone } from './model';
import type { StepGroup } from './model';
import './process.css';

function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const { t } = useTranslation();
  const percent = percentOf(done, total);
  if (percent === null) return <span className="pwf-hint">{t('pwf.process.progress.none.text', { label })}</span>;
  return (
    <span className="pwf-progress">
      <progress value={done} max={total} aria-label={t('pwf.process.progress.aria.label', { label, done, total })} />
      <span>{t('pwf.process.progress.value.text', { label, done, total, percent })}</span>
    </span>
  );
}

function TaskLine({ task, projectId }: { task: WorkflowTask; projectId: string }) {
  const { t } = useTranslation();
  return (
    <li className="pwf-taskline" data-task={task.task_code}>
      <span className="pwf-taskline__name">
        <Link to={taskLink(task.id, projectId)}>{task.name}</Link>
        <span className="pwf-code">{task.task_code}</span>
      </span>
      <span className="pwf-pills">
        <StatusPill tone={task.status === 'DONE' ? 'success' : 'neutral'} icon={task.status === 'DONE' ? '✓' : '○'}>
          {task.excluded ? t('pwf.process.task.excluded.word') : statusWord(t, task.status)}
        </StatusPill>
        {hasBand(task) && task.band.band !== 'NONE' ? <BandBadge band={task.band} /> : null}
        {(task.checklist_total ?? 0) > 0 ? (
          <span className="pwf-hint" data-testid={`checklist-${task.task_code}`}>
            {t('pwf.process.task.checklist.text', { done: task.checklist_done ?? 0, total: task.checklist_total ?? 0 })}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function Step({ group, projectId }: { group: StepGroup; projectId: string }) {
  const { t } = useTranslation();
  const { step, tasks } = group;
  return (
    <li className="pwf-step" data-step={step.code} data-status={step.status}>
      <div className="pwf-step__head">
        <h4>
          {step.order}. {step.name}
        </h4>
        <StatusPill tone={stepTone(step.status)} icon={stepIcon(step.status)}>
          {stepStatusWord(t, step.status)}
        </StatusPill>
        {step.implicit ? <span className="pwf-hint">{t('pwf.process.step.implicit.text')}</span> : null}
      </div>
      <dl className="pwf-facts">
        <dt>{t('pwf.process.step.time.label')}</dt>
        <dd data-testid={`step-time-${step.code}`}>
          {t('pwf.process.step.time.text', { days: step.standard_working_days })}
          {step.planned_start === null ? null : ` · ${t('pwf.process.step.window.text', { from: dayText(step.planned_start), to: dayText(step.planned_finish) })}`}
        </dd>
        {step.responsible_role === null ? null : (
          <>
            <dt>{t('pwf.process.step.owner.label')}</dt>
            <dd>
              <RoleName code={step.responsible_role} />
            </dd>
          </>
        )}
        <dt>{t('pwf.process.step.progress.label')}</dt>
        <dd>
          <Progress done={step.task_done} total={step.task_total} label={t('pwf.process.progress.tasks.label')} /> <Progress done={step.checklist_done} total={step.checklist_total} label={t('pwf.process.progress.checklist.label')} />
        </dd>
      </dl>
      <details className="pwf-step__legal">
        <summary>{t('pwf.process.step.legal.summary', { count: step.legal_basis.length })}</summary>
        <LegalBasisList basis={step.legal_basis} of={step.name} testId={`step-legal-${step.code}`} />
      </details>
      {tasks.length === 0 ? (
        <p className="pwf-hint">{t('pwf.process.step.noTasks.text')}</p>
      ) : (
        <ul className="pwf-list" aria-label={t('pwf.process.step.tasks.label', { step: step.name })}>
          {tasks.map((task) => (
            <TaskLine key={task.id} task={task} projectId={projectId} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The workflow as the procedure reads (R44): phase, step, task, checklist, each tier with its own progress; the standard time of a step is what the schedule of its tasks gives; the legal grounds of each step are one click away and a
 * ground that lapsed is announced at the top. A workflow read from before steps existed has none: the panel is then not shown and the older views of the screen stand as they were.
 */
export function StepsPanel({ detail, projectId }: { detail: WorkflowDetail; projectId: string }) {
  const { t } = useTranslation();
  const groups = phaseGroups(detail);
  if (groups.length === 0) return null;
  const attention = attentionCount(detail);
  const selection = detail.selection ?? null;
  return (
    <SectionCard title={t('pwf6.steps.section.title')}>
      <div data-testid="steps-panel">
        <p className="pwf-hint" data-testid="steps-summary">
          {t('pwf.process.steps.summary.text', { phases: groups.length, steps: (detail.steps ?? []).length, days: detail.standard_working_days ?? 0 })}
          {selection === null ? null : ` ${t('pwf6.steps.selection.text', { mode: selectionModeWord(t, selection.mode), version: versionText(t, selection.rule_version) })}`}
        </p>
        {selection !== null && selection.mode === 'OVERRIDE' ? (
          <p className="callout pwf-notice" role="status" data-testid="steps-override">
            {t('pwf.process.steps.override.text', { suggested: selection.suggested_template_code ?? '', reason: selection.reason ?? t('pwf.process.steps.override.noReason') })}
          </p>
        ) : null}
        {attention > 0 ? (
          <p className="callout warning pwf-notice" role="alert" data-testid="steps-lapsed">
            {t('pwf.process.steps.lapsed.text', { count: attention })}
          </p>
        ) : null}
        <ol className="pwf-phases">
          {groups.map((phase) => (
            <li key={phase.code} data-phase={phase.code}>
              <details className="pwf-phase" open={groups.length === 1}>
                <summary className="pwf-step__head">
                  <h3>
                    {phase.order}. {phase.name}
                  </h3>
                  <Progress done={phase.requiredDone} total={phase.requiredTotal} label={t('pwf.process.progress.required.label')} />
                </summary>
              <ol className="pwf-steps">
                {phase.steps.map((group) => (
                  <Step key={group.step.code} group={group} projectId={projectId} />
                ))}
              </ol>
              {phase.loose.length === 0 ? null : (
                <>
                  <p className="pwf-hint">{t('pwf.process.steps.loose.text')}</p>
                  <ul className="pwf-list">
                    {phase.loose.map((task) => (
                      <TaskLine key={task.id} task={task} projectId={projectId} />
                    ))}
                  </ul>
                </>
              )}
              </details>
            </li>
          ))}
        </ol>
      </div>
    </SectionCard>
  );
}
