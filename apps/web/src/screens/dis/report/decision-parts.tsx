import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { Field } from '../components';
import type { DecisionEntry } from './detail-parts';
import { decisionBody, emptyDecision, formatMoment, validateDecision } from './decision-model';
import type { DecisionForm, DecisionKindChoice, DecisionProblem } from './decision-model';
import { useDecide } from './hooks';
import { reportProblemMessage } from './labels';
import { describeReport } from './model';
import type { ReportDetail } from './model';

type T = Translator['t'];

function decisionLabel(t: T, decision: DecisionEntry['decision']): string {
  switch (decision) {
    case 'ACCEPTED':
      return t('dis.reportDecision.kind.accepted');
    case 'RETURNED':
      return t('dis.reportDecision.kind.returned');
    case 'AMENDMENT_REQUESTED':
      return t('dis.reportDecision.kind.amendmentRequested');
  }
}

export function problemMessage(t: T, problem: DecisionProblem): string {
  switch (problem) {
    case 'required':
      return t('dis.reportDecision.problem.required');
    case 'tooLong':
      return t('dis.reportDecision.problem.tooLong');
    case 'itemTooShort':
      return t('dis.reportDecision.problem.itemTooShort');
    case 'itemTooLong':
      return t('dis.reportDecision.problem.itemTooLong');
    case 'tooMany':
      return t('dis.reportDecision.problem.tooMany');
    case 'dueRequired':
      return t('dis.reportDecision.problem.dueRequired');
    case 'dueInvalid':
      return t('dis.reportDecision.problem.dueInvalid');
  }
}

/** What the reviewers decided on a report, the first first: the decision, when, why, and for a return what is to be fixed and by when. */
export function DecisionHistory({ decisions }: { decisions: readonly DecisionEntry[] }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="decision-history-title">
      <h2 id="decision-history-title">{t('dis.reportDecision.history.title')}</h2>
      {decisions.length === 0 ? (
        <p className="muted" data-testid="decisions-none">
          {t('dis.reportDecision.history.none.text')}
        </p>
      ) : (
        <ol className="dis-decisions" data-testid="decisions">
          {decisions.map((entry) => (
            <li key={entry.id} data-decision={entry.decision}>
              <p>
                <span className="pill gray">{decisionLabel(t, entry.decision)}</span> {t('dis.reportDecision.history.when.text', { at: formatMoment(entry.decidedAt) })}
              </p>
              <p>{entry.reason}</p>
              {entry.returnItems.length === 0 ? null : (
                <>
                  <p className="sub">{t('dis.reportDecision.history.items.label')}</p>
                  <ul>
                    {entry.returnItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {entry.dueAt === null ? null : <p className="sub">{t('dis.reportDecision.history.due.text', { at: formatMoment(entry.dueAt) })}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * The decision of a reviewer (DIS-07): accept or return a report that was handed in, or ask the amendment of an accepted one. The reason is required; a return names what is to be fixed and the day
 * it is due. The server judges the same again, and says why when it refuses (the person who handed the report in never decides on it).
 */
export function DecisionPanel({ detail, kinds }: { detail: ReportDetail; kinds: readonly DecisionKindChoice[] }) {
  const { t } = useTranslation();
  const decide = useDecide();
  const [form, setForm] = useState<DecisionForm>(() => emptyDecision(kinds[0] ?? 'approve'));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecision(form, new Date());
  const refusal = decide.isError ? describeReport(decide.error) : undefined;
  const kindLabel = (kind: DecisionKindChoice): string => {
    switch (kind) {
      case 'approve':
        return t('dis.reportDecision.choice.approve');
      case 'return':
        return t('dis.reportDecision.choice.return');
      case 'request_amendment':
        return t('dis.reportDecision.choice.amendment');
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ detail, body: decisionBody(form) });
  };
  const showsItems = form.kind !== 'approve';
  const shown = (problem: DecisionProblem | undefined): string | undefined => (submitted && problem !== undefined ? problemMessage(t, problem) : undefined);
  return (
    <form onSubmit={submit} noValidate aria-labelledby="decision-title" data-testid="decision-form">
      <h2 id="decision-title">{t('dis.reportDecision.form.title')}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="decision-refusal">
          {reportProblemMessage(t, refusal.problem)}
        </p>
      )}
      <Field id="decision-kind" label={t('dis.reportDecision.kind.label')} error={undefined}>
        <select id="decision-kind" value={form.kind} onChange={(event: ChangeEvent<HTMLSelectElement>) => setForm({ ...emptyDecision(event.target.value as DecisionKindChoice), reason: form.reason })}>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="decision-reason" label={t('dis.reportDecision.reason.label')} error={shown(problems.reason)}>
        <textarea id="decision-reason" rows={3} value={form.reason} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, reason: event.target.value })} />
      </Field>
      {showsItems ? (
        <>
          <Field id="decision-items" label={t('dis.reportDecision.items.label')} hint={t('dis.reportDecision.items.hint')} error={shown(problems.items)}>
            <textarea id="decision-items" rows={4} value={form.items} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setForm({ ...form, items: event.target.value })} />
          </Field>
          <Field id="decision-due" label={t('dis.reportDecision.due.label')} error={shown(problems.dueOn)}>
            <input id="decision-due" type="date" value={form.dueOn} onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, dueOn: event.target.value })} />
          </Field>
        </>
      ) : null}
      <div className="formfooter">
        <button type="submit" disabled={decide.isPending}>
          {decide.isPending ? t('dis.reportDecision.submit.pending') : t('dis.reportDecision.submit.action')}
        </button>
      </div>
    </form>
  );
}

