import { useId } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import { formProblemText, problemText } from '../labels';
import { MAX_REASON, MIN_REASON } from '../model';
import type { FormProblem, Problem } from '../model';
import { extensionUnitWord } from '../task-cells';
import { MAX_EXTENSION_ROWS, MAX_PROGRESS_ROWS, emptyExtension, emptyProgress } from './model';
import type { ExtendableStep, ExtensionErrors, ExtensionRow, FormErrors, ProgressRow, RescheduleForm, RowErrors } from './model';

interface FieldProps {
  label: string;
  testId: string;
  error?: string | undefined;
  hint?: string | undefined;
  wide?: boolean;
  children: (props: { id: string; invalid: true | undefined; describedBy: string | undefined }) => ReactNode;
}

function Field({ label, testId, error, hint, wide = false, children }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={wide ? 'pwf-field pwf-field--wide' : 'pwf-field'}>
      <label htmlFor={id}>{label}</label>
      {children({ id, invalid: error === undefined ? undefined : true, describedBy: error === undefined ? undefined : errorId })}
      {hint === undefined ? null : <span className="pwf-hint">{hint}</span>}
      {error === undefined ? null : (
        <span id={errorId} className="pwf-field__error" data-testid={`error-${testId}`}>
          {error}
        </span>
      )}
    </div>
  );
}

export interface ProposalFormProps {
  form: RescheduleForm;
  errors: FormErrors;
  pending: boolean;
  disabled: boolean;
  onChange: (form: RescheduleForm) => void;
  onSubmit: () => void;
  /** The steps whose template allows an extension, with what is used of each (R72). */
  steps: readonly ExtendableStep[];
  /** What the server refused at the last request; a refusal of an extension is said at the row of that step. */
  refusal?: Problem | undefined;
}

/** "What if the start day moves": the new start day, the progress that is known, and the reason; the server computes the preview and keeps it as a proposal for a second person to decide (BR-PWF-08, F6). */
export function ProposalForm({ form, errors, pending, disabled, onChange, onSubmit, steps, refusal }: ProposalFormProps) {
  const { t } = useTranslation();
  const say = (problem: FormProblem | undefined, limits: { min?: number; max?: number } = {}): string | undefined => (problem === undefined ? undefined : formProblemText(t, problem, limits));
  const set = (patch: Partial<RescheduleForm>): void => onChange({ ...form, ...patch });
  const setRow = (index: number, patch: Partial<ProgressRow>): void => set({ progress: form.progress.map((row, at) => (at === index ? { ...row, ...patch } : row)) });
  const setExtension = (index: number, patch: Partial<ExtensionRow>): void => set({ extensions: form.extensions.map((row, at) => (at === index ? { ...row, ...patch } : row)) });
  const extensionError = (index: number, field: keyof ExtensionErrors, limits: { min?: number; max?: number } = {}): string | undefined => say(errors.extensions[index]?.[field], limits);
  const rowError = (index: number, field: keyof RowErrors, limits: { min?: number; max?: number } = {}): string | undefined => say(errors.rows[index]?.[field], limits);
  return (
    <SectionCard title={t('pwf.resched.form.title')}>
      <form
        data-testid="whatif-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="pwf-filters">
          <Field label={t('pwf.resched.plannedStart.label')} testId="plannedStart" error={say(errors.fields.plannedStart)} hint={t('pwf.resched.plannedStart.hint')}>
            {({ id, invalid, describedBy }) => <input id={id} type="date" data-testid="planned-start" value={form.plannedStart} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => set({ plannedStart: event.target.value })} />}
          </Field>
          <Field label={t('pwf.resched.statusDate.label')} testId="statusDate" error={say(errors.fields.statusDate)} hint={t('pwf.resched.statusDate.hint')}>
            {({ id, invalid, describedBy }) => <input id={id} type="date" data-testid="status-date" value={form.statusDate} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => set({ statusDate: event.target.value })} />}
          </Field>
        </div>
        <fieldset className="pwf-progress">
          <legend>{t('pwf.resched.progress.legend')}</legend>
          <p className="pwf-hint">{t('pwf.resched.progress.hint')}</p>
          {form.progress.map((row, index) => (
            <div key={index} className="pwf-filters" data-testid={`progress-${index}`}>
              <Field label={t('pwf.resched.progress.code.label')} testId={`progress-${index}-code`} error={rowError(index, 'taskCode')}>
                {({ id, invalid, describedBy }) => <input id={id} type="text" data-testid={`progress-${index}-code`} value={row.taskCode} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => setRow(index, { taskCode: event.target.value })} />}
              </Field>
              <Field label={t('pwf.resched.progress.start.label')} testId={`progress-${index}-start`} error={rowError(index, 'actualStart')}>
                {({ id, invalid, describedBy }) => <input id={id} type="date" data-testid={`progress-${index}-start`} value={row.actualStart} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => setRow(index, { actualStart: event.target.value })} />}
              </Field>
              <Field label={t('pwf.resched.progress.finish.label')} testId={`progress-${index}-finish`} error={rowError(index, 'actualFinish')}>
                {({ id, invalid, describedBy }) => <input id={id} type="date" data-testid={`progress-${index}-finish`} value={row.actualFinish} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => setRow(index, { actualFinish: event.target.value })} />}
              </Field>
              <Field label={t('pwf.resched.progress.remaining.label')} testId={`progress-${index}-remaining`} error={rowError(index, 'remaining', { min: 0, max: 3650 })}>
                {({ id, invalid, describedBy }) => <input id={id} type="text" data-testid={`progress-${index}-remaining`} value={row.remaining} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => setRow(index, { remaining: event.target.value })} />}
              </Field>
              <Field label={t('pwf.resched.progress.percent.label')} testId={`progress-${index}-percent`} error={rowError(index, 'percent', { min: 0, max: 100 })}>
                {({ id, invalid, describedBy }) => <input id={id} type="text" data-testid={`progress-${index}-percent`} value={row.percent} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => setRow(index, { percent: event.target.value })} />}
              </Field>
              <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`remove-progress-${index}`} onClick={() => set({ progress: form.progress.filter((_, at) => at !== index) })}>
                {t('pwf.resched.progress.remove.action')}
              </button>
            </div>
          ))}
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="add-progress" disabled={form.progress.length >= MAX_PROGRESS_ROWS} onClick={() => set({ progress: [...form.progress, emptyProgress()] })}>
            {t('pwf.resched.progress.add.action')}
          </button>
        </fieldset>
        <fieldset className="pwf-progress" data-testid="extensions">
          <legend>{t('pwfp.resched.extend.legend')}</legend>
          <p className="pwf-hint">{t('pwfp.resched.extend.hint')}</p>
          {form.extensions.map((row, index) => {
            const step = steps.find((one) => one.code === row.taskCode);
            const unit = step === undefined ? '' : extensionUnitWord(t, step.rule.unit);
            const refused = refusal !== undefined && refusal.taskCode === row.taskCode && refusal.kind.startsWith('extension') ? refusal : undefined;
            return (
              <div key={index} className="pwf-filters" data-testid={`extension-${index}`}>
                <Field label={t('pwfp.resched.extend.task.label')} testId={`extension-${index}-task`} error={extensionError(index, 'taskCode')}>
                  {({ id, invalid, describedBy }) => (
                    <select id={id} data-testid={`extension-${index}-task`} value={row.taskCode} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => setExtension(index, { taskCode: event.target.value })}>
                      <option value="">{t('pwfp.resched.extend.task.choose')}</option>
                      {steps.map((one) => (
                        <option key={one.code} value={one.code}>
                          {one.name}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field
                  label={step === undefined ? t('pwfp.resched.extend.value.label') : t('pwfp.resched.extend.valueUnit.label', { unit })}
                  testId={`extension-${index}-value`}
                  error={extensionError(index, 'addValue', { min: 1, max: 1095 }) ?? (refused === undefined ? undefined : problemText(t, refused))}
                  hint={step === undefined ? undefined : t('pwfp.resched.extend.used.text', { times: step.rule.max_times === null ? t('pwfp.resched.extend.noLimit.text', { used: step.rule.times_used }) : t('pwfp.resched.extend.of.text', { used: step.rule.times_used, max: step.rule.max_times }), value: step.rule.max_value === null ? t('pwfp.resched.extend.noLimit.text', { used: step.rule.value_used }) : t('pwfp.resched.extend.of.text', { used: step.rule.value_used, max: step.rule.max_value }), unit })}
                >
                  {({ id, invalid, describedBy }) => <input id={id} type="text" inputMode="numeric" data-testid={`extension-${index}-value`} value={row.addValue} aria-invalid={invalid ?? (refused === undefined ? undefined : true)} aria-describedby={describedBy} onChange={(event) => setExtension(index, { addValue: event.target.value })} />}
                </Field>
                <button type="button" className="ui-button ui-button--outline ui-button--small" data-action={`remove-extension-${index}`} onClick={() => set({ extensions: form.extensions.filter((_, at) => at !== index) })}>
                  {t('pwfp.resched.extend.remove.action')}
                </button>
              </div>
            );
          })}
          {steps.length === 0 ? (
            <p className="pwf-hint" data-testid="extensions-none">
              {t('pwfp.resched.extend.none.text')}
            </p>
          ) : null}
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="add-extension" disabled={steps.length === 0 || form.extensions.length >= MAX_EXTENSION_ROWS} onClick={() => set({ extensions: [...form.extensions, emptyExtension()] })}>
            {t('pwfp.resched.extend.add.action')}
          </button>
        </fieldset>
        <Field label={t('pwf.resched.reason.label')} testId="reason" wide error={say(errors.fields.reason, { min: MIN_REASON, max: MAX_REASON })} hint={t('pwf.resched.reason.hint', { min: MIN_REASON })}>
          {({ id, invalid, describedBy }) => <textarea id={id} rows={3} data-testid="reason" value={form.reason} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => set({ reason: event.target.value })} />}
        </Field>
        {errors.fields.change === undefined ? null : (
          <p className="pwf-field__error" role="alert" data-testid="error-change">
            {t('pwf.resched.change.error')}
          </p>
        )}
        <div className="pwf-actions">
          <button type="button" className="ui-button ui-button--primary" data-testid="submit-propose" disabled={pending || disabled} onClick={onSubmit}>
            {t('pwf.resched.propose.action')}
          </button>
        </div>
      </form>
    </SectionCard>
  );
}
