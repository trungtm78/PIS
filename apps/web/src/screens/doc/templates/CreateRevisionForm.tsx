import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import { Info } from '../../gov11/gov11-kit';
import { useLayoutProfiles } from '../layout/hooks';
import { EMPTY_CREATE, createBody, refusalOfCreate, validateCreate } from './create-rules';
import type { CreateErrors, CreateProblem, CreateRefusal, CreateValues } from './create-rules';
import { useCreateTemplate } from './hooks';
import { groupLabel } from './labels';
import { TEMPLATE_GROUPS } from './types';

type T = Translator['t'];

function problemText(t: T, problem: CreateProblem): string {
  switch (problem) {
    case 'required':
      return t('misc.tpl.problem.required');
    case 'tooShort':
      return t('misc.tpl.problem.tooShort');
    case 'tooLong':
      return t('misc.tpl.problem.tooLong');
    case 'notJson':
      return t('misc.tpl.problem.notJson');
    case 'notObject':
      return t('misc.tpl.problem.notObject');
    case 'badDay':
      return t('misc.tpl.problem.badDay');
    case 'beforeStart':
      return t('misc.tpl.problem.beforeStart');
  }
}

function refusalText(t: T, refusal: CreateRefusal): string {
  switch (refusal) {
    case 'legalBasis':
      return t('misc.tpl.refused.legal');
    case 'placeholders':
      return t('misc.tpl.refused.placeholders');
    case 'formDuplicate':
      return t('misc.tpl.refused.form');
    case 'overlap':
      return t('misc.tpl.refused.overlap');
    case 'invalid':
      return t('misc.tpl.refused.invalid');
    case 'denied':
      return t('misc.tpl.refused.denied');
    case 'session':
      return t('misc.tpl.refused.session');
    case 'other':
      return t('misc.tpl.refused.other');
  }
}

export interface CreateRevisionFormProps {
  /** The day the "i" is as of, as the person reads it. */
  asOf: string;
  onCreated: (templateCode: string) => void;
  onCancel: () => void;
}

/**
 * DOC-14: the form that drafts a revision of a document template. The revision starts as a DRAFT and has no effect: another person publishes it (maker is not checker) and a third step confirms the legal basis. Every
 * member of the contract is checked before sending (lengths, the two JSON members, the period); what only the server can know (an overlapping period, a duplicate form code, a placeholder schema it cannot use) is told
 * in words, and the form keeps what was typed.
 */
export function CreateRevisionForm({ asOf, onCreated, onCancel }: CreateRevisionFormProps) {
  const { t } = useTranslation();
  const create = useCreateTemplate();
  const layouts = useLayoutProfiles(true);
  const [values, setValues] = useState<CreateValues>(EMPTY_CREATE);
  const [errors, setErrors] = useState<CreateErrors>({});
  const profiles = (layouts.data ?? []).filter((profile) => profile.status === 'PUBLISHED');
  const refusal = create.isError ? refusalOfCreate(create.error instanceof ApiError ? create.error.code : undefined) : undefined;

  const set = (field: keyof CreateValues, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validateCreate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(createBody(values), { onSuccess: () => onCreated(values.templateCode.trim()) });
  };

  const fieldError = (field: keyof CreateValues) =>
    errors[field] === undefined ? null : (
      <small role="alert" className="field-error">
        {problemText(t, errors[field] as CreateProblem)}
      </small>
    );

  const text = (field: keyof CreateValues, label: string, max: number, hint?: string) => (
    <div className="field" data-field={field}>
      <label htmlFor={`tpl-${field}`}>{label}</label>
      <input id={`tpl-${field}`} value={values[field]} maxLength={max} aria-invalid={errors[field] !== undefined} onChange={(event) => set(field, event.target.value)} />
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {fieldError(field)}
    </div>
  );

  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="tpl-create-title" data-testid="template-create-form">
      <h2 id="tpl-create-title">{t('misc.tpl.title')}</h2>
      <p className="sub">{t('misc.tpl.hint')}</p>
      {text('templateCode', t('misc.tpl.field.code'), 80)}
      <div className="field" data-field="groupCode">
        <label htmlFor="tpl-groupCode">{t('misc.tpl.field.group')}</label>
        <select id="tpl-groupCode" value={values.groupCode} aria-invalid={errors.groupCode !== undefined} onChange={(event) => set('groupCode', event.target.value)}>
          <option value="">{t('misc.tpl.field.choose')}</option>
          {TEMPLATE_GROUPS.map((group) => (
            <option key={group} value={group}>
              {groupLabel(t, group)}
            </option>
          ))}
        </select>
        {fieldError('groupCode')}
      </div>
      {text('docTypeCode', t('misc.tpl.field.docType'), 20)}
      {text('formCode', t('misc.tpl.field.form'), 40, t('misc.tpl.field.form.hint'))}
      {text('title', t('misc.tpl.field.title'), 300)}
      {text('sourceModule', t('misc.tpl.field.module'), 10)}
      <div className="field" data-field="layoutProfileId">
        <label htmlFor="tpl-layoutProfileId">{t('misc.tpl.field.layout')}</label>
        <select id="tpl-layoutProfileId" value={values.layoutProfileId} disabled={layouts.isLoading} aria-invalid={errors.layoutProfileId !== undefined} onChange={(event) => set('layoutProfileId', event.target.value)}>
          <option value="">{layouts.isLoading ? t('misc.tpl.layout.loading') : t('misc.tpl.field.choose')}</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {t('misc.tpl.layout.option', { code: profile.profileCode, revision: profile.revision })}
            </option>
          ))}
        </select>
        {layouts.isError ? (
          <small role="alert" className="field-error" data-testid="layout-error">
            {t('misc.tpl.layout.error')}{' '}
            <button type="button" onClick={() => void layouts.refetch()}>
              {t('misc.tpl.layout.retry')}
            </button>
          </small>
        ) : null}
        {!layouts.isLoading && !layouts.isError && profiles.length === 0 ? <small className="sub">{t('misc.tpl.layout.none')}</small> : null}
        {fieldError('layoutProfileId')}
      </div>
      <div className="field" data-field="bodyBlocks">
        <label htmlFor="tpl-bodyBlocks">{t('misc.tpl.field.blocks')}</label>
        <textarea id="tpl-bodyBlocks" rows={5} value={values.bodyBlocks} aria-invalid={errors.bodyBlocks !== undefined} onChange={(event) => set('bodyBlocks', event.target.value)} />
        <small className="sub">{t('misc.tpl.field.blocks.hint')}</small>
        {fieldError('bodyBlocks')}
      </div>
      <div className="field" data-field="placeholderSchema">
        <label htmlFor="tpl-placeholderSchema">{t('misc.tpl.field.placeholders')}</label>
        <textarea id="tpl-placeholderSchema" rows={5} value={values.placeholderSchema} aria-invalid={errors.placeholderSchema !== undefined} onChange={(event) => set('placeholderSchema', event.target.value)} />
        <small className="sub">{t('misc.tpl.field.placeholders.hint')}</small>
        {fieldError('placeholderSchema')}
      </div>
      <div className="field" data-field="legalBasis">
        <label htmlFor="tpl-legalBasis">{t('misc.tpl.field.legal')}</label>
        <textarea id="tpl-legalBasis" rows={3} value={values.legalBasis} maxLength={2100} aria-invalid={errors.legalBasis !== undefined} onChange={(event) => set('legalBasis', event.target.value)} />
        {fieldError('legalBasis')}
      </div>
      {text('legalConfirmationRef', t('misc.tpl.field.legalRef'), 50, t('misc.tpl.field.legalRef.hint'))}
      <div className="row gap">
        <div className="field" data-field="effectiveFrom">
          <label htmlFor="tpl-effectiveFrom">{t('misc.tpl.field.from')}</label>
          <input id="tpl-effectiveFrom" type="date" value={values.effectiveFrom} aria-invalid={errors.effectiveFrom !== undefined} onChange={(event) => set('effectiveFrom', event.target.value)} />
          {fieldError('effectiveFrom')}
        </div>
        <div className="field" data-field="effectiveUntil">
          <label htmlFor="tpl-effectiveUntil">{t('misc.tpl.field.until')}</label>
          <input id="tpl-effectiveUntil" type="date" value={values.effectiveUntil} aria-invalid={errors.effectiveUntil !== undefined} onChange={(event) => set('effectiveUntil', event.target.value)} />
          <small className="sub">{t('misc.tpl.field.until.hint')}</small>
          {fieldError('effectiveUntil')}
        </div>
        <Info name={t('misc.tpl.info.name')} rule={undefined} fallbackFormula={t('misc.tpl.info.formula')} owner={t('misc.tpl.info.owner')} asOf={asOf} />
      </div>
      {text('watermarkText', t('misc.tpl.field.watermark'), 120, t('misc.tpl.field.watermark.hint'))}
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="template-create-error" data-refusal={refusal}>
          {refusalText(t, refusal)}
        </p>
      )}
      <div className="row gap">
        <button type="submit" className="primary" disabled={create.isPending} data-testid="template-create-submit">
          {create.isPending ? t('misc.tpl.sending') : t('misc.tpl.submit')}
        </button>
        <button type="button" onClick={onCancel} data-testid="template-create-cancel">
          {t('misc.tpl.cancel')}
        </button>
      </div>
    </form>
  );
}
