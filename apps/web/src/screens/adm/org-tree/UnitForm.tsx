import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { businessToday } from './business-date';
import { statusLabel, unitTypeLabel } from './labels';
import { UNIT_TYPES } from './types';
import type { FormField, OrgUnit, UnitType } from './types';

export interface FormValues {
  code: string;
  name: string;
  parent_id: string;
  unit_type: UnitType;
  valid_from: string;
  is_investor: boolean;
  administrative_code: string;
  legal_basis_ref: string;
}

const isUnitType = (value: string): value is UnitType => (UNIT_TYPES as readonly string[]).includes(value);

/** The values the form starts with: the unit itself when editing, a blank unit under `parentId` when creating. */
export function initialValues(unit: OrgUnit | undefined, parentId: string | undefined, today: string = businessToday()): FormValues {
  if (unit === undefined) {
    return { code: '', name: '', parent_id: parentId ?? '', unit_type: 'DEPARTMENT', valid_from: today, is_investor: false, administrative_code: '', legal_basis_ref: '' };
  }
  return {
    code: unit.code,
    name: unit.name,
    parent_id: unit.parent_id ?? '',
    unit_type: isUnitType(unit.unit_type) ? unit.unit_type : 'OTHER',
    valid_from: unit.valid_from,
    is_investor: unit.is_investor,
    administrative_code: unit.administrative_code ?? '',
    legal_basis_ref: unit.legal_basis_ref ?? '',
  };
}

/**
 * The fields of an update that differ from the unit the draft was made from. An optional text the user emptied is sent as
 * an empty string (OrgUnitUpdate accepts it); a unit that never had the text and a form that leaves it empty is no change.
 */
export function changedFields(unit: OrgUnit, values: FormValues): Record<string, string | boolean> {
  const patch: Record<string, string | boolean> = {};
  if (values.code !== unit.code) patch.code = values.code;
  if (values.name !== unit.name) patch.name = values.name;
  if (values.is_investor !== unit.is_investor) patch.is_investor = values.is_investor;
  if (values.administrative_code !== (unit.administrative_code ?? '')) patch.administrative_code = values.administrative_code;
  if (values.legal_basis_ref !== (unit.legal_basis_ref ?? '')) patch.legal_basis_ref = values.legal_basis_ref;
  return patch;
}

interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}

function Field({ id, label, error, required, hint, children }: FieldProps) {
  const { t } = useTranslation();
  return (
    <div className={`field${error === undefined ? '' : ' unit-field-error'}`}>
      <label htmlFor={id}>
        {label} {required === true ? <span className="required" aria-label={t('adm.orgUnit.field.required.label')}>*</span> : null}
      </label>
      {children}
      {error === undefined ? <small>{hint ?? t('adm.orgUnit.field.scope.hint')}</small> : <p className="unit-form-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

export interface UnitFormProps {
  mode: 'create' | 'edit';
  unit: OrgUnit | undefined;
  units: readonly OrgUnit[];
  /** The parent a new unit starts under (the selected unit). */
  defaultParentId: string | undefined;
  readOnly: boolean;
  pending: boolean;
  /** Messages of the server's refusals by field, already translated. */
  errors: Partial<Record<FormField, string>>;
  /** A message that belongs to no field. */
  message: string | undefined;
  /** Values typed before the form was last unmounted; the form starts from them instead of from the unit. */
  draft?: FormValues;
  /** Called with every edit, so the owner can keep the draft across an unmount. */
  onDraft?(values: FormValues): void;
  onSubmit(values: FormValues): void;
  onMove?(): void;
}

/** The unit form: create (every field) or edit (code, name, investor flag, administrative code, legal basis; the rest is shown). */
export function UnitForm({ mode, unit, units, defaultParentId, readOnly, pending, errors, message, draft, onDraft, onSubmit, onMove }: UnitFormProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<FormValues>(() => draft ?? initialValues(unit, defaultParentId));
  const editing = mode === 'edit' && unit !== undefined;
  const parent = units.find((candidate) => candidate.id === (editing ? unit.parent_id : values.parent_id));
  const successor = editing ? units.find((candidate) => candidate.id === unit.successor_id) : undefined;
  const dirty = editing ? Object.keys(changedFields(unit, values)).length > 0 : true;
  const locked = readOnly || pending;
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]): void => {
    const next = { ...values, [key]: value };
    setValues(next);
    onDraft?.(next);
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!locked && dirty) onSubmit(values);
  };

  return (
    <form onSubmit={submit} noValidate={false} aria-label={editing ? t('adm.orgUnit.form.edit.title') : t('adm.orgUnit.form.new.title')}>
      <div className="formgrid">
        <Field id="unit-name" label={t('adm.orgUnit.field.name.label')} required error={errors.name}>
          <input id="unit-name" required value={values.name} disabled={locked} aria-invalid={errors.name !== undefined} aria-describedby={errors.name === undefined ? undefined : 'unit-name-error'} onChange={(event) => set('name', event.target.value)} />
        </Field>
        <Field id="unit-code" label={t('adm.orgUnit.field.code.label')} required error={errors.code}>
          <input id="unit-code" required value={values.code} disabled={locked} aria-invalid={errors.code !== undefined} aria-describedby={errors.code === undefined ? undefined : 'unit-code-error'} onChange={(event) => set('code', event.target.value)} />
        </Field>
        <Field id="unit-parent" label={t('adm.orgUnit.field.parent.label')} required={!editing} error={errors.parent_id}>
          {editing ? (
            <input id="unit-parent" readOnly value={parent === undefined ? '' : `${parent.code} · ${parent.name}`} aria-invalid={errors.parent_id !== undefined} />
          ) : (
            <select id="unit-parent" required value={values.parent_id} disabled={locked} aria-invalid={errors.parent_id !== undefined} aria-describedby={errors.parent_id === undefined ? undefined : 'unit-parent-error'} onChange={(event) => set('parent_id', event.target.value)}>
              <option value="">{t('adm.orgUnit.field.parent.placeholder')}</option>
              {[...units].sort((a, b) => (a.code < b.code ? -1 : 1)).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.code} · {candidate.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="unit-valid-from" label={t('adm.orgUnit.field.validFrom.label')} required={!editing} error={errors.valid_from}>
          <input id="unit-valid-from" type="date" required={!editing} value={values.valid_from} readOnly={editing} disabled={!editing && locked} aria-invalid={errors.valid_from !== undefined} aria-describedby={errors.valid_from === undefined ? undefined : 'unit-valid-from-error'} onChange={(event) => set('valid_from', event.target.value)} />
        </Field>
        <Field id="unit-type" label={t('adm.orgUnit.field.unitType.label')} required={!editing} error={errors.unit_type}>
          <select id="unit-type" value={values.unit_type} disabled={editing || locked} aria-invalid={errors.unit_type !== undefined} onChange={(event) => isUnitType(event.target.value) && set('unit_type', event.target.value)}>
            {UNIT_TYPES.map((type) => (
              <option key={type} value={type}>
                {unitTypeLabel(t, type)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="unit-administrative-code" label={t('adm.orgUnit.field.administrativeCode.label')} error={errors.administrative_code}>
          <input id="unit-administrative-code" maxLength={20} value={values.administrative_code} disabled={locked} aria-invalid={errors.administrative_code !== undefined} aria-describedby={errors.administrative_code === undefined ? undefined : 'unit-administrative-code-error'} onChange={(event) => set('administrative_code', event.target.value)} />
        </Field>
        <Field id="unit-legal-basis" label={t('adm.orgUnit.field.legalBasis.label')} error={errors.legal_basis_ref}>
          <input id="unit-legal-basis" maxLength={255} value={values.legal_basis_ref} disabled={locked} aria-invalid={errors.legal_basis_ref !== undefined} aria-describedby={errors.legal_basis_ref === undefined ? undefined : 'unit-legal-basis-error'} onChange={(event) => set('legal_basis_ref', event.target.value)} />
        </Field>
        <div className="field">
          <label htmlFor="unit-investor">{t('adm.orgUnit.field.isInvestor.label')}</label>
          <input id="unit-investor" type="checkbox" checked={values.is_investor} disabled={locked} onChange={(event) => set('is_investor', event.target.checked)} />
        </div>
        {editing ? (
          <>
            <div className="field">
              <label htmlFor="unit-successor">{t('adm.orgUnit.field.successor.label')}</label>
              <input id="unit-successor" readOnly value={successor === undefined ? '' : `${successor.code} · ${successor.name}`} />
            </div>
            <div className="field">
              <label htmlFor="unit-status">{t('adm.orgUnit.field.status.label')}</label>
              <input id="unit-status" readOnly value={statusLabel(t, unit.status)} />
            </div>
          </>
        ) : null}
      </div>
      {message === undefined ? null : <p className="callout warning" role="alert">{message}</p>}
      {readOnly ? (
        <p className="callout" role="note">{t('adm.orgUnit.readonly.notice')}</p>
      ) : (
        <div className="formfooter">
          {editing && onMove !== undefined ? (
            <button type="button" className="ui-button ui-button--outline" onClick={onMove} disabled={pending}>
              {t('adm.orgUnit.move.action')}
            </button>
          ) : (
            <span />
          )}
          <div className="actions">
            <button type="submit" className="ui-button ui-button--primary" disabled={pending || !dirty}>
              {editing ? t('adm.orgUnit.update.submit') : t('adm.orgUnit.create.submit')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
