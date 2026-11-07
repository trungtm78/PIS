import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, KpiStrip } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ClockChip, Field, FormulaTile, Notice, PolicyNote, Select, StatusChip } from './components';
import { useDirectiveList, useMeetingOptions, useProjectOptions, useSummary, useUnitOptions } from './hooks';
import { statusLabel } from './labels';
import { COLUMN_PAGE_SIZE, MEETING_LIST_PATH, NO_FILTER, PERIOD_PATH, STATUSES, appliedCount, asOfText, columnsOf, dayText, directivePath, narrowsBeyondSummary } from './model';
import type { DirectiveLine, DirectiveStatus, FilterState, Summary } from './model';

type View = 'status' | 'unit';

/**
 * DIR-03: the board that follows the directives: the numbers first (every one with its "i": formula, source, the time it is as of and the policy it follows), then one column for each status a reader sees with
 * what is late first and most prominent, or the directives of each unit that must do them. A column pages by the cursor of the server, so nothing is dropped; the status is the one the server computes on the day
 * of the read (OVERDUE is an open directive past its due day, never stored). The built-in thresholds are starting values nobody confirmed: the note says so.
 */
export default function BoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [filter, setFilter] = useState<FilterState>(NO_FILTER);
  const [view, setView] = useState<View>('status');
  const summary = useSummary(filter);
  const units = useUnitOptions();
  const projects = useProjectOptions();
  const meetings = useMeetingOptions();
  const applied = appliedCount(filter);
  const data = summary.data ?? undefined;
  const summaryState = summary.isLoading ? 'loading' : summary.error !== null && data === undefined ? 'error' : 'ready';
  const stale = summary.isError && data !== undefined;
  const change = (next: Partial<FilterState>): void => setFilter({ ...filter, ...next });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dir.board.page.title')}</h1>
          <p>{t('dir.board.page.subtitle')}</p>
        </div>
        <div className="dir-actions">
          <Link className="ui-button ui-button--outline" to={MEETING_LIST_PATH}>
            {t('dir.board.meetings.action')}
          </Link>
          <Link className="ui-button ui-button--outline" to={PERIOD_PATH}>
            {t('dir.board.period.action')}
          </Link>
        </div>
      </div>
      <ContextBar items={[{ label: t('dir.ctx.scope.label'), value: tenant?.name ?? t('dir.ctx.scope.all') }]} {...(data === undefined || data.asOf === '' ? {} : { asOf: asOfText(data.asOf) })} stale={stale} />
      <Tiles summary={data} state={summaryState} onRetry={() => void summary.refetch()} />
      {data?.truncated === true ? <Notice tone="info">{t('dir.board.truncated.text')}</Notice> : null}
      {data === undefined ? null : <PolicyNote policy={data.policy} />}
      <FilterPanel
        applied={applied}
        {...(data === undefined || data.asOf === '' ? {} : { updatedAt: asOfText(data.asOf) })}
        actions={
          applied === 0 ? undefined : (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setFilter(NO_FILTER)}>
              {t('dir.filter.clear.action')}
            </button>
          )
        }
      >
        <Select id="dir-f-status" label={t('dir.filter.status.label')} value={filter.status} onChange={(value) => change({ status: STATUSES.find((status) => status === value) ?? '' })} options={STATUSES.map((status) => ({ id: status, label: statusLabel(t, status) }))} emptyLabel={t('dir.filter.all.option')} />
        <Select id="dir-f-unit" label={t('dir.filter.unit.label')} value={filter.unitId} onChange={(value) => change({ unitId: value })} options={units.data ?? []} emptyLabel={t('dir.filter.all.option')} />
        <Select id="dir-f-project" label={t('dir.filter.project.label')} value={filter.projectId} onChange={(value) => change({ projectId: value })} options={projects.data ?? []} emptyLabel={t('dir.filter.all.option')} />
        <Select id="dir-f-meeting" label={t('dir.filter.meeting.label')} value={filter.meetingId} onChange={(value) => change({ meetingId: value })} options={meetings.data ?? []} emptyLabel={t('dir.filter.all.option')} />
        <Field id="dir-f-q" label={t('dir.filter.q.label')}>
          <input id="dir-f-q" type="search" value={filter.q} onChange={(event) => change({ q: event.target.value })} />
        </Field>
        <Field id="dir-f-from" label={t('dir.filter.dueFrom.label')}>
          <input id="dir-f-from" type="date" value={filter.dueFrom} onChange={(event) => change({ dueFrom: event.target.value })} />
        </Field>
        <Field id="dir-f-to" label={t('dir.filter.dueTo.label')}>
          <input id="dir-f-to" type="date" value={filter.dueTo} onChange={(event) => change({ dueTo: event.target.value })} />
        </Field>
        <label className="dir-check">
          <input type="checkbox" checked={filter.assignedToMe} onChange={(event) => change({ assignedToMe: event.target.checked })} /> {t('dir.filter.mine.label')}
        </label>
        <label className="dir-check">
          <input type="checkbox" checked={filter.overdue} onChange={(event) => change({ overdue: event.target.checked })} /> {t('dir.filter.overdue.label')}
        </label>
      </FilterPanel>
      <div className="dir-toggle" role="group" aria-label={t('dir.board.view.label')}>
        <button type="button" className="ui-button ui-button--outline" aria-pressed={view === 'status'} onClick={() => setView('status')}>
          {t('dir.board.view.status')}
        </button>
        <button type="button" className="ui-button ui-button--outline" aria-pressed={view === 'unit'} onClick={() => setView('unit')}>
          {t('dir.board.view.unit')}
        </button>
      </div>
      {view === 'status' ? (
        <div className="dir-board" data-testid="board">
          {columnsOf(filter).map((status) => (
            <Column key={status} status={status} filter={filter} count={data !== undefined && !narrowsBeyondSummary(filter) ? data.byStatus[status] : undefined} />
          ))}
        </div>
      ) : (
        <ByUnit
          summary={data}
          state={summaryState}
          onRetry={() => void summary.refetch()}
          onOpen={(unitId) => {
            setFilter({ ...filter, unitId });
            setView('status');
          }}
        />
      )}
      <p className="prototype-note">{t('dir.footer.text', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Tiles({ summary, state, onRetry }: { summary: Summary | undefined; state: 'loading' | 'error' | 'ready'; onRetry: () => void }) {
  const { t } = useTranslation();
  const policy = summary?.policy ?? { code: 'DEFAULT', version: null, source: 'DEFAULT' as const, unverified: true, reminderDaysBefore: [], escalateAfterOverdueDays: 0, maxExtensions: 0, maxExtensionDays: 0, closeRequiresEvidence: true };
  const tile = (key: string, label: string, value: number | undefined, extra: { tone?: 'danger' | 'warning' | 'success'; formula?: string; sub?: string } = {}) => (
    <FormulaTile
      label={label}
      value={value === undefined ? '' : String(value)}
      {...(extra.tone === undefined ? {} : { tone: extra.tone })}
      {...(extra.sub === undefined ? {} : { sub: extra.sub })}
      formula={extra.formula}
      asOf={summary?.asOf ?? ''}
      policy={policy}
      state={summary === undefined ? state : 'ready'}
      onRetry={onRetry}
      key={key}
    />
  );
  const by = summary?.byStatus;
  return (
    <KpiStrip label={t('dir.board.tiles.label')}>
      {tile('total', t('dir.board.tile.total.label'), summary?.total, { formula: summary?.definitions.by_status })}
      {tile('overdue', t('dir.board.tile.overdue.label'), by?.OVERDUE, { tone: 'danger', formula: summary?.definitions.by_status })}
      {tile('escalated', t('dir.board.tile.escalated.label'), summary?.escalated, { tone: 'danger', formula: summary?.definitions.escalated })}
      {tile('soon', t('dir.board.tile.soon.label'), summary?.dueSoon, { tone: 'warning', formula: summary?.definitions.due_soon })}
      {tile('open', t('dir.board.tile.open.label'), by === undefined ? undefined : by.OPEN + by.IN_PROGRESS, { formula: summary?.definitions.by_status })}
      {tile('done', t('dir.board.tile.done.label'), by?.DONE, { tone: 'success', formula: summary?.definitions.by_status })}
    </KpiStrip>
  );
}

/** One column of the board: the directives of one status, in the order the server gives (the late ones lead inside the open statuses), a page at a time. */
function Column({ status, filter, count }: { status: DirectiveStatus; filter: FilterState; count: number | undefined }) {
  const { t } = useTranslation();
  const list = useDirectiveList({ ...filter, status }, COLUMN_PAGE_SIZE);
  const lines = list.data?.pages.flatMap((page) => page.items) ?? [];
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: () => lines.length === 0 });
  return (
    <section className="dir-column" data-status={status} aria-label={statusLabel(t, status)}>
      <h3>
        <span>{statusLabel(t, status)}</span>
        <span data-testid={`count-${status}`}>{count === undefined ? t('dir.board.column.shown', { count: lines.length }) : String(count)}</span>
      </h3>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <ul className="dir-cards">
          {lines.map((line) => (
            <li key={line.id}>
              <Card line={line} />
            </li>
          ))}
        </ul>
        {list.hasNextPage ? (
          <button type="button" className="ui-button ui-button--outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage ? t('dir.form.sending.text') : t('dir.board.column.more.action')}
          </button>
        ) : null}
      </StateBoundary>
    </section>
  );
}

/** A directive on the board: its code opens it; what it is, who does it, by when and where it stands on its clock. */
export function Card({ line }: { line: DirectiveLine }) {
  const { t } = useTranslation();
  return (
    <article className="dir-card" data-directive={line.id}>
      <Link to={directivePath(line.id)}>{line.code}</Link>
      <p>{line.text}</p>
      <div className="dir-card__meta">
        <span>{line.project === null ? t('dir.table.about.unit', { unit: line.scopeUnit.code }) : line.project.code}</span>
        <span>{line.assignee === null ? line.assigneeUnit.code : `${line.assigneeUnit.code} · ${line.assignee.displayName}`}</span>
        <span>{t('dir.card.due.text', { day: dayText(line.dueOn) })}</span>
        <StatusChip status={line.status} />
        <ClockChip line={line} />
      </div>
    </article>
  );
}

/** The directives by the unit that must do them: how many each has, how many are open and late; a unit opens its directives on the board. */
function ByUnit({ summary, state, onRetry, onOpen }: { summary: Summary | undefined; state: 'loading' | 'error' | 'ready'; onRetry: () => void; onOpen: (unitId: string) => void }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<Summary['byUnit'][number]>[] = [
    { key: 'unit', header: t('dir.byUnit.unit.header'), pinned: true, render: (row) => `${row.unit.code} · ${row.unit.name}` },
    { key: 'total', header: t('dir.byUnit.total.header'), align: 'right', render: (row) => String(row.total) },
    { key: 'open', header: t('dir.byUnit.open.header'), align: 'right', render: (row) => String(row.open) },
    { key: 'overdue', header: t('dir.byUnit.overdue.header'), align: 'right', render: (row) => String(row.overdue) },
    { key: 'done', header: t('dir.byUnit.done.header'), align: 'right', render: (row) => String(row.done) },
    {
      key: 'open-unit',
      header: t('dir.byUnit.open.action'),
      render: (row) => (
        <button type="button" className="ui-button ui-button--outline" onClick={() => onOpen(row.unit.id)}>
          {t('dir.byUnit.show.action')}
        </button>
      ),
    },
  ];
  return (
    <DataTable
      caption={t('dir.byUnit.caption')}
      columns={columns}
      rows={summary?.byUnit ?? []}
      rowKey={(row) => row.unit.id}
      state={summary === undefined ? state : summary.byUnit.length === 0 ? 'empty' : 'ready'}
      onRetry={onRetry}
      severity={(row) => (row.overdue > 0 ? 'ACTION' : null)}
    />
  );
}

