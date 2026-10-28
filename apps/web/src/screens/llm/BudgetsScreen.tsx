import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useBudgets, useCreateBudget } from './hooks';
import { budgetPeriodLabel, budgetScopeLabel, financeProblemMessage, refusalMessage } from './labels';
import { BUDGET_PERIODS, BUDGET_SCOPES, EMPTY_BUDGET, FINOPS, describeLlmProblem, groupDigits, usedPercent, validateBudget, vietnamDay } from './llm-model';
import type { BudgetEntry, BudgetErrors, BudgetPeriod, BudgetScope, BudgetValues } from './llm-model';

export const USAGE_PATH = '/llm/llm-09';

const dong = groupDigits;

/**
 * LLM-07: the budgets of the AI gateway (ST-LLM-003, LLM F3): for the tenant, a unit, a project or a person, the limit of the period, what has been settled, what is held for requests in flight and what is left,
 * with the quota and whether the budget stops at the limit or asks for an approval. A budget is a ceiling over every request of its scope: a unit, a project or a person cannot be given more than the tenant has.
 */
export default function BudgetsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <BudgetsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BudgetsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(FINOPS)) && mode !== 'READ_ONLY';
  const budgets = useBudgets();
  const state = useScreenState({ isLoading: budgets.isLoading, error: budgets.error, data: budgets.data === undefined ? undefined : { rows: budgets.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.budgets.page.title')}</h1>
          <p>{t('llm.budgets.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void budgets.refetch()}>
        <table className="table" data-testid="budget-table" aria-label={t('llm.budgets.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('llm.budgets.column.scope')}</th>
              <th scope="col">{t('llm.budgets.column.period')}</th>
              <th scope="col">{t('llm.budgets.column.limit')}</th>
              <th scope="col">{t('llm.budgets.column.settled')}</th>
              <th scope="col">{t('llm.budgets.column.held')}</th>
              <th scope="col">{t('llm.budgets.column.available')}</th>
              <th scope="col">{t('llm.budgets.column.quota')}</th>
              <th scope="col">{t('llm.budgets.column.mode')}</th>
            </tr>
          </thead>
          <tbody>
            {(budgets.data ?? []).map((budget) => (
              <BudgetRow key={budget.id} budget={budget} />
            ))}
          </tbody>
        </table>
        {(budgets.data ?? []).length === 0 ? <p data-testid="budgets-none">{t('llm.budgets.none')}</p> : null}
        {may ? <BudgetForm /> : null}
      </StateBoundary>
    </section>
  );
}

function BudgetRow({ budget }: { budget: BudgetEntry }) {
  const { t } = useTranslation();
  const counter = budget.counter;
  const percent = usedPercent(counter, budget.limit);
  return (
    <tr data-budget-id={budget.id} data-blocked={counter?.blocked === true ? 'true' : 'false'}>
      <td>
        {budgetScopeLabel(t, budget.scope)} {budget.scopeRefId === null ? null : <span className="sub">{budget.scopeRefId.slice(0, 8)}</span>}
      </td>
      <td>{budgetPeriodLabel(t, budget.period)}</td>
      <td>{dong(budget.limit)}</td>
      <td>{counter === null ? t('llm.budgets.notUsed') : dong(counter.settled)}</td>
      <td>{counter === null ? t('llm.budgets.notUsed') : dong(counter.held)}</td>
      <td data-testid="budget-available">
        {counter === null ? dong(budget.limit) : dong(counter.available)}
        {counter === null ? null : (
          <span className="sub">
            {' '}
            · {t('llm.budgets.used', { percent })}
          </span>
        )}
        {counter?.blocked === true ? (
          <span className="callout warning" data-testid="budget-blocked">
            {' '}
            {t('llm.budgets.blocked')}
          </span>
        ) : null}
      </td>
      <td>
        {budget.maxRequestsPerDay === null ? t('llm.budgets.noLimit') : t('llm.budgets.perDay', { count: budget.maxRequestsPerDay })}
        {' · '}
        {budget.maxConcurrent === null ? t('llm.budgets.noLimit') : t('llm.budgets.concurrent', { count: budget.maxConcurrent })}
      </td>
      <td>
        {budget.hardStop ? t('llm.budgets.hardStop') : t('llm.budgets.needsApproval')}{' '}
        <span className="sub">{t('llm.budgets.soft', { percent: budget.softThresholdPct })}</span>{' '}
        <Link to={`${USAGE_PATH}?budget=${budget.id}`}>{t('llm.budgets.usage')}</Link>
      </td>
    </tr>
  );
}

function BudgetForm() {
  const { t } = useTranslation();
  const create = useCreateBudget();
  const [values, setValues] = useState<BudgetValues>({ ...EMPTY_BUDGET, effectiveFrom: vietnamDay(new Date().toISOString()) });
  const [errors, setErrors] = useState<BudgetErrors>({});
  const refused = create.isError ? describeLlmProblem(create.error) : undefined;
  const set = <K extends keyof BudgetValues>(field: K, value: BudgetValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const message = (field: keyof BudgetErrors): string | undefined => (errors[field] === undefined ? undefined : financeProblemMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateBudget(values);
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate(values);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.budgets.form.title')}>
      <h2>{t('llm.budgets.form.title')}</h2>
      <p className="sub">{t('llm.budgets.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="budget-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {create.isSuccess ? (
        <p className="callout" role="status" data-testid="budget-saved">
          {t('llm.budgets.form.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="budget-scope" label={t('llm.budgets.form.scope')} error={undefined}>
          <select id="budget-scope" value={values.scope} onChange={(event) => set('scope', event.target.value as BudgetScope)}>
            {BUDGET_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {budgetScopeLabel(t, scope)}
              </option>
            ))}
          </select>
        </Field>
        {values.scope === 'TENANT' ? null : (
          <Field id="budget-ref" label={t('llm.budgets.form.ref')} error={message('scopeRefId')}>
            <input id="budget-ref" value={values.scopeRefId} onChange={(event) => set('scopeRefId', event.target.value)} />
          </Field>
        )}
        <Field id="budget-period" label={t('llm.budgets.form.period')} error={undefined}>
          <select id="budget-period" value={values.period} onChange={(event) => set('period', event.target.value as BudgetPeriod)}>
            {BUDGET_PERIODS.map((period) => (
              <option key={period} value={period}>
                {budgetPeriodLabel(t, period)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="budget-limit" label={t('llm.budgets.form.limit')} error={message('limit')}>
          <input id="budget-limit" inputMode="numeric" value={values.limit} onChange={(event) => set('limit', event.target.value)} />
        </Field>
        <Field id="budget-soft" label={t('llm.budgets.form.soft')} error={message('softThresholdPct')}>
          <input id="budget-soft" inputMode="numeric" value={values.softThresholdPct} onChange={(event) => set('softThresholdPct', event.target.value)} />
        </Field>
        <Field id="budget-day" label={t('llm.budgets.form.perDay')} error={message('maxRequestsPerDay')}>
          <input id="budget-day" inputMode="numeric" value={values.maxRequestsPerDay} onChange={(event) => set('maxRequestsPerDay', event.target.value)} />
        </Field>
        <Field id="budget-concurrent" label={t('llm.budgets.form.concurrent')} error={message('maxConcurrent')}>
          <input id="budget-concurrent" inputMode="numeric" value={values.maxConcurrent} onChange={(event) => set('maxConcurrent', event.target.value)} />
        </Field>
        <Field id="budget-from" label={t('llm.budgets.form.from')} error={message('effectiveFrom')}>
          <input id="budget-from" type="date" value={values.effectiveFrom} onChange={(event) => set('effectiveFrom', event.target.value)} />
        </Field>
      </div>
      <label className="field" htmlFor="budget-hard">
        <input id="budget-hard" type="checkbox" checked={values.hardStop} onChange={(event) => set('hardStop', event.target.checked)} /> {t('llm.budgets.form.hardStop')}
      </label>
      <div className="mne-actions">
        <button type="submit" className="btn" disabled={create.isPending}>
          {t('llm.budgets.form.submit')}
        </button>
      </div>
    </form>
  );
}
