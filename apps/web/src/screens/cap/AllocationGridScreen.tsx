import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, SectionCard, StickyActions } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Money } from './components';
import { millionsInput } from './model';
import { PlanChooser, PlanHeader, SignedMoney, YearLockedBanner, usePlanChoice } from './plan-components';
import { useDraftAllocation, usePlanLines, usePlans } from './plan-hooks';
import { gridProblemMessage, planProblemMessage } from './plan-labels';
import { canDraft, ceilingStates, describePlanProblem, gridBody, gridRows, isDraft, nextTotal } from './plan-model';
import type { GridEdit, GridEdits, GridRow } from './plan-model';
import './cap.css';

/**
 * CAP-06: the allocation grid of a plan. For every line: the project, the source, the amount (editable while the plan is a draft), what the
 * appropriation has left once the edits are saved, and what is already committed and reserved. A planner changes amounts and removes lines;
 * the new remaining amount follows each keystroke and a save that would take more than the source has is not offered. Saving sends the
 * version of the plan the planner saw: another planner who saved first makes this save fail, and nothing is lost silently.
 */
export default function AllocationGridScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <GridContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function GridContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const mayDraft = canDraft(permissions, mode);
  const plans = usePlans();
  const { planId, choose } = usePlanChoice(plans.data ?? []);
  const detail = usePlanLines(planId);
  const draft = useDraftAllocation();
  const [edits, setEdits] = useState<GridEdits>({});
  const [locked, setLocked] = useState(false);
  const [saved, setSaved] = useState(false);
  const plan = detail.data?.plan;
  const lines = useMemo(() => detail.data?.lines ?? [], [detail.data]);
  const editable = plan !== undefined && isDraft(plan) && mayDraft && !locked;
  const rows = useMemo(() => gridRows(lines, edits, locale, (vnd) => millionsInput(vnd, locale)), [lines, edits, locale]);
  const ceilings = useMemo(() => new Map(ceilingStates(rows).map((state) => [state.appropriationId, state])), [rows]);
  const outcome = useMemo(() => gridBody(rows), [rows]);
  const state = useScreenState({
    isLoading: plans.isLoading || detail.isLoading,
    error: plans.error ?? detail.error,
    data: plans.data,
  });
  const problem = draft.isError ? describePlanProblem(draft.error) : undefined;

  const columns: DataTableColumn<GridRow>[] = [
    {
      key: 'project',
      header: t('cap.grid.column.project'),
      pinned: true,
      render: (row) => (
        <span data-line-id={row.line.id} data-removed={row.edit.remove ? 'true' : 'false'} data-changed={row.changed ? 'true' : 'false'}>
          {row.line.project.code} <small className="sub">{row.line.project.name}</small>
        </span>
      ),
    },
    {
      key: 'fund',
      header: t('cap.grid.column.fund'),
      render: (row) => row.line.fundSource.businessKey,
    },
    {
      key: 'amount',
      header: t('cap.grid.column.amount'),
      align: 'right',
      render: (row) =>
        editable ? (
          <>
            <input
              aria-label={t('cap.grid.amount.aria', {
                project: row.line.project.code,
              })}
              inputMode="decimal"
              value={row.edit.amount}
              disabled={row.edit.remove || row.line.appropriation === null}
              aria-invalid={row.problem === 'invalidAmount'}
              onChange={(event) => edit(row, { amount: event.target.value })}
            />
            {row.problem === undefined ? null : (
              <small role="alert" className="field-error">
                {gridProblemMessage(t, row.problem)}
              </small>
            )}
          </>
        ) : (
          <Money vnd={row.line.amountVnd} />
        ),
    },
    {
      key: 'ctmtqg',
      header: t('cap.grid.column.ctmtqg'),
      align: 'right',
      render: (row) =>
        editable ? (
          <input
            aria-label={t('cap.grid.ctmtqg.aria', {
              project: row.line.project.code,
            })}
            inputMode="decimal"
            value={row.edit.ctmtqg}
            disabled={row.edit.remove || row.line.appropriation === null}
            aria-invalid={row.problem === 'subsetExceeds'}
            onChange={(event) => edit(row, { ctmtqg: event.target.value })}
          />
        ) : row.line.ctmtqgSubsetVnd === '0' ? (
          ''
        ) : (
          <Money vnd={row.line.ctmtqgSubsetVnd} />
        ),
    },
    {
      key: 'available',
      header: t('cap.grid.column.available'),
      align: 'right',
      render: (row) => {
        const ceiling = row.line.appropriation === null ? undefined : ceilings.get(row.line.appropriation.id);
        return (
          <span data-testid="available" data-exceeded={ceiling?.exceeded === true ? 'true' : 'false'}>
            {ceiling === undefined ? t('cap.grid.noSource.notice') : <SignedMoney vnd={ceiling.remainingVnd} />}
            {ceiling?.exceeded === true ? (
              <small role="alert" className="field-error">
                {t('cap.grid.exceeded.error')}
              </small>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'committed',
      header: t('cap.grid.column.committed'),
      align: 'right',
      render: (row) => (row.line.committedVnd === null ? t('cap.grid.notPublished.notice') : <Money vnd={row.line.committedVnd} />),
    },
    {
      key: 'reserved',
      header: t('cap.grid.column.reserved'),
      align: 'right',
      render: (row) => (row.line.reservedVnd === null ? t('cap.grid.notPublished.notice') : <Money vnd={row.line.reservedVnd} />),
    },
    {
      key: 'avc',
      header: t('cap.grid.column.avc'),
      render: () => t('cap.grid.avc.notice'),
    },
    {
      key: 'actions',
      header: t('cap.grid.column.actions'),
      render: (row) =>
        editable ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="remove" aria-pressed={row.edit.remove} onClick={() => edit(row, { remove: !row.edit.remove })}>
            {row.edit.remove ? t('cap.grid.restore.action') : t('cap.grid.remove.action')}
          </button>
        ) : null,
    },
  ];

  // The edits belong to the plan and the version they were made on: another plan, or a newer version, starts the grid over.
  useEffect(() => {
    setEdits({});
  }, [planId, plan?.version]);

  const edit = (row: GridRow, change: Partial<GridEdit>): void => {
    setSaved(false);
    setEdits((current) => ({
      ...current,
      [row.line.id]: { ...row.edit, ...change },
    }));
  };
  const save = (): void => {
    if (!editable || plan === undefined || draft.isPending || !outcome.ok) return;
    draft.mutate(
      { planId: plan.id, version: plan.version, body: outcome.body },
      {
        onSuccess: () => setSaved(true),
        onError: (error) => setLocked(describePlanProblem(error).reason === 'yearLocked'),
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.grid.page.title')}</h1>
          <p>{t('cap.grid.page.subtitle')}</p>
        </div>
      </div>
      {locked ? <YearLockedBanner /> : null}
      {plan !== undefined && !isDraft(plan) ? (
        <p className="callout" role="status" data-testid="not-draft">
          {t('cap.grid.notDraft.notice')}
        </p>
      ) : null}
      {plan !== undefined && isDraft(plan) && !mayDraft ? (
        <p className="callout" role="status">
          {mode === 'READ_ONLY' ? t('cap.readOnly.frozen.notice') : t('cap.readOnly.denied.notice')}
        </p>
      ) : null}
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem">
          {planProblemMessage(t, problem, locale)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="saved">
          {t('cap.grid.saved.notice')}
        </p>
      ) : null}
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        <ContextBar
          items={[
            {
              label: t('cap.ctx.plans'),
              value: String((plans.data ?? []).length),
            },
          ]}
          unit={t('cap.ctx.unit')}
        />
        <PlanChooser id="grid-plan" plans={plans.data ?? []} value={planId} onChange={choose} />
        {plan === undefined ? null : <PlanHeader plan={plan} />}
        {lines.length === 0 ? (
          <p className="callout" role="status" data-testid="no-lines">
            {t('cap.grid.noLines.notice')}
          </p>
        ) : (
          <SectionCard title={t('cap.grid.table.aria')} unit={t('cap.ctx.unit')}>
            <div data-testid="grid">
              <DataTable
                caption={t('cap.grid.table.caption')}
                columns={columns}
                rows={rows}
                rowKey={(row) => row.line.id}
                rowAttrs={(row) => ({ 'data-line-id': row.line.id, 'data-removed': row.edit.remove ? 'true' : 'false', 'data-changed': row.changed ? 'true' : 'false' })}
                totalsLabel={t('cap.grid.total.label')}
                totals={{
                  amount: (
                    <span data-testid="total">
                      <Money vnd={nextTotal(rows)} />
                    </span>
                  ),
                }}
              />
            </div>
            <p className="sub" data-testid="totals">
              {t('cap.grid.total.note')}
            </p>
          </SectionCard>
        )}
        {editable ? (
          <StickyActions
            primary={
              <button type="button" className="ui-button ui-button--primary" disabled={draft.isPending || !outcome.ok} onClick={save}>
                {draft.isPending ? t('cap.form.submit.pending') : t('cap.grid.save.action')}
              </button>
            }
          />
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('cap.grid.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
