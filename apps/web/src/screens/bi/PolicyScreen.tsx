import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useCreatePolicy, useDatasets, usePolicies } from './hooks';
import { granteeKindLabel, policyFieldMessage, policyRefusalMessage, policyStatusLabel } from './labels';
import { EMPTY_POLICY, GRANTEE_KINDS, POLICY_PERMISSION, describePolicyProblem, predicateText, validatePolicy } from './policy-model';
import type { GranteeKind, PolicyErrors, PolicyValues } from './policy-model';
import './bi-kit.css';

/**
 * BI-08: the row and column policies (ST-BI-003, BI BR-BI-05): for the dataset chosen, who each policy is for (a role, a unit and everything under it, or one person), the rows it allows, the columns it hides and
 * its status. A dataset that no ACTIVE policy covers is closed: the screen says so, because an empty answer must never look like "no data". A draft is made from choices (only the rows in the person's scope, an
 * extra condition on a dimension, the columns to hide), so a condition outside the grammar cannot be typed; it allows nothing until another person makes it active (the decision on a publication request, ST-BI-006).
 */
export default function PolicyScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <PolicyContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PolicyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(POLICY_PERMISSION)) && mode !== 'READ_ONLY';
  const [params, setParams] = useSearchParams();
  const datasets = useDatasets();
  const asked = params.get('dataset') ?? '';
  const chosen = (datasets.data ?? []).find((dataset) => dataset.id === asked) ?? datasets.data?.[0];
  const policies = usePolicies(chosen?.id);
  const state = useScreenState({ isLoading: datasets.isLoading || (chosen !== undefined && policies.isLoading), error: datasets.error ?? policies.error, data: datasets.data });
  const rows = policies.data ?? [];
  const open = rows.some((policy) => policy.status === 'ACTIVE');
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.policy.page.title')}</h1>
          <p>{t('bi.policy.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void datasets.refetch();
          void policies.refetch();
        }}
      >
        <div className="card">
          <Field id="policy-dataset" label={t('bi.policy.dataset')} error={undefined}>
            <select id="policy-dataset" value={chosen?.id ?? ''} onChange={(event) => setParams({ dataset: event.target.value }, { replace: true })}>
              {(datasets.data ?? []).map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.title} ({dataset.code})
                </option>
              ))}
            </select>
          </Field>
          <p className={open ? 'sub' : 'callout warning'} role="status" data-testid="policy-openness" data-open={open ? 'true' : 'false'}>
            {open ? t('bi.policy.open') : t('bi.policy.closed')}
          </p>
        </div>
        <table className="table" data-testid="policy-table" aria-label={t('bi.policy.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.policy.column.grantee')}</th>
              <th scope="col">{t('bi.policy.column.scope')}</th>
              <th scope="col">{t('bi.policy.column.hidden')}</th>
              <th scope="col">{t('bi.policy.column.condition')}</th>
              <th scope="col">{t('bi.policy.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((policy) => (
              <tr key={policy.id} data-policy-id={policy.id} data-status={policy.status}>
                <td>
                  {granteeKindLabel(t, policy.granteeKind)} <span className="sub">{policy.granteeRefId.slice(0, 8)}</span> <span className="sub">{t('bi.policy.revision', { revision: policy.revision })}</span>
                </td>
                <td>{t('bi.policy.scope.own')}</td>
                <td>{policy.hiddenColumns.length === 0 ? t('bi.policy.none') : policy.hiddenColumns.join(', ')}</td>
                <td>
                  <code>{predicateText(policy.predicate, t('bi.policy.inScope'))}</code>
                </td>
                <td>{policyStatusLabel(t, policy.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <p data-testid="policy-none">{t('bi.policy.noPolicies')}</p> : null}
        <p className="sub" data-testid="policy-preview-note">
          {t('bi.policy.preview.note')}
        </p>
        {may && chosen !== undefined ? <PolicyForm key={chosen.id} datasetId={chosen.id} dimensions={chosen.dimensions} /> : null}
      </StateBoundary>
    </section>
  );
}

function PolicyForm({ datasetId, dimensions }: { datasetId: string; dimensions: string[] }) {
  const { t } = useTranslation();
  const create = useCreatePolicy();
  const [values, setValues] = useState<PolicyValues>({ ...EMPTY_POLICY, datasetId });
  const [errors, setErrors] = useState<PolicyErrors>({});
  const refused = create.isError ? describePolicyProblem(create.error) : undefined;
  const current = { ...values, datasetId };
  const set = <K extends keyof PolicyValues>(field: K, value: PolicyValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const message = (field: keyof PolicyErrors): string | undefined => (errors[field] === undefined ? undefined : policyFieldMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending) return;
    const found = validatePolicy(current);
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate(current);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('bi.policy.form.title')}>
      <h2>{t('bi.policy.form.title')}</h2>
      <p className="sub">{t('bi.policy.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="policy-refused">
          {policyRefusalMessage(t, refused.reason, refused.field)}
        </p>
      )}
      {create.isSuccess ? (
        <p className="callout" role="status" data-testid="policy-saved">
          {t('bi.policy.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="policy-kind" label={t('bi.policy.form.kind')} error={undefined}>
          <select id="policy-kind" value={values.granteeKind} onChange={(event) => set('granteeKind', event.target.value as GranteeKind)}>
            {GRANTEE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {granteeKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="policy-grantee" label={t('bi.policy.form.grantee')} error={message('granteeRefId')}>
          <input id="policy-grantee" value={values.granteeRefId} aria-invalid={errors.granteeRefId !== undefined} onChange={(event) => set('granteeRefId', event.target.value)} />
        </Field>
        <label className="field" htmlFor="policy-in-scope">
          <input id="policy-in-scope" type="checkbox" checked={values.inScope} onChange={(event) => set('inScope', event.target.checked)} /> {t('bi.policy.form.inScope')}
        </label>
        <Field id="policy-field" label={t('bi.policy.form.field')} error={message('condition')} hint={dimensions.length === 0 ? t('bi.policy.form.noDimensions') : t('bi.policy.form.fieldHint', { dimensions: dimensions.join(', ') })}>
          <input id="policy-field" value={values.conditionField} aria-invalid={errors.condition !== undefined} onChange={(event) => set('conditionField', event.target.value)} />
        </Field>
        <Field id="policy-values" label={t('bi.policy.form.values')} error={message('conditionValues')}>
          <input id="policy-values" value={values.conditionValues} aria-invalid={errors.conditionValues !== undefined} onChange={(event) => set('conditionValues', event.target.value)} />
        </Field>
        <Field id="policy-hidden" label={t('bi.policy.form.hidden')} error={message('hiddenColumns')} hint={t('bi.policy.form.columnsHint')}>
          <input id="policy-hidden" value={values.hiddenColumns} aria-invalid={errors.hiddenColumns !== undefined} onChange={(event) => set('hiddenColumns', event.target.value)} />
        </Field>
        <Field id="policy-masked" label={t('bi.policy.form.masked')} error={message('maskedColumns')}>
          <input id="policy-masked" value={values.maskedColumns} aria-invalid={errors.maskedColumns !== undefined} onChange={(event) => set('maskedColumns', event.target.value)} />
        </Field>
      </div>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
          {t('bi.policy.form.save')}
        </button>
      </div>
    </form>
  );
}
