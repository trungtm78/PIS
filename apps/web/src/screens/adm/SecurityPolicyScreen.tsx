import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useCreatePolicyDraft, usePolicies, usePublishPolicy, useRoleCodes } from './security/hooks';
import { policyFieldMessage, policyProblemMessage, policyStatusLabel, policyStatusTone } from './security/labels';
import {
  APPROVE_POLICY_PERMISSION,
  DRAFT_POLICY_PERMISSION,
  EMPTY_POLICY_VALUES,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  describeProblem,
  policyBody,
  validatePolicy,
  valuesOfPolicy,
} from './security/model';
import type { PolicyErrors, PolicyField, PolicyValues, PolicyView } from './security/model';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from './KitTable';
import './adm-kit.css';
import './security/security.css';

const NEVER_EMPTY = (): boolean => false;

interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

/** What a person must see before publishing a draft: every persisted field, not only the ones the table has room for. */
function PolicyPreview({ policy }: { policy: PolicyView }) {
  const { t } = useTranslation();
  return (
    <dl data-testid="publish-preview" aria-label={t('adm.securityPolicy.preview.title')}>
      <dt>{t('adm.securityPolicy.col.roles')}</dt>
      <dd>{policy.mfaRequiredRoles.length === 0 ? t('adm.securityPolicy.current.noRoles') : policy.mfaRequiredRoles.join(', ')}</dd>
      <dt>{t('adm.securityPolicy.col.session')}</dt>
      <dd>{t('adm.securityPolicy.session.summary', { idle: policy.sessionIdleMinutes, hours: policy.sessionMaxHours })}</dd>
      <dt>{t('adm.securityPolicy.ip.label')}</dt>
      <dd>{policy.ipAllowlist.length === 0 ? t('adm.securityPolicy.preview.none') : policy.ipAllowlist.join(', ')}</dd>
      <dt>{t('adm.securityPolicy.ttl.label')}</dt>
      <dd>{policy.downloadTtlMinutes === null ? t('adm.securityPolicy.preview.none') : policy.downloadTtlMinutes}</dd>
      <dt>{t('adm.securityPolicy.watermark.label')}</dt>
      <dd>{policy.exportWatermark ? t('adm.securityPolicy.preview.watermark.on') : t('adm.securityPolicy.preview.watermark.off')}</dd>
    </dl>
  );
}

/** ADM-14: the versioned tenant security policy (ST-ADM-009): a draft by one administrator, published by another. */
export default function SecurityPolicyScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the form, the open publication, the reason) belongs to one tenant: a switch starts it over,
  // so a policy drafted for one tenant can never be saved into another.
  return <SecurityPolicyContent key={tenantId ?? 'none'} route={route} />;
}

function SecurityPolicyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, tenant, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canDraft = (permissions === undefined || permissions.includes(DRAFT_POLICY_PERMISSION)) && !frozen;
  const canApprove = (permissions === undefined || permissions.includes(APPROVE_POLICY_PERMISSION)) && !frozen;
  const list = usePolicies();
  const roles = useRoleCodes();
  const create = useCreatePolicyDraft();
  const publish = usePublishPolicy();
  const [values, setValues] = useState<PolicyValues>(EMPTY_POLICY_VALUES);
  const [errors, setErrors] = useState<PolicyErrors>({});
  const [publishing, setPublishing] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  // The text of the draft the server accepted last: the same text is not saved again (it would be another revision) until it is edited.
  const [accepted, setAccepted] = useState<string | undefined>(undefined);
  const policies = useMemo(() => list.data ?? [], [list.data]);
  const inForce = policies.find((policy) => policy.status === 'Published');
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: NEVER_EMPTY });
  const createProblem = create.isError ? describeProblem(create.error) : undefined;
  const publishProblem = publish.isError ? describeProblem(publish.error) : undefined;
  // The roles a policy can name come from the role catalogue: without it the form cannot say which roles need MFA, and saving an
  // empty list would drop the requirement, so nothing is saved until the roles are read.
  const rolesReady = roles.isSuccess;
  const unchanged = accepted !== undefined && accepted === JSON.stringify(policyBody(values));

  const setField = (field: PolicyField, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const toggleRole = (code: string): void =>
    setValues((current) => ({
      ...current,
      mfaRequiredRoles: current.mfaRequiredRoles.includes(code) ? current.mfaRequiredRoles.filter((role) => role !== code) : [...current.mfaRequiredRoles, code],
    }));
  const fieldError = (field: PolicyField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : policyFieldMessage(t, own);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canDraft || !rolesReady || unchanged) return;
    const found = validatePolicy(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = policyBody(values);
    create.mutate(body, { onSuccess: () => setAccepted(JSON.stringify(body)) });
  };

  const confirmPublish = (event: FormEvent, policy: PolicyView): void => {
    event.preventDefault();
    if (publish.isPending || !canApprove) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    publish.mutate({ id: policy.id, version: policy.version, reason: trimmed }, { onSuccess: () => setPublishing(undefined) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.securityPolicy.page.title')}</h1>
          <p>{t('adm.securityPolicy.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="adm-security">
          <div className="adm-kit-stack">
          <SectionCard title={t('adm.securityPolicy.form.title')}>
            {!canDraft ? (
              <p className="callout warning" role="status">
                {frozen ? t('adm.securityPolicy.frozen.notice') : t('adm.securityPolicy.readOnly.notice')}
              </p>
            ) : null}
            {roles.isError ? (
              <p className="callout warning" role="alert">
                {t('adm.securityPolicy.roles.error')}
              </p>
            ) : null}
            {create.isSuccess && unchanged ? (
              <p className="callout" role="status">
                {t('adm.securityPolicy.draft.accepted.notice')}
              </p>
            ) : null}
            {createProblem === undefined ? null : (
              <p className="callout warning" role="alert">
                {policyProblemMessage(t, createProblem)}
              </p>
            )}
            <form onSubmit={submit} noValidate aria-label={t('adm.securityPolicy.form.title')}>
              <fieldset className="scope-types">
                <legend>{t('adm.securityPolicy.mfa.legend')}</legend>
                {(roles.data ?? []).map((code) => (
                  <label key={code} className="check">
                    <input type="checkbox" checked={values.mfaRequiredRoles.includes(code)} onChange={() => toggleRole(code)} />
                    {code}
                  </label>
                ))}
                <small className="sub">{t('adm.securityPolicy.mfa.hint')}</small>
              </fieldset>
              <div className="formgrid">
                <Field id="policy-sessionIdleMinutes" label={t('adm.securityPolicy.idle.label')} error={fieldError('sessionIdleMinutes')}>
                  <input id="policy-sessionIdleMinutes" inputMode="numeric" value={values.sessionIdleMinutes} aria-invalid={fieldError('sessionIdleMinutes') !== undefined} onChange={(event) => setField('sessionIdleMinutes', event.target.value)} />
                </Field>
                <Field id="policy-sessionMaxHours" label={t('adm.securityPolicy.hours.label')} error={fieldError('sessionMaxHours')}>
                  <input id="policy-sessionMaxHours" inputMode="numeric" value={values.sessionMaxHours} aria-invalid={fieldError('sessionMaxHours') !== undefined} onChange={(event) => setField('sessionMaxHours', event.target.value)} />
                </Field>
                <Field id="policy-downloadTtlMinutes" label={t('adm.securityPolicy.ttl.label')} error={fieldError('downloadTtlMinutes')}>
                  <input id="policy-downloadTtlMinutes" inputMode="numeric" value={values.downloadTtlMinutes} aria-invalid={fieldError('downloadTtlMinutes') !== undefined} onChange={(event) => setField('downloadTtlMinutes', event.target.value)} />
                </Field>
              </div>
              <Field id="policy-ipAllowlist" label={t('adm.securityPolicy.ip.label')} error={fieldError('ipAllowlist')} hint={t('adm.securityPolicy.ip.hint')}>
                <textarea id="policy-ipAllowlist" rows={4} spellCheck={false} value={values.ipAllowlist} aria-invalid={fieldError('ipAllowlist') !== undefined} onChange={(event) => setField('ipAllowlist', event.target.value)} />
              </Field>
              <label className="check">
                <input type="checkbox" checked={values.exportWatermark} onChange={(event) => setValues((current) => ({ ...current, exportWatermark: event.target.checked }))} />
                {t('adm.securityPolicy.watermark.label')}
              </label>
              <div className="adm-kit-actions">
                <span className="sub">{t('adm.securityPolicy.form.hint')}</span>
                {inForce === undefined ? null : (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setValues(valuesOfPolicy(inForce))}>
                    {t('adm.securityPolicy.copy.action')}
                  </button>
                )}
                {canDraft ? (
                  <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending || !rolesReady || unchanged}>
                    {t('adm.securityPolicy.draft.submit.action')}
                  </button>
                ) : null}
              </div>
            </form>
          </SectionCard>
          <SectionCard title={t('adm.securityPolicy.history.title')}>
            {policies.length === 0 ? <p className="muted">{t('adm.securityPolicy.history.empty')}</p> : null}
            {publish.isSuccess ? (
              <p className="callout" role="status">
                {t('adm.securityPolicy.publish.accepted.notice')}
              </p>
            ) : null}
            {publishProblem === undefined ? null : (
              <p className="callout warning" role="alert">
                {policyProblemMessage(t, publishProblem)}
              </p>
            )}
            {policies.length === 0 ? null : (
              <KitTable caption={t('w2adm.securityPolicy.table.caption')}>
                <thead>
                  <tr>
                    <th>{t('adm.securityPolicy.col.revision')}</th>
                    <th>{t('adm.securityPolicy.col.status')}</th>
                    <th>{t('adm.securityPolicy.col.roles')}</th>
                    <th>{t('adm.securityPolicy.col.session')}</th>
                    <th>
                      {t('adm.securityPolicy.col.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => {
                    const ownDraft = policy.createdBy === tenant?.membershipId;
                    return (
                      <tr key={policy.id} data-policy-id={policy.id} data-status={policy.status}>
                        <td>#{policy.revision}</td>
                        <td>
                          <StatusPill tone={policyStatusTone(policy.status)}>{policyStatusLabel(t, policy.status)}</StatusPill>
                        </td>
                        <td>{policy.mfaRequiredRoles.join(', ')}</td>
                        <td>{t('adm.securityPolicy.session.summary', { idle: policy.sessionIdleMinutes, hours: policy.sessionMaxHours })}</td>
                        <td className="row-actions">
                          {policy.status === 'Draft' && canApprove && publishing !== policy.id ? (
                            <button type="button" disabled={ownDraft} title={ownDraft ? t('adm.securityPolicy.publish.selfApproval.hint') : undefined} onClick={() => { setPublishing(policy.id); setReason(''); setReasonError(false); }}>
                              {t('adm.securityPolicy.publish.action')}
                            </button>
                          ) : null}
                          {publishing === policy.id && canApprove ? (
                            <form onSubmit={(event) => confirmPublish(event, policy)} noValidate aria-label={t('adm.securityPolicy.publish.action')}>
                              <PolicyPreview policy={policy} />
                              <Field id={`publish-reason-${policy.id}`} label={t('adm.securityPolicy.publish.reason.label')} error={reasonError ? t('adm.securityPolicy.field.required') : undefined}>
                                <input id={`publish-reason-${policy.id}`} value={reason} aria-invalid={reasonError} onChange={(event) => { setReason(event.target.value); setReasonError(false); }} />
                              </Field>
                              <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
                                {t('adm.securityPolicy.publish.confirm.action')}
                              </button>
                              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPublishing(undefined)}>
                                {t('adm.securityPolicy.publish.cancel.action')}
                              </button>
                            </form>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </KitTable>
            )}
          </SectionCard>
          </div>
          <aside aria-label={t('adm.securityPolicy.current.title')}>
          <SectionCard title={t('adm.securityPolicy.current.title')}>
            {inForce === undefined ? (
              <p className="muted" data-testid="no-policy">{t('adm.securityPolicy.current.none')}</p>
            ) : (
              <dl data-testid="policy-in-force">
                <dt>{t('adm.securityPolicy.col.revision')}</dt>
                <dd>#{inForce.revision}</dd>
                <dt>{t('adm.securityPolicy.col.roles')}</dt>
                <dd>{inForce.mfaRequiredRoles.length === 0 ? t('adm.securityPolicy.current.noRoles') : inForce.mfaRequiredRoles.join(', ')}</dd>
                <dt>{t('adm.securityPolicy.col.session')}</dt>
                <dd>{t('adm.securityPolicy.session.summary', { idle: inForce.sessionIdleMinutes, hours: inForce.sessionMaxHours })}</dd>
              </dl>
            )}
            <p className="callout" role="note">
              {t('adm.securityPolicy.enforcement.note')}
            </p>
          </SectionCard>
          </aside>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('adm.securityPolicy.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
