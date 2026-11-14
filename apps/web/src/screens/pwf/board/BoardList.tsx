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
  /** The exact total the server counted for the filters. */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  filtered: boolean;
  onClearFilters: () => void;
  /** The export of the whole list to Excel: what starts it, whether it is running, and what the last one answered. */
  onExport: () => void;
  exporting: boolean;
  exported?: { name: string; rows: number } | undefined;
  exportFailed?: boolean | undefined;
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

/**
 * The rows of the board and the official colour of each. The list comes in pages: the line "showing N of M" (the exact total) is always there, the tasks still to load are said in plain words beside the control
 * that loads the next page (a list in pages is not a fault, so nothing warns that it was "cut"), and the Excel file always holds every one of the M tasks whatever the page shown.
 */
export function BoardList({ rows, total, hasMore, loadingMore, onMore, filtered, onClearFilters, onExport, exporting, exported, exportFailed }: BoardListProps) {
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
      <div className="pwf-boardbar">
        <p data-testid="range" role="status">
          {t('pwf.board.range.text', { shown: rows.length, total })}
        </p>
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="export" disabled={exporting || total === 0} onClick={onExport}>
          {t('fix10.board.export.action', { total })}
        </button>
      </div>
      {exported === undefined ? null : (
        <p className="pwf-hint" role="status" data-testid="export-done">
          {t('fix10.board.export.done', { name: exported.name, rows: exported.rows })}
        </p>
      )}
      {exportFailed === true ? (
        <p className="callout danger" role="alert" data-testid="export-failed">
          {t('fix10.board.export.failed')}
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
          <span className="pwf-hint" data-testid="rest">
            {t('fix10.board.rest.text', { rest: Math.max(0, total - rows.length), total })}
          </span>
          <button type="button" className="ui-button ui-button--outline" data-testid="more" disabled={loadingMore} onClick={onMore}>
            {t('fix10.board.more.action')}
          </button>
        </p>
      ) : null}
    </div>
  );
}
