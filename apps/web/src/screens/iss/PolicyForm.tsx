import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useCategories, usePublishPolicy, useUnits } from './hooks';
import { fieldProblemMessage, problemMessage, severityLabel } from './labels';
import { EMPTY_POLICY_FORM, FIELD_OF_DETAIL, SEVERITIES, describeProblem, toPublishBody, validatePolicy } from './model';
import type { FormErrors, PolicyField, PolicyForm as PolicyFormValue, Severity } from './model';

/**
 * The form that publishes an SLA policy (ISS-09). A code that exists gets its next revision, which takes over on the date it begins; a
 * policy is never edited in place, so the form has no edit mode. What only the server can judge (the category, the unit, the calendar,
 * an overlap) comes back as a refusal that names the field or the rule.
 */
export function PolicyForm({ today }: { today: string }) {
  const { t } = useTranslation();
  const publish = usePublishPolicy();
  const categories = useCategories();
  const units = useUnits();
  const [form, setForm] = useState<PolicyFormValue>(EMPTY_POLICY_FORM);
  const [errors, setErrors] = useState<FormErrors<PolicyField>>({});
  const [saved, setSaved] = useState(false);
  const refused = publish.isError ? describeProblem(publish.error) : undefined;
  const refusedField = refused?.reason === 'validation' && refused.field !== undefined ? FIELD_OF_DETAIL[refused.field] : undefined;

  const setField = <Name extends PolicyField>(field: Name, value: PolicyFormValue[Name]): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaved(false);
    if (publish.isError) publish.reset();
  };
  const error = (field: PolicyField): string | undefined => {
    const own = errors[field] ?? (refusedField === field ? 'rejected' : undefined);
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (publish.isPending) return;
    const found = validatePolicy(form, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    publish.mutate(toPublishBody(form), {
      onSuccess: () => {
        setForm(EMPTY_POLICY_FORM);
        setSaved(true);
      },
    });
  };

  const text = (field: 'code' | 'calendarCode', id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );
  const number = (field: 'responseHours' | 'resolveHours' | 'escalateL2Pct' | 'escalateL3Pct', id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} inputMode="numeric" value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );

  return (
    <form className="card" onSubmit={save} noValidate aria-label={t('iss.sla.form.aria')}>
      <h2>{t('iss.sla.form.title')}</h2>
      <p className="sub">{t('iss.sla.form.hint')}</p>
      {refused === undefined || refusedField !== undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      {categories.isError ? (
        <p className="callout warning" role="alert">
          {t('iss.sla.categories.error')}
        </p>
      ) : null}
      {units.isError ? (
        <p className="callout warning" role="alert">
          {t('iss.sla.units.error')}
        </p>
      ) : null}
      {saved ? (
        <p className="callout" role="status" data-testid="policy-saved">
          {t('iss.sla.saved.notice')}
        </p>
      ) : null}
      <div className="formgrid">
        {text('code', 'sla-code', t('iss.sla.form.code.label'), t('iss.sla.form.code.hint'))}
        <Field id="sla-category" label={t('iss.sla.form.category.label')} error={error('categoryVersionId')}>
          <select id="sla-category" value={form.categoryVersionId} aria-invalid={error('categoryVersionId') !== undefined} onChange={(event) => setField('categoryVersionId', event.target.value)}>
            <option value="">{t('iss.sla.form.category.option')}</option>
            {(categories.data ?? []).map((category) => (
              <option key={category.versionId} value={category.versionId}>
                {`${category.key} · ${category.label}`}
              </option>
            ))}
          </select>
        </Field>
        <Field id="sla-severity" label={t('iss.sla.form.severity.label')} error={error('severity')}>
          <select id="sla-severity" value={form.severity} onChange={(event) => setField('severity', event.target.value as Severity)}>
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severityLabel(t, severity)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="sla-unit" label={t('iss.sla.form.unit.label')} error={error('ownerUnitId')}>
          <select id="sla-unit" value={form.ownerUnitId} aria-invalid={error('ownerUnitId') !== undefined} onChange={(event) => setField('ownerUnitId', event.target.value)}>
            <option value="">{t('iss.sla.unit.default.text')}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {`${unit.code} · ${unit.name}`}
              </option>
            ))}
          </select>
        </Field>
        {text('calendarCode', 'sla-calendar', t('iss.sla.form.calendar.label'))}
        {number('responseHours', 'sla-response', t('iss.sla.form.response.label'))}
        {number('resolveHours', 'sla-resolve', t('iss.sla.form.resolve.label'))}
        {number('escalateL2Pct', 'sla-level2', t('iss.sla.form.level2.label'), t('iss.sla.form.level2.hint'))}
        {number('escalateL3Pct', 'sla-level3', t('iss.sla.form.level3.label'), t('iss.sla.form.level3.hint'))}
        <Field id="sla-valid-from" label={t('iss.sla.form.validFrom.label')} error={error('validFrom')}>
          <input id="sla-valid-from" type="date" value={form.validFrom} aria-invalid={error('validFrom') !== undefined} onChange={(event) => setField('validFrom', event.target.value)} />
        </Field>
        <div className="field">
          <label>
            <input type="checkbox" checked={form.requireIndependentVerifier} onChange={(event) => setField('requireIndependentVerifier', event.target.checked)} />{' '}
            {t('iss.sla.form.verifier.label')}
          </label>
        </div>
        <div className="field">
          <label>
            <input type="checkbox" checked={form.requireEvidence} onChange={(event) => setField('requireEvidence', event.target.checked)} /> {t('iss.sla.form.evidence.label')}
          </label>
        </div>
      </div>
      <div className="formfooter">
        <span className="sub">{t('iss.sla.form.version.hint')}</span>
        <button type="submit" className="primary" disabled={publish.isPending}>
          {t('iss.sla.save.action')}
        </button>
      </div>
    </form>
  );
}
