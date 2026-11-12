import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { SectionCard, StatusPill } from '../../../ui';
import { BandBadge, CalendarMissingCell } from '../components';
import { bandWord, statusWord } from '../labels';
import { BANDS, calendarMissing, dayText } from '../model';
import type { Band, TaskPage, WorkflowDetail } from '../model';
import { WorkflowInfo } from './figures';
import { NO_FILTER, appliedFilters, assigneeOptions, boardColumns } from './model';
import type { TaskFilter } from './model';
import { TaskLink } from './Views';

const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'DONE', 'ON_HOLD', 'CANCELLED'] as const;

interface FiltersProps {
  detail: WorkflowDetail;
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <label className="pwf-field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

/** The filters of the board: phase, official colour, status and person. */
export function BoardFilters({ detail, filter, onChange }: FiltersProps) {
  const { t } = useTranslation();
  const people = assigneeOptions(detail.tasks);
  return (
    <div className="pwf-filters" role="group" aria-label={t('pwf.flow.filter.group.label')}>
      <Select label={t('pwf.flow.filter.phase.label')} value={filter.phase} onChange={(phase) => onChange({ ...filter, phase })}>
        <option value="">{t('pwf.flow.filter.all.option')}</option>
        {[...detail.phases]
          .sort((a, b) => a.order - b.order)
          .map((phase) => (
            <option key={phase.code} value={phase.code}>
              {phase.name}
            </option>
          ))}
      </Select>
      <Select label={t('pwf.flow.filter.band.label')} value={filter.band} onChange={(band) => onChange({ ...filter, band: band as TaskFilter['band'] })}>
        <option value="">{t('pwf.flow.filter.all.option')}</option>
        {BANDS.map((band: Band) => (
          <option key={band} value={band}>
            {bandWord(t, band)}
          </option>
        ))}
      </Select>
      <Select label={t('pwf.flow.filter.status.label')} value={filter.status} onChange={(status) => onChange({ ...filter, status })}>
        <option value="">{t('pwf.flow.filter.all.option')}</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {statusWord(t, status)}
          </option>
        ))}
      </Select>
      <Select label={t('pwf.flow.filter.assignee.label')} value={filter.assignee} onChange={(assignee) => onChange({ ...filter, assignee })}>
        <option value="">{t('pwf.flow.filter.all.option')}</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </Select>
      {appliedFilters(filter) === 0 ? null : (
        <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="clear-filters" onClick={() => onChange(NO_FILTER)}>
          {t('pwf.flow.filter.clear.action')}
        </button>
      )}
    </div>
  );
}

function Card({ item, projectId }: { item: TaskPage['items'][number]; projectId: string }) {
  const { t } = useTranslation();
  const missing = calendarMissing(item);
  return (
    <li className="pwf-card" data-testid={`card-${item.task_code}`} data-critical={item.critical}>
      <TaskLink id={item.id} projectId={projectId}>{`${item.task_code} · ${item.name}`}</TaskLink>
      <span className="pwf-pills">
        <StatusPill tone={item.status === 'DONE' ? 'success' : item.status === 'CANCELLED' || item.status === 'ON_HOLD' ? 'neutral' : 'default'}>{statusWord(t, item.status)}</StatusPill>
        {item.critical ? <StatusPill tone="info" icon="◆">{t('pwf.flow.critical.word')}</StatusPill> : null}
      </span>
      {item.status === 'DONE' || item.status === 'CANCELLED' || item.excluded ? null : <BandBadge band={item.band} />}
      <span className="pwf-card__due">
        {t('pwf.flow.board.due.label')}: {missing ? <CalendarMissingCell year={item.missing_year} /> : dayText(item.planned_finish)}
      </span>
      <span className="pwf-card__who">{item.assignee === null ? t('pwf.flow.board.unassigned.text') : item.assignee.display_name}</span>
    </li>
  );
}

interface BoardProps {
  detail: WorkflowDetail;
  projectId: string;
  items: TaskPage['items'];
  total: number | undefined;
  loading: boolean;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  filter: TaskFilter;
  onFilter: (filter: TaskFilter) => void;
  onMore: () => void;
  onRetry: () => void;
}

/** The tasks of the workflow by phase, one column each, with the colour, status and person; "showing N of M" carries the exact total of the filter and the rest is read on request. */
export function Board({ detail, projectId, items, total, loading, failed, hasMore, loadingMore, filter, onFilter, onMore, onRetry }: BoardProps) {
  const { t } = useTranslation();
  const columns = boardColumns(detail.phases, items);
  return (
    <SectionCard title={t('pwf.flow.section.board.title')} status={<WorkflowInfo figure="float" asOf={detail.as_of} version={t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version })} />}>
      <BoardFilters detail={detail} filter={filter} onChange={onFilter} />
      {loading ? (
        <p role="status" aria-busy="true" data-testid="board-loading">
          {t('pwf.flow.board.loading.text')}
        </p>
      ) : failed ? (
        <p className="callout danger" role="alert" data-testid="board-failed">
          {t('pwf.flow.board.failed.text')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
            {t('ui.common.retry')}
          </button>
        </p>
      ) : (
        <>
          <p className="sub" data-testid="board-count">
            {t('pwf.flow.board.shown.text', { shown: items.length, total: total ?? items.length })} <WorkflowInfo figure="count" asOf={detail.as_of} version={t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version })} />
          </p>
          <div className="pwf-board" data-testid="board">
            {columns.map((column) => (
              <section key={column.code} className="pwf-board__column" aria-label={column.name} data-phase={column.code}>
                <h3>{column.name}</h3>
                {column.required === null ? null : <p className="sub">{t('pwf.flow.stepper.progress.text', { done: column.required.done, total: column.required.total })} <WorkflowInfo figure="phase" asOf={detail.as_of} version={t('pwf.flow.info.scheduleVersion.text', { version: detail.schedule_version })} /></p>}
                {column.items.length === 0 ? (
                  <p className="sub">{t('pwf.flow.board.empty.text')}</p>
                ) : (
                  <ul>
                    {column.items.map((item) => (
                      <Card key={item.id} item={item} projectId={projectId} />
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
          {hasMore ? (
            <button type="button" className="ui-button ui-button--outline" data-action="more" disabled={loadingMore} onClick={onMore}>
              {t('pwf.flow.board.more.action')}
            </button>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}
