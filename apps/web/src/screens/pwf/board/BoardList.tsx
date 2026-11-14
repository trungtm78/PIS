import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { phaseName, TaskName } from '../codes';
import { BandBadge, Forecast } from '../components';
import { dayText, taskLink, workflowLink } from '../model';
import type { DeadlineBoard } from '../model';
import type { BoardRow } from './model';

export interface BoardListProps {
  rows: readonly BoardRow[];
  /** The exact total the server counted for the filters, and whether it cut the list it sent. */
  total: number;
  truncated: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  filtered: boolean;
  onClearFilters: () => void;
}

/** The deadline of a row: the day, or the words that say it cannot be counted (a calendar is missing): never a guessed date. */
export function DueCell({ row, task }: { row: Pick<DeadlineBoard['items'][number], 'due_date' | 'band'>; task?: Pick<DeadlineBoard['items'][number], 'status' | 'forecast_finish'> }) {
  const { t } = useTranslation();
  if (row.band.band === 'UNKNOWN') return <span className="pwf-missing">{t('pwf.board.unknown.text')}</span>;
  return (
    <span className="pwf-cellstack">
      <span>{dayText(row.due_date)}</span>
      {task === undefined ? null : <Forecast task={{ status: task.status, planned_finish: row.due_date, forecast_finish: task.forecast_finish }} />}
    </span>
  );
}

/** The rows of the board, the official colour of each, the "showing N of M" line with the exact total, the notice of a cut list and the control that loads the next page. */
export function BoardList({ rows, total, truncated, hasMore, loadingMore, onMore, filtered, onClearFilters }: BoardListProps) {
  const { t } = useTranslation();
  const columns: DataTableColumn<BoardRow>[] = [
    {
      key: 'task',
      header: t('pwf.board.col.task.header'),
      pinned: true,
      render: (row) => (
        <TaskName name={row.name} code={row.task_code} note={row.critical ? ` · ${t('pwf6.flow.critical.mark')}` : ''}>
          <Link to={taskLink(row.task_id, row.project_id)}>{row.name}</Link>
        </TaskName>
      ),
    },
    {
      key: 'project',
      header: t('pwf.board.col.project.header'),
      render: (row) => (
        <span className="pwf-cellstack">
          <Link to={workflowLink(row.project_id)}>{row.project_name}</Link>
          <span className="pwf-code">{row.project_code}</span>
        </span>
      ),
    },
    { key: 'phase', header: t('pwf.board.col.phase.header'), render: (row) => phaseName(t, row.phase_code) },
    { key: 'person', header: t('pwf.board.col.person.header'), render: (row) => row.assignee?.display_name ?? <span className="pwf-hint">{t('pwf.board.unassigned.text')}</span> },
    { key: 'due', header: t('pwf.board.col.due.header'), render: (row) => <DueCell row={row} task={row} /> },
    { key: 'band', header: t('pwf.board.col.band.header'), render: (row) => <BandBadge band={row.band} /> },
  ];
  return (
    <div data-testid="board-list">
      <p data-testid="range" role="status">
        {t('pwf.board.range.text', { shown: rows.length, total })}
      </p>
      {truncated ? (
        <p className="callout warning pwf-notice" data-testid="truncated" role="status">
          <span aria-hidden="true">⚠ </span>
          {t('pwf.board.truncated.notice', { total })}
        </p>
      ) : null}
      <div className="pwf-free">
        <DataTable
          columns={columns}
          rows={[...rows]}
          rowKey={(row) => row.task_id}
          rowAttrs={(row) => ({ 'data-task-id': row.task_id, 'data-band': row.band.band })}
          caption={t('fix9.pwf07.list.caption')}
          state="ready"
          emptyKind={filtered ? 'filtered' : 'none'}
          onClearFilters={onClearFilters}
        />
      </div>
      {hasMore ? (
        <p className="pwf-actions">
          <button type="button" className="ui-button ui-button--outline" data-testid="more" disabled={loadingMore} onClick={onMore}>
            {t('pwf.board.more.action')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
