import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useDraftPolicy, usePolicies, usePublishPolicy } from './hooks';
import { classificationLabel, policyStatusLabel, problemMessage, refusalMessage, routeLabel } from './labels';
import { BASELINE, CLASSIFICATIONS, POLICY_APPROVE, POLICY_MANAGE, ROUTES, describeLlmProblem, initialPolicy, matrixInForce, validatePolicy, vietnamDay } from './llm-model';
import type { Classification, Matrix, PolicyEntry, PolicyErrors, PolicyValues, Route } from './llm-model';
import './llm-kit.css';

/**
 * LLM-19: the matrix that says which route each class of data may take (ST-LLM-001, LLM BR-LLM-01): the one in force, the revisions with who may publish them, and a draft made from the matrix in force. The baseline is
 * shown as what it is, a floor nobody can go under: confidential, important and personal data never go to an international model, and important data goes to a model the tenant hosts itself. A draft cannot
 * be wider than the baseline; the server refuses a publication that is, and says which classes.
 */
export default function PolicyMatrixScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <PolicyMatrixContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PolicyMatrixContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const can = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';
  const policies = usePolicies();
  const state = useScreenState({
    isLoading: policies.isLoading,
    error: policies.error,
    data: policies.data,
  });
  const book = policies.data;
  const matrix = book === undefined ? undefined : matrixInForce(book);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.policy.page.title')}</h1>
          <p>{t('llm.policy.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void policies.refetch()}>
        {book === undefined || matrix === undefined ? null : (
          <>
            <p className={book.inForce === undefined ? 'callout warning' : 'sub'} role="status" data-testid="policy-in-force" data-baseline={book.inForce === undefined ? 'true' : 'false'}>
              {book.inForce === undefined ? t('llm.policy.baselineOnly') : t('llm.policy.inForce', { revision: book.inForce.revision })}
            </p>
            <MatrixTable matrix={matrix} testId="policy-matrix" label={t('llm.policy.matrix.aria')} />
            <table className="table" data-testid="policy-revisions" aria-label={t('llm.policy.revisions.aria')}>
              <thead>
                <tr>
                  <th scope="col">{t('llm.policy.column.revision')}</th>
                  <th scope="col">{t('llm.policy.column.status')}</th>
                  <th scope="col">{t('llm.policy.column.international')}</th>
                  <th scope="col">{t('llm.policy.column.basis')}</th>
                  <th scope="col">{t('llm.policy.column.effective')}</th>
                  <th scope="col">{t('llm.policy.column.action')}</th>
                </tr>
              </thead>
              <tbody>
                {book.policies.map((policy) => (
                  <PolicyRow key={policy.id} policy={policy} mayPublish={can(POLICY_APPROVE)} />
                ))}
              </tbody>
            </table>
            {book.policies.length === 0 ? <p data-testid="policy-none">{t('llm.policy.none')}</p> : null}
            {can(POLICY_MANAGE) ? <DraftForm matrix={matrix} /> : null}
          </>
        )}
      </StateBoundary>
    </section>
  );
}

function MatrixTable({ matrix, testId, label }: { matrix: Matrix; testId: string; label: string }) {
  const { t } = useTranslation();
  return (
    <table className="table" data-testid={testId} aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{t('llm.policy.matrix.level')}</th>
          {ROUTES.map((route) => (
            <th key={route} scope="col">
              {routeLabel(t, route)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {CLASSIFICATIONS.map((level) => (
          <tr key={level} data-level={level}>
            <th scope="row">{classificationLabel(t, level)}</th>
            {ROUTES.map((route) => {
              const allowed = matrix[level].includes(route);
              return (
                <td key={route} data-route={route} data-allowed={allowed ? 'true' : 'false'}>
                  {allowed ? t('llm.policy.matrix.allowed') : BASELINE[level].includes(route) ? t('llm.policy.matrix.closed') : t('llm.policy.matrix.never')}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PolicyRow({ policy, mayPublish }: { policy: PolicyEntry; mayPublish: boolean }) {
  const { t } = useTranslation();
  const publish = usePublishPolicy();
  const refused = publish.isError ? describeLlmProblem(publish.error) : undefined;
  return (
    <>
      <tr data-policy-id={policy.id} data-status={policy.status}>
        <td>{t('llm.policy.revision', { revision: policy.revision })}</td>
        <td>{policyStatusLabel(t, policy.status)}</td>
        <td>{policy.internationalEnabled ? t('llm.policy.international.on', { ref: policy.d07Ref ?? '' }) : t('llm.policy.international.off')}</td>
        <td>{policy.legalBasis}</td>
        <td>{vietnamDay(policy.effectiveFrom)}</td>
        <td>
          {mayPublish && policy.status === 'DRAFT' ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={publish.isPending} onClick={() => publish.mutate({ policyId: policy.id, version: policy.version })}>
              {t('llm.policy.publish')}
            </button>
          ) : null}
          {refused === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="publish-refused">
              {refusalMessage(t, refused.reason, refused.detail)}
            </p>
          )}
        </td>
      </tr>
      <tr data-policy-preview={policy.id}>
        <td colSpan={6}>
          <details>
            <summary>{t('llm.policy.preview', { revision: policy.revision })}</summary>
            <MatrixTable
              matrix={policy.matrix}
              testId={`policy-matrix-${policy.id}`}
              label={t('llm.policy.preview.aria', {
                revision: policy.revision,
              })}
            />
          </details>
        </td>
      </tr>
    </>
  );
}

function DraftForm({ matrix }: { matrix: Matrix }) {
  const { t } = useTranslation();
  const draft = useDraftPolicy();
  const [values, setValues] = useState<PolicyValues>(() => initialPolicy(matrix, vietnamDay(new Date().toISOString())));
  const [errors, setErrors] = useState<PolicyErrors>({});
  const refused = draft.isError ? describeLlmProblem(draft.error) : undefined;
  const set = <K extends keyof PolicyValues>(field: K, value: PolicyValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const toggle = (level: Classification, route: Route): void => {
    const next = {
      ...values.matrix,
      [level]: values.matrix[level].includes(route) ? values.matrix[level].filter((name) => name !== route) : [...values.matrix[level], route],
    };
    set('matrix', next);
  };
  const message = (field: keyof PolicyErrors): string | undefined => (errors[field] === undefined ? undefined : problemMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.isPending) return;
    const found = validatePolicy(values);
    setErrors(found);
    if (Object.keys(found).length === 0) draft.mutate(values);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.policy.form.title')}>
      <h2>{t('llm.policy.form.title')}</h2>
      <p className="sub">{t('llm.policy.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="policy-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {draft.isSuccess ? (
        <p className="callout" role="status" data-testid="policy-saved">
          {t('llm.policy.form.saved')}
        </p>
      ) : null}
      <fieldset data-testid="draft-matrix">
        <legend>{t('llm.policy.form.matrix')}</legend>
        {message('matrix') === undefined ? null : (
          <p className="callout warning" role="alert">
            {message('matrix')}
          </p>
        )}
        {CLASSIFICATIONS.map((level) => (
          <div key={level} data-level={level}>
            <strong>{classificationLabel(t, level)}</strong>{' '}
            {ROUTES.map((route) => {
              // A route the baseline never gives to a class is not offered; the one of important data that cannot be taken away is shown fixed; the international route needs the tenant to have it on.
              if (!BASELINE[level].includes(route)) return null;
              const fixed = level === 'IMPORTANT_CORE' && route === 'SELF_HOSTED';
              const off = route === 'INTERNATIONAL' && !values.internationalEnabled;
              return (
                <label key={route} className="field" htmlFor={`cell-${level}-${route}`}>
                  <input id={`cell-${level}-${route}`} type="checkbox" checked={values.matrix[level].includes(route) && !off} disabled={fixed || off} onChange={() => toggle(level, route)} />{' '}
                  {routeLabel(t, route)}
                </label>
              );
            })}
          </div>
        ))}
      </fieldset>
      <label className="field" htmlFor="policy-international">
        <input id="policy-international" type="checkbox" checked={values.internationalEnabled} onChange={(event) => set('internationalEnabled', event.target.checked)} />{' '}
        {t('llm.policy.form.international')}
      </label>
      {values.internationalEnabled ? (
        <Field id="policy-d07" label={t('llm.policy.form.d07')} error={message('d07Ref')}>
          <input id="policy-d07" value={values.d07Ref} onChange={(event) => set('d07Ref', event.target.value)} maxLength={80} />
        </Field>
      ) : null}
      <div className="mne-filters">
        <Field id="policy-basis" label={t('llm.policy.form.basis')} error={message('legalBasis')}>
          <input id="policy-basis" value={values.legalBasis} onChange={(event) => set('legalBasis', event.target.value)} maxLength={2000} />
        </Field>
        <Field id="policy-effective" label={t('llm.policy.form.effective')} error={message('effectiveFrom')}>
          <input id="policy-effective" type="date" value={values.effectiveFrom} onChange={(event) => set('effectiveFrom', event.target.value)} />
        </Field>
      </div>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={draft.isPending}>
          {t('llm.policy.form.submit')}
        </button>
      </div>
    </form>
  );
}
