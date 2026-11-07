import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ScopeBar } from '../ctr/kit';
import PlanDecisionPanel from './PlanDecisionPanel';
import { PlanRefusal, PlanStatusBadge } from './plan-components';
import { useDecidePlan, usePackages, usePlans, useSubmitPlan } from './plan-hooks';
import { biddingFormLabel, contractTypeLabel, lastDecisionLabel, methodLabel } from './plan-labels';
import { APPROVE_PLAN_PERMISSION, EDITOR_PATH, MANAGE_PLAN_PERMISSION, describeProblem, formatVnd, planLink, reviseLink } from './plan-model';
import type { PackageLine, PlanLine } from './plan-model';
import './bid.css';

/**
 * BID-15: the procurement plans of the projects, each with its packages, total, decision and the words of the last decision. A planner submits a
 * draft (the server checks the packages against the lines of capital and the stage of the project); an authority who is neither its maker nor its
 * submitter approves it on a decision in force, returns it or rejects it; an approved plan is revised, never edited (ST-BID-001).
 */
export default function ProcurementPlanScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The plans shown depend on the membership (a plan in work is for those who plan and approve): a switch starts the screen over.
  return <ProcurementPlanContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProcurementPlanContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params] = useSearchParams();
  const selectedId = params.get('plan') ?? undefined;
  const plans = usePlans();
  const packages = usePackages();
  const state = useScreenState({ isLoading: plans.isLoading, error: plans.error, data: plans.data });
  const editable = mode !== 'READ_ONLY';
  const mayManage = editable && (permissions === undefined || permissions.includes(MANAGE_PLAN_PERMISSION));
  const mayApprove = editable && (permissions === undefined || permissions.includes(APPROVE_PLAN_PERMISSION));
  const selected = (plans.data ?? []).find((plan) => plan.id === selectedId);
  const selectedPackages = useMemo(() => (packages.data ?? []).filter((item) => item.planId === selectedId), [packages.data, selectedId]);
  const columns: DataTableColumn<PlanLine>[] = [
    {
      key: 'project',
      header: t('bid.plans.column.project'),
      pinned: true,
      render: (plan) => (
        <span data-plan-id={plan.id} aria-current={plan.id === selectedId ? 'true' : undefined}>
          <Link to={planLink(plan.id)}>{plan.project.code}</Link>
          <br />
          <small className="sub">{plan.project.name}</small>
        </span>
      ),
    },
    { key: 'revision', header: t('bid.plans.column.revision'), align: 'right', render: (plan) => plan.revision },
    { key: 'title', header: t('bid.plans.column.title'), render: (plan) => plan.title },
    { key: 'packages', header: t('bid.plans.column.packages'), align: 'right', render: (plan) => plan.packageCount },
    { key: 'total', header: t('bid.plans.column.total'), align: 'right', render: (plan) => formatVnd(plan.totalVnd) },
    { key: 'status', header: t('bid.plans.column.status'), render: (plan) => <PlanStatusBadge status={plan.status} /> },
    { key: 'decision', header: t('bid.plans.column.decision'), render: (plan) => plan.decisionSymbol ?? t('bid.plans.noDecision.text') },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.plans.page.title')}</h1>
          <p>{t('bid.plans.page.subtitle')}</p>
        </div>
        {mayManage ? (
          <Link className="ui-button ui-button--primary" to={EDITOR_PATH}>
            {t('bid.plans.create.link')}
          </Link>
        ) : null}
      </div>
      <ScopeBar money updatedAt={plans.dataUpdatedAt} stale={plans.isRefetchError} />
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        <div data-testid="plans">
          <DataTable caption={t('bid.plans.page.title')} columns={columns} rows={plans.data ?? []} rowKey={(plan) => plan.id} />
        </div>
        {selectedId === undefined ? (
          <p className="callout" role="status" data-testid="no-selection">
            {t('bid.plans.noSelection.notice')}
          </p>
        ) : selected === undefined ? (
          <p className="callout warning" role="status" data-testid="plan-missing">
            {t('bid.plans.missing.notice')}
          </p>
        ) : (
          <Detail plan={selected} packages={selectedPackages} mayManage={mayManage} mayApprove={mayApprove} />
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bid.plans.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Detail({ plan, packages, mayManage, mayApprove }: { plan: PlanLine; packages: readonly PackageLine[]; mayManage: boolean; mayApprove: boolean }) {
  const { t } = useTranslation();
  const submit = useSubmitPlan();
  // The decision moves the plan out of review, which removes the panel: the mutation and the notice that it was recorded belong to the plan, not to the panel.
  const decide = useDecidePlan();
  const refused = submit.isError ? describeProblem(submit.error) : undefined;
  const columns: DataTableColumn<PackageLine>[] = [
    {
      key: 'code',
      header: t('bid.plans.package.code'),
      pinned: true,
      render: (item) => (
        <>
          <code>{item.code}</code>
          <br />
          {item.title ?? ''}
        </>
      ),
    },
    { key: 'method', header: t('bid.plans.package.method'), render: (item) => methodLabel(t, item.method) },
    { key: 'contractType', header: t('bid.plans.package.contractType'), render: (item) => (item.contractType === null ? '' : contractTypeLabel(t, item.contractType)) },
    { key: 'form', header: t('bid.plans.package.form'), render: (item) => (item.biddingForm === null ? '' : biddingFormLabel(t, item.biddingForm)) },
    { key: 'period', header: t('bid.plans.package.period'), render: (item) => item.plannedStartPeriod ?? '' },
    { key: 'budget', header: t('bid.plans.package.budget'), align: 'right', render: (item) => formatVnd(item.budgetVnd) },
  ];
  return (
    <div data-testid="plan-detail">
      <SectionCard title={t('bid.plans.detail.title', { title: plan.title, revision: plan.revision })} unit={t('w2pay.ctx.unit')} status={<PlanStatusBadge status={plan.status} />}>
        <p className="sub">{plan.legalBasis}</p>
        {plan.lastDecision === null ? null : (
          <p className="callout" role="status" data-testid="last-decision">
            {lastDecisionLabel(t, plan.lastDecision.decision)}
            {plan.lastDecision.comment === null ? '' : `: ${plan.lastDecision.comment}`}
          </p>
        )}
        <div data-testid="plan-packages">
          <DataTable caption={t('bid.plans.detail.title', { title: plan.title, revision: plan.revision })} columns={columns} rows={[...packages]} rowKey={(item) => item.id} />
        </div>
        <p className="sub">{t('bid.plans.detail.total', { total: formatVnd(plan.totalVnd) })}</p>
        {refused === undefined ? null : <PlanRefusal problem={refused} testId="submit-refusal" />}
        {submit.isSuccess ? (
          <p className="callout" role="status" data-testid="submit-done">
            {t('bid.plans.submit.done')}
          </p>
        ) : null}
        <div className="bid-row-actions">
          {mayManage && plan.status === 'DRAFT' ? (
            <button type="button" className="ui-button ui-button--primary" disabled={submit.isPending} onClick={() => submit.mutate({ id: plan.id, version: plan.version })}>
              {t('bid.plans.submit.action')}
            </button>
          ) : null}
          {mayManage && (plan.status === 'APPROVED' || plan.status === 'DRAFT') ? (
            <Link className="ui-button ui-button--outline" to={reviseLink(plan.id)}>
              {t('bid.plans.revise.link')}
            </Link>
          ) : null}
        </div>
        {decide.isSuccess ? (
          <p className="callout" role="status" data-testid="decision-done">
            {t('bid.decisionPanel.done.notice')}
          </p>
        ) : null}
        {mayApprove && plan.status === 'IN_REVIEW' ? <PlanDecisionPanel plan={plan} decide={decide} /> : null}
      </SectionCard>
    </div>
  );
}
