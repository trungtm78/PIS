import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { Money } from './components';
import { kindLabel, planStatusLabel } from './plan-labels';
import { periodOf } from './plan-model';
import type { PlanKind, PlanSummary } from './plan-model';
import './cap.css';

/** The plan the address names (`?plan=`), or the first of the plans offered when it names none of them. */
export function usePlanChoice(plans: readonly PlanSummary[]): { planId: string | undefined; choose: (id: string) => void } {
  const [params, setParams] = useSearchParams();
  const wanted = params.get('plan');
  const planId = plans.find((plan) => plan.id === wanted)?.id ?? plans[0]?.id;
  return {
    planId,
    choose: (id) => {
      const next = new URLSearchParams(params);
      next.set('plan', id);
      setParams(next, { replace: true });
    },
  };
}

/** An exact amount that may be below zero (what a ceiling has left once the edits are saved), in millions of dong; the sign is never lost. */
export function SignedMoney({ vnd }: { vnd: string }) {
  return vnd.startsWith('-') ? (
    <span className="cap-negative" data-negative="true">
      -<Money vnd={vnd.slice(1)} />
    </span>
  ) : (
    <Money vnd={vnd} />
  );
}

/** The link above the title that the mockup of a detail screen carries: an arrow and the name of the screen it comes from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <p className="cap-back-link">
      <Link to={to}>
        <span aria-hidden="true">← </span>
        {children}
      </Link>
    </p>
  );
}

export function KindBadge({ kind }: { kind: PlanKind }) {
  const { t } = useTranslation();
  return (
    <span className="cap-badge" data-kind={kind}>
      {kindLabel(t, kind)}
    </span>
  );
}

export function PlanStatusBadge({ plan }: { plan: PlanSummary }) {
  const { t } = useTranslation();
  return (
    <span className={plan.status === 'PUBLISHED' ? 'cap-badge' : 'cap-badge warning'} data-status={plan.status}>
      {planStatusLabel(t, plan.status)}
    </span>
  );
}

/** The choice of the plan a screen works on: its code, the years it covers and where it stands. */
export function PlanChooser({ id, plans, value, onChange }: { id: string; plans: readonly PlanSummary[]; value: string | undefined; onChange: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{t('cap.planChooser.label')}</label>
      <select id={id} value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
        {plans.map((plan) => (
          <option key={plan.id} value={plan.id}>
            {t('cap.planChooser.option', { code: plan.planCode, period: periodOf(plan), status: planStatusLabel(t, plan.status) })}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The decision that backs a revision: its symbol and date, or a note that it has none yet (a revision in work has no decision). */
export function PlanCitation({ plan }: { plan: PlanSummary }) {
  const { t } = useTranslation();
  if (plan.decisionSymbol === null) return <small className="sub">{t('cap.planHeader.noDecision.notice')}</small>;
  return <span>{plan.decisionIssuedOn === null ? plan.decisionSymbol : t('cap.decision.citation.label', { symbol: plan.decisionSymbol, date: plan.decisionIssuedOn })}</span>;
}

/** The header of the plan on the screens that work on one: its code and revision, the years, the unit it belongs to and the decision behind it. */
export function PlanHeader({ plan }: { plan: PlanSummary }) {
  const { t } = useTranslation();
  return (
    <div className="card cap-plan-header" data-testid="plan-header" data-plan-id={plan.id}>
      <h2>{t('cap.planHeader.title', { code: plan.planCode, revision: plan.revision })}</h2>
      <p>
        <KindBadge kind={plan.planKind} /> <PlanStatusBadge plan={plan} />{' '}
        <span>{t('cap.planHeader.period.label', { period: periodOf(plan) })}</span> ·{' '}
        <span>{t('cap.planHeader.unit.label', { unit: plan.scopeUnit.name })}</span>
      </p>
      <p>
        <PlanCitation plan={plan} />
      </p>
    </div>
  );
}

/** The year of the plan is locked: nothing can be written until it is reopened (CAP 3.1 F6). */
export function YearLockedBanner() {
  const { t } = useTranslation();
  return (
    <p className="callout warning" role="alert" data-testid="year-locked">
      {t('cap.yearLocked.banner')}
    </p>
  );
}
