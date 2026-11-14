import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { RoleName, phaseName } from '../codes';
import { BandBadge, CalendarMissingCell, FigureInfo, Forecast, Meter } from '../components';
import { priorityWord, statusWord } from '../labels';
import { calendarMissing, dayText, hasBand } from '../model';
import type { TaskDetail } from '../model';
import { statusTone } from './model';

const BAND_TONE: Readonly<Record<string, 'danger' | 'warning' | 'success' | undefined>> = { RED: 'danger', YELLOW: 'warning', GREEN: 'success' };

/**
 * The head of PWF-04: what a person needs to act, and nothing else. The name of the task (its code is a note), where it sits in the procedure, its state and official colour, the deadline in the colour of its band, who does
 * it and who approves it, how far the checklist is, and the actions the server allows (`children`). The figures of the schedule are one block further down, closed until asked for.
 */
export function TaskHeader({ task, children }: { task: TaskDetail; children?: ReactNode }) {
  const { t } = useTranslation();
  const missing = calendarMissing(task);
  const step = task.step ?? null;
  const banded = hasBand(task);
  const done = task.checklist.filter((item) => item.done).length;
  const tone = banded ? BAND_TONE[task.band.band] : undefined;
  const due = missing ? null : task.status === 'DONE' && task.actual_finish !== null ? dayText(task.actual_finish) : task.planned_finish === null ? null : dayText(task.planned_finish);
  // Two siblings of the page (the wrapper has no box of its own): the short summary sticks for the whole length of the tabs below, the facts scroll away.
  return (
    <div className="pwf-taskhead-frame" data-testid="task-head">
    <header className="pwf-taskhead pwf-taskhead--sticky" data-testid="task-sticky">
      <div className="heading pwf-taskhead__title">
        <h1 id="screen-title">{task.name}</h1>
        <p className="pwf-taskhead__where" data-testid="task-where">
          <span className="pwf-code">{task.task_code}</span>
          <span>{phaseName(t, step?.phase_code ?? task.phase_code)}</span>
          {step === null ? null : (
            <span>
              {t('pwf6.task.step.text', { order: step.order, name: step.name })}
            </span>
          )}
        </p>
      </div>
      <p className="pwf-pills" data-testid="task-pills">
        <StatusPill tone={statusTone(task.status)}>{statusWord(t, task.status)}</StatusPill>
        {!banded ? null : (
          <>
            <BandBadge band={task.band} />
            <FigureInfo name={t('pwf.task.band.name')} formula={t('pwf.task.band.formula')} source={t('pwf.task.source.policy.text')} asOf={task.as_of} version={t('pwf.task.version.record.text', { version: task.version })} />
          </>
        )}
        {task.critical ? (
          <StatusPill tone="info" icon="◆">
            {t('pwf.task.critical.word')}
          </StatusPill>
        ) : null}
        {task.kind === 'MILESTONE' ? (
          <StatusPill tone="neutral" icon="◆">
            {t('pwf.kind.milestone.word')}
          </StatusPill>
        ) : null}
        <StatusPill tone="neutral">{task.required ? t('pwf.task.required.yes') : t('pwf.task.required.no')}</StatusPill>
        {task.priority === 'NORMAL' ? null : <StatusPill tone={task.priority === 'LOW' ? 'neutral' : 'warning'}>{t('pwf6.task.priority.text', { priority: priorityWord(t, task.priority) })}</StatusPill>}
        {task.return_count > 0 ? <StatusPill tone="warning">{t('pwf6.task.returned.text', { count: task.return_count })}</StatusPill> : null}
        {due === null ? null : (
          <span className="pwf-taskhead__due" data-tone={tone} data-testid="task-sticky-due">
            {task.status === 'DONE' ? t('pwf6.task.finished.label') : t('pwf6.task.due.label')} <strong>{due}</strong>
          </span>
        )}
      </p>
      {children}
    </header>
    <div className="pwf-taskhead pwf-taskhead__rest">
      <dl className="pwf-stats pwf-taskhead__facts" data-testid="task-facts">
        <div className="pwf-stats__item" data-tone={tone}>
          <dt>{task.status === 'DONE' ? t('pwf6.task.finished.label') : t('pwf6.task.due.label')}</dt>
          <dd data-testid="task-due">{missing ? <CalendarMissingCell year={task.missing_year} /> : task.status === 'DONE' && task.actual_finish !== null ? dayText(task.actual_finish) : task.planned_finish === null ? t('pwf6.task.due.none') : dayText(task.planned_finish)}</dd>
          <Forecast task={task} testId="task-forecast" />
        </div>
        <div className="pwf-stats__item">
          <dt>{t('pwf6.task.doer.label')}</dt>
          <dd data-testid="task-doer">
            {task.assignee?.display_name ?? t('pwf.task.assignee.none')}
            <span className="pwf-code">
              <RoleName code={task.responsible_role} name={task.responsible_role_name} />
            </span>
          </dd>
        </div>
        <div className="pwf-stats__item">
          <dt>{t('pwf6.task.approver.label')}</dt>
          <dd data-testid="task-approver">{task.approver_role === null ? t('pwf.task.approver.none') : <RoleName code={task.approver_role} name={task.approver_role_name} />}</dd>
        </div>
        {task.checklist.length === 0 ? null : (
          <div className="pwf-stats__item">
            <dt>{t('pwf.task.checklist.title')}</dt>
            <dd>
              <Meter done={done} total={task.checklist.length} label={t('pwf.task.checklist.title')} testId="task-checklist-meter" />
            </dd>
          </div>
        )}
      </dl>
    </div>
    </div>
  );
}
