import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useCreateRule, useForms } from './hooks';
import { fieldProblemMessage, frequencyLabel, problemMessage, roleLabel } from './labels';
import { EMPTY_RULE, describeProblem, validateRule } from './model';
import type { RuleErrors, RuleValues } from './model';
import { FREQUENCIES, REPORTING_ROLES } from './types';
import type { Frequency, ReportingRole } from './types';

export interface RuleRevisionFormProps {
  /** Called with the code of the rule that was drafted, once the server accepted it. */
  onDone: (ruleCode: string) => void;
  onCancel: () => void;
}

const ALL_FORMS = { reportKind: '', effectiveOn: '' } as const;

/**
 * The form that drafts a revision of an obligation rule (createMneObligationRule): who files which form, how often, to whom and by which
 * formula, with its legal basis and period. The form must be published; the formula is data the server evaluates and refuses naming the
 * field. Nothing is published by drafting: another person publishes the draft from the list.
 */
export function RuleRevisionForm({ onDone, onCancel }: RuleRevisionFormProps) {
  const { t } = useTranslation();
  const create = useCreateRule();
  const forms = useForms(ALL_FORMS);
  const [values, setValues] = useState<RuleValues>(EMPTY_RULE);
  const [errors, setErrors] = useState<RuleErrors>({});
  const refused = create.isError ? describeProblem(create.error) : undefined;
  // A rule is written against a form that is published (a draft is not in force on any day).
  const choices = useMemo(() => (forms.data ?? []).filter((form) => form.status !== 'DRAFT'), [forms.data]);

  const set = <K extends keyof RuleValues>(field: K, value: RuleValues[K]): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateRule(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(values, { onSuccess: () => onDone(values.ruleCode.trim()) });
  };

  const error = (field: keyof RuleValues): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem);
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('mne.rules.create.title')}>
      <h3>{t('mne.rules.create.title')}</h3>
      <p className="sub">{t('mne.rules.create.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
          {refused.reason === 'invalid' && refused.field !== undefined ? ` (${refused.field})` : ''}
        </p>
      )}
      <div className="mne-filters">
        <Field id="rule-code" label={t('mne.rules.create.code.label')} error={error('ruleCode')}>
          <input id="rule-code" value={values.ruleCode} aria-invalid={errors.ruleCode !== undefined} onChange={(event) => set('ruleCode', event.target.value)} />
        </Field>
        <Field id="rule-form" label={t('mne.rules.create.form.label')} error={error('formId')} hint={t('mne.rules.create.form.hint')}>
          <select id="rule-form" value={values.formId} aria-invalid={errors.formId !== undefined} onChange={(event) => set('formId', event.target.value)}>
            <option value="">{t('mne.rules.create.form.placeholder')}</option>
            {choices.map((form) => (
              <option key={form.id} value={form.id}>
                {t('mne.rules.create.form.option', { code: form.formCode, revision: form.revision })}
              </option>
            ))}
          </select>
        </Field>
        <Field id="rule-role" label={t('mne.rules.create.role.label')} error={error('reportingRole')}>
          <select id="rule-role" value={values.reportingRole} aria-invalid={errors.reportingRole !== undefined} onChange={(event) => set('reportingRole', event.target.value as ReportingRole | '')}>
            <option value="">{t('mne.rules.create.role.placeholder')}</option>
            {REPORTING_ROLES.map((role) => (
              <option key={role} value={role}>
                {roleLabel(t, role)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="rule-frequency" label={t('mne.rules.create.frequency.label')} error={error('frequency')}>
          <select id="rule-frequency" value={values.frequency} aria-invalid={errors.frequency !== undefined} onChange={(event) => set('frequency', event.target.value as Frequency | '')}>
            <option value="">{t('mne.rules.create.frequency.placeholder')}</option>
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {frequencyLabel(t, frequency)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="rule-recipient" label={t('mne.rules.create.recipient.label')} error={error('recipient')}>
          <input id="rule-recipient" value={values.recipient} aria-invalid={errors.recipient !== undefined} onChange={(event) => set('recipient', event.target.value)} />
        </Field>
        <Field id="rule-from" label={t('mne.rules.create.from.label')} error={error('effectiveFrom')}>
          <input id="rule-from" type="date" value={values.effectiveFrom} aria-invalid={errors.effectiveFrom !== undefined} onChange={(event) => set('effectiveFrom', event.target.value)} />
        </Field>
        <Field id="rule-until" label={t('mne.rules.create.until.label')} error={error('effectiveUntil')} hint={t('mne.rules.create.until.hint')}>
          <input id="rule-until" type="date" value={values.effectiveUntil} aria-invalid={errors.effectiveUntil !== undefined} onChange={(event) => set('effectiveUntil', event.target.value)} />
        </Field>
      </div>
      <Field id="rule-due" label={t('mne.rules.create.due.label')} error={error('dueRuleText')} hint={t('mne.rules.create.due.hint')}>
        <textarea id="rule-due" value={values.dueRuleText} aria-invalid={errors.dueRuleText !== undefined} onChange={(event) => set('dueRuleText', event.target.value)} />
      </Field>
      <Field id="rule-basis" label={t('mne.rules.create.basis.label')} error={error('legalBasis')}>
        <textarea id="rule-basis" value={values.legalBasis} aria-invalid={errors.legalBasis !== undefined} onChange={(event) => set('legalBasis', event.target.value)} />
      </Field>
      <Field id="rule-reference" label={t('mne.rules.create.reference.label')} error={error('legalConfirmationRef')} hint={t('mne.rules.create.reference.hint')}>
        <input id="rule-reference" value={values.legalConfirmationRef} aria-invalid={errors.legalConfirmationRef !== undefined} onChange={(event) => set('legalConfirmationRef', event.target.value)} />
      </Field>
      <div className="row gap">
        <button type="submit" className="primary" disabled={create.isPending}>
          {t('mne.rules.create.submit.action')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('mne.rules.create.cancel.action')}
        </button>
      </div>
    </form>
  );
}
