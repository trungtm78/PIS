import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { BandBadge } from '../components';
import { statusWord } from '../labels';
import { dayText, taskLink, workflowLink } from '../model';
import { useMyTasks } from './hooks';
import { MY_TASKS_VIEWS, finishedLate, showsPersonal } from './model';
import type { MyTask, MyTasksView } from './model';
import './preference.css';

/**
 * "My coming tasks" (R40): the real due date and the official colour of each task, which stays primary; the person's own colour appears under it, with its label, only when it differs from the official one.
 * The shared screens (the deadline board, the portfolio, the reports) never show it.
 */
export function MyTasksSection() {
  const { t } = useTranslation();
  const [view, setView] = useState<MyTasksView>('open');
  const tasks = useMyTasks(true, view);
  // While the other list is being read the rows of the one just left are not shown under its heading: a row of the open list is never read as a finished task.
  const pages = tasks.isPlaceholderData ? undefined : tasks.data?.pages;
  const items = pages?.flatMap((page) => page.items) ?? [];
  const lastPage = pages?.[pages.length - 1];
  const total = lastPage?.total ?? 0;
  const done = view === 'done';
  const state = useScreenState({ isLoading: tasks.isLoading || tasks.isPlaceholderData, error: tasks.error, data: pages, isEmpty: () => items.length === 0 });
  return (
    <SectionCard title={t('pwf.pref.tasks.title')} status={items.length === 0 ? undefined : <span data-testid="tasks-count">{t('pwf.pref.tasks.count', { shown: items.length, total })}</span>}>
      <div className="pwfp-views" role="group" aria-label={t('fix10.mytasks.view.label')}>
        {MY_TASKS_VIEWS.map((one) => (
          <button key={one} type="button" className={`ui-button ui-button--small ${one === view ? 'ui-button--primary' : 'ui-button--outline'}`} aria-pressed={one === view} data-action={`my-tasks-${one}`} onClick={() => setView(one)}>
            {one === 'open' ? t('fix10.mytasks.view.open') : t('fix10.mytasks.view.done')}
          </button>
        ))}
      </div>
      <p className="adm-kit-sub" data-testid="my-tasks-note">
        {done ? t('fix10.mytasks.done.note', { days: lastPage?.done_window_days ?? DONE_WINDOW_FALLBACK }) : t('pwf.pref.tasks.note.text')}
      </p>
      <StateBoundary state={state} onRetry={() => void tasks.refetch()}>
        <div className="tablewrap">
          <table className="pwfp-table" data-testid="my-tasks" aria-label={t('pwf.pref.tasks.title')}>
            <thead>
              <tr>
                <th scope="col">{t('pwf.pref.tasks.project.label')}</th>
                <th scope="col">{t('pwf.pref.tasks.task.label')}</th>
                <th scope="col">{t('pwf.pref.tasks.status.label')}</th>
                <th scope="col">{t('pwf.pref.tasks.due.label')}</th>
                <th scope="col">{done ? t('fix10.mytasks.done.column') : t('pwf.pref.tasks.band.label')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((task) => (
                <TaskRow key={task.task_id} task={task} done={done} />
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

/** The window the server keeps the list of finished tasks to, said in the note until the first page says it. */
const DONE_WINDOW_FALLBACK = 90;

/** What the last column says of a finished task: the day it was finished and whether that was within its deadline. A finished task has no colour. */
function FinishedCell({ task }: { task: MyTask }) {
  const { t } = useTranslation();
  const late = finishedLate(task);
  return (
    <span data-testid="finished" data-late={late ? 'true' : 'false'}>
      {dayText(task.finished_on ?? null)}{' '}
      <StatusPill tone={late ? 'warning' : 'success'} icon={late ? '!' : '✓'}>
        {late ? t('fix10.mytasks.done.late') : t('fix10.mytasks.done.onTime')}
      </StatusPill>
    </span>
  );
}

function TaskRow({ task, done }: { task: MyTask; done: boolean }) {
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
        {done ? (
          <FinishedCell task={task} />
        ) : (
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
        )}
      </td>
    </tr>
  );
}
