import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
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

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bid.plans.page.title')}</h1>
          <p>{t('bid.plans.page.subtitle')}</p>
        </div>
        {mayManage ? (
          <Link className="button primary" to={EDITOR_PATH}>
            {t('bid.plans.create.link')}
          </Link>
        ) : null}
      </div>
      <StateBoundary state={state} onRetry={() => void plans.refetch()}>
        <div className="card">
          <table className="table" data-testid="plans">
            <thead>
              <tr>
                <th scope="col">{t('bid.plans.column.project')}</th>
                <th scope="col">{t('bid.plans.column.revision')}</th>
                <th scope="col">{t('bid.plans.column.title')}</th>
                <th scope="col">{t('bid.plans.column.packages')}</th>
                <th scope="col">{t('bid.plans.column.total')}</th>
                <th scope="col">{t('bid.plans.column.status')}</th>
                <th scope="col">{t('bid.plans.column.decision')}</th>
              </tr>
            </thead>
            <tbody>
              {(plans.data ?? []).map((plan) => (
                <tr key={plan.id} data-plan-id={plan.id} aria-selected={plan.id === selectedId}>
                  <th scope="row">
                    <Link to={planLink(plan.id)}>{plan.project.code}</Link>
                    <br />
                    <small className="sub">{plan.project.name}</small>
                  </th>
                  <td>{plan.revision}</td>
                  <td>{plan.title}</td>
                  <td>{plan.packageCount}</td>
                  <td className="num">{formatVnd(plan.totalVnd)}</td>
                  <td>
                    <PlanStatusBadge status={plan.status} />
                  </td>
                  <td>{plan.decisionSymbol ?? t('bid.plans.noDecision.text')}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  return (
    <div className="card" data-testid="plan-detail">
      <h2>{t('bid.plans.detail.title', { title: plan.title, revision: plan.revision })}</h2>
      <p className="sub">{plan.legalBasis}</p>
      {plan.lastDecision === null ? null : (
        <p className="callout" role="status" data-testid="last-decision">
          {lastDecisionLabel(t, plan.lastDecision.decision)}
          {plan.lastDecision.comment === null ? '' : `: ${plan.lastDecision.comment}`}
        </p>
      )}
      <table className="table" data-testid="plan-packages">
        <thead>
          <tr>
            <th scope="col">{t('bid.plans.package.code')}</th>
            <th scope="col">{t('bid.plans.package.method')}</th>
            <th scope="col">{t('bid.plans.package.contractType')}</th>
            <th scope="col">{t('bid.plans.package.form')}</th>
            <th scope="col">{t('bid.plans.package.period')}</th>
            <th scope="col">{t('bid.plans.package.budget')}</th>
          </tr>
        </thead>
        <tbody>
          {packages.map((item) => (
            <tr key={item.id}>
              <th scope="row">
                <code>{item.code}</code>
                <br />
                {item.title ?? ''}
              </th>
              <td>{methodLabel(t, item.method)}</td>
              <td>{item.contractType === null ? '' : contractTypeLabel(t, item.contractType)}</td>
              <td>{item.biddingForm === null ? '' : biddingFormLabel(t, item.biddingForm)}</td>
              <td>{item.plannedStartPeriod ?? ''}</td>
              <td className="num">{formatVnd(item.budgetVnd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub">{t('bid.plans.detail.total', { total: formatVnd(plan.totalVnd) })}</p>
      {refused === undefined ? null : <PlanRefusal problem={refused} testId="submit-refusal" />}
      {submit.isSuccess ? (
        <p className="callout" role="status" data-testid="submit-done">
          {t('bid.plans.submit.done')}
        </p>
      ) : null}
      <div className="formfooter">
        {mayManage && plan.status === 'DRAFT' ? (
          <button type="button" className="primary" disabled={submit.isPending} onClick={() => submit.mutate({ id: plan.id, version: plan.version })}>
            {t('bid.plans.submit.action')}
          </button>
        ) : null}
        {mayManage && (plan.status === 'APPROVED' || plan.status === 'DRAFT') ? (
          <Link className="button" to={reviseLink(plan.id)}>
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
    </div>
  );
}
