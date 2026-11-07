import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { usePublishPermitType } from './hooks';
import { categoryLabel, fieldProblemMessage, problemMessage } from './labels';
import { CATEGORIES, EMPTY_TYPE_FORM, FIELD_OF_DETAIL, describeProblem, toPublishBody, validatePermitType } from './model';
import type { Category, FormErrors, PermitTypeForm as TypeFormValue, TypeField } from './model';
import { SectionCard, StickyActions } from '../../ui';

export interface PermitTypeFormProps {
  /** The Vietnam date a later revision may begin on or after. */
  today: string;
  /** The codes the catalogue already has: a form for one of them publishes its next revision. */
  existingCodes: ReadonlySet<string>;
}

/**
 * The form that publishes a permit type version (PMT-03). A code that exists gets its next revision, which takes over on the day it begins
 * and ends the one before it the day before; a version is never edited in place, so the form has no edit mode. What only the server can
 * judge (an overlap) comes back as a refusal that names the field or the rule. A reference to a confirmation (CXN-...) marks the version
 * as a working assumption that still waits for the original text.
 */
export function PermitTypeForm({ today, existingCodes }: PermitTypeFormProps) {
  const { t } = useTranslation();
  const publish = usePublishPermitType();
  const [form, setForm] = useState<TypeFormValue>(EMPTY_TYPE_FORM);
  const [errors, setErrors] = useState<FormErrors<TypeField>>({});
  const [saved, setSaved] = useState(false);
  const refused = publish.isError ? describeProblem(publish.error) : undefined;
  const refusedField = refused?.reason === 'validation' && refused.field !== undefined ? FIELD_OF_DETAIL[refused.field] : undefined;
  const revisionOfExisting = existingCodes.has(form.code.trim());

  const setField = <Name extends TypeField>(field: Name, value: TypeFormValue[Name]): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaved(false);
    if (publish.isError) publish.reset();
  };
  const error = (field: TypeField): string | undefined => {
    const own = errors[field] ?? (refusedField === field ? 'rejected' : undefined);
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (publish.isPending) return;
    const found = validatePermitType(form, today, existingCodes);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    publish.mutate(toPublishBody(form), {
      onSuccess: () => {
        setForm(EMPTY_TYPE_FORM);
        setSaved(true);
      },
    });
  };

  const input = (field: 'code' | 'name' | 'authorityText' | 'cxnRef' | 'projectGroupKeys' | 'workTypes', id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );
  const number = (field: 'minInvestment' | 'maxInvestment' | 'validityMonths' | 'processingDays', id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} inputMode="numeric" value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );
  const date = (field: 'effectiveFrom' | 'effectiveUntil', id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} type="date" value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );

  return (
    <form onSubmit={save} noValidate aria-label={t('pmt.type.form.aria')}>
      <SectionCard title={t('pmt.type.form.title')}>
        <p className="sub">{t('pmt.type.form.hint')}</p>
        {refused === undefined || refusedField !== undefined ? null : (
          <p className="callout warning" role="alert">
            {problemMessage(t, refused)}
          </p>
        )}
        {saved ? (
          <p className="callout" role="status" data-testid="type-saved">
            {t('pmt.type.saved.notice')}
          </p>
        ) : null}
        {revisionOfExisting ? (
          <p className="callout" role="status" data-testid="next-revision">
            {t('pmt.type.form.revision.notice')}
          </p>
        ) : null}
        <div className="formgrid">
          {input('code', 'type-code', t('pmt.type.form.code.label'), t('pmt.type.form.code.hint'))}
          {input('name', 'type-name', t('pmt.type.form.name.label'))}
          <Field id="type-category" label={t('pmt.type.form.category.label')} error={error('category')}>
            <select id="type-category" value={form.category} aria-invalid={error('category') !== undefined} onChange={(event) => setField('category', event.target.value as Category)}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {categoryLabel(t, category)}
                </option>
              ))}
            </select>
          </Field>
          {input('authorityText', 'type-authority', t('pmt.type.form.authority.label'))}
          <Field id="type-legal-basis" label={t('pmt.type.form.legalBasis.label')} error={error('legalBasis')} hint={t('pmt.type.form.legalBasis.hint')}>
            <textarea id="type-legal-basis" value={form.legalBasis} aria-invalid={error('legalBasis') !== undefined} onChange={(event) => setField('legalBasis', event.target.value)} />
          </Field>
          {input('cxnRef', 'type-cxn', t('pmt.type.form.cxn.label'), t('pmt.type.form.cxn.hint'))}
          {date('effectiveFrom', 'type-effective-from', t('pmt.type.form.effectiveFrom.label'))}
          {date('effectiveUntil', 'type-effective-until', t('pmt.type.form.effectiveUntil.label'), t('pmt.type.form.effectiveUntil.hint'))}
          {input('projectGroupKeys', 'type-groups', t('pmt.type.form.groups.label'), t('pmt.type.form.groups.hint'))}
          {input('workTypes', 'type-works', t('pmt.type.form.works.label'))}
          {number('minInvestment', 'type-min', t('pmt.type.form.min.label'), t('pmt.type.form.amount.hint'))}
          {number('maxInvestment', 'type-max', t('pmt.type.form.max.label'))}
          {number('validityMonths', 'type-validity', t('pmt.type.form.validity.label'))}
          {number('processingDays', 'type-processing', t('pmt.type.form.processing.label'))}
          <div className="field">
            <label>
              <input type="checkbox" checked={form.exemptionAllowed} onChange={(event) => setField('exemptionAllowed', event.target.checked)} /> {t('pmt.type.form.exempt.label')}
            </label>
          </div>
        </div>
        <span className="sub">{t('pmt.type.form.version.hint')}</span>
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
              {t('pmt.type.save.action')}
            </button>
          }
        />
      </SectionCard>
    </form>
  );
}
