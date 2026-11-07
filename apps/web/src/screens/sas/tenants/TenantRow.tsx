import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { routeById } from '../../../routes/registry';
import { StatusPill } from '../../../ui';
import { toneOfPill } from '../../adm/kit-tone';
import { useRetryProvisioning, useTenantDetail } from './hooks';
import { describeProblem } from './problems';
import { isolationLabel, problemMessage, runStatusLabel, statusLabel, statusTone, stepLabel, toneClass } from './labels';
import { canRetry, failedStepOf, showsRun } from './types';
import type { TenantSummary } from './types';

const RETRY_REASON_MIN = 10;
const RETRY_REASON_MAX = 2000;

interface RetryProps {
  tenantId: string;
  version: number;
}

/** The retry of a Failed tenant: a reason of at least 10 characters, then one versioned command per intention. */
function RetryForm({ tenantId, version }: RetryProps) {
  const { t } = useTranslation();
  const retry = useRetryProvisioning();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [tooShort, setTooShort] = useState(false);

  if (!open) {
    return (
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setOpen(true)}>
        {t('sas.tenants.retry.action')}
      </button>
    );
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (retry.isPending) return;
    const trimmed = reason.trim();
    if (trimmed.length < RETRY_REASON_MIN || trimmed.length > RETRY_REASON_MAX) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    retry.mutate({ tenantId, version, reason: trimmed }, { onSuccess: () => setOpen(false) });
  };
  return (
    <form className="retry-form" onSubmit={submit} noValidate>
      <label htmlFor={`retry-reason-${tenantId}`}>{t('sas.tenants.retry.reason.label')}</label>
      <textarea id={`retry-reason-${tenantId}`} value={reason} onChange={(event) => setReason(event.target.value)} aria-invalid={tooShort} />
      {tooShort ? (
        <small role="alert" className="field-error">
          {t('sas.tenants.retry.reason.tooShort')}
        </small>
      ) : null}
      {retry.isError ? (
        <p className="callout warning" role="alert">
          {problemMessage(t, describeProblem(retry.error))}
        </p>
      ) : null}
      <div className="row">
        <button type="submit" className="ui-button ui-button--primary ui-button--small" disabled={retry.isPending}>
          {t('sas.tenants.retry.submit')}
        </button>
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setOpen(false)}>
          {t('sas.tenants.retry.cancel')}
        </button>
      </div>
    </form>
  );
}

interface RunProps {
  tenant: TenantSummary;
  canManage: boolean;
}

/** The step a saga is at (or failed on) under the status of a tenant that is not settled yet. */
function RunSummary({ tenant, canManage }: RunProps) {
  const { t } = useTranslation();
  const detail = useTenantDetail(tenant.id, showsRun(tenant.status));
  const run = detail.data?.run;
  if (detail.data === undefined || run === undefined) return null;
  const failed = failedStepOf(run);
  return (
    <div className="sub run-summary" data-run-step={run.currentStep ?? ''}>
      {failed === undefined ? (
        <span>{t('sas.tenants.run.at', { step: stepLabel(t, run.currentStep ?? '') })}</span>
      ) : (
        <span role="status">{t('sas.tenants.run.failedAt', { step: stepLabel(t, failed.step), status: runStatusLabel(t, failed.status) })}</span>
      )}
      {canManage && canRetry(tenant.status) ? <RetryForm tenantId={tenant.id} version={detail.data.version} /> : null}
    </div>
  );
}

interface Props {
  tenant: TenantSummary;
  canManage: boolean;
}

/** One row of the registry: names, plan, isolation, status with the run under it, license and the entitlement link. */
export function TenantRow({ tenant, canManage }: Props) {
  const { t } = useTranslation();
  const entitlements = routeById('SAS-25');
  const detail = routeById('SAS-03');
  return (
    <tr data-tenant-id={tenant.id}>
      <td>
        <b>{tenant.name}</b>
        <div className="sub">{tenant.code}</div>
      </td>
      <td>{tenant.planCode ?? t('sas.tenants.none')}</td>
      <td>{isolationLabel(t, tenant.isolationMode)}</td>
      <td>
        <StatusPill tone={toneOfPill(toneClass(statusTone(tenant.status)))}>{statusLabel(t, tenant.status)}</StatusPill>
        <RunSummary tenant={tenant} canManage={canManage} />
      </td>
      <td>{tenant.licenseStatus ?? t('sas.tenants.none')}</td>
      <td>
        <div className="row gap">
          {detail === undefined ? null : (
            <Link className="ui-button ui-button--outline ui-button--small" to={`${detail.path}?tenant=${encodeURIComponent(tenant.id)}`}>
              {t('sas.tenants.detail.action')}
            </Link>
          )}
          {entitlements === undefined ? null : (
            <Link className="ui-button ui-button--outline ui-button--small" to={`${entitlements.path}?tenant=${encodeURIComponent(tenant.id)}`}>
              {t('sas.tenants.entitlements.action')}
            </Link>
          )}
        </div>
      </td>
    </tr>
  );
}
