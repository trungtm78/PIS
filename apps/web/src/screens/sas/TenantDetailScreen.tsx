import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { LifecycleDialog } from './tenant-detail/LifecycleDialog';
import type { LifecycleResult } from './tenant-detail/hooks';
import { lifecycleActions } from './tenant-detail/rules';
import type { LifecycleAction } from './tenant-detail/rules';
import { useTenantDetail } from './tenants/hooks';
import { governingBodyLabel, isolationLabel, statusLabel, statusTone, toneClass } from './tenants/labels';
import { MANAGE_TENANTS_PERMISSION } from './tenants/types';
import './tenants/sas.css';
import './tenant-detail/tenant-detail.css';
import { StatusPill } from '../../ui';
import { toneOfPill } from '../adm/kit-tone';

const ARROW = '←';

/**
 * SAS-03: one tenant of the registry with its lifecycle. A system administrator suspends an Active tenant and resumes a
 * Suspended one (the buttons follow the state machine); everyone else with `system.tenant.read` only reads. The tenant
 * is named in the address (`?tenant=`), as on SAS-25.
 */
export default function TenantDetailScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const tenantId = params.get('tenant') ?? undefined;
  const canManage = permissions === undefined || permissions.includes(MANAGE_TENANTS_PERMISSION);
  const detail = useTenantDetail(tenantId ?? '', tenantId !== undefined);
  const state = useScreenState({ isLoading: detail.isLoading, error: detail.error, data: detail.data });
  const [open, setOpen] = useState<LifecycleAction | undefined>(undefined);
  const [done, setDone] = useState<{ action: LifecycleAction; version: number } | undefined>(undefined);
  const list = routeById('SAS-01');
  const licenses = routeById('SAS-13');
  const provisioning = routeById('SAS-22');
  const tenant = detail.data;
  const actions = tenant === undefined ? [] : lifecycleActions(tenant.status, canManage);

  const finished = (action: LifecycleAction) => (result: LifecycleResult): void => {
    setOpen(undefined);
    setDone({ action, version: result.version });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {list === undefined ? null : (
        <p className="sas-back-link">
          <Link to={list.path}>
            <span aria-hidden="true">{ARROW} </span>
            {t('sas.tenantDetail.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.tenantDetail.page.title')}</h1>
          <p>{t('sas.tenantDetail.page.subtitle')}</p>
        </div>
      </div>
      {tenantId === undefined ? (
        <p className="callout" role="status">
          {t('sas.tenantDetail.missing.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void detail.refetch()}>
          {tenant === undefined ? null : (
            <div className="sas-detail-grid" data-tenant-id={tenant.id}>
              <div className="card">
                <h2>{t('sas.tenantDetail.card.title')}</h2>
                <dl className="sas-detail-fields">
                  <div className="sas-detail-row">
                    <dt>{t('sas.tenantDetail.field.code')}</dt>
                    <dd>{tenant.code}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.tenantDetail.field.name')}</dt>
                    <dd>{tenant.name ?? tenant.code}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.tenantDetail.field.status')}</dt>
                    <dd>
                      <span data-tenant-status={tenant.status}><StatusPill tone={toneOfPill(toneClass(statusTone(tenant.status)))}>
                        {statusLabel(t, tenant.status)}
                      </StatusPill></span>
                    </dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.tenantDetail.field.isolation')}</dt>
                    <dd>{isolationLabel(t, tenant.isolationMode)}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.tenantDetail.field.governingBody')}</dt>
                    <dd>{tenant.governingBodyType === undefined ? t('sas.tenants.none') : governingBodyLabel(t, tenant.governingBodyType)}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.tenantDetail.field.version')}</dt>
                    <dd>{tenant.version}</dd>
                  </div>
                </dl>
                {provisioning === undefined ? null : (
                  <p className="sub">
                    <Link to={`${provisioning.path}?tenant=${encodeURIComponent(tenant.id)}`}>{t('sas.tenantDetail.provisioning.link')}</Link>
                  </p>
                )}
                {licenses === undefined ? null : (
                  <p className="sub">
                    <Link to={`${licenses.path}?tenant=${encodeURIComponent(tenant.id)}`}>{t('sas.tenantDetail.licenses.link')}</Link>
                  </p>
                )}
              </div>
              <div className="card">
                <h2>{t('sas.tenantDetail.lifecycle.title')}</h2>
                {done === undefined ? null : (
                  <p className="callout" role="status">
                    {done.action === 'suspend' ? t('sas.tenantDetail.done.suspended', { version: done.version }) : t('sas.tenantDetail.done.resumed', { version: done.version })}
                  </p>
                )}
                {tenant.status === 'Active' ? <p className="sub">{t('sas.tenantDetail.lifecycle.active.hint')}</p> : null}
                {tenant.status === 'Suspended' ? <p className="sub">{t('sas.tenantDetail.lifecycle.suspended.hint')}</p> : null}
                {tenant.status !== 'Active' && tenant.status !== 'Suspended' ? (
                  <p className="sub">{t('sas.tenantDetail.lifecycle.other.hint', { status: statusLabel(t, tenant.status) })}</p>
                ) : null}
                {!canManage ? (
                  <p className="callout warning" role="status">
                    {t('sas.tenantDetail.lifecycle.readOnly.notice')}
                  </p>
                ) : null}
                {actions.length === 0 ? null : (
                  <div className="lifecycle-actions">
                    {actions.includes('suspend') ? (
                      <button type="button" className="danger" onClick={() => setOpen('suspend')}>
                        {t('sas.tenantDetail.suspend.action')}
                      </button>
                    ) : null}
                    {actions.includes('resume') ? (
                      <button type="button" className="primary" onClick={() => setOpen('resume')}>
                        {t('sas.tenantDetail.resume.action')}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          )}
        </StateBoundary>
      )}
      {tenant !== undefined && open !== undefined ? <LifecycleDialog action={open} tenant={tenant} onClose={() => setOpen(undefined)} onDone={finished(open)} /> : null}
      <p className="prototype-note">{t('sas.tenantDetail.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
