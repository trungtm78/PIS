import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { llmRoot } from './hooks';
import { describeLlmProblem, groupDigits } from './llm-model';
import type { BudgetEntry, ReservationEntry } from './llm-model';
import { refusalMessage } from './labels';
import { EMPTY_RECONCILE, RECONCILE_DECISIONS, REASON_MAX, REASON_MIN, mayReconcile, reconcileBody, reconcileProblems, toggleReservation } from './reconcile-model';
import type { ReconcileDecision, ReconcileForm } from './reconcile-model';

/** Decides the reconciliation of reservations whose usage did not come back (versioned on the budget); the reads of the screens are refreshed on success and on a refusal. */
export function useReconcileBudget() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: { budgetId: string; version: number; form: ReconcileForm }) =>
      client.command('post_budgets_id_reconcile', { path: { id: input.budgetId }, ifMatchVersion: input.version, body: reconcileBody(input.form), attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: llmRoot(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: llmRoot(tenant?.id) });
    },
  });
}

interface Props {
  budget: BudgetEntry;
  /** The reservations that wait for the reconciliation. */
  waiting: readonly ReservationEntry[];
}

/**
 * LLM-09: the decision on the reservations that wait for their usage. Approving settles them as held, returning sends them back to be measured again, rejecting releases the amount; the reason is kept. A reservation is chosen
 * by the person: nothing is reconciled that was not named. The decision is made under the version of the budget that was read, and a budget that moved meanwhile is a conflict.
 */
export function ReconcilePanel({ budget, waiting }: Props) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const reconcile = useReconcileBudget();
  const [form, setForm] = useState<ReconcileForm>(EMPTY_RECONCILE);
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState(false);
  if (!mayReconcile(permissions, mode === 'READ_ONLY') || waiting.length === 0) return null;
  const problems = tried ? reconcileProblems(form) : {};
  const refusal = reconcile.isError ? describeLlmProblem(reconcile.error) : undefined;
  const decisionLabel = (decision: ReconcileDecision): string => (decision === 'approve' ? t('llm.reconcile.decision.approve') : decision === 'return' ? t('llm.reconcile.decision.return') : t('llm.reconcile.decision.reject'));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    setDone(false);
    if (Object.keys(reconcileProblems(form)).length > 0 || reconcile.isPending) return;
    reconcile.mutate({ budgetId: budget.id, version: budget.version, form }, { onSuccess: () => { setForm(EMPTY_RECONCILE); setTried(false); setDone(true); } });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="reconcile-title" data-testid="reconcile-form">
      <h2 id="reconcile-title">{t('llm.reconcile.title')}</h2>
      <p className="sub">{t('llm.reconcile.help')}</p>
      <fieldset>
        <legend>{t('llm.reconcile.reservations.legend')}</legend>
        {waiting.map((entry) => (
          <label key={entry.id} className="inline">
            <input type="checkbox" checked={form.reservationIds.includes(entry.id)} onChange={() => setForm({ ...form, reservationIds: toggleReservation(form.reservationIds, entry.id) })} data-testid={`reserve-${entry.id}`} />{' '}
            {t('llm.reconcile.reservations.option', { request: entry.requestId.slice(0, 8), amount: groupDigits(entry.amount) })}
          </label>
        ))}
        {problems.reservations === undefined ? null : (
          <small role="alert" className="field-error">
            {t('llm.reconcile.error.noReservation')}
          </small>
        )}
      </fieldset>
      <div className="field">
        <label htmlFor="reconcile-decision">{t('llm.reconcile.decision.label')}</label>
        <select id="reconcile-decision" value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value as ReconcileDecision })}>
          {RECONCILE_DECISIONS.map((decision) => (
            <option key={decision} value={decision}>
              {decisionLabel(decision)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="reconcile-reason">{t('llm.reconcile.reason.label')}</label>
        <textarea id="reconcile-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} aria-invalid={problems.reason !== undefined} />
        <small className="sub">{t('llm.reconcile.reason.hint', { min: REASON_MIN, max: REASON_MAX })}</small>
        {problems.reason === undefined ? null : (
          <small role="alert" className="field-error">
            {problems.reason === 'reasonShort' ? t('llm.reconcile.error.reasonShort', { min: REASON_MIN }) : t('llm.reconcile.error.reasonLong', { max: REASON_MAX })}
          </small>
        )}
      </div>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="reconcile-refusal">
          {refusalMessage(t, refusal.reason, refusal.detail)}
        </p>
      )}
      {done ? (
        <p className="callout" role="status" data-testid="reconcile-done">
          {t('llm.reconcile.done')}
        </p>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="ui-button ui-button--primary" disabled={reconcile.isPending} data-testid="reconcile-submit">
          {reconcile.isPending ? t('llm.reconcile.sending') : t('llm.reconcile.submit')}
        </button>
      </div>
    </form>
  );
}
