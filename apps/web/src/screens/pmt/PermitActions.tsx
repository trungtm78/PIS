import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useDeclareExemption, useDecidePermit, useRecordMilestone, useRenewPermit, useRevokePermit } from './dossier-commands';
import { permitFieldMessage, permitProblemMessage, stepLabel } from './dossier-labels';
import {
  EMPTY_DECISION,
  EMPTY_EXEMPTION,
  EMPTY_RENEWAL,
  EMPTY_REVOCATION,
  actionsFor,
  describePermitProblem,
  emptyMilestone,
  permitLink,
  toDecisionBody,
  toExemptionBody,
  toMilestoneBody,
  toRenewalBody,
  toRevocationBody,
  validateDecision,
  validateExemption,
  validateMilestone,
  validateRenewal,
  validateRevocation,
} from './dossier-model';
import type { DecisionField, DecisionForm, DecisionOutcome, ExemptionField, ExemptionForm, FormErrors, MilestoneField, MilestoneForm, MilestoneStep, PermitDetailView, RenewalField, RenewalForm, RevocationField, RevocationForm } from './dossier-model';
import './pmt.css';

const noop = (): void => undefined;

export interface PermitActionsProps {
  permit: PermitDetailView;
  /** The Vietnam date the dates of the forms are judged on. */
  today: string;
  /** `permit.manage`: record a milestone. */
  mayManage: boolean;
  /** `permit.record`: decide, renew, revoke. */
  mayRecord: boolean;
  /** `permit.exempt`: declare the exemption of a permit (the server still refuses the person who proposed it). */
  mayExempt: boolean;
}

/** The refusal of the last attempt and the notice of the last success of one form. */
function Outcome({ failure, notice, testId }: { failure: unknown; notice: ReactNode; testId: string }) {
  const { t } = useTranslation();
  return (
    <>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert">
          {permitProblemMessage(t, describePermitProblem(failure))}
        </p>
      )}
      {notice === null ? null : (
        <p className="callout" role="status" data-testid={testId}>
          {notice}
        </p>
      )}
    </>
  );
}

/** A form value setter that clears the error of the field and the last notice, as every form of this screen does. */
function useFormState<Values extends object, Field extends string>(initial: Values) {
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<FormErrors<Field>>({});
  const set = <Name extends keyof Values & string>(field: Name, value: Values[Name]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };
  return { values, setValues, errors, setErrors, set };
}

/**
 * PMT-02: what can be done with a permit now. The status decides which forms are offered (a milestone, the decision of an application in
 * appraisal, the renewal or revocation of an issued permit); the permissions decide who sees them. Every command names the version of the
 * permit that was read, so a permit that moved meanwhile is refused instead of overwritten.
 */
type Done = { kind: 'decision' } | { kind: 'renew'; renewedId: string | undefined } | { kind: 'revoke' } | { kind: 'exempt' };

/**
 * The notice of the last decision, renewal or revocation. It lives above the forms because the command moves the permit out of the status
 * that offered the form: the form is gone once the new status is read, and the person must still be told, and (after a renewal) be led to the new permit.
 */
function DoneNotice({ done }: { done: Done }) {
  const { t } = useTranslation();
  return (
    <p className="callout" role="status" data-testid={`${done.kind}-saved`}>
      {done.kind === 'decision' ? t('pmt.permit.decision.saved.notice') : null}
      {done.kind === 'revoke' ? t('pmt.permit.revoke.saved.notice') : null}
      {done.kind === 'exempt' ? t('pmt.permit.exempt.saved.notice') : null}
      {done.kind === 'renew' ? (
        <>
          {t('pmt.permit.renew.saved.notice')} {done.renewedId === undefined ? null : <Link to={permitLink(done.renewedId)}>{t('pmt.permit.renew.open.action')}</Link>}
        </>
      ) : null}
    </p>
  );
}

export function PermitActions({ permit, today, mayManage, mayRecord, mayExempt }: PermitActionsProps) {
  const { t } = useTranslation();
  const [done, setDone] = useState<Done | undefined>(undefined);
  const actions = actionsFor(permit);
  const showMilestone = mayManage && actions.steps.length > 0;
  const showDecision = mayRecord && actions.decide;
  const showRenewal = mayRecord && actions.renew;
  const showRevocation = mayRecord && actions.revoke;
  const showExemption = mayExempt && actions.exempt;
  const offered = actions.steps.length > 0 || actions.decide || actions.renew || actions.revoke || actions.exempt;

  if (!offered) {
    return (
      <>
        {done === undefined ? null : <DoneNotice done={done} />}
        <p className="sub" data-testid="no-actions">
          {t('pmt.permit.actions.none.text')}
        </p>
      </>
    );
  }
  if (!showMilestone && !showDecision && !showRenewal && !showRevocation && !showExemption) {
    return (
      <p className="sub" data-testid="actions-readonly">
        {t('pmt.permit.actions.readonly.text')}
      </p>
    );
  }
  return (
    <div className="pmt-actions" data-testid="actions">
      {done === undefined ? null : <DoneNotice done={done} />}
      {showMilestone ? <MilestoneFormView permit={permit} steps={actions.steps} today={today} /> : null}
      {showDecision ? <DecisionFormView permit={permit} today={today} onDone={() => setDone({ kind: 'decision' })} /> : null}
      {showRenewal ? <RenewalFormView permit={permit} today={today} onDone={(renewedId) => setDone({ kind: 'renew', renewedId })} /> : null}
      {showRevocation ? <RevocationFormView permit={permit} onDone={() => setDone({ kind: 'revoke' })} /> : null}
      {showExemption ? <ExemptionFormView permit={permit} onDone={() => setDone({ kind: 'exempt' })} /> : null}
    </div>
  );
}

function MilestoneFormView({ permit, steps, today }: { permit: PermitDetailView; steps: MilestoneStep[]; today: string }) {
  const { t } = useTranslation();
  const record = useRecordMilestone();
  const { values, setValues, errors, setErrors, set } = useFormState<MilestoneForm, MilestoneField>(emptyMilestone(steps[0] as MilestoneStep));
  const [saved, setSaved] = useState(false);
  // The status moved (a milestone was recorded): the form starts over with the first step that status allows.
  const step = steps.includes(values.step) ? values.step : (steps[0] as MilestoneStep);
  const error = (field: MilestoneField): string | undefined => (errors[field] === undefined ? undefined : permitFieldMessage(t, errors[field]));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (record.isPending) return;
    const form = { ...values, step };
    const found = validateMilestone(form, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    record.mutate(
      { permitId: permit.id, version: permit.version, body: toMilestoneBody(form) },
      {
        onSuccess: () => {
          setValues(emptyMilestone(step));
          setSaved(true);
        },
      },
    );
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('pmt.permit.milestone.aria')}>
      <h2>{t('pmt.permit.milestone.title')}</h2>
      <Outcome failure={record.isError ? record.error : undefined} notice={saved && record.isSuccess ? t('pmt.permit.milestone.saved.notice') : null} testId="milestone-saved" />
      <Field id="milestone-step" label={t('pmt.permit.milestone.step.label')} error={undefined}>
        <select
          id="milestone-step"
          value={step}
          onChange={(event) => {
            set('step', event.target.value as MilestoneStep);
            setSaved(false);
          }}
        >
          {steps.map((candidate) => (
            <option key={candidate} value={candidate}>
              {stepLabel(t, candidate)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="milestone-planned" label={t('pmt.permit.milestone.planned.label')} error={error('plannedOn')}>
        <input id="milestone-planned" type="date" value={values.plannedOn} onChange={(event) => set('plannedOn', event.target.value)} />
      </Field>
      <Field id="milestone-actual" label={t('pmt.permit.milestone.actual.label')} error={error('actualOn')}>
        <input id="milestone-actual" type="date" value={values.actualOn} max={today} onChange={(event) => set('actualOn', event.target.value)} />
      </Field>
      <Field id="milestone-note" label={t('pmt.permit.milestone.note.label')} error={error('note')}>
        <textarea id="milestone-note" value={values.note} onChange={(event) => set('note', event.target.value)} />
      </Field>
      <Field id="milestone-scan" label={t('pmt.permit.scan.label')} error={error('documentVersionId')} hint={t('pmt.permit.scan.hint')}>
        <input id="milestone-scan" value={values.documentVersionId} onChange={(event) => set('documentVersionId', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={record.isPending}>
          {t('pmt.permit.milestone.save.action')}
        </button>
      </div>
    </form>
  );
}

function DecisionFormView({ permit, today, onDone }: { permit: PermitDetailView; today: string; onDone: () => void }) {
  const { t } = useTranslation();
  const decide = useDecidePermit();
  const { values, setValues, errors, setErrors, set } = useFormState<DecisionForm, DecisionField>(EMPTY_DECISION);
  const issued = values.outcome === 'ISSUED';
  const error = (field: DecisionField): string | undefined => (errors[field] === undefined ? undefined : permitFieldMessage(t, errors[field]));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (decide.isPending) return;
    const found = validateDecision(values, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    // The command moves the permit out of the status that offers this form, so the form may be gone when it answers: the parent is told.
    // A refusal is shown from the state of the mutation; there is nothing more to do with it here.
    void decide.mutateAsync({ permitId: permit.id, version: permit.version, body: toDecisionBody(values) }).then(() => {
      setValues(EMPTY_DECISION);
      onDone();
    }, noop);
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('pmt.permit.decision.aria')}>
      <h2>{t('pmt.permit.decision.title')}</h2>
      <Outcome failure={decide.isError ? decide.error : undefined} notice={null} testId="decision-saved" />
      <Field id="decision-outcome" label={t('pmt.permit.decision.outcome.label')} error={undefined}>
        <select
          id="decision-outcome"
          value={values.outcome}
          onChange={(event) => {
            set('outcome', event.target.value as DecisionOutcome);
            setErrors({});
          }}
        >
          <option value="ISSUED">{t('pmt.permit.decision.issued.option')}</option>
          <option value="REJECTED">{t('pmt.permit.decision.rejected.option')}</option>
        </select>
      </Field>
      {issued ? (
        <>
          <Field id="decision-number" label={t('pmt.permit.decision.number.label')} error={error('permitNo')}>
            <input id="decision-number" value={values.permitNo} onChange={(event) => set('permitNo', event.target.value)} />
          </Field>
          <Field id="decision-issued-on" label={t('pmt.permit.decision.issuedOn.label')} error={error('issuedOn')}>
            <input id="decision-issued-on" type="date" value={values.issuedOn} max={today} onChange={(event) => set('issuedOn', event.target.value)} />
          </Field>
          <Field id="decision-valid-from" label={t('pmt.permit.decision.validFrom.label')} error={error('validFrom')}>
            <input id="decision-valid-from" type="date" value={values.validFrom} onChange={(event) => set('validFrom', event.target.value)} />
          </Field>
          <Field id="decision-valid-until" label={t('pmt.permit.decision.validUntil.label')} error={error('validUntil')} hint={t('pmt.permit.decision.validUntil.hint')}>
            <input id="decision-valid-until" type="date" value={values.validUntil} disabled={values.noExpiry} onChange={(event) => set('validUntil', event.target.value)} />
          </Field>
          <div className="field">
            <label>
              <input
                type="checkbox"
                checked={values.noExpiry}
                onChange={(event) => {
                  // A permit without an end has no last day: the field is cleared, not kept behind the box.
                  const noExpiry = event.target.checked;
                  setValues((previous) => ({ ...previous, noExpiry, validUntil: noExpiry ? '' : previous.validUntil }));
                  setErrors((previous) => ({ ...previous, validUntil: undefined }));
                }}
              />{' '}
              {t('pmt.permit.decision.noExpiry.label')}
            </label>
          </div>
        </>
      ) : (
        <Field id="decision-reason" label={t('pmt.permit.decision.reason.label')} error={error('reason')}>
          <textarea id="decision-reason" value={values.reason} onChange={(event) => set('reason', event.target.value)} />
        </Field>
      )}
      <Field id="decision-scan" label={t('pmt.permit.scan.label')} error={error('documentVersionId')} hint={t('pmt.permit.scan.hint')}>
        <input id="decision-scan" value={values.documentVersionId} onChange={(event) => set('documentVersionId', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={decide.isPending}>
          {t('pmt.permit.decision.save.action')}
        </button>
      </div>
    </form>
  );
}

function RenewalFormView({ permit, today, onDone }: { permit: PermitDetailView; today: string; onDone: (renewedId: string | undefined) => void }) {
  const { t } = useTranslation();
  const renew = useRenewPermit();
  const { values, setValues, errors, setErrors, set } = useFormState<RenewalForm, RenewalField>(EMPTY_RENEWAL);
  const error = (field: RenewalField): string | undefined => (errors[field] === undefined ? undefined : permitFieldMessage(t, errors[field]));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (renew.isPending) return;
    const found = validateRenewal(values, permit, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void renew.mutateAsync({ permitId: permit.id, version: permit.version, body: toRenewalBody(values) }).then((answer) => {
      setValues(EMPTY_RENEWAL);
      onDone(answer.resource_id);
    }, noop);
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('pmt.permit.renew.aria')}>
      <h2>{t('pmt.permit.renew.title')}</h2>
      <p className="sub">{t('pmt.permit.renew.hint')}</p>
      <Outcome failure={renew.isError ? renew.error : undefined} notice={null} testId="renew-saved" />
      <Field id="renew-number" label={t('pmt.permit.renew.number.label')} error={error('newPermitNo')}>
        <input id="renew-number" value={values.newPermitNo} onChange={(event) => set('newPermitNo', event.target.value)} />
      </Field>
      <Field id="renew-until" label={t('pmt.permit.renew.until.label')} error={error('newValidUntil')}>
        <input id="renew-until" type="date" value={values.newValidUntil} min={today} onChange={(event) => set('newValidUntil', event.target.value)} />
      </Field>
      <Field id="renew-scan" label={t('pmt.permit.scan.label')} error={error('documentVersionId')} hint={t('pmt.permit.scan.hint')}>
        <input id="renew-scan" value={values.documentVersionId} onChange={(event) => set('documentVersionId', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={renew.isPending}>
          {t('pmt.permit.renew.save.action')}
        </button>
      </div>
    </form>
  );
}

function ExemptionFormView({ permit, onDone }: { permit: PermitDetailView; onDone: () => void }) {
  const { t } = useTranslation();
  const exempt = useDeclareExemption();
  const { values, setValues, errors, setErrors, set } = useFormState<ExemptionForm, ExemptionField>(EMPTY_EXEMPTION);
  const error = (field: ExemptionField): string | undefined => (errors[field] === undefined ? undefined : permitFieldMessage(t, errors[field]));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (exempt.isPending) return;
    const found = validateExemption(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void exempt.mutateAsync({ permitId: permit.id, version: permit.version, body: toExemptionBody(values) }).then(() => {
      setValues(EMPTY_EXEMPTION);
      onDone();
    }, noop);
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('pmt.permit.exempt.aria')}>
      <h2>{t('pmt.permit.exempt.title')}</h2>
      <p className="sub">{t('pmt.permit.exempt.hint.text')}</p>
      <Outcome failure={exempt.isError ? exempt.error : undefined} notice={null} testId="exempt-saved" />
      <Field id="exempt-basis" label={t('pmt.permit.exempt.basis.label')} error={error('basis')}>
        <textarea id="exempt-basis" value={values.basis} onChange={(event) => set('basis', event.target.value)} />
      </Field>
      <Field id="exempt-scan" label={t('pmt.permit.exempt.scan.label')} error={error('decisionDocumentVersionId')} hint={t('pmt.permit.scan.hint')}>
        <input id="exempt-scan" value={values.decisionDocumentVersionId} onChange={(event) => set('decisionDocumentVersionId', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={exempt.isPending}>
          {t('pmt.permit.exempt.save.action')}
        </button>
      </div>
    </form>
  );
}

function RevocationFormView({ permit, onDone }: { permit: PermitDetailView; onDone: () => void }) {
  const { t } = useTranslation();
  const revoke = useRevokePermit();
  const { values, setValues, errors, setErrors, set } = useFormState<RevocationForm, RevocationField>(EMPTY_REVOCATION);
  const error = (field: RevocationField): string | undefined => (errors[field] === undefined ? undefined : permitFieldMessage(t, errors[field]));

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (revoke.isPending) return;
    const found = validateRevocation(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void revoke.mutateAsync({ permitId: permit.id, version: permit.version, body: toRevocationBody(values) }).then(() => {
      setValues(EMPTY_REVOCATION);
      onDone();
    }, noop);
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('pmt.permit.revoke.aria')}>
      <h2>{t('pmt.permit.revoke.title')}</h2>
      <Outcome failure={revoke.isError ? revoke.error : undefined} notice={null} testId="revoke-saved" />
      <Field id="revoke-reason" label={t('pmt.permit.revoke.reason.label')} error={error('reason')}>
        <textarea id="revoke-reason" value={values.reason} onChange={(event) => set('reason', event.target.value)} />
      </Field>
      <Field id="revoke-scan" label={t('pmt.permit.revoke.scan.label')} error={error('decisionDocumentVersionId')} hint={t('pmt.permit.scan.hint')}>
        <input id="revoke-scan" value={values.decisionDocumentVersionId} onChange={(event) => set('decisionDocumentVersionId', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={revoke.isPending}>
          {t('pmt.permit.revoke.save.action')}
        </button>
      </div>
    </form>
  );
}
