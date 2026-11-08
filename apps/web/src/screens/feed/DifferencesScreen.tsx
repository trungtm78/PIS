import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { useFeedConnection, useFeedDifferences, useReconcile } from './feed-hooks';
import { differenceFieldLabel, reconcileIssueLabel, resolutionLabel } from './feed-labels';
import {
  appliedFilters,
  amountText,
  dayText,
  defaultFiscalYear,
  describeProblem,
  differenceFiltersOf,
  differenceSearchOf,
  isOverdue,
  numberText,
  percentText,
  reconcileBody,
  validateReconcile,
  vietnamStamp,
  vietnamToday,
} from './feed-model';
import type { Difference, DifferenceFilters, DifferencePage, Problem, ReconcileErrors, ReconcileForm, Reconciliation } from './feed-model';
import { AcceptanceBadge, DASH, FeedLinks, Figure, ListState, PagingFoot, ProblemNote, StaleNote } from './feed-parts';
import { ResolveDialog } from './resolve-dialog';
import './feed.css';

type T = Translator['t'];

/**
 * FEED-04, the discrepancy worklist: the feed of the Finance Department is compared with our own figures (the plan and the disbursement of the DIS snapshot, the treasury) for a fiscal year, every figure that differs by more than the
 * tolerance becomes an item with an owner and a due day, and a person who did not make the figures settles it: accept the feed, keep ours, dispute it (with a reference to the evidence) or waive it (with a day to look at it again).
 */
export default function DifferencesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters, the dialog and the receipt belong to one membership: a switch of tenant or of membership starts the screen over.
  return <DifferencesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DifferencesContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode, tenant } = useSession();
  const connection = useFeedConnection();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => differenceFiltersOf(search), [search]);
  const list = useFeedDifferences(filters);
  const [dialog, setDialog] = useState<Difference | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const frozen = mode === 'READ_ONLY';
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const applied = appliedFilters(filters);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: () => rows.length === 0 && applied === 0 });
  const refreshFailed = list.isError && list.data !== undefined && !list.isFetchNextPageError;
  const change = (next: DifferenceFilters): void => setSearch(differenceSearchOf(next));
  const mayResolve = connection.data?.actions.resolve === true && !frozen;
  const now = new Date();

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="feed-page">
      <div className="feed-head">
        <div>
          <h1 id="screen-title">{t('feed.diff.page.title')}</h1>
          <p>{t('feed.diff.page.subtitle')}</p>
          <FeedLinks current="differences" />
          <div className="feed-badges">
            <AcceptanceBadge acceptance={connection.data?.acceptance ?? 'PENDING_EXTERNAL'} />
          </div>
        </div>
      </div>
      <ContextBar items={[{ label: t('feed.diff.context.scope.label'), value: tenant?.name ?? '' }]} {...(first?.asOf === undefined || first.asOf === null ? {} : { asOf: vietnamStamp(first.asOf) })} stale={refreshFailed} />
      <p className="callout" data-testid="maker-note">
        {t('feed.diff.note.maker')}
      </p>
      {receipt !== undefined && (
        <p className="callout feed-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {!mayResolve && connection.data !== undefined && (
        <p className="callout" role="status" data-testid="readonly-note">
          {frozen ? t('feed.common.readonly.mode') : t('feed.common.readonly.right')}
        </p>
      )}
      {refreshFailed && <StaleNote asOf={first?.asOf ?? null} onRetry={() => void list.refetch()} />}
      {state === 'denied' ? (
        <ListState state="denied" onRetry={() => void list.refetch()} />
      ) : (
        <>
          <ReconcileSection canRun={connection.data?.actions.reconcile === true && !frozen} defaultYear={defaultFiscalYear(connection.data?.quality, vietnamToday())} />
          <Counts page={first} />
          <SectionCard title={t('feed.diff.list.title')}>
            <FilterBar filters={filters} onChange={change} />
            <ListState
              state={state}
              onRetry={() => void list.refetch()}
              empty={
                <div className="feed-state" role="status" data-testid="empty">
                  <h2>{t('feed.diff.empty.title')}</h2>
                  <p>{t('feed.diff.empty.body')}</p>
                </div>
              }
            />
            {state === 'default' && (
              <>
                <DataTable
                  caption={t('feed.diff.table.caption')}
                  columns={columns(t, locale, first, mayResolve, now, (row) => setDialog(row))}
                  rows={rows}
                  rowKey={(row) => row.id}
                  rowAttrs={(row) => ({ 'data-difference-id': row.id, 'data-state': row.state, 'data-large': String(row.large), 'data-project': row.feedProjectCode })}
                  severity={(row) => (row.state === 'OPEN' && row.large ? 'URGENT' : row.state === 'OPEN' && isOverdue(row, now) ? 'ACTION' : null)}
                  emptyKind={applied > 0 ? 'filtered' : 'none'}
                  onClearFilters={() => change({})}
                />
                <PagingFoot shown={rows.length} hasMore={list.hasNextPage} loadingMore={list.isFetchingNextPage} failedMore={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />
              </>
            )}
          </SectionCard>
        </>
      )}
      {dialog !== undefined && <ResolveDialog key={dialog.id} difference={dialog} onClose={() => setDialog(undefined)} onDone={(text) => setReceipt(text)} />}
      <p className="prototype-note">{t('feed.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The four numbers of the worklist, each with its "i": what is open, what is large, what was settled, how many figures were compared. */
function Counts({ page }: { page: DifferencePage | undefined }) {
  const { t, locale } = useTranslation();
  if (page === undefined) return null;
  const asOf = vietnamStamp(page.asOf);
  const figure = (name: string, formula: string) => <Figure name={name} formula={formula} source={t('feed.diff.figure.source')} asOf={asOf} />;
  return (
    <KpiStrip label={t('feed.diff.counts.group.label')}>
      <KpiTile label={t('feed.diff.counts.open.label')} value={numberText(page.counts.open, locale)} tone={page.counts.open > 0 ? 'warning' : 'default'} sub={figure(t('feed.diff.counts.open.label'), t('feed.diff.figure.open.formula'))} />
      <KpiTile label={t('feed.diff.counts.large.label')} value={numberText(page.counts.openLarge, locale)} tone={page.counts.openLarge > 0 ? 'danger' : 'default'} sub={figure(t('feed.diff.counts.large.label'), t('feed.diff.figure.large.formula'))} />
      <KpiTile label={t('feed.diff.counts.resolved.label')} value={numberText(page.counts.resolved, locale)} sub={figure(t('feed.diff.counts.resolved.label'), t('feed.diff.figure.resolved.formula'))} />
      <KpiTile label={t('feed.diff.counts.compared.label')} value={numberText(page.counts.figuresCompared, locale)} unit={t('feed.diff.counts.compared.unit')} sub={figure(t('feed.diff.counts.compared.label'), t('feed.diff.figure.compared.formula'))} />
    </KpiStrip>
  );
}

/** Runs the comparison of the feed with our figures for a fiscal year, with an owner for the items it opens (the caller when none is named). */
function ReconcileSection({ canRun, defaultYear }: { canRun: boolean; defaultYear: string }) {
  const { t, locale } = useTranslation();
  const reconcile = useReconcile();
  const [form, setForm] = useState<ReconcileForm>({ fiscalYear: defaultYear, ownerId: '' });
  const [touched, setTouched] = useState(false);
  const [errors, setErrors] = useState<ReconcileErrors>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [result, setResult] = useState<Reconciliation | undefined>(undefined);
  // The year follows the connection until the person types one.
  useEffect(() => {
    if (!touched) setForm((previous) => ({ ...previous, fiscalYear: defaultYear }));
  }, [defaultYear, touched]);
  const change = (key: keyof ReconcileForm, value: string): void => {
    if (key === 'fiscalYear') setTouched(true);
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors({});
    setProblem(undefined);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (reconcile.isPending) return;
    const found = validateReconcile(form);
    setErrors(found);
    setProblem(undefined);
    setResult(undefined);
    if (Object.keys(found).length > 0) return;
    reconcile.mutate(reconcileBody(form), {
      onSuccess: (done) => setResult(done),
      onError: (failure) => setProblem(describeProblem(failure)),
    });
  };
  return (
    <SectionCard title={t('feed.diff.reconcile.title')}>
      <p className="feed-note">{t('feed.diff.reconcile.intro.text')}</p>
      {canRun ? (
        <form className="feed-filters" aria-label={t('feed.diff.reconcile.form.label')} onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="feed-reconcile-year">{t('feed.diff.reconcile.year.label')}</label>
            <input id="feed-reconcile-year" inputMode="numeric" value={form.fiscalYear} aria-invalid={errors.fiscalYear !== undefined} onChange={(event) => change('fiscalYear', event.target.value)} />
            {errors.fiscalYear !== undefined && <span className="feed-error">{reconcileIssueLabel(t, errors.fiscalYear)}</span>}
          </div>
          <div className="field">
            <label htmlFor="feed-reconcile-owner">{t('feed.diff.reconcile.owner.label')}</label>
            <input id="feed-reconcile-owner" value={form.ownerId} autoComplete="off" aria-invalid={errors.ownerId !== undefined} onChange={(event) => change('ownerId', event.target.value)} />
            <span className="sub">{t('feed.diff.reconcile.owner.hint')}</span>
            {errors.ownerId !== undefined && <span className="feed-error">{reconcileIssueLabel(t, errors.ownerId)}</span>}
          </div>
          <button type="submit" className="ui-button ui-button--primary" disabled={reconcile.isPending}>
            {reconcile.isPending ? t('feed.diff.reconcile.run.pending') : t('feed.diff.reconcile.run.action')}
          </button>
        </form>
      ) : (
        <p className="feed-none" data-testid="reconcile-blocked">
          {t('feed.diff.reconcile.blocked.text')}
        </p>
      )}
      {problem !== undefined && <ProblemNote problem={problem} />}
      {result !== undefined && (
        <div data-testid="reconcile-result">
          <p className="callout feed-receipt" role="status">
            {t('feed.diff.reconcile.result.text', {
              year: result.fiscalYear,
              projects: numberText(result.projectsCompared, locale),
              figures: numberText(result.figuresCompared, locale),
              opened: numberText(result.opened, locale),
              large: numberText(result.openedLarge, locale),
              existing: numberText(result.existing, locale),
            })}
          </p>
          {result.skippedOwnerIsMaker > 0 && (
            <p className="callout warning" role="status" data-testid="reconcile-skipped">
              {t('feed.diff.reconcile.skipped.text', { count: result.skippedOwnerIsMaker })}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

/** The state, the size, the year and the free text, in the address so that a link keeps the view. */
function FilterBar({ filters, onChange }: { filters: DifferenceFilters; onChange: (next: DifferenceFilters) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(filters.q ?? '');
  const [year, setYear] = useState(filters.fiscalYear === undefined ? '' : String(filters.fiscalYear));
  useEffect(() => setText(filters.q ?? ''), [filters.q]);
  useEffect(() => setYear(filters.fiscalYear === undefined ? '' : String(filters.fiscalYear)), [filters.fiscalYear]);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const next: DifferenceFilters = { ...filters };
    if (text.trim() === '') delete next.q;
    else next.q = text.trim();
    const parsed = Number(year.trim());
    if (year.trim() === '' || !Number.isInteger(parsed)) delete next.fiscalYear;
    else next.fiscalYear = parsed;
    onChange(next);
  };
  return (
    <form className="feed-filters" role="search" aria-label={t('feed.diff.filter.group.label')} onSubmit={submit}>
      <div className="field">
        <label htmlFor="feed-diff-state">{t('feed.diff.filter.state.label')}</label>
        <select
          id="feed-diff-state"
          value={filters.state ?? ''}
          onChange={(event) => {
            const next: DifferenceFilters = { ...filters };
            if (event.target.value === 'OPEN' || event.target.value === 'RESOLVED') next.state = event.target.value;
            else delete next.state;
            onChange(next);
          }}
        >
          <option value="">{t('feed.diff.filter.all.option')}</option>
          <option value="OPEN">{t('feed.diff.state.open')}</option>
          <option value="RESOLVED">{t('feed.diff.state.resolved')}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="feed-diff-large">{t('feed.diff.filter.large.label')}</label>
        <select
          id="feed-diff-large"
          value={filters.large === undefined ? '' : String(filters.large)}
          onChange={(event) => {
            const next: DifferenceFilters = { ...filters };
            if (event.target.value === 'true') next.large = true;
            else if (event.target.value === 'false') next.large = false;
            else delete next.large;
            onChange(next);
          }}
        >
          <option value="">{t('feed.diff.filter.all.option')}</option>
          <option value="true">{t('feed.diff.filter.large.only')}</option>
          <option value="false">{t('feed.diff.filter.large.not')}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="feed-diff-year">{t('feed.diff.filter.year.label')}</label>
        <input id="feed-diff-year" inputMode="numeric" value={year} onChange={(event) => setYear(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="feed-diff-q">{t('feed.diff.filter.q.label')}</label>
        <input id="feed-diff-q" type="search" value={text} autoComplete="off" onChange={(event) => setText(event.target.value)} />
      </div>
      <button type="submit" className="ui-button ui-button--outline">
        {t('feed.diff.filter.apply.action')}
      </button>
    </form>
  );
}

function columns(t: T, locale: string, page: DifferencePage | undefined, mayResolve: boolean, now: Date, open: (row: Difference) => void): Array<DataTableColumn<Difference>> {
  const asOf = vietnamStamp(page?.asOf ?? null);
  const none = t('feed.diff.cell.none');
  return [
    {
      key: 'project',
      header: t('feed.diff.column.project'),
      pinned: true,
      render: (row) => (
        <span className="feed-cell">
          <span className="feed-code">{row.feedProjectCode}</span>
          <small>{row.ourCode === null ? t('feed.diff.cell.noOurCode') : row.ourCode}</small>
        </span>
      ),
    },
    {
      key: 'field',
      header: t('feed.diff.column.field'),
      render: (row) => (
        <span className="feed-cell">
          <span>{differenceFieldLabel(t, row.field)}</span>
          <small>{row.fiscalYear}</small>
        </span>
      ),
    },
    { key: 'feed', header: t('feed.diff.column.feed'), align: 'right', render: (row) => <span className="feed-num">{amountText(row.feedValue, locale)}</span> },
    { key: 'ours', header: t('feed.diff.column.ours'), align: 'right', render: (row) => (row.ourValue === null ? t('feed.diff.cell.missingOurs') : <span className="feed-num">{amountText(row.ourValue, locale)}</span>) },
    {
      key: 'delta',
      header: t('feed.diff.column.delta'),
      align: 'right',
      render: (row) => (
        <span className="feed-num">
          {row.delta === null ? DASH : amountText(row.delta, locale)}{' '}
          <Figure
            name={t('feed.diff.figure.delta.name')}
            formula={t('feed.diff.figure.delta.formula')}
            source={t('feed.diff.figure.source')}
            asOf={asOf}
            version={t('feed.diff.figure.delta.version', { field: differenceFieldLabel(t, row.field) })}
          />
        </span>
      ),
    },
    { key: 'pct', header: t('feed.diff.column.pct'), align: 'right', render: (row) => (row.deltaPct === null ? DASH : <span className="feed-num">{percentText(row.deltaPct, locale)}</span>) },
    { key: 'size', header: t('feed.diff.column.size'), render: (row) => (row.large ? <StatusPill tone="danger" icon="!">{t('feed.diff.size.large')}</StatusPill> : <StatusPill tone="neutral">{t('feed.diff.size.normal')}</StatusPill>) },
    { key: 'owner', header: t('feed.diff.column.owner'), render: (row) => row.ownerName ?? none },
    {
      key: 'due',
      header: t('feed.diff.column.due'),
      render: (row) => (isOverdue(row, now) ? <span className="feed-overdue" data-testid="overdue">{t('feed.diff.due.overdue', { day: dayText(row.dueAt) })}</span> : dayText(row.dueAt)),
    },
    {
      key: 'state',
      header: t('feed.diff.column.state'),
      render: (row) =>
        row.resolution === null ? (
          <StatusPill tone="info" icon="◔">
            {t('feed.diff.state.open')}
          </StatusPill>
        ) : (
          <span className="feed-cell" data-testid="resolution">
            <StatusPill tone="success" icon="✓">
              {resolutionLabel(t, row.resolution.kind)}
            </StatusPill>
            <small>{t('feed.diff.resolution.by', { name: row.resolution.resolvedByName ?? none, day: dayText(row.resolution.resolvedAt) })}</small>
            {row.resolution.reason !== null && <small>{t('feed.diff.resolution.reason', { reason: row.resolution.reason })}</small>}
            {row.resolution.evidenceRef !== null && <small>{t('feed.diff.resolution.evidence', { ref: row.resolution.evidenceRef })}</small>}
            {row.resolution.reviewOn !== null && <small>{t('feed.diff.resolution.review', { day: dayText(row.resolution.reviewOn) })}</small>}
          </span>
        ),
    },
    {
      key: 'actions',
      header: t('feed.diff.column.actions'),
      render: (row) =>
        row.state === 'OPEN' && mayResolve && row.canResolve ? (
          <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('feed.diff.action.resolve.label', { code: row.feedProjectCode, field: differenceFieldLabel(t, row.field) })} onClick={() => open(row)}>
            {t('feed.diff.action.resolve')}
          </button>
        ) : row.state === 'OPEN' ? (
          <span className="feed-words" data-testid="maker-words">
            {t('feed.diff.row.makerWords')}
          </span>
        ) : (
          DASH
        ),
    },
  ];
}
