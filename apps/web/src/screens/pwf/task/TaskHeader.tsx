import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { BandBadge, CalendarMissingCell, FigureInfo } from '../components';
import { kindWord, priorityWord, statusWord } from '../labels';
import { calendarMissing, dayText, hasBand } from '../model';
import type { TaskDetail } from '../model';
import { statusTone } from './model';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const orDash = (value: number | string | null): string => (value === null ? '–' : String(value));

/** The head of PWF-04: what the task is, where it stands and every figure of its schedule with the "i" that says how it is counted. */
export function TaskHeader({ task }: { task: TaskDetail }) {
  const { t } = useTranslation();
  const missing = calendarMissing(task);
  const record = t('pwf.task.version.record.text', { version: task.version });
  const figure = (name: string, formula: string, source: string): ReactNode => <FigureInfo name={name} formula={formula} source={source} asOf={task.as_of} version={record} />;
  const planned = missing ? <CalendarMissingCell year={task.missing_year} /> : `${dayText(task.planned_start)} – ${dayText(task.planned_finish)}`;
  const late = missing ? <CalendarMissingCell year={task.missing_year} /> : `${dayText(task.late_start)} – ${dayText(task.late_finish)}`;
  return (
    <SectionCard title={t('pwf.task.header.title')}>
      <p className="pwf-pills">
        <StatusPill tone={statusTone(task.status)}>{statusWord(t, task.status)}</StatusPill>
        {!hasBand(task) ? null : (
          <>
            <BandBadge band={task.band} />
            {figure(t('pwf.task.band.name'), t('pwf.task.band.formula'), t('pwf.task.source.policy.text'))}
          </>
        )}
        {task.critical ? (
          <StatusPill tone="danger" icon="◆">
            {t('pwf.task.critical.word')}
          </StatusPill>
        ) : null}
      </p>
      <dl className="pwf-facts" data-testid="task-facts">
        <Fact label={t('pwf.task.field.phase.label')}>{task.phase_code}</Fact>
        <Fact label={t('pwf.task.field.kind.label')}>{kindWord(t, task.kind)}</Fact>
        <Fact label={t('pwf.task.field.priority.label')}>{priorityWord(t, task.priority)}</Fact>
        <Fact label={t('pwf.task.field.required.label')}>{task.required ? t('pwf.task.required.yes') : t('pwf.task.required.no')}</Fact>
        <Fact label={t('pwf.task.field.responsible.label')}>{task.responsible_role}</Fact>
        <Fact label={t('pwf.task.field.approver.label')}>{task.approver_role ?? t('pwf.task.approver.none')}</Fact>
        <Fact label={t('pwf.task.field.assignee.label')}>{task.assignee?.display_name ?? t('pwf.task.assignee.none')}</Fact>
        <Fact label={t('pwf.task.field.planned.label')}>{planned}</Fact>
        <Fact label={t('pwf.task.field.baseline.label')}>{`${dayText(task.baseline_start)} – ${dayText(task.baseline_finish)}`}</Fact>
        <Fact label={t('pwf.task.field.late.label')}>{late}</Fact>
        <Fact label={t('pwf.task.field.actual.label')}>{`${dayText(task.actual_start)} – ${dayText(task.actual_finish)}`}</Fact>
        <Fact label={t('pwf.task.field.duration.label')}>
          <span className="pwf-figure">
            {t('pwf.task.days.text', { days: task.duration_working_days })}
            {figure(t('pwf.task.duration.name'), t('pwf.task.duration.formula'), t('pwf.task.source.template.text'))}
          </span>
        </Fact>
        <Fact label={t('pwf.task.field.remaining.label')}>
          <span className="pwf-figure">
            {task.remaining_working_days === null ? '–' : t('pwf.task.days.text', { days: task.remaining_working_days })}
            {figure(t('pwf.task.remaining.name'), t('pwf.task.remaining.formula'), t('pwf.task.source.record.text'))}
          </span>
        </Fact>
        <Fact label={t('pwf.task.field.percent.label')}>
          <span className="pwf-figure">
            {task.percent_complete === null ? '–' : `${task.percent_complete}%`}
            {figure(t('pwf.task.percent.name'), t('pwf.task.percent.formula'), t('pwf.task.source.record.text'))}
          </span>
        </Fact>
        <Fact label={t('pwf.task.field.float.label')}>
          <span className="pwf-figure">
            {missing ? '–' : orDash(task.total_float)}
            {figure(t('pwf.task.float.name'), t('pwf.task.float.formula'), t('pwf.task.source.schedule.text'))}
          </span>
        </Fact>
        <Fact label={t('pwf.task.field.freeFloat.label')}>
          <span className="pwf-figure">
            {missing ? '–' : orDash(task.free_float)}
            {figure(t('pwf.task.freeFloat.name'), t('pwf.task.freeFloat.formula'), t('pwf.task.source.schedule.text'))}
          </span>
        </Fact>
        <Fact label={t('pwf.task.field.variance.label')}>
          <span className="pwf-figure">
            {task.finish_variance_days === null ? '–' : t('pwf.task.days.text', { days: task.finish_variance_days })}
            {figure(t('pwf.task.variance.name'), t('pwf.task.variance.formula'), t('pwf.task.source.baseline.text'))}
          </span>
        </Fact>
        <Fact label={t('pwf.task.field.returns.label')}>
          <span className="pwf-figure">
            {task.return_count}
            {figure(t('pwf.task.returns.name'), t('pwf.task.returns.formula'), t('pwf.task.source.history.text'))}
          </span>
        </Fact>
        <Fact label={t('pwf.task.field.reschedules.label')}>
          <span className="pwf-figure">
            {task.reschedule_count}
            {figure(t('pwf.task.reschedules.name'), t('pwf.task.reschedules.formula'), t('pwf.task.source.history.text'))}
          </span>
        </Fact>
      </dl>
    </SectionCard>
  );
}
