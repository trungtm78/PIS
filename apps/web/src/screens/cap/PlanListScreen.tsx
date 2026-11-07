import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StickyActions } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Field, Money } from './components';
import { KindBadge, PlanCitation, PlanStatusBadge } from './plan-components';
import { useCreatePlan, usePlanUnits, usePlans } from './plan-hooks';
import { kindLabel, planFormProblemMessage, planProblemMessage } from './plan-labels';
import { ALLOCATION_GRID_PATH, ANNUAL_PLAN_PATH, EMPTY_PLAN_FORM, canDraft, PLAN_KINDS, describePlanProblem, periodOf, planBody, validatePlanForm } from './plan-model';
import type { PlanField, PlanForm, PlanFormProblem, PlanKind, PlanSummary } from './plan-model';
import './cap.css';

/**
 * CAP-01: the capital plans of the province, the medium-term ones first: the years each covers, the fund sources it draws on, the ceiling of
 * the appropriations behind it and what is already proposed. A planner creates a plan here (revision 1, a draft); its lines are proposed on
 * CAP-02 and edited on CAP-06. A revision in work is listed only for the people who draft and approve plans.
 */
export default function PlanListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PlanListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanListContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const mayDraft = canDraft(permissions, mode);
  const plans = usePlans();
  const create = useCreatePlan();
  const [kind, setKind] = useState<PlanKind | ''>('MEDIUM_TERM');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<PlanForm>(EMPTY_PLAN_FORM);
  const [errors, setErrors] = useState<Partial<Record<PlanField, PlanFormProblem>>>({});
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const units = usePlanUnits(creating);
  const shown = useMemo(() => (plans.data ?? []).filter((plan) => kind === '' || plan.planKind === kind), [plans.data, kind]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const index = Math.min(pageIndex, Math.max(0, Math.ceil(shown.length / pageSize) - 1));
  const pageRows = shown.slice(index * pageSize, (index + 1) * pageSize);
  const from = pageRows.length === 0 ? 0 : index * pageSize + 1;
  const columns: DataTableColumn<PlanSummary>[] = [
    {
      key: 'period',
      header: t('cap.plans.column.period'),
      pinned: true,
      render: (plan) => (
        <span data-plan-id={plan.id} data-kind={plan.planKind}>
          {periodOf(plan)}
        </span>
      ),
    },
    {
      key: 'plan',
      header: t('cap.plans.column.plan'),
      render: (plan) => (
        <>
          {plan.planCode} <small className="sub">{t('cap.plans.revision.label', { revision: plan.revision })}</small> <KindBadge kind={plan.planKind} />
        </>
      ),
    },
    {
      key: 'funds',
      header: t('cap.plans.column.funds'),
      render: (plan) => (plan.fundSources.length === 0 ? t('cap.plans.noFunds.notice') : plan.fundSources.map((source) => source.businessKey).join(', ')),
    },
    {
      key: 'ceiling',
      header: t('cap.plans.column.ceiling'),
      align: 'right',
      render: (plan) => (
        <span data-testid="ceiling">
          <Money vnd={plan.totals.ceilingVnd} />
        </span>
      ),
    },
    {
      key: 'allocated',
      header: t('cap.plans.column.allocated'),
      align: 'right',
      render: (plan) => (
        <span data-testid="allocated">
          <Money vnd={plan.totals.allocatedVnd} />
        </span>
      ),
    },
    {
      key: 'status',
      header: t('cap.plans.column.status'),
      render: (plan) => <PlanStatusBadge plan={plan} />,
    },
    {
      key: 'decision',
      header: t('cap.plans.column.decision'),
      render: (plan) => <PlanCitation plan={plan} />,
    },
    {
      key: 'actions',
      header: t('cap.plans.column.actions'),
      render: (plan) => (
        <span className="cap-actions">
          <Link to={`${ALLOCATION_GRID_PATH}?plan=${plan.id}`}>{t('cap.plans.open.action')}</Link>
          {plan.planKind === 'ANNUAL' ? <Link to={`${ANNUAL_PLAN_PATH}?plan=${plan.id}`}>{t('cap.plans.annual.action')}</Link> : null}
        </span>
      ),
    },
  ];
  const state = useScreenState({
    isLoading: plans.isLoading,
    error: plans.error,
    data: plans.data,
  });
  const problem = create.isError ? describePlanProblem(create.error) : undefined;

  const setField = (field: PlanField, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const close = (): void => {
    setCreating(false);
    setErrors({});
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !mayDraft) return;
    const found = validatePlanForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(planBody(form), {
      onSuccess: (done) => {
        setCreatedId(done.resource_id);
        setForm(EMPTY_PLAN_FORM);
        close();
      },
    });
  };
  const message = (field: PlanField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : planFormProblemMessage(t, found);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.plans.page.title')}</h1>
          <p>{t('cap.plans.page.subtitle')}</p>
        </div>
        {mayDraft ? (
          <button
            type="button"
            className="ui-button ui-button--primary"
            disabled={creating}
            onClick={() => {
              create.reset();
              setCreatedId(undefined);
              setCreating(true);
            }}
          >
            {t('cap.plans.create.action')}
          </button>
        ) : (
          <p className="callout" role="status">
            {mode === 'READ_ONLY' ? t('cap.readOnly.frozen.notice') : t('cap.readOnly.denied.notice')}
          </p>
        )}
      </div>
      {problem === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem">
          {planProblemMessage(t, problem, locale)}
        </p>
      )}
      {createdId === undefined ? null : (
        <p className="callout" role="status" data-testid="created">
          {t('cap.plans.created.notice')} <Link to={`${ALLOCATION_GRID_PATH}?plan=${createdId}`}>{t('cap.plans.created.link')}</Link>
        </p>
      )}
      {creating ? (
        <form className="cap-form" onSubmit={save} noValidate aria-label={t('cap.plans.form.title')}>
          <SectionCard title={t('cap.plans.form.title')}>
            <fieldset disabled={!mayDraft} className="formgrid">
              <Field id="plan-code" label={t('cap.plans.code.label')} error={message('planCode')}>
                <input id="plan-code" value={form.planCode} aria-invalid={message('planCode') !== undefined} onChange={(event) => setField('planCode', event.target.value)} />
              </Field>
              <Field id="plan-kind" label={t('cap.plans.kind.label')} error={undefined}>
                <select id="plan-kind" value={form.planKind} onChange={(event) => setField('planKind', event.target.value)}>
                  {PLAN_KINDS.map((option) => (
                    <option key={option} value={option}>
                      {kindLabel(t, option)}
                    </option>
                  ))}
                </select>
              </Field>
              {form.planKind === 'ANNUAL' ? (
                <Field id="plan-year" label={t('cap.plans.year.label')} error={message('planYear')}>
                  <input id="plan-year" inputMode="numeric" value={form.planYear} aria-invalid={message('planYear') !== undefined} onChange={(event) => setField('planYear', event.target.value)} />
                </Field>
              ) : (
                <>
                  <Field id="plan-from" label={t('cap.plans.from.label')} error={message('periodFrom')}>
                    <input id="plan-from" inputMode="numeric" value={form.periodFrom} aria-invalid={message('periodFrom') !== undefined} onChange={(event) => setField('periodFrom', event.target.value)} />
                  </Field>
                  <Field id="plan-to" label={t('cap.plans.to.label')} error={message('periodTo')}>
                    <input id="plan-to" inputMode="numeric" value={form.periodTo} aria-invalid={message('periodTo') !== undefined} onChange={(event) => setField('periodTo', event.target.value)} />
                  </Field>
                </>
              )}
              <Field id="plan-unit" label={t('cap.plans.unit.label')} error={message('scopeUnitId')} hint={units.isError ? t('cap.plans.unit.unreadable.notice') : undefined}>
                <select id="plan-unit" value={form.scopeUnitId} aria-invalid={message('scopeUnitId') !== undefined} onChange={(event) => setField('scopeUnitId', event.target.value)}>
                  <option value="">{t('cap.form.choose.option')}</option>
                  {(units.data ?? []).map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.code} · {unit.name}
                    </option>
                  ))}
                </select>
              </Field>
            </fieldset>
            <StickyActions
              primary={
                <button type="submit" className="ui-button ui-button--primary" disabled={!mayDraft || create.isPending}>
                  {create.isPending ? t('cap.form.submit.pending') : t('cap.plans.form.submit.action')}
                </button>
              }
              secondary={[
                <button key="cancel" type="button" className="ui-button ui-button--outline" onClick={close}>
                  {t('cap.form.cancel.action')}
                </button>,
              ]}
            />
          </SectionCard>
        </form>
      ) : null}
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        <ContextBar
          items={[
            {
              label: t('cap.ctx.scope'),
              value: tenant?.name ?? t('cap.ctx.scope.all'),
            },
            {
              label: t('cap.ctx.plans'),
              value: String((plans.data ?? []).length),
            },
          ]}
          unit={t('cap.ctx.unit')}
        />
        <FilterPanel applied={kind === '' ? 0 : 1} unitLabel={t('cap.ctx.unit')}>
          <form className="cap-filters" role="search" aria-label={t('cap.plans.filters.title')} onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="plans-kind">{t('cap.plans.kind.label')}</label>
              <select
                id="plans-kind"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as PlanKind | '');
                  setPageIndex(0);
                }}
              >
                <option value="">{t('cap.book.filter.all')}</option>
                {PLAN_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {kindLabel(t, option)}
                  </option>
                ))}
              </select>
            </div>
          </form>
        </FilterPanel>
        <div data-testid="plans">
          <DataTable
            caption={t('cap.plans.table.aria')}
            columns={columns}
            rows={pageRows}
            rowKey={(plan) => plan.id}
            emptyKind={kind === '' ? 'none' : 'filtered'}
            onClearFilters={() => setKind('')}
            page={{
              from,
              to: from + pageRows.length - (pageRows.length === 0 ? 0 : 1),
              total: shown.length,
              size: pageSize,
              index,
              onPage: setPageIndex,
              onSize: (size) => {
                setPageSize(size);
                setPageIndex(0);
              },
            }}
          />
        </div>
      </StateBoundary>
      <p className="prototype-note">
        {t('cap.plans.footer.reference', {
          id: route.id,
          req: route.req ?? '',
        })}
      </p>
    </section>
  );
}
