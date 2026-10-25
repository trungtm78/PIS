import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field } from '../components';
import type { ParcelLine, UnitOption } from '../model';
import { useLinkParcel, useRegisterHousehold, useRevealIdentity } from './hooks';
import { commandProblemMessage, formProblemMessage, legalBasisLabel, rightKindLabel } from './labels';
import { EMPTY_LINK_FORM, EMPTY_REGISTER_FORM, LEGAL_BASES, RIGHT_KINDS, describeProblem, linkBody, registerBody, validateLink, validateReason, validateRegister } from './model';
import type { HouseholdLine, LinkForm, RegisterForm } from './model';

/** The registration of a household. Every field of personal data is optional except the name of the head; none can be read back in the clear except by the one reading that is recorded. */
export function RegisterDialog({ projectId, units, today, onClose }: { projectId: string; units: readonly UnitOption[]; today: string; onClose(): void }) {
  const { t } = useTranslation();
  const register = useRegisterHousehold();
  const [form, setForm] = useState<RegisterForm>(EMPTY_REGISTER_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRegister(form, today);
  const error = (field: keyof RegisterForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (register.isPending || Object.keys(problems).length > 0) return;
    register.mutate(registerBody(projectId, form), { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.households.registerDialog.title.text')}
      onClose={onClose}
      refusal={register.isError ? commandProblemMessage(t, describeProblem(register.error)) : undefined}
      pending={register.isPending}
      onSubmit={submit}
    >
      <p className="callout" data-testid="register-note">
        {t('lnd.households.registerDialog.note.text')}
      </p>
      <Field id="household-unit" label={t('lnd.households.registerDialog.unit.label')} error={error('ownerUnitId')} hint={t('lnd.households.registerDialog.unit.help')}>
        <select id="household-unit" value={form.ownerUnitId} onChange={(event) => setForm({ ...form, ownerUnitId: event.target.value })}>
          <option value="">{t('lnd.households.registerDialog.unit.choose')}</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="household-head" label={t('lnd.households.registerDialog.head.label')} error={error('headName')}>
        <input id="household-head" autoComplete="off" value={form.headName} onChange={(event) => setForm({ ...form, headName: event.target.value })} />
      </Field>
      <Field id="household-national-id" label={t('lnd.households.registerDialog.nationalId.label')} error={error('nationalId')} hint={t('lnd.households.registerDialog.nationalId.help')}>
        <input id="household-national-id" autoComplete="off" inputMode="numeric" value={form.nationalId} onChange={(event) => setForm({ ...form, nationalId: event.target.value })} />
      </Field>
      <Field id="household-phone" label={t('lnd.households.registerDialog.phone.label')} error={error('phone')}>
        <input id="household-phone" autoComplete="off" inputMode="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
      </Field>
      <Field id="household-address" label={t('lnd.households.registerDialog.address.label')} error={error('addressText')}>
        <input id="household-address" autoComplete="off" value={form.addressText} onChange={(event) => setForm({ ...form, addressText: event.target.value })} />
      </Field>
      <Field id="household-members" label={t('lnd.households.registerDialog.members.label')} error={error('memberCount')}>
        <input id="household-members" inputMode="numeric" value={form.memberCount} onChange={(event) => setForm({ ...form, memberCount: event.target.value })} />
      </Field>
      <Field id="household-policy" label={t('lnd.households.registerDialog.policy.label')} error={undefined}>
        <input id="household-policy" type="checkbox" checked={form.policyBeneficiary} onChange={(event) => setForm({ ...form, policyBeneficiary: event.target.checked })} />
      </Field>
      <Field id="household-basis" label={t('lnd.households.registerDialog.basis.label')} error={error('legalBasis')}>
        <select id="household-basis" value={form.legalBasis} onChange={(event) => setForm({ ...form, legalBasis: event.target.value as RegisterForm['legalBasis'] })}>
          <option value="">{t('lnd.households.registerDialog.basis.choose')}</option>
          {LEGAL_BASES.map((basis) => (
            <option key={basis} value={basis}>
              {legalBasisLabel(t, basis)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="household-basis-ref" label={t('lnd.households.registerDialog.basisRef.label')} error={error('legalBasisRef')} hint={t('lnd.households.registerDialog.basisRef.help')}>
        <input id="household-basis-ref" value={form.legalBasisRef} onChange={(event) => setForm({ ...form, legalBasisRef: event.target.value })} />
      </Field>
      {form.legalBasis === 'CONSENT' ? (
        <Field id="household-consent" label={t('lnd.households.registerDialog.consent.label')} error={error('consentRecordId')} hint={t('lnd.households.registerDialog.consent.help')}>
          <input id="household-consent" value={form.consentRecordId} onChange={(event) => setForm({ ...form, consentRecordId: event.target.value })} />
        </Field>
      ) : null}
      <Field id="household-retention" label={t('lnd.households.registerDialog.retention.label')} error={error('retentionUntil')} hint={t('lnd.households.registerDialog.retention.help')}>
        <input id="household-retention" type="date" min={today} value={form.retentionUntil} onChange={(event) => setForm({ ...form, retentionUntil: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The link of a household to a parcel of its own unit: the right it holds there and its share of the parcel. */
export function LinkDialog({ household, parcels, onClose }: { household: HouseholdLine; parcels: readonly ParcelLine[]; onClose(): void }) {
  const { t } = useTranslation();
  const link = useLinkParcel();
  const [form, setForm] = useState<LinkForm>(EMPTY_LINK_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateLink(form);
  const error = (field: keyof LinkForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (link.isPending || Object.keys(problems).length > 0) return;
    link.mutate({ householdId: household.id, body: linkBody(form) }, { onSuccess: onClose });
  };
  // A household is linked to the parcels of its own unit; the parcels of other units are not offered.
  const offered = parcels.filter((parcel) => parcel.ownerUnitId === household.ownerUnitId);
  return (
    <DialogFrame
      title={t('lnd.households.linkDialog.title.text', { code: household.householdCode })}
      onClose={onClose}
      refusal={link.isError ? commandProblemMessage(t, describeProblem(link.error)) : undefined}
      pending={link.isPending}
      onSubmit={submit}
    >
      <Field id="link-parcel" label={t('lnd.households.linkDialog.parcel.label')} error={error('parcelId')} hint={t('lnd.households.linkDialog.parcel.help')}>
        <select id="link-parcel" value={form.parcelId} onChange={(event) => setForm({ ...form, parcelId: event.target.value })}>
          <option value="">{t('lnd.households.linkDialog.parcel.choose')}</option>
          {offered.map((parcel) => (
            <option key={parcel.id} value={parcel.id}>
              {parcel.parcelCode}
            </option>
          ))}
        </select>
      </Field>
      <Field id="link-right" label={t('lnd.households.linkDialog.right.label')} error={error('rightKind')}>
        <select id="link-right" value={form.rightKind} onChange={(event) => setForm({ ...form, rightKind: event.target.value as LinkForm['rightKind'] })}>
          <option value="">{t('lnd.households.linkDialog.right.choose')}</option>
          {RIGHT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {rightKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="link-share" label={t('lnd.households.linkDialog.share.label')} error={error('sharePct')} hint={t('lnd.households.linkDialog.share.help')}>
        <input id="link-share" inputMode="decimal" value={form.sharePct} onChange={(event) => setForm({ ...form, sharePct: event.target.value })} />
      </Field>
      <Field id="link-title" label={t('lnd.households.linkDialog.title.label')} error={error('titleDocumentVersionId')} hint={t('lnd.households.linkDialog.title.help')}>
        <input id="link-title" value={form.titleDocumentVersionId} onChange={(event) => setForm({ ...form, titleDocumentVersionId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/**
 * The one place where the personal data of a household is shown in the clear. Nothing is read when the dialog opens: the reading is asked for, says that it is recorded, and its answer lives
 * in this dialog until it is closed.
 */
export function RevealDialog({ household, onClose }: { household: HouseholdLine; onClose(): void }) {
  const { t } = useTranslation();
  const reveal = useRevealIdentity();
  const identity = reveal.data;
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateReason(reason);
  return (
    <DialogFrame
      title={t('lnd.households.revealDialog.title.text', { code: household.householdCode })}
      onClose={onClose}
      refusal={reveal.isError ? commandProblemMessage(t, describeProblem(reveal.error)) : undefined}
      pending={reveal.isPending}
      submitLabel={t('lnd.households.revealDialog.submit.action')}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (reveal.isPending || identity !== undefined || problem !== undefined) return;
        reveal.mutate({ householdId: household.id, reason });
      }}
    >
      <p className="callout" data-testid="reveal-note">
        {t('lnd.households.revealDialog.note.text')}
      </p>
      {identity === undefined ? (
        <Field id="reveal-reason" label={t('lnd.households.revealDialog.reason.label')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined} hint={t('lnd.households.revealDialog.reason.help')}>
          <input id="reveal-reason" autoComplete="off" value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      ) : (
        <dl className="lnd-identity" data-testid="identity">
          <dt>{t('lnd.households.revealDialog.head.label')}</dt>
          <dd data-testid="identity-head">{identity.headName}</dd>
          <dt>{t('lnd.households.revealDialog.nationalId.label')}</dt>
          <dd data-testid="identity-national-id">{identity.nationalId ?? t('lnd.households.revealDialog.none.text')}</dd>
          <dt>{t('lnd.households.revealDialog.phone.label')}</dt>
          <dd data-testid="identity-phone">{identity.phone ?? t('lnd.households.revealDialog.none.text')}</dd>
          <dt>{t('lnd.households.revealDialog.address.label')}</dt>
          <dd data-testid="identity-address">{identity.addressText ?? t('lnd.households.revealDialog.none.text')}</dd>
        </dl>
      )}
    </DialogFrame>
  );
}
