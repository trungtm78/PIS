import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { CalendarMissingCell, FigureInfo } from '../components';
import { dependencyWord } from '../labels';
import { calendarMissing, dayText } from '../model';
import type { TaskDetail } from '../model';

const span = (from: string | null, to: string | null): string | null => (from === null && to === null ? null : from === null ? dayText(to) : to === null ? dayText(from) : `${dayText(from)} – ${dayText(to)}`);

/**
 * The schedule of the task and how far it may slip, closed until a person asks for it: planned, baseline, latest and actual days, duration, float and variance, each figure with its "i", then the tasks it waits for.
 * A figure the record does not have is left out (a row of dashes and zeros says nothing).
 */
export function ScheduleSection({ task, names }: { task: TaskDetail; names?: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  const missing = calendarMissing(task);
  const record = t('pwf.task.version.record.text', { version: task.version });
  const info = (name: string, formula: string, source: string): ReactNode => <FigureInfo name={name} formula={formula} source={source} asOf={task.as_of} version={record} />;
  const days = (value: number): string => t('pwf.task.days.text', { days: value });
  const rows: Array<{ key: string; label: string; value: ReactNode; info?: ReactNode; tone?: 'danger' | 'success' }> = [];
  const add = (key: string, label: string, value: ReactNode | null, extra?: ReactNode, tone?: 'danger' | 'success'): void => {
    if (value !== null && value !== undefined && value !== '') rows.push({ key, label, value, ...(extra === undefined ? {} : { info: extra }), ...(tone === undefined ? {} : { tone }) });
  };
  add('planned', t('pwf.task.field.planned.label'), missing ? <CalendarMissingCell year={task.missing_year} /> : span(task.planned_start, task.planned_finish));
  add('baseline', t('pwf.task.field.baseline.label'), span(task.baseline_start, task.baseline_finish));
  add('late', t('pwf.task.field.late.label'), missing ? null : span(task.late_start, task.late_finish));
  add('actual', t('pwf.task.field.actual.label'), span(task.actual_start, task.actual_finish));
  add('duration', t('pwf.task.field.duration.label'), days(task.duration_working_days), info(t('pwf.task.duration.name'), t('pwf.task.duration.formula'), t('pwf.task.source.template.text')));
  add('remaining', t('pwf.task.field.remaining.label'), task.remaining_working_days === null ? null : days(task.remaining_working_days), info(t('pwf.task.remaining.name'), t('pwf.task.remaining.formula'), t('pwf.task.source.record.text')));
  add('percent', t('pwf.task.field.percent.label'), task.percent_complete === null ? null : `${task.percent_complete}%`, info(t('pwf.task.percent.name'), t('pwf.task.percent.formula'), t('pwf.task.source.record.text')));
  add('float', t('pwf.task.field.float.label'), missing || task.total_float === null ? null : days(task.total_float), info(t('pwf.task.float.name'), t('pwf.task.float.formula'), t('pwf.task.source.schedule.text')));
  add('freeFloat', t('pwf.task.field.freeFloat.label'), missing || task.free_float === null ? null : days(task.free_float), info(t('pwf.task.freeFloat.name'), t('pwf.task.freeFloat.formula'), t('pwf.task.source.schedule.text')));
  add(
    'variance',
    t('pwf.task.field.variance.label'),
    task.finish_variance_days === null ? null : task.finish_variance_days === 0 ? t('pwf6.task.variance.none') : task.finish_variance_days > 0 ? t('pwf6.task.variance.late', { days: task.finish_variance_days }) : t('pwf6.task.variance.early', { days: Math.abs(task.finish_variance_days) }),
    info(t('pwf.task.variance.name'), t('pwf.task.variance.formula'), t('pwf.task.source.baseline.text')),
    task.finish_variance_days !== null && task.finish_variance_days > 0 ? 'danger' : undefined,
  );
  add('returns', t('pwf.task.field.returns.label'), task.return_count > 0 ? String(task.return_count) : null, info(t('pwf.task.returns.name'), t('pwf.task.returns.formula'), t('pwf.task.source.history.text')));
  add('reschedules', t('pwf.task.field.reschedules.label'), task.reschedule_count > 0 ? String(task.reschedule_count) : null, info(t('pwf.task.reschedules.name'), t('pwf.task.reschedules.formula'), t('pwf.task.source.history.text')));
  return (
    <details className="pwf-fold" data-testid="schedule">
      <summary>
        {t('pwf6.task.schedule.title')}
        {task.finish_variance_days !== null && task.finish_variance_days > 0 ? <span className="pwf-fold__note pwf-late">{t('pwf6.task.variance.late', { days: task.finish_variance_days })}</span> : null}
      </summary>
      <div className="pwf-fold__body">
        <dl className="pwf-stats" data-testid="schedule-facts">
          {rows.map((row) => (
            <div key={row.key} className="pwf-stats__item" data-fact={row.key} data-tone={row.tone}>
              <dt>{row.label}</dt>
              <dd>
                <span className="pwf-figure">
                  {row.value}
                  {row.info}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <h3 className="pwf-subtitle">{t('pwf.task.predecessor.title')}</h3>
        <div data-testid="predecessors">
          {task.predecessors.length === 0 ? (
            <p className="pwf-hint">{t('pwf.task.predecessor.empty')}</p>
          ) : (
            <ul className="pwf-list">
              {task.predecessors.map((item) => {
                const name = names?.get(item.task);
                return (
                  <li key={`${item.task}:${item.kind}`} data-predecessor={item.task}>
                    {name ?? item.task} {name === undefined ? null : <span className="pwf-code">{item.task}</span>} · {dependencyWord(t, item.kind)}
                    {item.lag_working_days === 0 ? null : ` · ${t('pwf6.task.lag.text', { days: item.lag_working_days })}`}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </details>
  );
}
