import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useCreateForm } from './hooks';
import { fieldProblemMessage, problemMessage, reportKindLabel } from './labels';
import { EMPTY_REVISION, describeProblem, validateRevision } from './model';
import type { RevisionErrors, RevisionValues } from './model';
import { EXPORT_FORMATS, REPORT_KINDS } from './types';
import type { ExportFormat, ReportKind } from './types';

export interface FormRevisionFormProps {
  /** Called with the code of the revision that was drafted, once the server accepted it. */
  onDone: (formCode: string) => void;
  onCancel: () => void;
}

/**
 * The form that drafts a revision of a report form (createMneFormVersion): the legal basis and the period are mandatory and the DOC
 * template must exist. Nothing is published by drafting: another person publishes the draft from the catalogue.
 */
export function FormRevisionForm({ onDone, onCancel }: FormRevisionFormProps) {
  const { t } = useTranslation();
  const create = useCreateForm();
  const [values, setValues] = useState<RevisionValues>(EMPTY_REVISION);
  const [errors, setErrors] = useState<RevisionErrors>({});
  const refused = create.isError ? describeProblem(create.error) : undefined;

  const set = <K extends keyof RevisionValues>(field: K, value: RevisionValues[K]): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const toggleFormat = (format: ExportFormat): void => set('exportFormats', values.exportFormats.includes(format) ? values.exportFormats.filter((item) => item !== format) : [...values.exportFormats, format]);

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateRevision(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(values, { onSuccess: () => onDone(values.formCode.trim()) });
  };

  const error = (field: keyof RevisionValues): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem);
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('mne.forms.create.title')}>
      <h2>{t('mne.forms.create.title')}</h2>
      <p className="sub">{t('mne.forms.create.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      <div className="mne-filters">
        <Field id="revision-code" label={t('mne.forms.create.code.label')} error={error('formCode')}>
          <input id="revision-code" value={values.formCode} aria-invalid={errors.formCode !== undefined} onChange={(event) => set('formCode', event.target.value)} />
        </Field>
        <Field id="revision-title" label={t('mne.forms.create.name.label')} error={error('title')}>
          <input id="revision-title" value={values.title} aria-invalid={errors.title !== undefined} onChange={(event) => set('title', event.target.value)} />
        </Field>
        <Field id="revision-kind" label={t('mne.forms.create.kind.label')} error={error('reportKind')}>
          <select id="revision-kind" value={values.reportKind} aria-invalid={errors.reportKind !== undefined} onChange={(event) => set('reportKind', event.target.value as ReportKind | '')}>
            <option value="">{t('mne.forms.create.kind.placeholder')}</option>
            {REPORT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {reportKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="revision-template" label={t('mne.forms.create.template.label')} error={error('docTemplateCode')} hint={t('mne.forms.create.template.hint')}>
          <input id="revision-template" value={values.docTemplateCode} aria-invalid={errors.docTemplateCode !== undefined} onChange={(event) => set('docTemplateCode', event.target.value)} />
        </Field>
        <Field id="revision-from" label={t('mne.forms.create.from.label')} error={error('effectiveFrom')}>
          <input id="revision-from" type="date" value={values.effectiveFrom} aria-invalid={errors.effectiveFrom !== undefined} onChange={(event) => set('effectiveFrom', event.target.value)} />
        </Field>
        <Field id="revision-until" label={t('mne.forms.create.until.label')} error={error('effectiveUntil')} hint={t('mne.forms.create.until.hint')}>
          <input id="revision-until" type="date" value={values.effectiveUntil} aria-invalid={errors.effectiveUntil !== undefined} onChange={(event) => set('effectiveUntil', event.target.value)} />
        </Field>
      </div>
      <Field id="revision-basis" label={t('mne.forms.create.basis.label')} error={error('legalBasis')}>
        <textarea id="revision-basis" value={values.legalBasis} aria-invalid={errors.legalBasis !== undefined} onChange={(event) => set('legalBasis', event.target.value)} />
      </Field>
      <Field id="revision-reference" label={t('mne.forms.create.reference.label')} error={error('legalConfirmationRef')} hint={t('mne.forms.create.reference.hint')}>
        <input id="revision-reference" value={values.legalConfirmationRef} aria-invalid={errors.legalConfirmationRef !== undefined} onChange={(event) => set('legalConfirmationRef', event.target.value)} />
      </Field>
      <fieldset className="field" data-field="formats">
        <legend>{t('mne.forms.create.formats.label')}</legend>
        <div className="mne-formats">
          {EXPORT_FORMATS.map((format) => (
            <label key={format}>
              <input type="checkbox" checked={values.exportFormats.includes(format)} onChange={() => toggleFormat(format)} /> {format}
            </label>
          ))}
        </div>
        {errors.exportFormats === undefined ? null : (
          <small role="alert" className="field-error">
            {error('exportFormats')}
          </small>
        )}
      </fieldset>
      <Field id="revision-schema" label={t('mne.forms.create.schema.label')} error={error('schemaText')} hint={t('mne.forms.create.schema.hint')}>
        <textarea id="revision-schema" value={values.schemaText} aria-invalid={errors.schemaText !== undefined} onChange={(event) => set('schemaText', event.target.value)} />
      </Field>
      <div className="row gap">
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
          {t('mne.forms.create.submit.action')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('mne.forms.create.cancel.action')}
        </button>
      </div>
    </form>
  );
}
