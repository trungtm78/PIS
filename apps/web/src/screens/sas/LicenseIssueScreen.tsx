import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useIssueLicense } from './license/hooks';
import { editionLabel, fieldProblemMessage, problemMessage } from './license/labels';
import { describeProblem } from './license/problems';
import { EMPTY_ISSUE_VALUES, validateIssueForm } from './license/rules';
import type { IssueErrors, IssueField, IssueValues } from './license/rules';
import { EDITIONS, MANAGE_LICENSES_PERMISSION } from './license/types';
import { TenantSelect } from './license/TenantSelect';
import { useEntitlements, useTenantList } from './tenants/hooks';
import type { TenantSummary } from './tenants/types';
import './tenants/sas.css';

const NOT_ISSUABLE: readonly string[] = ['Requested', 'Archived'];
const isIssuable = (tenant: TenantSummary): boolean => !NOT_ISSUABLE.includes(tenant.status);
const NO_VERSION = 0;

interface FieldProps {
  field: IssueField;
  label: string;
  error: string | undefined;
  children: ReactNode;
}

function Field({ field, label, error, children }: FieldProps) {
  return (
    <div className="field" data-field={field}>
      <label htmlFor={`license-${field}`}>{label}</label>
      {children}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`license-${field}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

/**
 * SAS-12: issues revision 1 of a license of a tenant. The server signs it with its own key and the tenant's current
 * entitlement version (a client sends no claims, BR-SAS-12); the form checks the window of BR-SAS-11 before it sends anything.
 */
export default function LicenseIssueScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const canManage = permissions === undefined || permissions.includes(MANAGE_LICENSES_PERMISSION);
  const issue = useIssueLicense();
  // The typed values live in state: a re-render for any reason never resets the form.
  const [values, setValues] = useState<IssueValues>({ ...EMPTY_ISSUE_VALUES, tenant_id: params.get('tenant') ?? '' });
  const [refused, setRefused] = useState<IssueErrors>({});
  const [issuedId, setIssuedId] = useState<string | undefined>(undefined);
  const entitlements = useEntitlements(values.tenant_id, values.tenant_id !== '');
  // The registry is what the form chooses from: a registry that cannot be read (or has no tenant to issue to) is the state of the screen; a later page that fails is told by the picker.
  const registry = useTenantList();
  const state = useScreenState({
    isLoading: registry.isLoading,
    error: registry.data === undefined ? registry.error : undefined,
    data: registry.data === undefined ? undefined : registry.data.pages.flatMap((page) => page.items).filter(isIssuable),
  });
  const detail = routeById('SAS-13');
  const versionId = entitlements.data !== undefined && entitlements.data.versionNo > NO_VERSION ? entitlements.data.versionId : undefined;

  const set = (field: keyof IssueValues, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setRefused((current) => ({ ...current, [field]: undefined }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (issue.isPending || !canManage) return;
    // A version that could not be read is not a version that does not exist: nothing is judged or sent until it has been read.
    if (values.tenant_id !== '' && entitlements.isError) {
      void entitlements.refetch();
      return;
    }
    const errors = validateIssueForm(values, versionId, new Date());
    setRefused(errors);
    if (Object.keys(errors).length > 0 || versionId === undefined) return;
    // A license that was issued is done: the form empties, so a second click cannot issue a second one.
    issue.mutate(
      { values, entitlementVersionId: versionId },
      {
        onSuccess: (result) => {
          setValues(EMPTY_ISSUE_VALUES);
          setIssuedId(result.resource_id);
        },
      },
    );
  };

  const problem = issue.isError ? describeProblem(issue.error) : undefined;
  const errorOf = (field: IssueField): string | undefined => {
    const own = refused[field];
    if (own !== undefined) return fieldProblemMessage(t, own);
    return problem?.field === field ? problemMessage(t, problem) : undefined;
  };
  const invalid = (field: IssueField) => ({ 'aria-invalid': errorOf(field) !== undefined, 'aria-describedby': errorOf(field) === undefined ? undefined : `license-${field}-error` });
  const text = (field: keyof IssueValues, label: string, type = 'text') => (
    <Field field={field} label={label} error={errorOf(field)}>
      <input id={`license-${field}`} type={type} value={values[field]} {...invalid(field)} onChange={(event) => set(field, event.target.value)} />
    </Field>
  );
  const entitlementText =
    values.tenant_id === ''
      ? t('sas.licenseIssue.entitlement.choose')
      : entitlements.isLoading
        ? t('sas.licenseIssue.entitlement.loading')
        : entitlements.isError
          ? t('sas.licenseIssue.entitlement.error')
          : versionId === undefined
          ? t('sas.licenseIssue.entitlement.none')
          : t('sas.licenseIssue.entitlement.current', { version: entitlements.data?.versionNo ?? NO_VERSION });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.licenseIssue.page.title')}</h1>
          <p>{t('sas.licenseIssue.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        {!canManage ? (
          <p className="callout warning" role="status">
            {t('sas.licenseIssue.readOnly.notice')}
          </p>
        ) : null}
        {issue.isSuccess && issuedId !== undefined ? (
          <p className="callout" role="status">
            {t('sas.licenseIssue.accepted.notice', { version: issue.data.resource_version })}{' '}
            {detail === undefined ? null : <Link to={`${detail.path}?license=${encodeURIComponent(issuedId)}`}>{t('sas.licenseIssue.accepted.link')}</Link>}
          </p>
        ) : null}
        {problem !== undefined && problem.field === undefined ? (
          <p className="callout warning" role="alert">
            {problemMessage(t, problem)}
          </p>
        ) : null}
        <StateBoundary state={state} onRetry={() => void registry.refetch()}>
          <form onSubmit={submit} noValidate>
            <div className="formgrid">
              <Field field="tenant_id" label={t('sas.licenseIssue.tenant.label')} error={errorOf('tenant_id')}>
                <TenantSelect id="license-tenant_id" value={values.tenant_id} chooseLabel={t('sas.licenseIssue.tenant.choose')} accepts={isIssuable} {...invalid('tenant_id')} onChange={(tenantId) => set('tenant_id', tenantId)} />
              </Field>
              <Field field="entitlement_version_id" label={t('sas.licenseIssue.entitlement.label')} error={errorOf('entitlement_version_id')}>
                <input id="license-entitlement_version_id" readOnly value={entitlementText} {...invalid('entitlement_version_id')} />
                {values.tenant_id !== '' && entitlements.isError ? (
                  <p className="callout warning" role="alert">
                    {t('sas.licenseIssue.entitlement.error.notice')}{' '}
                    <button type="button" disabled={entitlements.isFetching} onClick={() => void entitlements.refetch()}>
                      {t('sas.licenseIssue.entitlement.retry.action')}
                    </button>
                  </p>
                ) : null}
              </Field>
              {text('seats', t('sas.licenseIssue.seats.label'), 'number')}
              <Field field="edition" label={t('sas.licenseIssue.edition.label')} error={errorOf('edition')}>
                <select id="license-edition" value={values.edition} {...invalid('edition')} onChange={(event) => set('edition', event.target.value)}>
                  {EDITIONS.map((edition) => (
                    <option key={edition} value={edition}>
                      {editionLabel(t, edition)}
                    </option>
                  ))}
                </select>
              </Field>
              {text('valid_from', t('sas.licenseIssue.validFrom.label'), 'date')}
              {text('valid_until', t('sas.licenseIssue.validUntil.label'), 'date')}
              {text('grace_until', t('sas.licenseIssue.graceUntil.label'), 'date')}
              {values.edition === 'PRIVATE' ? text('deployment_binding', t('sas.licenseIssue.binding.label')) : null}
              {values.edition === 'PRIVATE' ? text('offline_lease_days', t('sas.licenseIssue.lease.label'), 'number') : null}
            </div>
            <p className="callout">{t('sas.licenseIssue.signing.notice')}</p>
            <div className="formfooter">
              <span className="sub">{t('sas.licenseIssue.hint')}</span>
              {canManage ? (
                <button type="submit" className="primary" disabled={issue.isPending}>
                  {t('sas.licenseIssue.submit.action')}
                </button>
              ) : null}
            </div>
          </form>
        </StateBoundary>
      </div>
      <p className="prototype-note">{t('sas.licenseIssue.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
