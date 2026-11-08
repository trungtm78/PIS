import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { instantDay } from './mapping-model';
import { ResolveDialog } from './ReconcileDialogs';
import { CountInfo, DeltaInfo, DueInfo } from './ReconcileInfo';
import { useReconcileItems, useRunReconciliation } from './reconcile-hooks';
import { deltaText, differenceLabel, fieldLabel, followUpText, resolutionLabel, stateLabel, subjectLabel, valueText } from './reconcile-labels';
import { RECONCILE_PERMISSION, SUBJECTS, appliedCount, filtersOf, searchOf, totalOf } from './reconcile-model';
import type { Filters, ReconcileItem, ReconcilePage, ReconcileSubject, RunResult } from './reconcile-model';
import './reconcile.css';

type T = Translator['t'];

const NEVER_EMPTY = (): boolean => false;
const BID_IMPORT_PATH = '/bid/bid-24';

/**
 * BID-33, "Reconciliation with the national procurement network" (EGP-2): every field on which our register and what a file of the network said disagree, as an item with an owner who did not make the record and one of four
 * resolutions (accept the figure of the network, correct ours, dispute, waive). The resolution edits nothing of another module: the owner of the record changes it through its own command. The files the figures come from
 * have a layout that is a working assumption (PENDING-EXTERNAL), and the due time comes from a rule whose numbers are ours until the agency approves its own.
 */
export default function ReconciliationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The filters, the dialog and the receipt belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReconciliationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

const dayOf = (instant: string): string => (instant === '' ? '' : instantDay(instant));

function ReconciliationContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search), [search]);
  const list = useReconcileItems(filters);
  const run = useRunReconciliation();
  const [dialog, setDialog] = useState<ReconcileItem | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<RunResult | undefined>(undefined);
  const [runFailed, setRunFailed] = useState(false);

  const frozen = mode === 'READ_ONLY';
  const pages = list.data?.pages;
  const first = pages?.[0];
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: NEVER_EMPTY });
  const applied = appliedCount(filters);
  const denied = state === 'denied';
  const mayRun = first !== undefined && first.canRun && (permissions === undefined || permissions.includes(RECONCILE_PERMISSION)) && !frozen;
  const refreshFailed = list.isError && !list.isFetchNextPageError && list.data !== undefined;
  const asOf = first === undefined ? undefined : `${dayOf(first.asOf)}`;

  const change = (next: Filters): void => setSearch(searchOf(next));
  const runNow = (): void => {
    setReceipt(undefined);
    setOutcome(undefined);
    setRunFailed(false);
    run.mutate(
      { subject: filters.subject_type },
      {
        onSuccess: (result) => {
          setOutcome(result);
          setReceipt(t('egp.reconcile.success.run', { examined: result.examined, differences: result.differences, opened: result.opened, unchanged: result.unchanged, settled: result.settledAlready }));
        },
        onError: () => setRunFailed(true),
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('egp.reconcile.page.title')}</h1>
          <p>{t('egp.reconcile.page.subtitle')}</p>
          <div className="reconcile-badges">
            <span className="bid-badge warning" data-testid="assumption-badge">
              {t('egp.reconcile.badge.assumption')}
            </span>
          </div>
        </div>
        {mayRun && !denied && (
          <div className="actions reconcile-actions">
            <button type="button" className="ui-button ui-button--primary" data-testid="run-button" disabled={run.isPending} onClick={runNow}>
              {run.isPending ? t('egp.reconcile.action.running') : filters.subject_type === undefined ? t('egp.reconcile.action.run') : t('egp.reconcile.action.runSubject', { subject: subjectLabel(t, filters.subject_type) })}
            </button>
          </div>
        )}
      </div>
      <ContextBar
        items={[
          { label: t('egp.reconcile.context.scope.label'), value: tenant?.name ?? t('egp.reconcile.cell.none') },
          { label: t('egp.reconcile.context.rule.label'), value: first === undefined ? t('egp.reconcile.cell.none') : t('egp.reconcile.context.rule.value', { days: first.dueRule.days }) },
        ]}
        {...(asOf === undefined ? {} : { asOf })}
        stale={refreshFailed}
      />
      <p className="callout" data-testid="maker-note">
        {t('egp.reconcile.note.maker')}
      </p>
      {first !== undefined && first.dueRule.unverified && !denied && (
        <p className="callout" data-testid="unverified-note">
          <span>{t('egp.reconcile.note.unverified', { days: first.dueRule.days })}</span> <DueInfo page={first} />
        </p>
      )}
      {receipt !== undefined && (
        <p className="callout reconcile-receipt" role="status" data-testid="receipt">
          {receipt}
        </p>
      )}
      {outcome !== undefined && outcome.noOwner > 0 && (
        <p className="callout" role="status" data-testid="no-owner-note">
          {t('egp.reconcile.note.noOwner', { count: outcome.noOwner })}
        </p>
      )}
      {runFailed && (
        <p className="callout" role="alert" data-testid="run-error">
          {t('egp.reconcile.run.error')}
        </p>
      )}
      {!mayRun && !denied && first !== undefined && (
        <p className="callout" role="status" data-testid="readonly-note">
          {frozen ? t('egp.reconcile.readonly.mode') : t('egp.reconcile.readonly.right')}
        </p>
      )}
      {denied ? (
        <div className="reconcile-state reconcile-state--denied" role="alert" data-testid="denied">
          <h2>{t('egp.reconcile.denied.title')}</h2>
          <p>{t('egp.reconcile.denied.body')}</p>
        </div>
      ) : (
        <SectionCard title={t('egp.reconcile.list.title')} status={first === undefined ? undefined : <span>{t('egp.reconcile.list.asOf', { day: dayOf(first.asOf) })}</span>}>
          {first !== undefined && (
            <>
              <p className="reconcile-summary" data-testid="summary">
                <span>{t('egp.reconcile.summary.text', { open: first.counts.open, overdue: first.counts.overdue, waivers: first.counts.waiversDue })}</span>
                <CountInfo page={first} />
              </p>
              {(totalOf(first.counts) > 0 || applied > 0) && <Chips filters={filters} page={first} onChange={change} />}
            </>
          )}
          <FilterBar filters={filters} onChange={change} />
          {state === 'error' || state === 'offline' || state === 'signedOut' || state === 'expired' ? (
            <div className="reconcile-state reconcile-state--error" role="alert" data-testid="error">
              <h2>{t('egp.reconcile.error.title')}</h2>
              <p>{t('egp.reconcile.error.body')}</p>
              <button type="button" className="ui-button ui-button--outline" onClick={() => void list.refetch()}>
                {t('states.retry.action')}
              </button>
            </div>
          ) : first !== undefined && applied === 0 && totalOf(first.counts) === 0 && rows.length === 0 ? (
            <div className="reconcile-state" role="status" data-testid="empty">
              <h2>{t('egp.reconcile.empty.title')}</h2>
              <p>{t('egp.reconcile.empty.body')}</p>
              <Link to={BID_IMPORT_PATH}>{t('egp.reconcile.empty.import.link')}</Link>
            </div>
          ) : (
            <>
              <DataTable
                caption={t('egp.reconcile.table.caption')}
                columns={columns(t, first, !frozen, (item) => {
                  setReceipt(undefined);
                  setDialog(item);
                })}
                rows={rows}
                rowKey={(row) => row.id}
                rowAttrs={(row) => ({ 'data-item-id': row.id, 'data-state': row.state, 'data-field': row.field })}
                severity={(row) => (row.state === 'OPEN' && row.overdue ? 'URGENT' : null)}
                state={state === 'loading' ? 'loading' : 'ready'}
                emptyKind={applied > 0 ? 'filtered' : 'none'}
                onClearFilters={() => change({})}
              />
              {first !== undefined && (
                <div className="reconcile-more">
                  <span className="sub" role="status" data-testid="shown">
                    {t('egp.reconcile.paging.summary', { shown: rows.length })}
                  </span>
                  {list.isFetchNextPageError && <span role="alert">{t('egp.reconcile.paging.error')}</span>}
                  {list.hasNextPage && (
                    <button type="button" className="ui-button ui-button--outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                      {list.isFetchingNextPage ? t('egp.reconcile.paging.loading') : t('egp.reconcile.paging.more')}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </SectionCard>
      )}
      <ResolveDialog item={dialog} onClose={() => setDialog(undefined)} onDone={(text) => setReceipt(text)} />
      <p className="prototype-note">{t('egp.reconcile.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The state of the items as chips, each with its count: a press sets the view in the address, "all" clears it. */
function Chips({ filters, page, onChange }: { filters: Filters; page: ReconcilePage; onChange: (next: Filters) => void }) {
  const { t } = useTranslation();
  const choose = (patch: Pick<Filters, 'state' | 'overdue'>): void => {
    const next: Filters = { ...filters };
    delete next.state;
    delete next.overdue;
    onChange({ ...next, ...patch });
  };
  const all = filters.state === undefined && filters.overdue !== true;
  return (
    <fieldset className="reconcile-chips">
      <legend>{t('egp.reconcile.chip.group.label')}</legend>
      <button type="button" className="reconcile-chip" aria-pressed={all} onClick={() => choose({})}>
        {t('egp.reconcile.chip.all', { count: totalOf(page.counts) })}
      </button>
      <button type="button" className="reconcile-chip" aria-pressed={filters.state === 'OPEN'} onClick={() => choose({ state: 'OPEN' })}>
        {t('egp.reconcile.chip.open', { count: page.counts.open })}
      </button>
      <button type="button" className="reconcile-chip" aria-pressed={filters.state === 'RESOLVED'} onClick={() => choose({ state: 'RESOLVED' })}>
        {t('egp.reconcile.chip.resolved', { count: page.counts.resolved })}
      </button>
      <button type="button" className="reconcile-chip" aria-pressed={filters.overdue === true} onClick={() => choose({ overdue: true })}>
        {t('egp.reconcile.chip.overdue', { count: page.counts.overdue })}
      </button>
    </fieldset>
  );
}

/** The kind of subject and "only mine"; the state is the chips. They live in the address, so a link keeps the view. */
function FilterBar({ filters, onChange }: { filters: Filters; onChange: (next: Filters) => void }) {
  const { t } = useTranslation();
  return (
    <form className="reconcile-filters" role="search" aria-label={t('egp.reconcile.filter.group.label')} onSubmit={(event) => event.preventDefault()}>
      <div className="field">
        <label htmlFor="reconcile-filter-subject">{t('egp.reconcile.filter.subject.label')}</label>
        <select
          id="reconcile-filter-subject"
          value={filters.subject_type ?? ''}
          onChange={(event) => {
            const next: Filters = { ...filters };
            if (event.target.value === '') delete next.subject_type;
            else next.subject_type = event.target.value as ReconcileSubject;
            onChange(next);
          }}
        >
          <option value="">{t('egp.reconcile.filter.all.option')}</option>
          {SUBJECTS.map((subject) => (
            <option key={subject} value={subject}>
              {subjectLabel(t, subject)}
            </option>
          ))}
        </select>
      </div>
      <label className="reconcile-mine" htmlFor="reconcile-filter-mine">
        <input
          id="reconcile-filter-mine"
          type="checkbox"
          checked={filters.mine === true}
          onChange={(event) => {
            const next: Filters = { ...filters };
            if (event.target.checked) next.mine = true;
            else delete next.mine;
            onChange(next);
          }}
        />
        <span>{t('egp.reconcile.filter.mine.label')}</span>
      </label>
    </form>
  );
}

function columns(t: T, page: ReconcilePage | undefined, mayAct: boolean, open: (item: ReconcileItem) => void): Array<DataTableColumn<ReconcileItem>> {
  const none = t('egp.reconcile.cell.none');
  return [
    {
      key: 'subject',
      header: t('egp.reconcile.column.subject'),
      pinned: true,
      render: (row) => (
        <span className="reconcile-cell">
          <span>{subjectLabel(t, row.subjectType)}</span>
          <span className="reconcile-code">{row.subjectCode === '' ? none : row.subjectCode}</span>
          <small>{t('egp.reconcile.cell.external', { code: row.externalCode })}</small>
        </span>
      ),
    },
    {
      key: 'field',
      header: t('egp.reconcile.column.field'),
      render: (row) => (
        <span className="reconcile-cell">
          <span>{fieldLabel(t, row.field)}</span>
          <small>{differenceLabel(t, row.differenceKind)}</small>
        </span>
      ),
    },
    { key: 'ours', header: t('egp.reconcile.column.ours'), align: 'right', render: (row) => <Figure text={(locale) => valueText(t, locale, row.field, row.ours)} /> },
    { key: 'theirs', header: t('egp.reconcile.column.theirs'), align: 'right', render: (row) => <Figure text={(locale) => valueText(t, locale, row.field, row.theirs)} /> },
    {
      key: 'delta',
      header: t('egp.reconcile.column.delta'),
      align: 'right',
      render: (row) => <Figure text={(locale) => deltaText(locale, row.field, row.delta) ?? none} info={row.delta !== null && page !== undefined ? <DeltaInfo page={page} /> : undefined} />,
    },
    { key: 'owner', header: t('egp.reconcile.column.owner'), render: (row) => row.ownerName ?? none },
    {
      key: 'due',
      header: t('egp.reconcile.column.due'),
      render: (row) => (
        <span className="reconcile-cell">
          <span>{dayOf(row.dueAt)}</span>
          {row.overdue && row.state === 'OPEN' && <StatusPill tone="danger" icon="!">{t('egp.reconcile.cell.overdue')}</StatusPill>}
        </span>
      ),
    },
    {
      key: 'resolution',
      header: t('egp.reconcile.column.resolution'),
      render: (row) => {
        const resolution = row.resolution;
        if (resolution === null) {
          return (
            <StatusPill tone="info" icon="◔">
              {stateLabel(t, row.state)}
            </StatusPill>
          );
        }
        const follow = followUpText(t, resolution.followUp);
        return (
          <span className="reconcile-resolution" data-testid="resolution">
            <StatusPill tone="success" icon="✓">
              {resolutionLabel(t, resolution.kind)}
            </StatusPill>
            <small>{t('egp.reconcile.cell.resolved', { name: resolution.resolvedByName ?? none, day: resolution.resolvedAt === null ? none : dayOf(resolution.resolvedAt) })}</small>
            <small>{t('egp.reconcile.cell.reason', { reason: resolution.reason })}</small>
            {resolution.evidenceRef !== null && <small>{t('egp.reconcile.cell.evidence', { evidence: resolution.evidenceRef })}</small>}
            {resolution.reviewOn !== null && <small>{t('egp.reconcile.cell.review', { day: instantDay(resolution.reviewOn) })}</small>}
            {follow !== '' && <small>{follow}</small>}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: t('egp.reconcile.column.actions'),
      render: (row) => (
        <span className="reconcile-row-actions">
          {mayAct && row.canResolve && row.state === 'OPEN' && (
            <button type="button" className="ui-button ui-button--primary ui-button--small" aria-label={t('egp.reconcile.row.resolve.label', { subject: subjectLabel(t, row.subjectType), code: row.subjectCode, field: fieldLabel(t, row.field) })} onClick={() => open(row)}>
              {t('egp.reconcile.row.resolve.action')}
            </button>
          )}
          {row.state === 'OPEN' && row.isMaker && (
            <span className="reconcile-words" data-testid="maker-words">
              {t('egp.reconcile.row.maker')}
            </span>
          )}
        </span>
      ),
    },
  ];
}

/** A figure with the thousands marked by the locale, and its "i" when it has one. */
function Figure({ text, info }: { text: (locale: string) => string; info?: ReactNode }) {
  const { locale } = useTranslation();
  return (
    <span className="reconcile-number">
      <span>{text(locale)}</span>
      {info}
    </span>
  );
}
