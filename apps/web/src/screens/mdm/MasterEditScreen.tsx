import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { AttributeFields, BackLink, Field, SubmitWithImpact } from './components';
import { useChange, useCreateChange, useHistory, useRecordByKey, useRecords } from './hooks';
import { fieldProblemMessage, problemMessage, recordStatusLabel } from './labels';
import { PROPOSE_PERMISSION, describeProblem, namespaceOf, parseAttributes, recordLink, validateEdit } from './model';
import type { EditField, EditForm, RecordView } from './model';
import { SectionCard } from '../../ui';
import '../adm/adm-kit.css';

const APPROVAL_PATH = '/mdm/mdm-32';
const HISTORY_PATH = '/mdm/mdm-28';
const DETAIL_PATH = '/mdm/mdm-27';
const NEVER_EMPTY = (): boolean => false;

/** MDM-26: a change of an entry in force from a new effective date: the old version stays valid until then (ST-MDM-001). */
export default function MasterEditScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterEditContent key={tenantId ?? 'none'} route={route} />;
}

function MasterEditContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const masterType = params.get('type') ?? undefined;
  const businessKey = params.get('key') ?? undefined;
  const namespace = namespaceOf(params.get('ns'));
  const record = useRecordByKey(masterType, businessKey, namespace);
  const state = useScreenState({ isLoading: record.isLoading, error: record.error, data: masterType === undefined || businessKey === undefined ? undefined : record.data ?? undefined, isEmpty: NEVER_EMPTY });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={masterType === undefined || businessKey === undefined ? HISTORY_PATH : recordLink(HISTORY_PATH, masterType, businessKey, namespace)}>{t('mdm.back.history.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.edit.page.title')}</h1>
          <p>{t('mdm.edit.page.subtitle')}</p>
        </div>
      </div>
      {masterType === undefined || businessKey === undefined || (record.isSuccess && record.data === null) ? (
        <p className="callout warning" role="status" data-testid="no-record">
          {t('mdm.edit.noRecord.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void record.refetch()}>
          {record.data === undefined || record.data === null ? null : <EditForm record={record.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('mdm.edit.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function EditForm({ record }: { record: RecordView }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && !frozen;
  const history = useHistory(record.id);
  const records = useRecords(undefined);
  const create = useCreateChange();
  const current = useMemo(() => history.data?.find((version) => version.id === record.versionId), [history.data, record.versionId]);
  const [form, setForm] = useState<EditForm | undefined>(undefined);
  const [errors, setErrors] = useState<Partial<Record<EditField, ReturnType<typeof validateEdit>[EditField]>>>({});
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  const change = useChange(opened);
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const parents = useMemo(() => (records.data ?? []).filter((candidate) => candidate.masterType === record.masterType && candidate.id !== record.id && candidate.status === 'EFFECTIVE'), [records.data, record.masterType, record.id]);

  // The form starts from the version in force; it is filled once, when that version has been read.
  useEffect(() => {
    if (current !== undefined && form === undefined) {
      setForm({
        label: current.label,
        attributes: JSON.stringify(current.attributes, null, 2),
        parentRecordId: current.parentRecordId ?? '',
        effectiveFrom: '',
        validUntil: current.validUntil ?? '',
        legalBasis: current.legalBasis ?? '',
        reason: '',
      });
    }
  }, [current, form]);

  const setField = (field: EditField, value: string): void => {
    setForm((previous) => (previous === undefined ? previous : { ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };
  const error = (field: EditField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (form === undefined || create.isPending || !canPropose || opened !== undefined) return;
    const found = validateEdit(form, current?.validFrom ?? null);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(
      {
        change_kind: 'UPDATE',
        master_type: record.masterType,
        master_record_id: record.id,
        proposed: {
          label: form.label.trim(),
          attributes: parseAttributes(form.attributes) ?? {},
          parent_record_id: form.parentRecordId === '' ? null : form.parentRecordId,
          valid_until: form.validUntil === '' ? null : form.validUntil,
          legal_basis: form.legalBasis.trim() === '' ? null : form.legalBasis.trim(),
        },
        effective_from: form.effectiveFrom,
        reason: form.reason.trim(),
      },
      { onSuccess: (answer) => setOpened((answer as { resource_id?: string }).resource_id) },
    );
  };

  if (record.status !== 'EFFECTIVE') {
    return (
      <p className="callout warning" role="status" data-testid="not-in-force">
        {t('mdm.edit.notInForce.notice', { status: recordStatusLabel(t, record.status) })}
      </p>
    );
  }
  if (record.openChangeRequestId !== null && opened === undefined) {
    return (
      <p className="callout warning" role="status" data-testid="change-open">
        {t('mdm.edit.changeOpen.notice')} <Link to={recordLink(DETAIL_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.edit.detail.link')}</Link>
      </p>
    );
  }

  return (
    <div className="mdm-grid">
      <form className="card" onSubmit={save} noValidate aria-label={t('mdm.edit.form.aria')}>
        <h2>{t('mdm.edit.form.title', { key: record.businessKey })}</h2>
        {!canPropose ? (
          <p className="callout warning" role="status">
            {frozen ? t('mdm.readOnly.frozen.notice') : t('mdm.readOnly.denied.notice')}
          </p>
        ) : null}
        {current === undefined ? <p className="muted">{t('mdm.edit.loading.text')}</p> : null}
        {problem === undefined ? null : (
          <p className="callout warning" role="alert">
            {problemMessage(t, problem)}
          </p>
        )}
        {form === undefined ? null : (
          <>
            <fieldset disabled={opened !== undefined || !canPropose} className="formgrid">
              <Field id="edit-label" label={t('mdm.edit.name.label')} error={error('label')}>
                <input id="edit-label" value={form.label} aria-invalid={error('label') !== undefined} onChange={(event) => setField('label', event.target.value)} />
              </Field>
              <Field id="edit-effectiveFrom" label={t('mdm.edit.effectiveFrom.label')} error={error('effectiveFrom')} hint={t('mdm.edit.effectiveFrom.hint', { from: current?.validFrom ?? '' })}>
                <input id="edit-effectiveFrom" type="date" value={form.effectiveFrom} aria-invalid={error('effectiveFrom') !== undefined} onChange={(event) => setField('effectiveFrom', event.target.value)} />
              </Field>
              <Field id="edit-validUntil" label={t('mdm.edit.validUntil.label')} error={error('validUntil')}>
                <input id="edit-validUntil" type="date" value={form.validUntil} aria-invalid={error('validUntil') !== undefined} onChange={(event) => setField('validUntil', event.target.value)} />
              </Field>
              <Field id="edit-parentRecordId" label={t('mdm.edit.parent.label')} error={undefined}>
                <select id="edit-parentRecordId" value={form.parentRecordId} onChange={(event) => setField('parentRecordId', event.target.value)}>
                  <option value="">{t('mdm.edit.parent.none')}</option>
                  {parents.map((parent) => (
                    <option key={parent.id} value={parent.id}>
                      {parent.businessKey} · {parent.label ?? ''}
                    </option>
                  ))}
                </select>
              </Field>
            </fieldset>
            <fieldset disabled={opened !== undefined || !canPropose}>
              <Field id="edit-legalBasis" label={t('mdm.edit.legalBasis.label')} error={error('legalBasis')}>
                <textarea id="edit-legalBasis" rows={2} value={form.legalBasis} aria-invalid={error('legalBasis') !== undefined} onChange={(event) => setField('legalBasis', event.target.value)} />
              </Field>
              <AttributeFields
                idPrefix="edit"
                masterType={record.masterType}
                value={form.attributes}
                onChange={(json) => setField('attributes', json)}
                records={records.data ?? []}
                disabled={opened !== undefined || !canPropose}
                label={t('mdm.edit.attributes.label')}
                error={error('attributes')}
                effectiveFrom={form.effectiveFrom}
              />
              <Field id="edit-reason" label={t('mdm.edit.reason.label')} error={error('reason')}>
                <textarea id="edit-reason" rows={2} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
              </Field>
            </fieldset>
            <div className="adm-kit-actions">
              <span className="sub">{t('mdm.edit.form.hint')}</span>
              {canPropose && opened === undefined ? (
                <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
                  {t('mdm.edit.save.action')}
                </button>
              ) : null}
            </div>
          </>
        )}
      </form>
      <div>
        {opened === undefined ? (
          <SectionCard title={t('mdm.impact.step.title')}>
            <p className="muted">{t('mdm.create.impact.waiting.text')}</p>
          </SectionCard>
        ) : (
          <>
            <p className="callout" role="status">
              {t('mdm.edit.draft.saved.notice')}
            </p>
            {change.data === undefined || change.data === null || submitted ? null : <SubmitWithImpact change={change.data} canSubmit={canPropose} onSubmitted={() => setSubmitted(true)} />}
            {submitted ? (
              <p className="callout" role="status">
                {t('mdm.create.submitted.notice')} <Link to={APPROVAL_PATH}>{t('mdm.create.queue.link')}</Link> · <Link to={recordLink(DETAIL_PATH, record.masterType, record.businessKey, record.namespace)}>{t('mdm.create.detail.link')}</Link>
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
