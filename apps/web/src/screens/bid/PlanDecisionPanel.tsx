import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { PlanRefusal } from './plan-components';
import type { useDecidePlan } from './plan-hooks';
import { decisionLabel, planFieldMessage } from './plan-labels';
import { DECISIONS, EMPTY_DECISION_FORM, describeProblem, validateDecision } from './plan-model';
import type { DecisionField, DecisionForm, FieldProblem, PlanDecision, PlanLine } from './plan-model';

/**
 * The decision on a plan in review (BID-15): approve it on a decision document in force, return it to its maker or reject it, the last two
 * with the words that explain them. The maker and the submitter never decide; the server refuses them and says so.
 */
export default function PlanDecisionPanel({ plan, decide }: { plan: PlanLine; decide: ReturnType<typeof useDecidePlan> }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<DecisionForm>(EMPTY_DECISION_FORM);
  const [errors, setErrors] = useState<Partial<Record<DecisionField, FieldProblem>>>({});
  const refused = decide.isError ? describeProblem(decide.error) : undefined;
  const error = (field: DecisionField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : planFieldMessage(t, problem);
  };
  const change = (next: Partial<DecisionForm>): void => {
    setForm((previous) => ({ ...previous, ...next }));
    setErrors({});
    decide.reset();
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (decide.isPending) return;
    const found = validateDecision(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    decide.mutate({ id: plan.id, version: plan.version, form });
  };

  return (
    <div className="card" data-testid="decision-panel">
      <h3>{t('bid.decisionPanel.title.text')}</h3>
      <form onSubmit={send} noValidate aria-label={t('bid.decisionPanel.title.text')}>
        {refused === undefined ? null : <PlanRefusal problem={refused} testId="decision-refusal" />}
        <div className="formgrid">
          <Field id="decision-kind" label={t('bid.decisionPanel.kind.label')} error={undefined}>
            <select id="decision-kind" value={form.decision} onChange={(event) => change({ decision: event.target.value as PlanDecision })}>
              {DECISIONS.map((decision) => (
                <option key={decision} value={decision}>
                  {decisionLabel(t, decision)}
                </option>
              ))}
            </select>
          </Field>
          {form.decision === 'APPROVE' ? (
            <Field id="decision-documentId" label={t('bid.decisionPanel.document.label')} error={error('documentId')} hint={t('bid.decisionPanel.document.hint')}>
              <input id="decision-documentId" value={form.documentId} aria-invalid={error('documentId') !== undefined} onChange={(event) => change({ documentId: event.target.value })} />
            </Field>
          ) : null}
          <Field id="decision-comment" label={t('bid.decisionPanel.comment.label')} error={error('comment')}>
            <textarea id="decision-comment" rows={3} value={form.comment} aria-invalid={error('comment') !== undefined} onChange={(event) => change({ comment: event.target.value })} />
          </Field>
        </div>
        <div className="formfooter">
          <button type="submit" className="primary" disabled={decide.isPending}>
            {t('bid.decisionPanel.submit.action')}
          </button>
        </div>
      </form>
    </div>
  );
}
