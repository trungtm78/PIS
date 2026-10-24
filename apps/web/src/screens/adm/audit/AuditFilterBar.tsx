import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { filterMessage, outcomeLabel } from './labels';
import { AUDIT_OUTCOMES, EMPTY_FILTER, validateFilter } from './model';
import type { AuditOutcome, FilterErrors, FilterField, FilterValues } from './model';

export interface AuditFilterBarProps {
  /** Called with values that passed validation; an empty filter shows the whole trail. */
  onApply(values: FilterValues): void;
}

function FieldError({ id, errors, field }: { id: string; errors: FilterErrors; field: FilterField }) {
  const { t } = useTranslation();
  const problem = errors[field];
  return problem === undefined ? null : (
    <small role="alert" className="field-error" id={`${id}-error`}>
      {filterMessage(t, problem)}
    </small>
  );
}

/** The filters of the trail (ADM 3.11): actor, action, resource type, outcome and period. */
export function AuditFilterBar({ onApply }: AuditFilterBarProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<FilterValues>(EMPTY_FILTER);
  const [errors, setErrors] = useState<FilterErrors>({});
  const set = (field: FilterField) => (value: string) => setValues((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateFilter(values);
    setErrors(found);
    if (Object.keys(found).length === 0) onApply(values);
  };
  const clear = (): void => {
    setValues(EMPTY_FILTER);
    setErrors({});
    onApply(EMPTY_FILTER);
  };

  return (
    <form className="filters" onSubmit={submit} aria-label={t('adm.audit.filter.title')} noValidate>
      <div>
        <label htmlFor="audit-outcome">{t('adm.audit.filter.outcome.label')}</label>
        <select id="audit-outcome" value={values.outcome} onChange={(event) => set('outcome')(event.target.value as '' | AuditOutcome)}>
          <option value="">{t('adm.audit.filter.outcome.all')}</option>
          {AUDIT_OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcomeLabel(t, outcome)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="audit-actor">{t('adm.audit.filter.actor.label')}</label>
        <input id="audit-actor" value={values.actorId} aria-invalid={errors.actorId !== undefined} onChange={(event) => set('actorId')(event.target.value)} />
        <FieldError id="audit-actor" errors={errors} field="actorId" />
      </div>
      <div>
        <label htmlFor="audit-action">{t('adm.audit.filter.action.label')}</label>
        <input id="audit-action" value={values.action} aria-invalid={errors.action !== undefined} onChange={(event) => set('action')(event.target.value)} />
        <FieldError id="audit-action" errors={errors} field="action" />
      </div>
      <div>
        <label htmlFor="audit-resource">{t('adm.audit.filter.resource.label')}</label>
        <input id="audit-resource" value={values.resourceType} aria-invalid={errors.resourceType !== undefined} onChange={(event) => set('resourceType')(event.target.value)} />
        <FieldError id="audit-resource" errors={errors} field="resourceType" />
      </div>
      <div>
        <label htmlFor="audit-from">{t('adm.audit.filter.from.label')}</label>
        <input id="audit-from" type="datetime-local" value={values.from} aria-invalid={errors.from !== undefined} onChange={(event) => set('from')(event.target.value)} />
        <FieldError id="audit-from" errors={errors} field="from" />
      </div>
      <div>
        <label htmlFor="audit-to">{t('adm.audit.filter.to.label')}</label>
        <input id="audit-to" type="datetime-local" value={values.to} aria-invalid={errors.to !== undefined} onChange={(event) => set('to')(event.target.value)} />
        <FieldError id="audit-to" errors={errors} field="to" />
      </div>
      <button type="submit" className="primary">
        {t('adm.audit.filter.apply.action')}
      </button>
      <button type="button" onClick={clear}>
        {t('adm.audit.filter.clear.action')}
      </button>
    </form>
  );
}
