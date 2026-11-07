import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { SectionCard, StatusPill, StickyActions } from '../../ui';
import { KitTable } from './KitTable';
import { useCertificates, useMemberOptions, useRegisterCertificate, useRevokeCertificate, useUnitOptions } from './security/hooks';
import { certificateFieldMessage, certificateProblemMessage, certificateStatusLabel, certificateTone, kindLabel } from './security/labels';
import {
  CERTIFICATE_KINDS,
  EMPTY_CERTIFICATE_VALUES,
  EXPIRY_WARNING_DAYS,
  MANAGE_CERTIFICATES_PERMISSION,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  certificateBody,
  daysUntil,
  describeProblem,
  expiryState,
  validateCertificate,
} from './security/model';
import type { CertificateErrors, CertificateField, CertificateValues, CertificateView } from './security/model';
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

const dateOf = (iso: string): string => iso.slice(0, 10);

/** ADM-08: the registry of public signing certificates (ST-ADM-008) with the 30-day expiry warning. */
export default function CertificatesScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the holder, the pasted certificate, an open revocation) belongs to one tenant: a switch starts it over.
  return <CertificatesContent key={tenantId ?? 'none'} route={route} />;
}

function CertificatesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_CERTIFICATES_PERMISSION)) && !frozen;
  const list = useCertificates();
  const members = useMemberOptions();
  const units = useUnitOptions();
  const register = useRegisterCertificate();
  const revoke = useRevokeCertificate();
  const [values, setValues] = useState<CertificateValues>(EMPTY_CERTIFICATE_VALUES);
  const [errors, setErrors] = useState<CertificateErrors>({});
  const [revoking, setRevoking] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const now = new Date();
  const certificates = useMemo(() => list.data ?? [], [list.data]);
  const expiring = certificates.filter((certificate) => expiryState(certificate, now) === 'expiring');
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data, isEmpty: NEVER_EMPTY });
  const registerProblem = register.isError ? describeProblem(register.error) : undefined;
  const revokeProblem = revoke.isError ? describeProblem(revoke.error) : undefined;

  const set = (field: CertificateField, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };
  const fieldError = (field: CertificateField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : certificateFieldMessage(t, own);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending || !canManage) return;
    const found = validateCertificate(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    // An accepted certificate is done: the form empties, so a second click cannot register it again.
    register.mutate(certificateBody(values), { onSuccess: () => setValues(EMPTY_CERTIFICATE_VALUES) });
  };

  const confirmRevoke = (event: FormEvent, certificate: CertificateView): void => {
    event.preventDefault();
    if (revoke.isPending || !canManage) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    revoke.mutate({ id: certificate.id, version: certificate.version, reason: trimmed }, { onSuccess: () => setRevoking(undefined) });
  };

  const expiryCell = (certificate: CertificateView): ReactNode => {
    const expiry = expiryState(certificate, now);
    if (expiry === 'expiring') {
      return (
        <span data-expiry="expiring">
          <StatusPill tone="warning">{t('adm.certificates.expiry.warning', { days: Math.max(daysUntil(certificate.validUntil, now), 0) })}</StatusPill>
        </span>
      );
    }
    if (expiry === 'expired') {
      return (
        <span data-expiry="expired">
          <StatusPill tone="danger">{t('adm.certificates.expiry.expired')}</StatusPill>
        </span>
      );
    }
    return null;
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.certificates.page.title')}</h1>
          <p>{t('adm.certificates.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="adm-security">
          <SectionCard title={t('adm.certificates.list.title')}>
            {expiring.length > 0 ? (
              <p className="callout warning" role="status" data-testid="expiry-banner">
                {t('adm.certificates.expiring.banner', { count: expiring.length, days: EXPIRY_WARNING_DAYS })}
              </p>
            ) : null}
            {certificates.length === 0 ? <p className="muted">{t('adm.certificates.list.empty')}</p> : null}
            {revokeProblem === undefined ? null : (
              <p className="callout warning" role="alert">
                {certificateProblemMessage(t, revokeProblem)}
              </p>
            )}
            {certificates.length === 0 ? null : (
              <KitTable caption={t('w2adm.certificates.table.caption')}>
                <thead>
                  <tr>
                    <th>{t('adm.certificates.col.subject')}</th>
                    <th>{t('adm.certificates.col.serial')}</th>
                    <th>{t('adm.certificates.col.provider')}</th>
                    <th>{t('adm.certificates.col.validUntil')}</th>
                    <th>{t('adm.certificates.col.status')}</th>
                    <th>{t('adm.certificates.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {certificates.map((certificate) => (
                    <tr key={certificate.id} data-certificate-id={certificate.id} data-status={certificate.status}>
                      <td>
                        <strong>{certificate.subjectDn}</strong>
                        <div className="sub">{kindLabel(t, certificate.kind)}</div>
                      </td>
                      <td>
                        <code>{certificate.serial}</code>
                      </td>
                      <td>{certificate.providerCode}</td>
                      <td>
                        {dateOf(certificate.validUntil)} {expiryCell(certificate)}
                      </td>
                      <td>
                        <StatusPill tone={certificateTone(certificate.status)}>{certificateStatusLabel(t, certificate.status)}</StatusPill>
                      </td>
                      <td className="row-actions">
                        {canManage && certificate.status !== 'Revoked' && revoking !== certificate.id ? (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => { setRevoking(certificate.id); setReason(''); setReasonError(false); }}>
                            {t('adm.certificates.revoke.action')}
                          </button>
                        ) : null}
                        {revoking === certificate.id && canManage ? (
                          <form onSubmit={(event) => confirmRevoke(event, certificate)} noValidate aria-label={t('adm.certificates.revoke.action')}>
                            <Field id={`revoke-reason-${certificate.id}`} label={t('adm.certificates.revoke.reason.label')} error={reasonError ? t('adm.certificates.field.tooShort') : undefined}>
                              <input id={`revoke-reason-${certificate.id}`} value={reason} aria-invalid={reasonError} onChange={(event) => { setReason(event.target.value); setReasonError(false); }} />
                            </Field>
                            <button type="submit" className="ui-button ui-button--primary ui-button--small" disabled={revoke.isPending}>
                              {t('adm.certificates.revoke.confirm.action')}
                            </button>
                            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setRevoking(undefined)}>
                              {t('adm.certificates.revoke.cancel.action')}
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </KitTable>
            )}
          </SectionCard>
          <aside aria-label={t('adm.certificates.register.title')}>
            <SectionCard title={t('adm.certificates.register.title')}>
            <p className="adm-kit-sub">{t('adm.certificates.register.hint')}</p>
            {!canManage ? (
              <p className="callout warning" role="status">
                {frozen ? t('adm.certificates.frozen.notice') : t('adm.certificates.readOnly.notice')}
              </p>
            ) : null}
            {register.isSuccess ? (
              <p className="callout" role="status">
                {t('adm.certificates.register.accepted.notice')}
              </p>
            ) : null}
            {registerProblem === undefined ? null : (
              <p className="callout warning" role="alert">
                {certificateProblemMessage(t, registerProblem)}
              </p>
            )}
            <form onSubmit={submit} noValidate aria-label={t('adm.certificates.register.title')}>
              <Field id="cert-kind" label={t('adm.certificates.kind.label')} error={undefined}>
                <select id="cert-kind" value={values.kind} onChange={(event) => set('kind', event.target.value)}>
                  {CERTIFICATE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kindLabel(t, kind)}
                    </option>
                  ))}
                </select>
              </Field>
              {values.kind === 'PERSONAL' ? (
                <Field id="cert-holderMembershipId" label={t('adm.certificates.holder.label')} error={fieldError('holderMembershipId')}>
                  <select id="cert-holderMembershipId" value={values.holderMembershipId} aria-invalid={fieldError('holderMembershipId') !== undefined} onChange={(event) => set('holderMembershipId', event.target.value)}>
                    <option value="">{t('adm.certificates.holder.placeholder')}</option>
                    {(members.data ?? []).map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <Field id="cert-organizationUnitId" label={t('adm.certificates.unit.label')} error={fieldError('organizationUnitId')}>
                  <select id="cert-organizationUnitId" value={values.organizationUnitId} aria-invalid={fieldError('organizationUnitId') !== undefined} onChange={(event) => set('organizationUnitId', event.target.value)}>
                    <option value="">{t('adm.certificates.unit.placeholder')}</option>
                    {(units.data ?? []).map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unit.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field id="cert-providerCode" label={t('adm.certificates.provider.label')} error={fieldError('providerCode')}>
                <input id="cert-providerCode" value={values.providerCode} aria-invalid={fieldError('providerCode') !== undefined} onChange={(event) => set('providerCode', event.target.value)} />
              </Field>
              <Field id="cert-certificatePem" label={t('adm.certificates.pem.label')} error={fieldError('certificatePem')} hint={t('adm.certificates.pem.hint')}>
                <textarea id="cert-certificatePem" rows={8} spellCheck={false} value={values.certificatePem} aria-invalid={fieldError('certificatePem') !== undefined} onChange={(event) => set('certificatePem', event.target.value)} />
              </Field>
              {canManage ? (
                <StickyActions
                  primary={
                    <button type="submit" className="ui-button ui-button--primary" disabled={register.isPending}>
                      {t('adm.certificates.register.submit.action')}
                    </button>
                  }
                />
              ) : null}
            </form>
            </SectionCard>
          </aside>
        </div>
      </StateBoundary>
      <p className="prototype-note">{t('adm.certificates.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
