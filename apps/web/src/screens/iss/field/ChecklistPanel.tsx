import { useTranslation } from '../../../i18n';
import { wireControl } from '../../field-wiring';
import { Field } from '../components';
import { formProblemMessage, outcomeLabel, resultLabel } from '../../qms/inspection/labels';
import { OUTCOMES, RESULTS } from '../../qms/inspection/model';
import type { AnswerForm, ChecklistRow, ResultForm, ResultProblems } from '../../qms/inspection/model';
import '../../qms/qms.css';

export interface ChecklistPanelProps {
  items: readonly ChecklistRow[];
  form: ResultForm;
  onChange(next: ResultForm): void;
  /** The problems of the form, shown once the person has tried to save. */
  problems: ResultProblems | undefined;
}

/** The checklist an inspection was given, answered item by item, with the result and the words that go with it. */
export function ChecklistPanel({ items, form, onChange, problems }: ChecklistPanelProps) {
  const { t } = useTranslation();
  const answer = (code: string): AnswerForm => form.answers[code] ?? { outcome: '', note: '' };
  const setAnswer = (code: string, patch: Partial<AnswerForm>): void => onChange({ ...form, answers: { ...form.answers, [code]: { ...answer(code), ...patch } } });
  return (
    <>
      <fieldset className="field" data-field="inspection-checklist">
        <legend>{t('iss.field.checklist.title')}</legend>
        {items.map((item, index) => {
          const problem = problems?.answers[item.code];
          const selectId = `field-answer-${index}`;
          return (
            <div key={item.code} className="qms-checklist-row" data-item={item.code}>
              <label htmlFor={selectId}>{item.label}</label>
              {wireControl(
                <select id={selectId} value={answer(item.code).outcome} onChange={(event) => setAnswer(item.code, { outcome: OUTCOMES.find((outcome) => outcome === event.target.value) ?? '' })}>
                  <option value="">{t('iss.field.outcome.choose')}</option>
                  {OUTCOMES.map((outcome) => (
                    <option key={outcome} value={outcome}>
                      {outcomeLabel(t, outcome)}
                    </option>
                  ))}
                </select>,
                selectId,
                { hint: false, error: problem === 'unanswered' },
              )}
              <input
                aria-label={t('iss.field.itemNote.label', { item: item.label })}
                autoComplete="off"
                value={answer(item.code).note}
                onChange={(event) => setAnswer(item.code, { note: event.target.value })}
              />
              {problem === undefined ? null : (
                <small role="alert" className="field-error">
                  {formProblemMessage(t, problem)}
                </small>
              )}
            </div>
          );
        })}
      </fieldset>
      <Field id="field-result" label={t('iss.field.result.label')} error={problems?.result === undefined ? undefined : formProblemMessage(t, problems.result)}>
        <select id="field-result" value={form.result} onChange={(event) => onChange({ ...form, result: RESULTS.find((result) => result === event.target.value) ?? '' })}>
          <option value="">{t('iss.field.result.choose')}</option>
          {RESULTS.map((result) => (
            <option key={result} value={result}>
              {resultLabel(t, result)}
            </option>
          ))}
        </select>
      </Field>
      {problems?.whole === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="contradiction">
          {formProblemMessage(t, problems.whole)}
        </p>
      )}
      <Field id="field-result-note" label={t('iss.field.resultNote.label')} error={problems?.resultNote === undefined ? undefined : formProblemMessage(t, problems.resultNote)}>
        <textarea id="field-result-note" rows={3} value={form.resultNote} onChange={(event) => onChange({ ...form, resultNote: event.target.value })} />
      </Field>
    </>
  );
}
