import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useLicense, useTenantLicenses } from './license/hooks';
import { editionLabel, signatureLabel, signatureTone, statusLabel, statusTone } from './license/labels';
import { licenseRenewable } from './license/renew';
import { licenseActions } from './license/rules';
import { MANAGE_LICENSES_PERMISSION } from './license/types';
import type { License } from './license/types';
import { toneClass } from './tenants/labels';
import { TenantSelect } from './license/TenantSelect';
import './tenants/sas.css';
import './tenant-detail/tenant-detail.css';
import './license/license.css';

const ARROW = '←';

/** Dates and instants of a license are server instants in UTC: they are shown in UTC, never in the zone of the browser. */
function dateOf(locale: string, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
}

interface RevisionProps {
  license: License;
}

/** One revision as a card of labelled rows: identity, window, state, signature and the entitlement version it signs. */
function LicenseCard({ license }: RevisionProps) {
  const { t, locale } = useTranslation();
  const none = t('sas.licenseDetail.none.text');
  const row = (label: string, value: string | number | undefined) => (
    <div className="sas-detail-row">
      <dt>{label}</dt>
      <dd>{value === undefined || value === '' ? none : value}</dd>
    </div>
  );
  return (
    <div className="card" data-license-id={license.id}>
      <h2>{t('sas.licenseDetail.card.title')}</h2>
      <dl className="sas-detail-fields">
        {row(t('sas.licenseDetail.field.serial'), license.serial)}
        {row(t('sas.licenseDetail.field.revision'), license.revision)}
        {row(t('sas.licenseDetail.field.edition'), editionLabel(t, license.edition))}
        <div className="sas-detail-row">
          <dt>{t('sas.licenseDetail.field.status')}</dt>
          <dd>
            <span className={toneClass(statusTone(license.status))} data-license-status={license.status}>
              {statusLabel(t, license.status)}
            </span>
            {license.expiring ? <span className="pill warn license-expiring"> {t('sas.licenseDetail.expiring.label')}</span> : null}
          </dd>
        </div>
        {license.statusReason === undefined ? null : row(t('sas.licenseDetail.field.reason'), license.statusReason)}
        {row(t('sas.licenseDetail.field.validFrom'), dateOf(locale, license.validFrom))}
        {row(t('sas.licenseDetail.field.validUntil'), dateOf(locale, license.validUntil))}
        {row(t('sas.licenseDetail.field.graceUntil'), dateOf(locale, license.graceUntil))}
        {row(t('sas.licenseDetail.field.seats'), license.seats)}
        {row(t('sas.licenseDetail.field.entitlement'), license.entitlementVersionId)}
        {row(t('sas.licenseDetail.field.supersedes'), license.supersedesId)}
        {row(t('sas.licenseDetail.field.key'), license.keyId)}
        <div className="sas-detail-row">
          <dt>{t('sas.licenseDetail.field.signature')}</dt>
          <dd>
            <span className={toneClass(signatureTone(license.signatureCheck))} data-signature-check={license.signatureCheck}>
              {signatureLabel(t, license.signatureCheck)}
            </span>
          </dd>
        </div>
        {row(t('sas.licenseDetail.field.version'), license.version)}
      </dl>
    </div>
  );
}

/** One revision of a license with the way to SAS-15 for a person who may change it. */
function OneLicense({ licenseId, canManage }: { licenseId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const query = useLicense(licenseId, true);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data });
  const action = routeById('SAS-15');
  const renew = routeById('SAS-14');
  const history = routeById('SAS-16');
  const license = query.data;
  const actions = license === undefined ? [] : licenseActions(license.status, canManage);
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      {license === undefined ? null : (
        <div className="sas-detail-grid">
          <LicenseCard license={license} />
          <div className="card">
            <h2>{t('sas.licenseDetail.actions.title')}</h2>
            {!canManage ? (
              <p className="callout warning" role="status">
                {t('sas.licenseDetail.readOnly.notice')}
              </p>
            ) : null}
            {canManage && actions.length === 0 ? <p className="sub">{t('sas.licenseDetail.actions.none')}</p> : null}
            {actions.length > 0 && action !== undefined ? (
              <div className="lifecycle-actions">
                <Link className="button-link primary" to={`${action.path}?license=${encodeURIComponent(license.id)}`}>
                  {t('sas.licenseDetail.actions.change')}
                </Link>
              </div>
            ) : null}
            {renew !== undefined && licenseRenewable(license.status, canManage) ? (
              <div className="lifecycle-actions">
                <Link className="button-link" to={`${renew.path}?license=${encodeURIComponent(license.id)}`}>
                  {t('sas.licenseDetail.actions.renew')}
                </Link>
              </div>
            ) : null}
            {history === undefined ? null : (
              <div className="lifecycle-actions">
                <Link className="button-link" to={`${history.path}?tenant=${encodeURIComponent(license.tenantId)}`}>
                  {t('sas.licenseDetail.actions.history')}
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </StateBoundary>
  );
}

/** The revisions of one tenant, newest last as the server orders them (serial and revision); each opens its own detail. */
function TenantLicenses({ tenantId }: { tenantId: string }) {
  const { t, locale } = useTranslation();
  const query = useTenantLicenses(tenantId, true);
  const all = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data === undefined ? undefined : all });
  const detail = routeById('SAS-13');
  return (
    <StateBoundary state={state} onRetry={() => void query.refetch()}>
      <div className="card">
        <h2>{t('sas.licenseDetail.list.title')}</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t('sas.licenseDetail.col.serial')}</th>
                <th>{t('sas.licenseDetail.col.edition')}</th>
                <th>{t('sas.licenseDetail.col.status')}</th>
                <th>{t('sas.licenseDetail.col.validUntil')}</th>
                <th>{t('sas.licenseDetail.col.signature')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {all.map((license) => (
                <tr key={license.id} data-license-id={license.id}>
                  <td>
                    <b>{license.serial}</b>
                    <div className="sub">{t('sas.licenseDetail.revision.text', { revision: license.revision })}</div>
                  </td>
                  <td>{editionLabel(t, license.edition)}</td>
                  <td>
                    <span className={toneClass(statusTone(license.status))}>{statusLabel(t, license.status)}</span>
                  </td>
                  <td>{dateOf(locale, license.validUntil)}</td>
                  <td>
                    <span className={toneClass(signatureTone(license.signatureCheck))}>{signatureLabel(t, license.signatureCheck)}</span>
                  </td>
                  <td>
                    {detail === undefined ? null : (
                      <Link className="button-link" to={`${detail.path}?license=${encodeURIComponent(license.id)}`}>
                        {t('sas.licenseDetail.open.action')}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {query.hasNextPage ? (
          <div className="row between gap tiny muted">
            <span />
            <button type="button" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {t('sas.licenseDetail.more.action')}
            </button>
          </div>
        ) : null}
      </div>
    </StateBoundary>
  );
}

/** Picks the tenant whose licenses are listed when the address names neither a license nor a tenant. */
function TenantPicker() {
  const { t } = useTranslation();
  const [, setParams] = useSearchParams();
  return (
    <div className="card">
      <p className="callout" role="status">
        {t('sas.licenseDetail.missing.notice')}
      </p>
      <div className="field">
        <label htmlFor="license-tenant-pick">{t('sas.licenseDetail.tenant.label')}</label>
        <TenantSelect id="license-tenant-pick" value="" chooseLabel={t('sas.licenseDetail.tenant.choose')} chooseDisabled onChange={(tenantId) => setParams({ tenant: tenantId })} />
      </div>
    </div>
  );
}

/**
 * SAS-13: a license revision of any tenant with its state at the server clock and the result of checking its signature,
 * named in the address (`?license=`), or the revisions of a tenant (`?tenant=`). A registry reader sees it; only a
 * person who manages licenses is offered the change of state (SAS-15).
 */
export default function LicenseDetailScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const licenseId = params.get('license') ?? undefined;
  const tenantId = params.get('tenant') ?? undefined;
  const canManage = permissions === undefined || permissions.includes(MANAGE_LICENSES_PERMISSION);
  const issue = routeById('SAS-12');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {issue === undefined ? null : (
        <p className="sas-back-link">
          <Link to={issue.path}>
            <span aria-hidden="true">{ARROW} </span>
            {t('sas.licenseDetail.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.licenseDetail.page.title')}</h1>
          <p>{t('sas.licenseDetail.page.subtitle')}</p>
        </div>
      </div>
      {licenseId !== undefined ? <OneLicense licenseId={licenseId} canManage={canManage} /> : tenantId !== undefined ? <TenantLicenses tenantId={tenantId} /> : <TenantPicker />}
      <p className="prototype-note">{t('sas.licenseDetail.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
