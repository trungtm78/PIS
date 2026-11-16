import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { ScrollRegion } from '../../scroll-region';
import { phaseName, TaskName } from '../codes';
import { BandBadge } from '../components';
import { statusWord } from '../labels';
import { dayText, hasBand, taskLink, todayInVietnam } from '../model';
import type { Schedule, WorkflowDetail } from '../model';
import { WorkflowInfo } from './figures';
import { GanttChart } from './GanttChart';
import { ganttRows, milestoneRows } from './model';

interface Common {
  detail: WorkflowDetail;
  version: string;
}

interface GanttProps extends Common {
  schedule: Schedule | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}

/** The schedule on a time axis: the current bars, the first baseline, the delay against it, the critical path and today. The critical path is also named in words under the chart. */
export function Gantt({ detail, version, schedule, loading, failed, onRetry }: GanttProps) {
  const { t } = useTranslation();
  const rows = schedule === undefined ? [] : ganttRows(schedule, detail.tasks);
  const names = new Map((schedule?.tasks ?? []).map((task) => [task.task_code, task.name]));
  const dated = rows.some((row) => row.actual !== null);
  return (
    <SectionCard title={t('pwf.flow.section.gantt.title')} status={<WorkflowInfo figure="critical" asOf={schedule?.as_of ?? detail.as_of} version={version} />}>
      {loading ? (
        <p role="status" aria-busy="true" data-testid="gantt-loading">
          {t('pwf6.gantt.loading.text')}
        </p>
      ) : failed ? (
        <p className="callout danger" role="alert" data-testid="gantt-failed">
          {t('pwf6.gantt.failed.text')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
            {t('ui.common.retry')}
          </button>
        </p>
      ) : !dated ? (
        <p className="callout" role="status" data-testid="gantt-empty">
          {t('pwf6.gantt.empty.text')}
        </p>
      ) : (
        <GanttChart rows={rows} phases={detail.phases} today={todayInVietnam()} />
      )}
      {schedule === undefined ? null : (
        <div className="pwf-path" data-testid="critical-path">
          <strong>{t('pwf.flow.gantt.path.label')}</strong>{' '}
          {schedule.critical_path.length === 0 ? (
            t('pwf.flow.gantt.pathNone.text')
          ) : (
            <ol className="pwf-path__list">
              {schedule.critical_path.map((code) => (
                <li key={code} data-code={code}>
                  {names.get(code) ?? code}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** The milestones of the plan in the order of their dates: the day, the milestone, its phase, where it stands and its official colour in words. A plan table, not a log: no hour, no author, no "days without change". */
export function MilestoneTimeline({ detail, version, projectId }: Common & { projectId: string }) {
  const { t } = useTranslation();
  const rows = milestoneRows(detail);
  const dated = rows.filter((row) => row.day !== null);
  return (
    <SectionCard title={t('pwf.flow.section.milestones.title')} status={<WorkflowInfo figure="bands" asOf={detail.as_of} version={version} />}>
      {dated.length === 0 ? (
        <p className="callout" role="status" data-testid="no-milestones">
          {t('pwf.flow.timeline.empty.text')}
        </p>
      ) : (
        <div className="pwf-free" data-testid="milestones">
          <ScrollRegion label={t('pwf.flow.timeline.caption.text')}>
            <table className="pwf-outline pwf-outline--flat">
              <caption className="sr-only">{t('pwf.flow.timeline.caption.text')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('pwf6.milestone.col.day')}</th>
                  <th scope="col">{t('pwf6.milestone.col.name')}</th>
                  <th scope="col">{t('pwf6.milestone.col.phase')}</th>
                  <th scope="col">{t('pwf6.milestone.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-milestone={row.code}>
                    <td className="pwf-num">{row.day === null ? <span className="pwf-missing">{t('pwf6.milestone.noDay.text')}</span> : <strong>{dayText(row.day)}</strong>}</td>
                    <th scope="row">
                      <span className="pwf-outline__name">
                        <span aria-hidden="true">◆</span>
                        <TaskName name={row.name} code={row.code}>
                          <Link to={taskLink(row.id, projectId)}>{row.name}</Link>
                        </TaskName>
                      </span>
                    </th>
                    <td>{phaseName(t, row.phase, detail.phases)}</td>
                    <td>
                      <span className="pwf-pills">
                        <StatusPill tone={row.task.status === 'DONE' ? 'success' : 'neutral'} icon={row.task.status === 'DONE' ? '✓' : '○'}>
                          {statusWord(t, row.task.status)}
                        </StatusPill>
                        {hasBand(row.task) && row.task.band.band !== 'NONE' ? <BandBadge band={row.task.band} /> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </div>
      )}
    </SectionCard>
  );
}

/** A link to the task of a gate or a card, in the one place the address is built. */
export function TaskLink({ id, projectId, children }: { id: string; projectId: string; children: string }) {
  return <Link to={taskLink(id, projectId)}>{children}</Link>;
}
