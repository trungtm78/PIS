import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useLicense, useRenewLicense } from './license/hooks';
import { editionLabel, problemMessage, statusLabel, statusTone } from './license/labels';
import { describeProblem } from './license/problems';
import { EMPTY_RENEW_VALUES, licenseRenewable, renewalStart, validateRenewForm } from './license/renew';
import type { RenewField, RenewProblem, RenewValues } from './license/renew';
import { isReasonValid } from './license/rules';
import { MANAGE_LICENSES_PERMISSION } from './license/types';
import type { License } from './license/types';
import { toneClass } from './tenants/labels';
import './tenants/sas.css';
import './tenant-detail/tenant-detail.css';
import './license/license.css';

const ARROW = '←';

type Translate = ReturnType<typeof useTranslation>['t'];

/** Dates and instants of a license are server instants in UTC: they are shown in UTC, never in the zone of the browser. */
function dateOf(locale: string, value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date);
}

function renewProblemMessage(t: Translate, problem: RenewProblem): string {
  switch (problem) {
    case 'required':
      return t('sas.licenseRenew.problem.required');
    case 'date':
      return t('sas.licenseRenew.problem.date');
    case 'notLater':
      return t('sas.licenseRenew.problem.notLater');
    case 'past':
      return t('sas.licenseRenew.problem.past');
    case 'grace':
      return t('sas.licenseRenew.problem.grace');
    case 'seats':
      return t('sas.licenseRenew.problem.seats');
  }
}

/**
 * SAS-14: renews one license, named in the address (`?license=`), by a new revision that takes its place. The screen sets the revision that is current beside the revision that would
 * replace it: the new term starts with the renewal (or at the end of the current one, in its grace period), so the term has no gap; the new end must be later than the current end;
 * the edition, the quota and the binding stay; the reason needs 10 to 2000 characters; the command carries the version the screen showed. The revision replaced stays signed and is
 * kept (Superseded).
 */
export default function LicenseRenewScreen({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const licenseId = params.get('license') ?? undefined;
  const canManage = permissions === undefined || permissions.includes(MANAGE_LICENSES_PERMISSION);
  const query = useLicense(licenseId ?? '', licenseId !== undefined);
  const command = useRenewLicense();
  const [values, setValues] = useState<RenewValues>(EMPTY_RENEW_VALUES);
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState<{ id: string | undefined; version: number } | undefined>(undefined);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data });
  const detail = routeById('SAS-13');
  const history = routeById('SAS-16');
  const license = query.data;
  const renewable = license !== undefined && licenseRenewable(license.status, canManage);
  const now = new Date();
  const errors = license === undefined ? {} : validateRenewForm(values, license, now);
  const shown = (field: RenewField): string | undefined => {
    const problem = errors[field];
    return submitted && problem !== undefined ? renewProblemMessage(t, problem) : undefined;
  };
  const reasonRefused = submitted && !isReasonValid(reason);
  const problem = command.isError ? describeProblem(command.error) : undefined;

  const set = (field: RenewField, value: string): void => setValues({ ...values, [field]: value });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (command.isPending || license === undefined || Object.keys(errors).length > 0 || !isReasonValid(reason)) return;
    command.mutate(
      { license, values, reason },
      {
        onSuccess: (result) => {
          setDone({ id: result.resource_id, version: result.resource_version });
          setValues(EMPTY_RENEW_VALUES);
          setReason('');
          setSubmitted(false);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {detail === undefined || licenseId === undefined ? null : (
        <p className="sas-back-link">
          <Link to={`${detail.path}?license=${encodeURIComponent(licenseId)}`}>
            <span aria-hidden="true">{ARROW} </span>
            {t('sas.licenseRenew.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.licenseRenew.page.title')}</h1>
          <p>{t('sas.licenseRenew.page.subtitle')}</p>
        </div>
      </div>
      {licenseId === undefined ? (
        <p className="callout" role="status">
          {t('sas.licenseRenew.missing.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {license === undefined ? null : (
            <>
              {done === undefined ? null : (
                <p className="callout" role="status" data-testid="renewed">
                  {t('sas.licenseRenew.done.notice', { version: done.version })}{' '}
                  {history === undefined ? null : <Link to={`${history.path}?tenant=${encodeURIComponent(license.tenantId)}`}>{t('sas.licenseRenew.done.link')}</Link>}
                </p>
              )}
              {!canManage ? (
                <p className="callout warning" role="status">
                  {t('sas.licenseRenew.readOnly.notice')}
                </p>
              ) : null}
              {canManage && !renewable ? (
                <p className="callout" role="status" data-testid="not-renewable">
                  {t('sas.licenseRenew.notRenewable.notice', { status: statusLabel(t, license.status) })}
                </p>
              ) : null}
              <div className="sas-compare">
                <CurrentRevision license={license} locale={locale} />
                <form className="card license-renew-card" onSubmit={submit} noValidate data-testid="proposal">
                  <h2>{t('sas.licenseRenew.proposal.title', { revision: license.revision + 1 })}</h2>
                  <dl className="sas-detail-fields">
                    <div className="sas-detail-row">
                      <dt>{t('sas.licenseRenew.field.validFrom')}</dt>
                      <dd data-testid="proposed-from">{dateOf(locale, renewalStart(license, now))}</dd>
                    </div>
                    <div className="sas-detail-row">
                      <dt>{t('sas.licenseRenew.field.keeps')}</dt>
                      <dd>{t('sas.licenseRenew.keeps.text', { edition: editionLabel(t, license.edition) })}</dd>
                    </div>
                  </dl>
                  <div className="field">
                    <label htmlFor="renew-valid-until">{t('sas.licenseRenew.field.validUntil')}</label>
                    <input id="renew-valid-until" type="date" disabled={!renewable} value={values.valid_until} aria-invalid={shown('valid_until') !== undefined} onChange={(event) => set('valid_until', event.target.value)} />
                    {shown('valid_until') === undefined ? null : (
                      <small role="alert" className="field-error">
                        {shown('valid_until')}
                      </small>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="renew-grace-until">{t('sas.licenseRenew.field.graceUntil')}</label>
                    <input id="renew-grace-until" type="date" disabled={!renewable} value={values.grace_until} aria-invalid={shown('grace_until') !== undefined} onChange={(event) => set('grace_until', event.target.value)} />
                    {shown('grace_until') === undefined ? null : (
                      <small role="alert" className="field-error">
                        {shown('grace_until')}
                      </small>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="renew-seats">{t('sas.licenseRenew.field.seats')}</label>
                    <input id="renew-seats" inputMode="numeric" disabled={!renewable} value={values.seats} placeholder={license.seats === undefined ? '' : String(license.seats)} aria-invalid={shown('seats') !== undefined} onChange={(event) => set('seats', event.target.value)} />
                    {shown('seats') === undefined ? null : (
                      <small role="alert" className="field-error">
                        {shown('seats')}
                      </small>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="renew-reason">{t('sas.licenseRenew.field.reason')}</label>
                    <textarea id="renew-reason" disabled={!renewable} value={reason} aria-invalid={reasonRefused} onChange={(event) => setReason(event.target.value)} />
                    {reasonRefused ? (
                      <small role="alert" className="field-error">
                        {t('sas.licenseRenew.reason.tooShort')}
                      </small>
                    ) : null}
                  </div>
                  <p className="sub">
                    <b>{t('sas.licenseRenew.field.slo')}:</b> {t('sas.licenseRenew.slo.text')}
                  </p>
                  {problem === undefined ? null : (
                    <div className="callout warning" role="alert" data-testid="refusal">
                      {problemMessage(t, problem)}
                    </div>
                  )}
                  <div className="formfooter">
                    {detail === undefined ? null : (
                      <Link className="button-link" to={`${detail.path}?license=${encodeURIComponent(license.id)}`}>
                        {t('sas.licenseRenew.cancel.action')}
                      </Link>
                    )}
                    <button type="submit" className="primary" disabled={!renewable || command.isPending}>
                      {t('sas.licenseRenew.submit.action')}
                    </button>
                  </div>
                </form>
              </div>
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('sas.licenseRenew.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The revision that is current, as the left side of the comparison. */
function CurrentRevision({ license, locale }: { license: License; locale: string }) {
  const { t } = useTranslation();
  const none = t('sas.licenseRenew.none.text');
  const row = (label: string, value: string | number | undefined) => (
    <div className="sas-detail-row">
      <dt>{label}</dt>
      <dd>{value === undefined || value === '' ? none : value}</dd>
    </div>
  );
  return (
    <div className="card" data-license-id={license.id} data-testid="current">
      <h2>{t('sas.licenseRenew.current.title', { revision: license.revision })}</h2>
      <dl className="sas-detail-fields">
        {row(t('sas.licenseRenew.field.serial'), license.serial)}
        <div className="sas-detail-row">
          <dt>{t('sas.licenseRenew.field.status')}</dt>
          <dd>
            <span className={toneClass(statusTone(license.status))} data-license-status={license.status}>
              {statusLabel(t, license.status)}
            </span>
          </dd>
        </div>
        {row(t('sas.licenseRenew.field.edition'), editionLabel(t, license.edition))}
        {row(t('sas.licenseRenew.field.validFrom'), dateOf(locale, license.validFrom))}
        {row(t('sas.licenseRenew.field.validUntil'), dateOf(locale, license.validUntil))}
        {row(t('sas.licenseRenew.field.graceUntil'), dateOf(locale, license.graceUntil))}
        {row(t('sas.licenseRenew.field.seats'), license.seats)}
      </dl>
    </div>
  );
}
