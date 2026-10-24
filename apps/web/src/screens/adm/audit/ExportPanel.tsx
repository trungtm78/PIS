import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { useExportAudit } from './hooks';
import { exportFieldMessage, problemMessage } from './labels';
import { EMPTY_EXPORT, EXPORT_FORMATS, MAX_EXPORT_DAYS, describeProblem, exportBody, validateExport } from './model';
import type { ExportDone, ExportErrors, ExportField, ExportFormat, ExportValues } from './model';

function FieldError({ id, errors, field }: { id: string; errors: ExportErrors; field: ExportField }) {
  const { t } = useTranslation();
  const problem = errors[field];
  return problem === undefined ? null : (
    <small role="alert" className="field-error" id={`${id}-error`}>
      {exportFieldMessage(t, problem)}
    </small>
  );
}

/**
 * The export of a sealed slice (ST-ADM-016): a period of at most 366 days, a format and, when wanted, the resource types. The file
 * holds the events, the seals that cover them and the hashes of the other rows of those seals, so the recipient verifies the chain alone.
 */
export function ExportPanel({ onClose }: { onClose(): void }) {
  const { t } = useTranslation();
  const exporting = useExportAudit();
  const [values, setValues] = useState<ExportValues>(EMPTY_EXPORT);
  const [errors, setErrors] = useState<ExportErrors>({});
  const [done, setDone] = useState<ExportDone | undefined>(undefined);
  const set = <K extends keyof ExportValues>(field: K, value: ExportValues[K]): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setDone(undefined);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateExport(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    exporting.mutate(exportBody(values), { onSuccess: (result) => setDone(result ?? { exportId: '' }) });
  };

  return (
    <aside className="card export-panel" aria-label={t('adm.audit.export.title')} data-testid="export-panel">
      <h2>{t('adm.audit.export.title')}</h2>
      <p className="sub">{t('adm.audit.export.hint', { days: MAX_EXPORT_DAYS })}</p>
      <form onSubmit={submit} noValidate>
        <div className="formgrid">
          <div className="field">
            <label htmlFor="export-from">{t('adm.audit.export.from.label')}</label>
            <input id="export-from" type="datetime-local" value={values.from} aria-invalid={errors.from !== undefined} onChange={(event) => set('from', event.target.value)} />
            <FieldError id="export-from" errors={errors} field="from" />
          </div>
          <div className="field">
            <label htmlFor="export-to">{t('adm.audit.export.to.label')}</label>
            <input id="export-to" type="datetime-local" value={values.to} aria-invalid={errors.to !== undefined} onChange={(event) => set('to', event.target.value)} />
            <FieldError id="export-to" errors={errors} field="to" />
          </div>
          <div className="field">
            <label htmlFor="export-format">{t('adm.audit.export.format.label')}</label>
            <select id="export-format" value={values.format} onChange={(event) => set('format', event.target.value as ExportFormat)}>
              {EXPORT_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
            <small>{t('adm.audit.export.format.hint')}</small>
          </div>
          <div className="field">
            <label htmlFor="export-types">{t('adm.audit.export.types.label')}</label>
            <input id="export-types" value={values.resourceTypes} aria-invalid={errors.resourceTypes !== undefined} onChange={(event) => set('resourceTypes', event.target.value)} />
            <small>{t('adm.audit.export.types.hint')}</small>
            <FieldError id="export-types" errors={errors} field="resourceTypes" />
          </div>
        </div>
        {exporting.isError ? (
          <p className="callout warning" role="alert">
            {problemMessage(t, describeProblem(exporting.error))}
          </p>
        ) : null}
        {done === undefined ? null : (
          <p className="callout" role="status" data-testid="export-done">
            {t('adm.audit.export.done.text', { id: done.exportId })}
          </p>
        )}
        <div className="formfooter">
          <button type="submit" className="primary" disabled={exporting.isPending}>
            {t('adm.audit.export.submit.action')}
          </button>
          <button type="button" onClick={onClose}>
            {t('adm.audit.export.close.action')}
          </button>
        </div>
      </form>
    </aside>
  );
}
