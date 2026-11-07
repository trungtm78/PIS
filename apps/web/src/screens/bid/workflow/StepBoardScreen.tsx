import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, StatusPill } from '../../../ui';
import { PATHS, ViewSwitcher, WorkflowFilters, packageColumns } from './components';
import { useBoard, usePackageList } from './hooks';
import { countdownText, methodLabel } from './labels';
import { appliedCount, billions, filtersOf, fullDay, vietnamDay, vietnamTime, withoutPeriod } from './model';
import type { BoardDto, Filters, WfRow } from './model';
import './workflow.css';

/**
 * BID-28, "Bảng gói thầu theo bước" (PRC-1): the packages of one selection method as columns by step (a card for each package with its project, value, days in the step, holder and late flag) or as a list that
 * can be cut by step, on hold and without an owner. Looking at one step says which packages are in it; the filters are those of the tree.
 */
export default function StepBoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <StepBoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function columnName(t: ReturnType<typeof useTranslation>['t'], column: BoardDto['columns'][number]): string {
  switch (column.kind) {
    case 'NOT_STARTED':
      return t('prc1.status.notStarted.name');
    case 'COMPLETED':
      return t('prc1.status.completed.name');
    case 'CANCELLED':
      return t('prc1.status.cancelled.name');
    case 'OTHER':
      return t('prc1.board.other.name');
    case 'STEP':
      return column.name ?? column.code;
  }
}

function Card({ row, node }: { row: WfRow; node?: string }) {
  const { t, locale } = useTranslation();
  const href = `${PATHS.package}?package=${row.package_id}${node === undefined ? '' : `&node=${encodeURIComponent(node)}`}`;
  return (
    <li className={`prc1-card${row.late ? ' is-late' : ''}${row.status === 'ON_HOLD' ? ' is-hold' : ''}`} data-package={row.package_id}>
      <Link to={href} className="prc1-card__code">
        {row.package_code}
      </Link>
      <span className="prc1-card__title">{row.title ?? ''}</span>
      <span className="prc1-card__meta">
        {row.project.code} · {billions(row.value_vnd, locale)} {t('prc1.unit.billion.name')}
      </span>
      <span className="prc1-card__meta">
        {row.days_in_step === null ? t('prc1.column.none.text') : t('prc1.card.days.text', { days: row.days_in_step.working_days ?? row.days_in_step.calendar_days })} · {row.owner === null ? t('prc1.column.noOwner.text') : (row.owner.name ?? t('prc1.column.none.text'))}
      </span>
      <span className="prc1-card__flags">
        {row.late && (
          <StatusPill tone="danger" icon="⛔">
            {t('prc1.card.late.text', { days: row.late_days })}
          </StatusPill>
        )}
        {row.status === 'ON_HOLD' && (
          <StatusPill tone="neutral" icon="⏸">
            {t('prc1.status.onHold.name')}
          </StatusPill>
        )}
        {row.status === 'IN_PROGRESS' && !row.late && row.countdown !== null && <span className="sub">{countdownText(t, row.countdown, row)}</span>}
        {row.stalled === true && <StatusPill tone="warning" icon="⚠">{t('prc1.card.stalled.text')}</StatusPill>}
      </span>
    </li>
  );
}

function StepBoardContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => withoutPeriod(filtersOf(search)), [search]);
  const view = search.get('view') === 'list' ? 'list' : 'board';
  const step = search.get('step') ?? undefined;
  const board = useBoard(filters);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [onHold, setOnHold] = useState(false);
  const [noOwner, setNoOwner] = useState(false);
  const list = usePackageList(filters, { step, on_hold: onHold, no_owner: noOwner, cursor: cursors[cursors.length - 1] });
  const { tenant } = useSession();

  const active = view === 'board' ? board : list;
  const state = useScreenState({
    isLoading: active.isLoading,
    error: active.data === undefined ? active.error : undefined,
    data: active.data,
    isEmpty: (data) => (view === 'board' ? (data as BoardDto).columns.every((column) => column.count === 0) : (data as { items: unknown[] }).items.length === 0),
  });
  const change = (next: Filters): void => {
    const params = new URLSearchParams(search);
    for (const key of ['unit_id', 'project_id', 'method', 'owner_id', 'late_only', 'q']) params.delete(key);
    for (const [key, value] of Object.entries(next)) if (value !== undefined && key !== 'from' && key !== 'to') params.set(key, String(value));
    params.delete('step');
    setSearch(params);
    setCursors([undefined]);
  };
  const chooseStep = (value: string): void => {
    const params = new URLSearchParams(search);
    if (value === '') params.delete('step');
    else params.set('step', value);
    setSearch(params);
    setCursors([undefined]);
  };
  const data = active.data;
  const asOf = data === undefined ? undefined : `${fullDay(vietnamDay(data.as_of))} ${vietnamTime(data.as_of)}`;
  const stale = active.isError && data !== undefined;
  const boardState = state === 'loading' ? 'loading' : state === 'error' ? 'error' : state === 'empty' ? 'empty' : 'ready';
  const emptyText = appliedCount(filters) > 0 ? t('prc1.board.empty.filtered') : t('prc1.board.empty.none');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{view === 'board' ? t('prc1.board.page.title') : t('prc1.list.page.title')}</h1>
          <p>{view === 'board' ? t('prc1.board.page.subtitle') : t('prc1.list.page.subtitle')}</p>
        </div>
      </div>
      <ViewSwitcher active={view === 'board' ? 'board' : 'list'} />
      <ContextBar items={[{ label: t('prc1.context.scope.label'), value: tenant?.name ?? t('prc1.column.none.text') }, ...(view === 'board' && board.data !== undefined ? [{ label: t('prc1.filter.method.label'), value: board.data.method_name }] : [])]} unit={t('prc1.unit.billion.name')} {...(asOf === undefined ? {} : { asOf })} stale={stale} />
      <WorkflowFilters filters={filters} onChange={change} updatedAt={asOf} />
      {stale && (
        <div className="callout prc1-callout" role="alert">
          <span>{t('prc1.error.source.text')}</span>{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void active.refetch()}>
            {t('ui.common.retry')}
          </button>
        </div>
      )}
      <StateBoundary state={state === 'denied' || state === 'signedOut' || state === 'offline' ? state : 'default'} onRetry={() => void active.refetch()}>
        {view === 'board' ? (
          boardState !== 'ready' || board.data === undefined ? (
            <BoardState state={boardState} text={emptyText} onRetry={() => void board.refetch()} onClear={() => change({})} filtered={appliedCount(filters) > 0} />
          ) : (
            <>
              {board.data.truncated && <p className="callout" role="status">{t('prc1.truncated.text')}</p>}
              <div className="prc1-kanban ui-table-scroll" role="region" aria-label={t('prc1.board.region.label', { method: board.data.method_name })} tabIndex={0}>
                {board.data.columns
                  .filter((column) => column.kind === 'STEP' || column.count > 0 || column.kind === 'NOT_STARTED')
                  .map((column) => (
                    <section key={column.code} className={`prc1-column${column.count === 0 ? ' is-empty' : ''}`} aria-label={columnName(t, column)} data-column={column.code}>
                      <header className="prc1-column__head">
                        <h2 className="prc1-column__title">{columnName(t, column)}</h2>
                        <p className="prc1-column__count">
                          <strong>{column.count}</strong> {t('prc1.board.column.packages.text')} · {billions(column.value_vnd, locale)} {t('prc1.unit.billion.name')}
                        </p>
                        {column.late_count > 0 && <StatusPill tone="danger" icon="⛔">{t('ui.processTree.node.late', { count: column.late_count })}</StatusPill>}
                        {column.standard_working_days !== null && <span className="sub">{t('prc1.board.column.standard.text', { days: column.standard_working_days })}</span>}
                      </header>
                      <ul className="prc1-column__cards">
                        {column.cards.map((card) => (
                          <Card key={card.package_id} row={card} />
                        ))}
                      </ul>
                      {column.count > column.cards.length && (
                        <Link className="prc1-column__more" to={`${PATHS.board}?view=list&step=${column.code}${filters.method === undefined ? `&method=${board.data?.method ?? ''}` : ''}`}>
                          {t('prc1.board.column.more.text', { count: column.count - column.cards.length })}
                        </Link>
                      )}
                    </section>
                  ))}
              </div>
            </>
          )
        ) : (
          <>
            <div className="prc1-listbar">
              <div className="field">
                <label htmlFor="prc1-step">{t('prc1.list.step.label')}</label>
                <select id="prc1-step" value={step ?? ''} onChange={(event) => chooseStep(event.target.value)}>
                  <option value="">{t('prc1.filter.all.text')}</option>
                  {(board.data?.columns ?? []).map((column) => (
                    <option key={column.code} value={column.code}>
                      {columnName(t, column)} ({column.count})
                    </option>
                  ))}
                </select>
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={onHold} onChange={(event) => { setOnHold(event.target.checked); setCursors([undefined]); }} /> {t('prc1.list.hold.label')}
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={noOwner} onChange={(event) => { setNoOwner(event.target.checked); setCursors([undefined]); }} /> {t('prc1.list.noOwner.label')}
              </label>
            </div>
            <DataTable
              caption={t('prc1.list.caption.text')}
              columns={[
                ...packageColumns(t, locale, (row) => `${PATHS.package}?package=${row.package_id}`),
                { key: 'step', header: t('prc1.column.step.label'), render: (row) => row.step?.name ?? methodLabel(t, row.method) },
              ]}
              rows={list.data?.items ?? []}
              rowKey={(row) => row.package_id}
              severity={(row) => (row.late ? 'ACTION' : null)}
              state={boardState}
              emptyKind={appliedCount(filters) > 0 || step !== undefined || onHold || noOwner ? 'filtered' : 'none'}
              onClearFilters={() => {
                change({});
                setOnHold(false);
                setNoOwner(false);
              }}
              onRetry={() => void list.refetch()}
            />
            {state === 'default' && (
              <div className="prc1-pager">
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={cursors.length < 2} onClick={() => setCursors((value) => value.slice(0, -1))}>
                  {t('prc1.pager.previous.action')}
                </button>
                <span className="sub">{t('prc1.pager.page.text', { page: cursors.length })}</span>
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={list.data?.next_cursor === null || list.data?.next_cursor === undefined} onClick={() => setCursors((value) => [...value, list.data?.next_cursor ?? undefined])}>
                  {t('prc1.pager.next.action')}
                </button>
              </div>
            )}
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('prc1.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function BoardState({ state, text, onRetry, onClear, filtered }: { state: 'loading' | 'error' | 'empty' | 'ready'; text: string; onRetry: () => void; onClear: () => void; filtered: boolean }) {
  const { t } = useTranslation();
  if (state === 'loading') {
    return (
      <div className="prc1-state" role="status" aria-busy="true" aria-label={t('prc1.board.loading.label')}>
        <span className="ui-skeleton ui-skeleton--line" />
        <span className="ui-skeleton ui-skeleton--line" />
        <span className="ui-skeleton ui-skeleton--line" />
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="prc1-state" role="alert">
        <span>{t('prc1.board.error.text')}</span>
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
          {t('ui.common.retry')}
        </button>
      </div>
    );
  }
  return (
    <div className="prc1-state" role="status">
      <span>{text}</span>
      {filtered && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClear}>
          {t('ui.processTree.empty.clear')}
        </button>
      )}
    </div>
  );
}
