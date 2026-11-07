import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { compensationLabel } from './provisioning/labels';
import { isReasonValid } from './tenant-detail/rules';
import { useRetryProvisioning, useTenantDetail } from './tenants/hooks';
import { problemMessage, runStatusLabel, statusLabel, statusTone, stepLabel, toneClass } from './tenants/labels';
import { describeProblem } from './tenants/problems';
import { MANAGE_TENANTS_PERMISSION, canRetry, failedStepOf } from './tenants/types';
import type { RunStep } from './tenants/types';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './tenant-detail/tenant-detail.css';
import { StatusPill } from '../../ui';
import { toneOfPill } from '../adm/kit-tone';

const ARROW = '←';
const STEP_TONE: Readonly<Record<string, 'ok' | 'warn' | 'red' | 'gray'>> = { DONE: 'ok', RUNNING: 'warn', FAILED: 'red', COMPENSATED: 'gray', PENDING: 'gray' };

interface RetryProps {
  tenantId: string;
  version: number;
  onStarted(): void;
}

/** The retry of a Failed tenant: a reason of 10 characters or more, then one versioned command that starts the next attempt at the failed step. */
function RetryPanel({ tenantId, version, onStarted }: RetryProps) {
  const { t } = useTranslation();
  const retry = useRetryProvisioning();
  const [reason, setReason] = useState('');
  const [tooShort, setTooShort] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (retry.isPending) return;
    if (!isReasonValid(reason)) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    retry.mutate(
      { tenantId, version, reason: reason.trim() },
      {
        onSuccess: () => {
          setReason('');
          onStarted();
        },
      },
    );
  };

  return (
    <form className="retry-form" onSubmit={submit} noValidate>
      <label htmlFor="provisioning-retry-reason">{t('sas.tenants.retry.reason.label')}</label>
      <textarea id="provisioning-retry-reason" value={reason} onChange={(event) => setReason(event.target.value)} aria-invalid={tooShort} />
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
        <button type="submit" className="ui-button ui-button--primary" disabled={retry.isPending}>
          {t('sas.tenants.retry.submit')}
        </button>
      </div>
    </form>
  );
}

function StepRow({ step, current }: { step: RunStep; current: boolean }) {
  const { t } = useTranslation();
  return (
    <tr data-step={step.step} data-step-status={step.status} aria-current={current ? 'step' : undefined}>
      <td>
        <b>{stepLabel(t, step.step)}</b>
      </td>
      <td>
        <StatusPill tone={toneOfPill(toneClass(STEP_TONE[step.status] ?? 'gray'))}>{runStatusLabel(t, step.status)}</StatusPill>
      </td>
      <td>{step.attempts}</td>
      <td>{step.errorCode ?? t('sas.tenants.none')}</td>
      <td className="sub">{compensationLabel(t, step.step)}</td>
    </tr>
  );
}

/**
 * SAS-22: the provisioning run of one tenant as a timeline of its eleven steps (state, attempts, error code and what is
 * undone when provisioning is cancelled). The tenant is named in the address (`?tenant=`); while the saga works the screen
 * reads again every few seconds, so it follows the run to the end. A Failed tenant offers the retry to a person who manages
 * tenants: the next attempt starts at the failed step and runs no finished step again.
 */
export default function ProvisioningRunScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const tenantId = params.get('tenant') ?? undefined;
  const canManage = permissions === undefined || permissions.includes(MANAGE_TENANTS_PERMISSION);
  const detail = useTenantDetail(tenantId ?? '', tenantId !== undefined, true);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: detail.data });
  const list = routeById('SAS-01');
  const tenant = detail.data;
  const run = tenant?.run;
  const failed = failedStepOf(run);
  // The tenant is Provisioning again as soon as the retry is accepted, so the form is gone: the notice belongs to the screen.
  const [retried, setRetried] = useState(false);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {list === undefined ? null : (
        <p className="sas-back-link">
          <Link to={list.path}>
            <span aria-hidden="true">{ARROW} </span>
            {t('sas.provisioning.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.provisioning.page.title')}</h1>
          <p>{t('sas.provisioning.page.subtitle')}</p>
        </div>
      </div>
      {tenantId === undefined ? (
        <p className="callout" role="status">
          {t('sas.provisioning.missing.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void detail.refetch()}>
          {tenant === undefined ? null : (
            <div className="card" data-tenant-id={tenant.id}>
              <div className="row between gap">
                <h2>{t('sas.provisioning.card.title', { code: tenant.code })}</h2>
                <span data-tenant-status={tenant.status}><StatusPill tone={toneOfPill(toneClass(statusTone(tenant.status)))}>
                  {statusLabel(t, tenant.status)}
                </StatusPill></span>
              </div>
              {run === undefined ? (
                <p className="callout" role="status">
                  {t('sas.provisioning.noRun.notice')}
                </p>
              ) : (
                <>
                  <p className="sub">{t('sas.provisioning.attempt.text', { attempt: run.attempt ?? '' })}</p>
                  {failed === undefined ? null : (
                    <p className="callout warning" role="alert" data-failed-step={failed.step}>
                      {t('sas.provisioning.failed.notice', { step: stepLabel(t, failed.step), code: failed.errorCode ?? t('sas.tenants.none') })}
                    </p>
                  )}
                    <KitTable caption={t('w2sas.provisioning.table.caption')}>
                      <thead>
                        <tr>
                          <th>{t('sas.provisioning.col.step')}</th>
                          <th>{t('sas.provisioning.col.status')}</th>
                          <th>{t('sas.provisioning.col.attempts')}</th>
                          <th>{t('sas.provisioning.col.error')}</th>
                          <th>{t('sas.provisioning.col.compensation')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.steps.map((step) => (
                          <StepRow key={step.step} step={step} current={step.step === run.currentStep} />
                        ))}
                      </tbody>
                    </KitTable>
                  {retried ? (
                    <p className="callout" role="status">
                      {t('sas.provisioning.retry.started.notice')}
                    </p>
                  ) : null}
                  {canManage && canRetry(tenant.status) ? <RetryPanel tenantId={tenant.id} version={tenant.version} onStarted={() => setRetried(true)} /> : null}
                  {!canManage && canRetry(tenant.status) ? (
                    <p className="callout warning" role="status">
                      {t('sas.provisioning.readOnly.notice')}
                    </p>
                  ) : null}
                  {tenant.status === 'Active' ? <p className="callout">{t('sas.provisioning.active.notice')}</p> : null}
                </>
              )}
            </div>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('sas.provisioning.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
