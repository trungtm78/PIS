import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { BackLink, Field, ImpactTable, SubmitWithImpact } from './components';
import { useChange, useCreateChange, useHistory, useRecordByKey, useRecords, useTypePolicies, useUsage } from './hooks';
import { fieldProblemMessage, problemMessage, recordStatusLabel } from './labels';
import { PROPOSE_PERMISSION, describeProblem, namespaceOf, recordLink, validateRetire } from './model';
import type { RecordView, RetireField, RetireForm } from './model';

const APPROVAL_PATH = '/mdm/mdm-32';
const DETAIL_PATH = '/mdm/mdm-27';
const NEVER_EMPTY = (): boolean => false;
const EMPTY_FORM: RetireForm = { effectiveFrom: '', successorRecordId: '', reason: '' };

/** MDM-31: retiring an entry: what still uses it, the entry that takes its place, the date, and the reason (ST-MDM-002). */
export default function MasterRetireScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  return <MasterRetireContent key={tenantId ?? 'none'} route={route} />;
}

function MasterRetireContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const masterType = params.get('type') ?? undefined;
  const businessKey = params.get('key') ?? undefined;
  const record = useRecordByKey(masterType, businessKey, namespaceOf(params.get('ns')));
  const state = useScreenState({ isLoading: record.isLoading, error: record.error, data: masterType === undefined || businessKey === undefined ? undefined : (record.data ?? undefined), isEmpty: NEVER_EMPTY });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={APPROVAL_PATH}>{t('mdm.back.approval.link')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('mdm.retire.page.title')}</h1>
          <p>{t('mdm.retire.page.subtitle')}</p>
        </div>
      </div>
      {masterType === undefined || businessKey === undefined || (record.isSuccess && record.data === null) ? (
        <p className="callout warning" role="status" data-testid="no-record">
          {t('mdm.retire.noRecord.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void record.refetch()}>
          {record.data === undefined || record.data === null ? null : <Retire record={record.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('mdm.retire.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Retire({ record }: { record: RecordView }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const canPropose = (permissions === undefined || permissions.includes(PROPOSE_PERMISSION)) && !frozen;
  const usage = useUsage(record.id);
  const policies = useTypePolicies();
  const history = useHistory(record.id);
  const siblings = useRecords(record.masterType);
  const create = useCreateChange();
  const [form, setForm] = useState<RetireForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<RetireField, ReturnType<typeof validateRetire>[RetireField]>>>({});
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [submitted, setSubmitted] = useState(false);
  const change = useChange(opened);
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const current = useMemo(() => history.data?.find((version) => version.id === record.versionId), [history.data, record.versionId]);
  const policy = policies.data?.find((candidate) => candidate.masterType === record.masterType);
  const inUse = (usage.data?.total ?? 0) > 0;
  const successorRequired = inUse || policy?.retireRequiresSuccessor === true;
  const successors = useMemo(() => (siblings.data ?? []).filter((candidate) => candidate.id !== record.id && candidate.status === 'EFFECTIVE'), [siblings.data, record.id]);
  // What the server judges is read first: retiring is offered once the usage and the policy are known, never on a guess.
  const ready = usage.isSuccess && usage.data !== null && policies.isSuccess;

  const setField = (field: RetireField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };
  const error = (field: RetireField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canPropose || !ready || opened !== undefined) return;
    const found = validateRetire(form, current?.validFrom ?? null, successorRequired);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(
      {
        change_kind: 'RETIRE',
        master_type: record.masterType,
        master_record_id: record.id,
        proposed: {},
        effective_from: form.effectiveFrom,
        reason: form.reason.trim(),
        ...(form.successorRecordId === '' ? {} : { successor_record_id: form.successorRecordId }),
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
      <form className="card" onSubmit={save} noValidate aria-label={t('mdm.retire.form.aria')}>
        <h2>{t('mdm.retire.form.title', { key: record.businessKey })}</h2>
        {!canPropose ? (
          <p className="callout warning" role="status">
            {frozen ? t('mdm.readOnly.frozen.notice') : t('mdm.readOnly.denied.notice')}
          </p>
        ) : null}
        {inUse ? (
          <p className="callout warning" role="status" data-testid="in-use">
            {t('mdm.retire.inUse.notice', { total: usage.data?.total ?? 0 })}
          </p>
        ) : null}
        {!inUse && policy?.retireRequiresSuccessor === true ? (
          <p className="callout" role="status" data-testid="successor-policy">
            {t('mdm.retire.policy.notice')}
          </p>
        ) : null}
        {usage.isError || policies.isError ? (
          <p className="callout warning" role="alert">
            {t('mdm.retire.read.error')}
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p className="callout warning" role="alert">
            {problemMessage(t, problem)}
          </p>
        )}
        <fieldset disabled={opened !== undefined || !canPropose || !ready}>
          <Field id="retire-effectiveFrom" label={t('mdm.retire.date.label')} error={error('effectiveFrom')} hint={t('mdm.edit.effectiveFrom.hint', { from: current?.validFrom ?? '' })}>
            <input id="retire-effectiveFrom" type="date" value={form.effectiveFrom} aria-invalid={error('effectiveFrom') !== undefined} onChange={(event) => setField('effectiveFrom', event.target.value)} />
          </Field>
          <Field id="retire-successor" label={t('mdm.retire.successor.label')} error={error('successorRecordId')} hint={successorRequired ? t('mdm.retire.successor.required.hint') : t('mdm.retire.successor.optional.hint')}>
            <select id="retire-successor" value={form.successorRecordId} aria-invalid={error('successorRecordId') !== undefined} onChange={(event) => setField('successorRecordId', event.target.value)}>
              <option value="">{t('mdm.retire.successor.none')}</option>
              {successors.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.businessKey} · {candidate.label ?? ''}
                </option>
              ))}
            </select>
          </Field>
          <Field id="retire-reason" label={t('mdm.retire.reason.label')} error={error('reason')}>
            <textarea id="retire-reason" rows={2} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
          </Field>
        </fieldset>
        <div className="formfooter">
          <span className="sub">{t('mdm.retire.form.hint')}</span>
          {canPropose && opened === undefined ? (
            <button type="submit" className="primary" disabled={create.isPending || !ready}>
              {t('mdm.retire.save.action')}
            </button>
          ) : null}
        </div>
      </form>
      <div>
        {opened === undefined ? (
          <aside className="card" aria-label={t('mdm.detail.usage.title')}>
            <h2>{t('mdm.detail.usage.title')}</h2>
            {usage.data === undefined || usage.data === null ? <p className="muted">{t('mdm.detail.usage.loading')}</p> : <ImpactTable impact={usage.data} />}
          </aside>
        ) : (
          <>
            <p className="callout" role="status">
              {t('mdm.retire.draft.saved.notice')}
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
