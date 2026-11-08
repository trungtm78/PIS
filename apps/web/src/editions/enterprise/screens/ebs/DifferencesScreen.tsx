import { useId, useState } from 'react';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, InfoFormula, ReadonlyStat, SectionCard, StatusPill } from '../../../../ui';
import type { DataTableColumn } from '../../../../ui';
import { dayText, failureCode, moneyText, numberText, vietnamStamp } from '../shared/format';
import { AcceptanceBadge, Field, ReadonlyNote } from '../shared/parts';
import { useEbsConnection, useEbsDifferences, useReassignEbsDifference, useReconcileEbs, useResolveEbsDifference } from './hooks';
import { differenceKindLabel, ebsErrorText, measureLabel, resolutionHint, resolutionLabel, stateLabel } from './labels';
import {
  EMPTY_RECONCILE_FORM,
  EMPTY_RESOLVE_FORM,
  NO_FILTERS,
  RESOLUTION_KINDS,
  UUID_PATTERN,
  gapSign,
  isFiltered,
  needsEvidence,
  needsReview,
  reconcileBody,
  reconcileProblems,
  resolveBody,
  resolveProblems,
  vietnamDay,
} from './model';
import type { Difference, Filters, ReconcileForm, Reconciled, ResolveForm } from './model';
import '../shared/shared.css';

/**
 * EBS-02, the differences between our figures and the statement of Oracle EBS, by project code (ENT-2): each difference is an item with an owner who is not one of the people who made the figures and a due time; the owner
 * explains it (ours is wrong, EBS is wrong, a timing difference, accepted with a reason) and the item closes. Amounts are exact decimals as the server wrote them. The layout of the file is a working assumption: PENDING-EXTERNAL.
 */
export default function DifferencesScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DifferencesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'reconcile' } | { kind: 'resolve'; difference: Difference } | { kind: 'reassign'; difference: Difference } | undefined;

function DifferencesContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode } = useSession();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const ids = useId();
  const query = useEbsDifferences(filters);
  const connection = useEbsConnection();
  const [dialog, setDialog] = useState<Dialog>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [reconciled, setReconciled] = useState<Reconciled | undefined>(undefined);
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = query.data?.pages[0]?.counts;
  const state = useScreenState({ isLoading: query.isLoading, error: rows.length === 0 ? query.error : undefined, data: query.data === undefined ? undefined : rows, isEmpty: (data) => Array.isArray(data) && data.length === 0 });
  const refreshFailed = query.isError && rows.length > 0;
  const asOf = vietnamStamp(query.data?.pages[0]?.as_of);
  const readOnly = mode === 'READ_ONLY';
  const mayReconcile = connection.data?.actions.may_reconcile === true && !readOnly;
  const acceptance = connection.data?.acceptance ?? 'PENDING_EXTERNAL';
  const set = (patch: Partial<Filters>): void => setFilters((current) => ({ ...current, ...patch }));

  const columns: DataTableColumn<Difference>[] = [
    { key: 'project', header: t('ebs.differences.column.project'), pinned: true, render: (row) => row.project_code },
    { key: 'period', header: t('ebs.differences.column.period'), render: (row) => row.period },
    {
      key: 'measure',
      header: t('ebs.differences.column.measure'),
      render: (row) => (
        <span className="ent2-stack">
          {measureLabel(t, row.measure)}
          <span className="ent2-note">{differenceKindLabel(t, row.difference_kind)}</span>
        </span>
      ),
    },
    { key: 'ours', header: t('ebs.differences.column.ours'), align: 'right', render: (row) => (row.ours === null ? t('ebs.differences.ours.none') : moneyText(row.ours, locale)) },
    { key: 'theirs', header: t('ebs.differences.column.theirs'), align: 'right', render: (row) => moneyText(row.theirs, locale) },
    {
      key: 'delta',
      header: t('ebs.differences.column.delta'),
      align: 'right',
      render: (row) => (
        <span data-testid={`delta-${row.id}`} data-sign={gapSign(row.delta)}>
          {row.delta === null ? '–' : `${gapSign(row.delta) === 'PLUS' ? '+' : ''}${moneyText(row.delta, locale)}`}
        </span>
      ),
    },
    { key: 'owner', header: t('ebs.differences.column.owner'), render: (row) => row.owner_name ?? '–' },
    {
      key: 'due',
      header: t('ebs.differences.column.due'),
      render: (row) => (
        <span className="ent2-stack">
          {dayText(row.due_at)}
          {row.overdue && <StatusPill tone="danger">{t('ebs.differences.overdue.badge')}</StatusPill>}
        </span>
      ),
    },
    {
      key: 'state',
      header: t('ebs.differences.column.state'),
      render: (row) => (
        <span className="ent2-stack">
          <StatusPill tone={row.state === 'OPEN' ? 'warning' : 'success'}>{stateLabel(t, row.state)}</StatusPill>
          {row.resolution !== null && <span className="ent2-note">{resolutionLabel(t, row.resolution.kind)}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('ebs.differences.column.actions'),
      render: (row) => (
        <span className="ent2-row-actions">
          {row.actions.may_resolve && !readOnly && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`resolve-${row.id}`} onClick={() => { setNote(undefined); setDialog({ kind: 'resolve', difference: row }); }}>
              {t('ebs.differences.resolve.action')}
            </button>
          )}
          {row.actions.may_reassign && !readOnly && (
            <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`reassign-${row.id}`} onClick={() => { setNote(undefined); setDialog({ kind: 'reassign', difference: row }); }}>
              {t('ebs.differences.reassign.action')}
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ebs.differences.page.title')}</h1>
          <p>{t('ebs.differences.page.subtitle')}</p>
        </div>
        <div className="actions">
          <AcceptanceBadge acceptance={acceptance} />
          {mayReconcile && (
            <button type="button" className="ui-button ui-button--primary" data-testid="reconcile-button" onClick={() => { setNote(undefined); setReconciled(undefined); setDialog({ kind: 'reconcile' }); }}>
              {t('ebs.differences.header.reconcile.action')}
            </button>
          )}
        </div>
      </div>
      <ContextBar items={[{ label: t('ebs.context.scope.label'), value: tenant?.name ?? '–' }]} {...(asOf === '' ? {} : { asOf })} stale={refreshFailed} />
      {note !== undefined && (
        <p className="callout ent2-receipt" role="status" data-testid="action-receipt">
          {note}
        </p>
      )}
      {reconciled !== undefined && (
        <p className="callout ent2-receipt" role="status" data-testid="reconcile-result">
          {t('ebs.differences.reconcile.result.text', { examined: reconciled.examined, opened: reconciled.opened, refreshed: reconciled.refreshed, unchanged: reconciled.unchanged, settled: reconciled.settled_already, none: reconciled.no_owner })}
        </p>
      )}
      {readOnly && <ReadonlyNote block="MODE" />}
      {!readOnly && connection.data !== undefined && !mayReconcile && !connection.data.actions.may_import && <ReadonlyNote block="RIGHT" />}
      {counts !== undefined && (
        <ul className="ent2-stats" data-testid="difference-counts">
          <li>
            <ReadonlyStat label={t('ebs.counts.open.label')} value={numberText(counts.open, locale)} tone={counts.open > 0 ? 'warning' : 'neutral'} />
          </li>
          <li>
            <ReadonlyStat label={t('ebs.counts.overdue.label')} value={numberText(counts.overdue, locale)} tone={counts.overdue > 0 ? 'danger' : 'neutral'} />
          </li>
          <li>
            <ReadonlyStat label={t('ebs.counts.resolved.label')} value={numberText(counts.resolved, locale)} tone="success" />
          </li>
          <li>
            <ReadonlyStat label={t('ebs.differences.counts.reviews.label')} value={numberText(counts.reviews_due, locale)} tone={counts.reviews_due > 0 ? 'info' : 'neutral'} />
          </li>
        </ul>
      )}
      <div className="ent2-filter" role="search" aria-label={t('ebs.differences.filter.label')}>
        <div className="ent2-field">
          <label htmlFor={`${ids}-state`}>{t('ebs.differences.filter.state.label')}</label>
          <select id={`${ids}-state`} value={filters.state ?? ''} onChange={(event) => set({ state: event.target.value === 'OPEN' ? 'OPEN' : event.target.value === 'RESOLVED' ? 'RESOLVED' : undefined })} data-testid="filter-state">
            <option value="">{t('ebs.differences.filter.state.all')}</option>
            <option value="OPEN">{stateLabel(t, 'OPEN')}</option>
            <option value="RESOLVED">{stateLabel(t, 'RESOLVED')}</option>
          </select>
        </div>
        <div className="ent2-field">
          <label htmlFor={`${ids}-project`}>{t('ebs.differences.filter.project.label')}</label>
          <input id={`${ids}-project`} value={filters.projectCode} onChange={(event) => set({ projectCode: event.target.value })} data-testid="filter-project" />
        </div>
        <div className="ent2-field">
          <label htmlFor={`${ids}-period`}>{t('ebs.differences.filter.period.label')}</label>
          <input id={`${ids}-period`} value={filters.period} onChange={(event) => set({ period: event.target.value })} data-testid="filter-period" />
        </div>
        <label className="ent2-check">
          <input type="checkbox" checked={filters.overdue} onChange={(event) => set({ overdue: event.target.checked })} data-testid="filter-overdue" />
          {t('ebs.differences.filter.overdue.label')}
        </label>
      </div>
      <StateBoundary state={isFiltered(filters) && state === 'empty' ? 'default' : state} onRetry={() => void query.refetch()}>
        <SectionCard
          title={t('ebs.differences.section.title')}
          status={
            <InfoFormula
              name={t('ebs.differences.figure.name')}
              formula={t('ebs.differences.figure.formula')}
              source={t('ebs.differences.figure.source')}
              asOf={asOf}
              owner={t('ent.info.owner.text')}
              version={t('ebs.differences.figure.version')}
              unverified
              labels={{
                open: t('ent.info.open.label', { name: t('ebs.differences.figure.name') }),
                close: t('ent.info.close.label'),
                formula: t('ent.info.formula.label'),
                numerator: t('ent.info.numerator.label'),
                denominator: t('ent.info.denominator.label'),
                exclusions: t('ent.info.exclusions.label'),
                source: t('ent.info.source.label'),
                asOf: t('ent.info.asOf.label'),
                owner: t('ent.info.owner.label'),
                version: t('ent.info.version.label'),
                unverified: t('ent.info.unverified.text'),
              }}
            />
          }
        >
          {rows.length === 0 ? (
            <p className="ent2-none" role="status" data-testid="differences-empty">
              {isFiltered(filters) ? t('ebs.differences.empty.filtered') : t('ebs.differences.empty.none')}
            </p>
          ) : (
            <DataTable caption={t('ebs.differences.section.title')} columns={columns} rows={rows} rowKey={(row) => row.id} severity={(row) => (row.overdue ? 'URGENT' : null)} rowAttrs={(row) => ({ 'data-difference-id': row.id, 'data-state': row.state })} />
          )}
          {query.hasNextPage && (
            <p className="ent2-more">
              <button type="button" className="ui-button ui-button--outline" disabled={query.isFetchingNextPage} data-testid="differences-more" onClick={() => void query.fetchNextPage()}>
                {t('ebs.differences.more.action')}
              </button>
            </p>
          )}
        </SectionCard>
      </StateBoundary>
      {dialog?.kind === 'reconcile' && (
        <ReconcileDialog
          onClose={() => setDialog(undefined)}
          onDone={(result) => {
            setDialog(undefined);
            setReconciled(result);
          }}
        />
      )}
      {dialog?.kind === 'resolve' && (
        <ResolveDialog
          difference={dialog.difference}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            setNote(t('ebs.differences.resolve.done'));
          }}
          onReload={() => void query.refetch()}
        />
      )}
      {dialog?.kind === 'reassign' && (
        <ReassignDialog
          difference={dialog.difference}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            setNote(t('ebs.differences.reassign.done'));
          }}
          onReload={() => void query.refetch()}
        />
      )}
      <p className="prototype-note">{t('ebs.differences.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function contextOf(difference: Difference, t: ReturnType<typeof useTranslation>['t'], locale: string): { label: string; value: string }[] {
  return [
    { label: t('ebs.differences.context.project.label'), value: `${difference.project_code} · ${difference.period}` },
    { label: t('ebs.differences.context.measure.label'), value: measureLabel(t, difference.measure) },
    { label: t('ebs.differences.context.figures.label'), value: t('ebs.differences.context.figures.value', { ours: difference.ours === null ? t('ebs.differences.ours.none') : moneyText(difference.ours, locale), theirs: moneyText(difference.theirs, locale) }) },
  ];
}

function ReconcileDialog({ onClose, onDone }: { onClose: () => void; onDone: (result: Reconciled) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const mutation = useReconcileEbs();
  const [form, setForm] = useState<ReconcileForm>(EMPTY_RECONCILE_FORM);
  const [problems, setProblems] = useState<ReturnType<typeof reconcileProblems>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('ebs.reconcile.dialog.title')}
      context={[{ label: t('ebs.reconcile.context.rule.label'), value: t('ebs.reconcile.context.rule.value') }]}
      confirmLabel={t('ebs.reconcile.dialog.confirm')}
      cancelLabel={t('ebs.dialog.cancel.action')}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const found = reconcileProblems(form);
        setProblems(found);
        if (Object.keys(found).length > 0) {
          setError(t('ent.error.validation.text'));
          return;
        }
        setError(undefined);
        mutation.mutateAsync(reconcileBody(form)).then(onDone, (failure: unknown) => setError(ebsErrorText(t, failure)));
      }}
    >
      <Field id={`${id}-period`} label={t('ebs.reconcile.field.period.label')} problem={problems.period} hint={t('ebs.reconcile.field.period.hint')}>
        <input id={`${id}-period`} value={form.period} onChange={(event) => setForm((current) => ({ ...current, period: event.target.value }))} aria-invalid={problems.period !== undefined} data-testid="reconcile-period" />
      </Field>
      <Field id={`${id}-owner`} label={t('ebs.reconcile.field.owner.label')} problem={problems.ownerId} hint={t('ebs.reconcile.field.owner.hint')}>
        <input id={`${id}-owner`} value={form.ownerId} onChange={(event) => setForm((current) => ({ ...current, ownerId: event.target.value }))} aria-invalid={problems.ownerId !== undefined} data-testid="reconcile-owner" />
      </Field>
    </ConfirmDialog>
  );
}

function ResolveDialog({ difference, onClose, onDone, onReload }: { difference: Difference; onClose: () => void; onDone: () => void; onReload: () => void }) {
  const { t, locale } = useTranslation();
  const id = useId();
  const mutation = useResolveEbsDifference();
  const [form, setForm] = useState<ResolveForm>(EMPTY_RESOLVE_FORM);
  const [problems, setProblems] = useState<ReturnType<typeof resolveProblems>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('ebs.resolve.dialog.title')}
      context={contextOf(difference, t, locale)}
      confirmLabel={t('ebs.resolve.dialog.confirm')}
      cancelLabel={t('ebs.dialog.cancel.action')}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const found = resolveProblems(form, vietnamDay(new Date()));
        setProblems(found);
        if (Object.keys(found).length > 0) {
          setError(t('ent.error.validation.text'));
          return;
        }
        setError(undefined);
        mutation.mutateAsync({ id: difference.id, version: difference.version, body: resolveBody(form) }).then(onDone, (failure: unknown) => {
          setError(ebsErrorText(t, failure));
          if (failureCode(failure) === 'VERSION_CONFLICT') onReload();
        });
      }}
    >
      <fieldset className="ent2-choice">
        <legend>{t('ebs.resolve.field.kind.label')}</legend>
        {RESOLUTION_KINDS.map((kind) => (
          <label key={kind}>
            <input type="radio" name={`${id}-kind`} checked={form.kind === kind} onChange={() => setForm((current) => ({ ...current, kind }))} data-testid={`kind-${kind}`} />
            {resolutionLabel(t, kind)}
          </label>
        ))}
        <span className="ent2-field__hint" data-testid="kind-hint">
          {resolutionHint(t, form.kind)}
        </span>
      </fieldset>
      <Field id={`${id}-reason`} label={t('ebs.resolve.field.reason.label')} problem={problems.reason} hint={t('ebs.resolve.field.reason.hint')}>
        <textarea id={`${id}-reason`} rows={3} value={form.reason} onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))} aria-invalid={problems.reason !== undefined} data-testid="resolve-reason" />
      </Field>
      {needsEvidence(form.kind) && (
        <Field id={`${id}-evidence`} label={t('ebs.resolve.field.evidence.label')} problem={problems.evidenceRef} hint={t('ebs.resolve.field.evidence.hint')}>
          <input id={`${id}-evidence`} value={form.evidenceRef} onChange={(event) => setForm((current) => ({ ...current, evidenceRef: event.target.value }))} aria-invalid={problems.evidenceRef !== undefined} data-testid="resolve-evidence" />
        </Field>
      )}
      {needsReview(form.kind) && (
        <Field id={`${id}-review`} label={t('ebs.resolve.field.review.label')} problem={problems.reviewOn} hint={t('ebs.resolve.field.review.hint')}>
          <input id={`${id}-review`} type="date" value={form.reviewOn} onChange={(event) => setForm((current) => ({ ...current, reviewOn: event.target.value }))} aria-invalid={problems.reviewOn !== undefined} data-testid="resolve-review" />
        </Field>
      )}
    </ConfirmDialog>
  );
}

function ReassignDialog({ difference, onClose, onDone, onReload }: { difference: Difference; onClose: () => void; onDone: () => void; onReload: () => void }) {
  const { t, locale } = useTranslation();
  const id = useId();
  const mutation = useReassignEbsDifference();
  const [owner, setOwner] = useState('');
  const [problem, setProblem] = useState<'REQUIRED' | 'FORMAT' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <ConfirmDialog
      open
      title={t('ebs.reassign.dialog.title')}
      context={[...contextOf(difference, t, locale), { label: t('ebs.reassign.context.owner.label'), value: difference.owner_name ?? '–' }]}
      confirmLabel={t('ebs.reassign.dialog.confirm')}
      cancelLabel={t('ebs.dialog.cancel.action')}
      pending={mutation.isPending}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={() => {
        const next = owner.trim();
        const found = next === '' ? 'REQUIRED' : UUID_PATTERN.test(next) ? undefined : 'FORMAT';
        setProblem(found);
        if (found !== undefined) {
          setError(t('ent.error.validation.text'));
          return;
        }
        setError(undefined);
        mutation.mutateAsync({ id: difference.id, version: difference.version, ownerId: next.toLowerCase() }).then(onDone, (failure: unknown) => {
          setError(ebsErrorText(t, failure));
          if (failureCode(failure) === 'VERSION_CONFLICT') onReload();
        });
      }}
    >
      <Field id={`${id}-owner`} label={t('ebs.reassign.field.owner.label')} problem={problem} hint={t('ebs.reassign.field.owner.hint')}>
        <input id={`${id}-owner`} value={owner} onChange={(event) => setOwner(event.target.value)} aria-invalid={problem !== undefined} data-testid="reassign-owner" />
      </Field>
    </ConfirmDialog>
  );
}

