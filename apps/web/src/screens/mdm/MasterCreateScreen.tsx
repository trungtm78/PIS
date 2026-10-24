import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { BackLink, Field, SubmitWithImpact } from './components';
import { useChange, useProposeRecord, useRecordByKey, useRecords } from './hooks';
import { fieldProblemMessage, problemMessage } from './labels';
import { EMPTY_RECORD_FORM, LABEL_MAX_LENGTH, PROPOSE_PERMISSION, describeProblem, parseAttributes, recordLink, validateNewRecord } from './model';
import type { RecordField, RecordForm } from './model';

const APPROVAL_PATH = '/mdm/mdm-32';
const IMPORT_PATH = '/mdm/mdm-29';
const DETAIL_PATH = '/mdm/mdm-27';

/** MDM-25: a new master record is proposed as a draft, its impact is shown, and only then it is submitted for review (ST-MDM-001). */
export default function MasterCreateScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The form, the draft and the impact belong to one tenant: a switch starts the screen over.
  return <MasterCreateContent key={tenantId ?? 'none'} route={route} />;
}

function MasterCreateContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && !frozen;
  const records = useRecords(undefined);
  const propose = useProposeRecord();
  const [form, setForm] = useState<RecordForm>(EMPTY_RECORD_FORM);
  const [errors, setErrors] = useState<Partial<Record<RecordField, ReturnType<typeof validateNewRecord>[RecordField]>>>({});
  const [draft, setDraft] = useState<{ type: string; key: string } | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  const saved = useRecordByKey(draft?.type, draft?.key);
  const change = useChange(saved.data?.openChangeRequestId);
  const problem = propose.isError ? describeProblem(propose.error) : undefined;
  const types = useMemo(() => [...new Set((records.data ?? []).map((record) => record.masterType))].sort(), [records.data]);
  const parents = useMemo(() => (records.data ?? []).filter((record) => record.masterType === form.masterType.trim() && record.status === 'EFFECTIVE'), [records.data, form.masterType]);

  const setField = (field: RecordField, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const error = (field: RecordField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (propose.isPending || !canPropose || draft !== undefined) return;
    const found = validateNewRecord(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    propose.mutate(
      {
        namespace: 'TENANT',
        master_type: form.masterType.trim(),
        business_key: form.businessKey.trim(),
        label: form.label.trim(),
        attributes: parseAttributes(form.attributes) ?? {},
        valid_from: form.validFrom,
        ...(form.validUntil === '' ? {} : { valid_until: form.validUntil }),
        ...(form.parentRecordId === '' ? {} : { parent_record_id: form.parentRecordId }),
        ...(form.legalBasis.trim() === '' ? {} : { legal_basis: form.legalBasis.trim() }),
        reason: form.reason.trim(),
      },
      { onSuccess: () => setDraft({ type: form.masterType.trim(), key: form.businessKey.trim() }) },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={IMPORT_PATH}>{t('mdm.back.import.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.create.page.title')}</h1>
          <p>{t('mdm.create.page.subtitle')}</p>
        </div>
      </div>
      <div className="mdm-grid">
        <form className="card" onSubmit={save} noValidate aria-label={t('mdm.create.form.title')}>
          <h2>{t('mdm.create.form.title')}</h2>
          {!canPropose ? (
            <p className="callout warning" role="status">
              {frozen ? t('mdm.readOnly.frozen.notice') : t('mdm.readOnly.denied.notice')}
            </p>
          ) : null}
          {problem === undefined ? null : (
            <p className="callout warning" role="alert">
              {problemMessage(t, problem)}
            </p>
          )}
          <fieldset disabled={draft !== undefined || !canPropose} className="formgrid">
            <Field id="record-masterType" label={t('mdm.create.type.label')} error={error('masterType')}>
              <input id="record-masterType" list="mdm-known-types" value={form.masterType} aria-invalid={error('masterType') !== undefined} onChange={(event) => setField('masterType', event.target.value)} />
              <datalist id="mdm-known-types">
                {types.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </Field>
            <Field id="record-businessKey" label={t('mdm.create.key.label')} error={error('businessKey')}>
              <input id="record-businessKey" value={form.businessKey} aria-invalid={error('businessKey') !== undefined} onChange={(event) => setField('businessKey', event.target.value)} />
            </Field>
            <Field id="record-label" label={t('mdm.create.name.label')} error={error('label')}>
              <input id="record-label" maxLength={LABEL_MAX_LENGTH + 1} value={form.label} aria-invalid={error('label') !== undefined} onChange={(event) => setField('label', event.target.value)} />
            </Field>
            <Field id="record-parentRecordId" label={t('mdm.create.parent.label')} error={undefined} hint={t('mdm.create.parent.hint')}>
              <select id="record-parentRecordId" value={form.parentRecordId} onChange={(event) => setField('parentRecordId', event.target.value)}>
                <option value="">{t('mdm.create.parent.none')}</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.businessKey} · {parent.label ?? ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="record-validFrom" label={t('mdm.create.validFrom.label')} error={error('validFrom')}>
              <input id="record-validFrom" type="date" value={form.validFrom} aria-invalid={error('validFrom') !== undefined} onChange={(event) => setField('validFrom', event.target.value)} />
            </Field>
            <Field id="record-validUntil" label={t('mdm.create.validUntil.label')} error={error('validUntil')} hint={t('mdm.create.validUntil.hint')}>
              <input id="record-validUntil" type="date" value={form.validUntil} aria-invalid={error('validUntil') !== undefined} onChange={(event) => setField('validUntil', event.target.value)} />
            </Field>
          </fieldset>
          <fieldset disabled={draft !== undefined || !canPropose}>
            <Field id="record-legalBasis" label={t('mdm.create.legalBasis.label')} error={error('legalBasis')}>
              <textarea id="record-legalBasis" rows={2} value={form.legalBasis} aria-invalid={error('legalBasis') !== undefined} onChange={(event) => setField('legalBasis', event.target.value)} />
            </Field>
            <Field id="record-attributes" label={t('mdm.create.attributes.label')} error={error('attributes')} hint={t('mdm.create.attributes.hint')}>
              <textarea id="record-attributes" rows={4} spellCheck={false} value={form.attributes} aria-invalid={error('attributes') !== undefined} onChange={(event) => setField('attributes', event.target.value)} />
            </Field>
            <Field id="record-reason" label={t('mdm.create.reason.label')} error={error('reason')}>
              <textarea id="record-reason" rows={2} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
            </Field>
          </fieldset>
          <div className="formfooter">
            <span className="sub">{t('mdm.create.form.hint')}</span>
            {canPropose && draft === undefined ? (
              <button type="submit" className="primary" disabled={propose.isPending}>
                {t('mdm.create.save.action')}
              </button>
            ) : null}
          </div>
        </form>
        <div>
          {draft === undefined ? (
            <aside className="card">
              <h2>{t('mdm.impact.step.title')}</h2>
              <p className="muted">{t('mdm.create.impact.waiting.text')}</p>
            </aside>
          ) : (
            <>
              <p className="callout" role="status">
                {t('mdm.create.draft.saved.notice')}
              </p>
              {change.isError || saved.isError ? (
                <p className="callout warning" role="alert">
                  {t('mdm.create.impact.error')}
                </p>
              ) : null}
              {change.data === undefined || change.data === null || submitted ? null : <SubmitWithImpact change={change.data} canSubmit={canPropose} onSubmitted={() => setSubmitted(true)} />}
              {submitted ? (
                <p className="callout" role="status">
                  {t('mdm.create.submitted.notice')} <Link to={APPROVAL_PATH}>{t('mdm.create.queue.link')}</Link> · <Link to={recordLink(DETAIL_PATH, draft.type, draft.key)}>{t('mdm.create.detail.link')}</Link>
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      <p className="prototype-note">{t('mdm.create.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
