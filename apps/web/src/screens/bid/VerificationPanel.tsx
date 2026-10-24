import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useVerifyContractor } from './hooks';
import { fieldProblemMessage, problemMessage, statusLabel } from './labels';
import { DECISIONS, EMPTY_VERIFY_FORM, MERGE_PATH, describeProblem, profileLink, validateVerify } from './model';
import type { ContractorView, Decision, FormErrors, VerifyField, VerifyForm } from './model';

/**
 * The decision on an unverified contractor (BID-02): verified or rejected, on an evidence document. It must be someone other than the
 * registrant; a tax id that a verified contractor holds already is not verified again, and the duplicate is sent to the merge in master data.
 */
export default function VerificationPanel({ contractor }: { contractor: ContractorView }) {
  const { t } = useTranslation();
  const verify = useVerifyContractor();
  const [form, setForm] = useState<VerifyForm>(EMPTY_VERIFY_FORM);
  const [errors, setErrors] = useState<FormErrors<VerifyField>>({});
  const refused = verify.isError ? describeProblem(verify.error, 'verify') : undefined;
  const evidenceError = errors.evidenceDocumentId === undefined ? undefined : fieldProblemMessage(t, errors.evidenceDocumentId);

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (verify.isPending) return;
    const found = validateVerify(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    verify.mutate({ id: contractor.id, version: contractor.version, decision: form.decision, evidenceDocumentId: form.evidenceDocumentId });
  };

  return (
    <div className="card" data-testid="verification-panel">
      <h2>{t('bid.verify.panel.title')}</h2>
      <p className="sub">{t('bid.verify.panel.hint')}</p>
      <form onSubmit={send} noValidate aria-label={t('bid.verify.panel.title')}>
        {refused === undefined ? null : (
          <div className="callout warning" role="alert" data-testid="verify-refusal">
            <p>{problemMessage(t, refused)}</p>
            {refused.reason === 'duplicateVerified' ? (
              <p data-testid="merge-suggestion">
                {t('bid.verify.merge.text')}{' '}
                {refused.verifiedContractorId === undefined ? null : <Link to={profileLink(refused.verifiedContractorId)}>{t('bid.verify.holder.link')}</Link>}{' '}
                <Link to={MERGE_PATH}>{t('bid.verify.merge.link')}</Link>
              </p>
            ) : null}
          </div>
        )}
        <fieldset className="formgrid">
          <legend>{t('bid.verify.decision.label')}</legend>
          {DECISIONS.map((decision: Decision) => (
            <label key={decision} className="check">
              <input type="radio" name="decision" value={decision} checked={form.decision === decision} onChange={() => setForm({ ...form, decision })} />
              {statusLabel(t, decision)}
            </label>
          ))}
        </fieldset>
        <Field id="verify-evidence" label={t('bid.verify.evidence.label')} error={evidenceError} hint={t('bid.verify.evidence.hint')}>
          <input
            id="verify-evidence"
            value={form.evidenceDocumentId}
            aria-invalid={evidenceError !== undefined}
            onChange={(event) => {
              setForm({ ...form, evidenceDocumentId: event.target.value });
              setErrors({});
              verify.reset();
            }}
          />
        </Field>
        <div className="formfooter">
          <button type="submit" className="primary" disabled={verify.isPending}>
            {t('bid.verify.submit.action')}
          </button>
        </div>
      </form>
    </div>
  );
}
