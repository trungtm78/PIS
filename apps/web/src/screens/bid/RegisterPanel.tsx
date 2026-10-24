import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useRegisterContractor } from './hooks';
import { fieldProblemMessage, problemMessage } from './labels';
import { EMPTY_REGISTER_FORM, describeProblem, profileLink, validateRegister } from './model';
import type { FormErrors, ProblemView, RegisterField, RegisterForm } from './model';

/** The registration of a contractor (BID-01): the tax id, the legal name, the legal form and the profile document; nothing about people. */
export default function RegisterPanel() {
  const { t } = useTranslation();
  const register = useRegisterContractor();
  const [form, setForm] = useState<RegisterForm>(EMPTY_REGISTER_FORM);
  const [errors, setErrors] = useState<FormErrors<RegisterField>>({});
  const refused: ProblemView | undefined = register.isError ? describeProblem(register.error, 'register') : undefined;
  const error = (field: RegisterField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem);
  };
  const setField = (field: RegisterField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    register.reset();
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    const found = validateRegister(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    register.mutate(form, { onSuccess: () => setForm(EMPTY_REGISTER_FORM) });
  };

  return (
    <div className="card" data-testid="register-panel">
      <h2>{t('bid.register.panel.title')}</h2>
      <p className="sub">{t('bid.register.panel.hint')}</p>
      <form onSubmit={send} noValidate aria-label={t('bid.register.panel.title')}>
        {refused === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="register-refusal">
            {problemMessage(t, refused)}
            {refused.verifiedContractorId === undefined ? null : (
              <>
                {' '}
                <Link to={profileLink(refused.verifiedContractorId)}>{t('bid.register.holder.link')}</Link>
              </>
            )}
          </p>
        )}
        {register.isSuccess ? (
          <p className="callout" role="status" data-testid="register-done">
            {t('bid.register.done.notice')}{' '}
            {register.data.resource_id === undefined ? null : <Link to={profileLink(register.data.resource_id)}>{t('bid.register.open.link')}</Link>}
          </p>
        ) : null}
        <div className="formgrid">
          <Field id="register-taxIdentifier" label={t('bid.register.taxId.label')} error={error('taxIdentifier')} hint={t('bid.register.taxId.hint')}>
            <input id="register-taxIdentifier" inputMode="numeric" value={form.taxIdentifier} aria-invalid={error('taxIdentifier') !== undefined} onChange={(event) => setField('taxIdentifier', event.target.value)} />
          </Field>
          <Field id="register-legalName" label={t('bid.register.name.label')} error={error('legalName')}>
            <input id="register-legalName" value={form.legalName} aria-invalid={error('legalName') !== undefined} onChange={(event) => setField('legalName', event.target.value)} />
          </Field>
          <Field id="register-legalForm" label={t('bid.register.form.label')} error={error('legalForm')}>
            <input id="register-legalForm" value={form.legalForm} aria-invalid={error('legalForm') !== undefined} onChange={(event) => setField('legalForm', event.target.value)} />
          </Field>
          <Field id="register-profileDocumentId" label={t('bid.register.profile.label')} error={error('profileDocumentId')} hint={t('bid.register.profile.hint')}>
            <input id="register-profileDocumentId" value={form.profileDocumentId} aria-invalid={error('profileDocumentId') !== undefined} onChange={(event) => setField('profileDocumentId', event.target.value)} />
          </Field>
        </div>
        <div className="formfooter">
          <button type="submit" className="primary" disabled={register.isPending}>
            {t('bid.register.submit.action')}
          </button>
        </div>
      </form>
    </div>
  );
}
