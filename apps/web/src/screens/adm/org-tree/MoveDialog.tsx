import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { businessToday } from './business-date';
import type { FormField, OrgUnit } from './types';

export const MIN_REASON_LENGTH = 10;

export interface MoveValues {
  new_parent_id: string;
  effective_from: string;
  reason: string;
}

export interface MoveDialogProps {
  unit: OrgUnit;
  units: readonly OrgUnit[];
  pending: boolean;
  errors: Partial<Record<FormField, string>>;
  message: string | undefined;
  onSubmit(values: MoveValues): void;
  onCancel(): void;
}

/**
 * Moves a unit under another parent. The new parent list leaves out the unit itself only: a cycle or a depth the server
 * refuses is answered by the server and shown on the field, so the user sees the real rule, not a hidden option.
 */
export function MoveDialog({ unit, units, pending, errors, message, onSubmit, onCancel }: MoveDialogProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<MoveValues>({ new_parent_id: unit.parent_id ?? '', effective_from: businessToday(), reason: '' });
  const reasonTooShort = values.reason.trim().length < MIN_REASON_LENGTH;
  const set = <K extends keyof MoveValues>(key: K, value: MoveValues[K]): void => setValues((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!pending && values.new_parent_id !== '' && !reasonTooShort) onSubmit({ ...values, reason: values.reason.trim() });
  };

  const field = (name: FormField): string | undefined => errors[name];
  return (
    <div role="dialog" aria-modal="false" aria-labelledby="move-title" className="unit-dialog">
      <h2 id="move-title">{t('adm.orgUnit.move.title', { name: unit.name })}</h2>
      <form onSubmit={submit}>
        <div className="formgrid">
          <div className={`field${field('new_parent_id') === undefined ? '' : ' unit-field-error'}`}>
            <label htmlFor="move-parent">{t('adm.orgUnit.move.parent.label')}</label>
            <select id="move-parent" required value={values.new_parent_id} disabled={pending} aria-invalid={field('new_parent_id') !== undefined} aria-describedby={field('new_parent_id') === undefined ? undefined : 'move-parent-error'} onChange={(event) => set('new_parent_id', event.target.value)}>
              <option value="">{t('adm.orgUnit.field.parent.placeholder')}</option>
              {units
                .filter((candidate) => candidate.id !== unit.id)
                .sort((a, b) => (a.code < b.code ? -1 : 1))
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {`${candidate.code} · ${candidate.name}`}
                  </option>
                ))}
            </select>
            {field('new_parent_id') === undefined ? null : <p className="unit-form-error" id="move-parent-error" role="alert">{field('new_parent_id')}</p>}
          </div>
          <div className={`field${field('effective_from') === undefined ? '' : ' unit-field-error'}`}>
            <label htmlFor="move-effective">{t('adm.orgUnit.move.effectiveFrom.label')}</label>
            <input id="move-effective" type="date" required value={values.effective_from} disabled={pending} aria-invalid={field('effective_from') !== undefined} onChange={(event) => set('effective_from', event.target.value)} />
            {field('effective_from') === undefined ? null : <p className="unit-form-error" role="alert">{field('effective_from')}</p>}
          </div>
          <div className={`field${field('reason') === undefined ? '' : ' unit-field-error'}`}>
            <label htmlFor="move-reason">{t('adm.orgUnit.move.reason.label')}</label>
            <textarea id="move-reason" required minLength={MIN_REASON_LENGTH} maxLength={2000} value={values.reason} disabled={pending} aria-invalid={field('reason') !== undefined} aria-describedby="move-reason-hint" onChange={(event) => set('reason', event.target.value)} />
            <small id="move-reason-hint">{field('reason') ?? t('adm.orgUnit.move.reason.hint', { count: MIN_REASON_LENGTH })}</small>
          </div>
        </div>
        {message === undefined ? null : <p className="callout warning" role="alert">{message}</p>}
        <div className="formfooter">
          <button type="button" onClick={onCancel} disabled={pending}>
            {t('adm.orgUnit.move.cancel')}
          </button>
          <div className="actions">
            <button type="submit" className="ui-button ui-button--primary" disabled={pending || reasonTooShort || values.new_parent_id === ''}>
              {t('adm.orgUnit.move.submit')}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
