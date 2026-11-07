import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useLicense, useLicenseAction } from './license/hooks';
import { actionLabel, consequenceLabel, problemMessage, statusLabel, statusTone } from './license/labels';
import { describeProblem } from './license/problems';
import { isLicenseAction, isReasonValid, licenseActions } from './license/rules';
import type { LicenseAction } from './license/rules';
import { MANAGE_LICENSES_PERMISSION } from './license/types';
import { toneClass } from './tenants/labels';
import './tenants/sas.css';
import './tenant-detail/tenant-detail.css';
import './license/license.css';
import { StatusPill } from '../../ui';
import { toneOfPill } from '../adm/kit-tone';

const ARROW = '←';

interface Done {
  action: LicenseAction;
  version: number;
}

/**
 * SAS-15: suspends, reinstates or revokes one license, named in the address (`?license=`). The buttons follow the state of
 * the license (a live license is suspended or revoked, a suspended one is reinstated or revoked, nothing else changes), the
 * reason needs 10 to 2000 characters, a revocation also needs the confirmation that it is for good, and the command carries
 * the version the screen showed. Nothing is deleted: the tenant's data stays (SAS-15 rule).
 */
export default function LicenseActionScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [params] = useSearchParams();
  const licenseId = params.get('license') ?? undefined;
  const canManage = permissions === undefined || permissions.includes(MANAGE_LICENSES_PERMISSION);
  const query = useLicense(licenseId ?? '', licenseId !== undefined);
  const command = useLicenseAction();
  const [selected, setSelected] = useState<LicenseAction | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [done, setDone] = useState<Done | undefined>(undefined);
  const state = useScreenState({ isLoading: query.isLoading, error: query.error, data: query.data });
  const detail = routeById('SAS-13');
  const issue = routeById('SAS-12');
  const license = query.data;
  const actions = license === undefined ? [] : licenseActions(license.status, canManage);
  const chosen: LicenseAction | undefined = selected !== undefined && actions.includes(selected) ? selected : actions[0];
  const detailPath = license === undefined || detail === undefined ? undefined : `${detail.path}?license=${encodeURIComponent(license.id)}`;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (command.isPending || license === undefined || chosen === undefined) return;
    const reasonRefused = !isReasonValid(reason);
    const confirmRefused = chosen === 'revoke' && !understood;
    setTooShort(reasonRefused);
    setUnconfirmed(confirmRefused);
    if (reasonRefused || confirmRefused) return;
    command.mutate(
      { action: chosen, license, reason: reason.trim() },
      {
        onSuccess: (result) => {
          setDone({ action: chosen, version: result.resource_version });
          setReason('');
          setUnderstood(false);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {issue === undefined ? null : (
        <p className="sas-back-link">
          <Link to={issue.path}>
            <span aria-hidden="true">{ARROW} </span>
            {t('sas.licenseAction.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.licenseAction.page.title')}</h1>
          <p>{t('sas.licenseAction.page.subtitle')}</p>
        </div>
      </div>
      {licenseId === undefined ? (
        <p className="callout" role="status">
          {t('sas.licenseAction.missing.notice')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void query.refetch()}>
          {license === undefined ? null : (
            <div className="card license-action-card" data-license-id={license.id}>
              <h2>{t('sas.licenseAction.card.title')}</h2>
              <p className="sub">{t('sas.licenseAction.card.subtitle')}</p>
              <dl className="sas-detail-fields">
                <div className="sas-detail-row">
                  <dt>{t('sas.licenseAction.field.scope')}</dt>
                  <dd>{t('sas.licenseAction.scope.text', { serial: license.serial, revision: license.revision })}</dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.licenseAction.field.status')}</dt>
                  <dd>
                    <span data-license-status={license.status}><StatusPill tone={toneOfPill(toneClass(statusTone(license.status)))}>
                      {statusLabel(t, license.status)}
                    </StatusPill></span>
                  </dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.licenseAction.field.effective')}</dt>
                  <dd>{t('sas.licenseAction.effective.text')}</dd>
                </div>
              </dl>
              {done === undefined ? null : (
                <p className="callout" role="status">
                  {t('sas.licenseAction.done.notice', { action: actionLabel(t, done.action), version: done.version })}{' '}
                  {detailPath === undefined ? null : <Link to={detailPath}>{t('sas.licenseAction.done.link')}</Link>}
                </p>
              )}
              {!canManage ? (
                <p className="callout warning" role="status">
                  {t('sas.licenseAction.readOnly.notice')}
                </p>
              ) : null}
              {canManage && chosen === undefined ? <p className="sub">{t('sas.licenseAction.none.notice', { status: statusLabel(t, license.status) })}</p> : null}
              {chosen === undefined ? null : (
                <form onSubmit={submit} noValidate>
                  <fieldset className="license-actions">
                    <legend>{t('sas.licenseAction.field.action')}</legend>
                    {actions.map((action) => (
                      <label key={action} className="license-action-choice">
                        <input
                          type="radio"
                          name="license-action"
                          value={action}
                          checked={chosen === action}
                          onChange={(event) => {
                            if (isLicenseAction(event.target.value)) setSelected(event.target.value);
                          }}
                        />{' '}
                        {actionLabel(t, action)}
                      </label>
                    ))}
                  </fieldset>
                  <p className="sub" data-consequence={chosen}>
                    <b>{t('sas.licenseAction.field.data')}:</b> {consequenceLabel(t, chosen)}
                  </p>
                  <p className="sub">
                    <b>{t('sas.licenseAction.field.slo')}:</b> {t('sas.licenseAction.slo.text')}
                  </p>
                  <div className="field">
                    <label htmlFor="license-reason">{t('sas.licenseAction.field.reason')}</label>
                    <textarea id="license-reason" name="reason" value={reason} aria-invalid={tooShort} onChange={(event) => setReason(event.target.value)} />
                    {tooShort ? (
                      <small role="alert" className="field-error">
                        {t('sas.licenseAction.reason.tooShort')}
                      </small>
                    ) : null}
                  </div>
                  {chosen === 'revoke' ? (
                    <div className="field">
                      <label className="license-action-choice">
                        <input type="checkbox" checked={understood} aria-invalid={unconfirmed} onChange={(event) => setUnderstood(event.target.checked)} /> {t('sas.licenseAction.revoke.confirm')}
                      </label>
                      {unconfirmed ? (
                        <small role="alert" className="field-error">
                          {t('sas.licenseAction.revoke.unconfirmed')}
                        </small>
                      ) : null}
                    </div>
                  ) : null}
                  {command.isError ? (
                    <div className="callout warning" role="alert">
                      {problemMessage(t, describeProblem(command.error))}
                    </div>
                  ) : null}
                  <div className="formfooter">
                    {detailPath === undefined ? null : (
                      <Link className="button-link" to={detailPath}>
                        {t('sas.licenseAction.cancel.action')}
                      </Link>
                    )}
                    <button type="submit" className={chosen === 'reinstate' ? 'primary' : 'danger'} disabled={command.isPending}>
                      {t('sas.licenseAction.submit.action', { action: actionLabel(t, chosen) })}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('sas.licenseAction.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
