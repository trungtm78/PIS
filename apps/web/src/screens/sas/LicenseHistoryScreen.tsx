import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useTenantLicenses } from './license/hooks';
import { editionLabel, signatureLabel, signatureTone, statusLabel, statusTone } from './license/labels';
import { chainOf, licenseRenewable } from './license/renew';
import { MANAGE_LICENSES_PERMISSION } from './license/types';
import { TenantSelect } from './license/TenantSelect';
import { toneClass } from './tenants/labels';
import './tenants/sas.css';
import './tenant-detail/tenant-detail.css';
import './license/license.css';
import { StatusPill } from '../../ui';
import { toneOfPill } from '../adm/kit-tone';

/** Dates and instants of a license are server instants in UTC: they are shown in UTC, never in the zone of the browser. */
function dateOf(locale: string, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
}

/**
 * SAS-16: the history of the licenses of a tenant, named in the address (`?tenant=`): every revision in the order of its serial and revision, each with its state at the server clock,
 * its window, what it replaced and the result of checking its signature; the revision that is in force is marked, and a person who manages licenses is offered to renew it. A change of
 * a license reaches the sessions of the tenant within the propagation objective the screen states.
 */
export default function LicenseHistoryScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const [params, setParams] = useSearchParams();
  const tenantId = params.get('tenant') ?? undefined;
  const canManage = permissions === undefined || permissions.includes(MANAGE_LICENSES_PERMISSION);
  const query = useTenantLicenses(tenantId ?? '', tenantId !== undefined);
  const all = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const chain = useMemo(() => chainOf(all), [all]);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data === undefined ? undefined : all, isEmpty: () => false });
  const detail = routeById('SAS-13');
  const renew = routeById('SAS-14');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.licenseHistory.page.title')}</h1>
          <p>{t('sas.licenseHistory.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <div className="field">
          <label htmlFor="history-tenant">{t('sas.licenseHistory.tenant.label')}</label>
          <TenantSelect id="history-tenant" value={tenantId ?? ''} chooseLabel={t('sas.licenseHistory.tenant.choose')} chooseDisabled onChange={(id) => setParams(id === '' ? {} : { tenant: id })} />
        </div>
        <p className="sub" data-testid="slo">
          <b>{t('sas.licenseHistory.slo.label')}:</b> {t('sas.licenseHistory.slo.text')}
        </p>
      </div>
      {tenantId === undefined ? (
        <p className="callout" role="status" data-testid="choose-tenant">
          {t('sas.licenseHistory.missing.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          <div className="card">
            <h2>{t('sas.licenseHistory.chain.title')}</h2>
            <ol className="license-chain" data-testid="chain">
              {chain.map(({ license, current }) => (
                <li key={license.id} data-license-id={license.id} data-current={current}>
                  <div className="license-chain-head">
                    <b>{license.serial}</b> <span className="sub">{t('sas.licenseHistory.revision.text', { revision: license.revision })}</span>{' '}
                    <span data-license-status={license.status}><StatusPill tone={toneOfPill(toneClass(statusTone(license.status)))}>
                      {statusLabel(t, license.status)}
                    </StatusPill></span>
                    {current ? (
                      <span className="license-current" data-testid="current-mark">
                        <StatusPill tone="success">{t('sas.licenseHistory.current.label')}</StatusPill>
                      </span>
                    ) : null}
                  </div>
                  <div className="sub">
                    {t('sas.licenseHistory.window.text', { from: dateOf(locale, license.validFrom), until: dateOf(locale, license.validUntil), grace: dateOf(locale, license.graceUntil) })} ·{' '}
                    {editionLabel(t, license.edition)}
                  </div>
                  {license.supersedesId === undefined ? null : (
                    <div className="sub" data-testid="supersedes">
                      {t('sas.licenseHistory.supersedes.text', { revision: all.find((candidate) => candidate.id === license.supersedesId)?.revision ?? '' })}
                    </div>
                  )}
                  {license.statusReason === undefined ? null : <div className="sub">{t('sas.licenseHistory.reason.text', { reason: license.statusReason })}</div>}
                  <div className="sub">
                    <span data-signature-check={license.signatureCheck}><StatusPill tone={toneOfPill(toneClass(signatureTone(license.signatureCheck)))}>
                      {signatureLabel(t, license.signatureCheck)}
                    </StatusPill></span>
                  </div>
                  <div className="row gap">
                    {detail === undefined ? null : (
                      <Link className="button-link" to={`${detail.path}?license=${encodeURIComponent(license.id)}`}>
                        {t('sas.licenseHistory.open.action')}
                      </Link>
                    )}
                    {renew !== undefined && licenseRenewable(license.status, canManage) ? (
                      <Link className="button-link primary" to={`${renew.path}?license=${encodeURIComponent(license.id)}`}>
                        {t('sas.licenseHistory.renew.action')}
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            {chain.length === 0 ? (
              <p className="callout" role="status" data-testid="no-licenses">
                {t('sas.licenseHistory.empty.notice')}
              </p>
            ) : null}
            {query.hasNextPage ? (
              <div className="row between gap tiny muted">
                <span />
                <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  {t('sas.licenseHistory.more.action')}
                </button>
              </div>
            ) : null}
          </div>
        </StateBoundary>
      )}
      <p className="prototype-note">{t('sas.licenseHistory.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
