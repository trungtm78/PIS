import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { problemMessage } from '../tenants/labels';
import { describeProblem } from '../tenants/problems';
import type { TenantDetail } from '../tenants/types';
import { useResumeTenant, useSuspendTenant } from './hooks';
import type { LifecycleResult } from './hooks';
import { policyLabel, reasonCodeLabel } from './labels';
import { SUSPENSION_REASON_CODES, accessPolicyOf, isReasonCode, isReasonValid } from './rules';
import type { LifecycleAction, SuspensionReasonCode } from './rules';

/** The multiplication sign on the close button of the dialog. */
const CLOSE_GLYPH = '\u00d7';

export interface LifecycleDialogProps {
  action: LifecycleAction;
  tenant: TenantDetail;
  onClose(): void;
  onDone(result: LifecycleResult): void;
}

/**
 * The confirmation of a lifecycle command: the reason (and, for a suspension, its code, with the access policy it
 * implies), then one versioned command with the version the screen showed (`If-Match`). Nothing is sent before the
 * reason is long enough, and a second click on the confirm button reuses the idempotency attempt of the first.
 */
export function LifecycleDialog({ action, tenant, onClose, onDone }: LifecycleDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const suspend = useSuspendTenant();
  const resume = useResumeTenant();
  const [reasonCode, setReasonCode] = useState<SuspensionReasonCode>('NON_PAYMENT');
  const [reason, setReason] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const command = action === 'suspend' ? suspend : resume;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (command.isPending) return;
    if (!isReasonValid(reason)) {
      setTooShort(true);
      return;
    }
    setTooShort(false);
    const input = { tenantId: tenant.id, version: tenant.version, reason: reason.trim() };
    if (action === 'suspend') suspend.mutate({ ...input, reasonCode }, { onSuccess: onDone });
    else resume.mutate(input, { onSuccess: onDone });
  };

  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="command-titlebar">
          <strong id={titleId}>{action === 'suspend' ? t('sas.tenantDetail.suspend.dialog.title', { code: tenant.code }) : t('sas.tenantDetail.resume.dialog.title', { code: tenant.code })}</strong>
          <button type="button" className="icon-button" aria-label={t('sas.tenantDetail.dialog.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <form className="lifecycle-dialog-body" onSubmit={submit} noValidate>
          {action === 'suspend' ? (
            <>
              <div className="field">
                <label htmlFor="lifecycle-reason-code">{t('sas.tenantDetail.reasonCode.label')}</label>
                <select
                  id="lifecycle-reason-code"
                  value={reasonCode}
                  onChange={(event) => {
                    if (isReasonCode(event.target.value)) setReasonCode(event.target.value);
                  }}
                >
                  {SUSPENSION_REASON_CODES.map((code) => (
                    <option key={code} value={code}>
                      {reasonCodeLabel(t, code)}
                    </option>
                  ))}
                </select>
              </div>
              <p className="sub" data-access-policy={accessPolicyOf(reasonCode)}>
                {t('sas.tenantDetail.policy.label')}: <b>{policyLabel(t, accessPolicyOf(reasonCode))}</b>
              </p>
              <p className="callout warning">{t('sas.tenantDetail.suspend.warning')}</p>
            </>
          ) : null}
          <div className="field">
            <label htmlFor="lifecycle-reason">{t('sas.tenantDetail.reason.label')}</label>
            <textarea id="lifecycle-reason" name="reason" value={reason} aria-invalid={tooShort} onChange={(event) => setReason(event.target.value)} />
            {tooShort ? (
              <small role="alert" className="field-error">
                {t('sas.tenantDetail.reason.tooShort')}
              </small>
            ) : null}
          </div>
          {command.isError ? (
            <div className="callout warning" role="alert">
              {problemMessage(t, describeProblem(command.error))}
            </div>
          ) : null}
          <div className="formfooter">
            <button type="button" onClick={onClose}>
              {t('sas.tenantDetail.confirm.cancel')}
            </button>
            <button type="submit" className={action === 'suspend' ? 'danger' : 'primary'} disabled={command.isPending}>
              {action === 'suspend' ? t('sas.tenantDetail.suspend.confirm') : t('sas.tenantDetail.resume.confirm')}
            </button>
          </div>
        </form>
      </section>
    </NavigationDialog>
  );
}
