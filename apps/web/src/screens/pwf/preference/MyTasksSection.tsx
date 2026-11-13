import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { BandBadge } from '../components';
import { statusWord } from '../labels';
import { dayText, taskLink, workflowLink } from '../model';
import { useMyTasks } from './hooks';
import { showsPersonal } from './model';
import type { MyTask } from './model';
import './preference.css';

/**
 * "My coming tasks" (R40): the real due date and the official colour of each task, which stays primary; the person's own colour appears under it, with its label, only when it differs from the official one.
 * The shared screens (the deadline board, the portfolio, the reports) never show it.
 */
export function MyTasksSection() {
  const { t } = useTranslation();
  const tasks = useMyTasks(true);
  const items = tasks.data?.pages.flatMap((page) => page.items) ?? [];
  const total = tasks.data?.pages[tasks.data.pages.length - 1]?.total ?? 0;
  const state = useScreenState({ isLoading: tasks.isLoading, error: tasks.error, data: tasks.data, isEmpty: () => items.length === 0 });
  return (
    <SectionCard title={t('pwf.pref.tasks.title')} status={items.length === 0 ? undefined : <span data-testid="tasks-count">{t('pwf.pref.tasks.count', { shown: items.length, total })}</span>}>
      <p className="adm-kit-sub">{t('pwf.pref.tasks.note.text')}</p>
      <StateBoundary state={state} onRetry={() => void tasks.refetch()}>
        <div className="tablewrap">
          <table className="pwfp-table" data-testid="my-tasks" aria-label={t('pwf.pref.tasks.title')}>
            <thead>
              <tr>
                <th scope="col">{t('pwf.pref.tasks.project.label')}</th>
                <th scope="col">{t('pwf.pref.tasks.task.label')}</th>
                <th scope="col">{t('pwf.pref.tasks.status.label')}</th>
                <th scope="col">{t('pwf.pref.tasks.due.label')}</th>
                <th scope="col">{t('pwf.pref.tasks.band.label')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((task) => (
                <TaskRow key={task.task_id} task={task} />
              ))}
            </tbody>
          </table>
        </div>
        {tasks.hasNextPage ? (
          <p className="pwf-actions">
            <button type="button" className="ui-button ui-button--outline" data-action="more" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>
              {t('pwf.pref.tasks.more.action')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
    </SectionCard>
  );
}

function TaskRow({ task }: { task: MyTask }) {
  const { t } = useTranslation();
  return (
    <tr data-task={task.task_id}>
      <td>
        <Link to={workflowLink(task.project_id)}>{task.project_code}</Link>
      </td>
      <td>
        <Link to={taskLink(task.task_id, task.project_id)}>{task.name}</Link>
        {task.critical ? (
          <>
            {' '}
            <StatusPill tone="danger" icon="◆">
              {t('pwf.pref.tasks.critical.word')}
            </StatusPill>
          </>
        ) : null}
      </td>
      <td>{statusWord(t, task.status)}</td>
      <td data-testid="due">{task.due_date === null ? t('pwf.common.noDue.text') : dayText(task.due_date)}</td>
      <td>
        <div className="pwfp-bands">
          <span data-testid="official-band">
            <BandBadge band={task.official_band} />
          </span>
          {showsPersonal(task) && task.personal_band !== null ? (
            <span className="pwfp-personal" data-testid="personal-band" data-band={task.personal_band.band}>
              <span className="pwfp-personal__label">{t('pwf.pref.personal.label')}</span>
              <BandBadge band={task.personal_band} />
            </span>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
