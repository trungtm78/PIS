import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import type { HouseholdLine } from '../household/model';
import type { PlanLine } from '../plan/model';
import type { ParcelLine, UnitOption } from '../model';
import { useAdvanceEnforcement, useStartEnforcement } from './hooks';
import { fieldLabel, refusalLabel, stepLabel } from './labels';
import { EMPTY_ADVANCE, EMPTY_START, TEXT_MAX, advanceBody, describeRefusal, moveChoices, needsDocument, startBody, validateAdvance, validateStart, vietnamToday } from './model';
import type { AdvanceField, AdvanceForm, CaseLine, StartField, StartForm } from './model';

const NONE = '—';

/** Opening a case: the parcel whose recovery was decided, the household and the plan whose payment was offered, the authority that enforces and the legal basis. The unit that answers is the unit of the household. */
export function StartDialog({
  projectId,
  parcels,
  households,
  plans,
  authorities,
  onClose,
}: {
  projectId: string;
  parcels: readonly ParcelLine[];
  households: readonly HouseholdLine[];
  plans: readonly PlanLine[];
  authorities: readonly UnitOption[];
  onClose(): void;
}) {
  const { t } = useTranslation();
  const start = useStartEnforcement();
  const today = vietnamToday();
  const [form, setForm] = useState<StartForm>(EMPTY_START);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateStart(form, today);
  const shown = (field: StartField): string | undefined => (submitted ? fieldLabel(t, problems[field]) : undefined);
  const set = (patch: Partial<StartForm>): void => setForm({ ...form, ...patch });
  const owner = households.find((household) => household.id === form.householdId)?.ownerUnitId ?? '';
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (start.isPending || Object.keys(problems).length > 0) return;
    start.mutate(startBody(form, projectId, owner), { onSuccess: onClose });
  };
  const words = { close: t('lnd.enforcement.dialog.close'), cancel: t('lnd.enforcement.dialog.cancel'), pending: t('lnd.enforcement.dialog.pending') };
  return (
    <CommandFrame
      title={t('lnd.enforcement.start.title')}
      refusal={start.isError ? refusalLabel(t, describeRefusal(start.error)) : undefined}
      pending={start.isPending}
      submitLabel={t('lnd.enforcement.start.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="enforcement-parcel" label={t('lnd.enforcement.field.parcel.label')} error={shown('parcel')} hint={parcels.length === 0 ? t('lnd.enforcement.field.parcel.none') : t('lnd.enforcement.field.parcel.hint')}>
        <select id="enforcement-parcel" value={form.parcelId} onChange={(event) => set({ parcelId: event.target.value })}>
          <option value="">{NONE}</option>
          {parcels.map((parcel) => (
            <option key={parcel.id} value={parcel.id}>
              {parcel.parcelCode}
            </option>
          ))}
        </select>
      </Field>
      <Field id="enforcement-household" label={t('lnd.enforcement.field.household.label')} error={shown('household')}>
        <select id="enforcement-household" value={form.householdId} onChange={(event) => set({ householdId: event.target.value })}>
          <option value="">{NONE}</option>
          {households.map((household) => (
            <option key={household.id} value={household.id}>
              {`${household.householdCode} ${household.headNameMasked}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="enforcement-plan" label={t('lnd.enforcement.field.plan.label')} error={shown('plan')} hint={t('lnd.enforcement.field.plan.hint')}>
        <select id="enforcement-plan" value={form.planId} onChange={(event) => set({ planId: event.target.value })}>
          <option value="">{NONE}</option>
          {plans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {`${plan.planCode} · ${t('lnd.enforcement.field.plan.revision', { revision: plan.revision })}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="enforcement-authority" label={t('lnd.enforcement.field.authority.label')} error={shown('authority')}>
        <select id="enforcement-authority" value={form.authorityUnitId} onChange={(event) => set({ authorityUnitId: event.target.value })}>
          <option value="">{NONE}</option>
          {authorities.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {`${unit.code} · ${unit.name}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="enforcement-basis" label={t('lnd.enforcement.field.basis.label')} error={shown('basis')} hint={t('lnd.enforcement.field.basis.hint', { max: TEXT_MAX })}>
        <textarea id="enforcement-basis" rows={3} value={form.legalBasis} onChange={(event) => set({ legalBasis: event.target.value })} />
      </Field>
      <Field id="enforcement-started" label={t('lnd.enforcement.field.started.label')} error={shown('startedOn')}>
        <input id="enforcement-started" type="date" max={today} value={form.startedOn} onChange={(event) => set({ startedOn: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** Moving a case to its next step, suspending it or resuming it: the fields are the ones the chosen step asks for, and the server judges the move, the document and the person again. */
export function AdvanceDialog({ line, onClose }: { line: CaseLine; onClose(): void }) {
  const { t } = useTranslation();
  const advance = useAdvanceEnforcement();
  const today = vietnamToday();
  const choices = moveChoices(line);
  const [form, setForm] = useState<AdvanceForm>({ ...EMPTY_ADVANCE, toStep: choices.length === 1 ? (choices[0] ?? '') : '' });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateAdvance(form, line, today);
  const shown = (field: AdvanceField): string | undefined => (submitted ? fieldLabel(t, problems[field]) : undefined);
  const set = (patch: Partial<AdvanceForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (advance.isPending || Object.keys(problems).length > 0) return;
    advance.mutate({ id: line.id, version: line.version, body: advanceBody(form) }, { onSuccess: onClose });
  };
  const words = { close: t('lnd.enforcement.dialog.close'), cancel: t('lnd.enforcement.dialog.cancel'), pending: t('lnd.enforcement.dialog.pending') };
  return (
    <CommandFrame
      title={t('lnd.enforcement.advance.title', { parcel: line.parcelCode })}
      refusal={advance.isError ? refusalLabel(t, describeRefusal(advance.error)) : undefined}
      pending={advance.isPending}
      submitLabel={t('lnd.enforcement.advance.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="callout" role="note" data-testid="current-step">
        {t('lnd.enforcement.advance.current', { step: stepLabel(t, line.step) })}
      </p>
      <Field id="enforcement-to" label={t('lnd.enforcement.field.to.label')} error={shown('toStep')}>
        <select id="enforcement-to" value={form.toStep} onChange={(event) => set({ toStep: event.target.value })}>
          <option value="">{NONE}</option>
          {choices.map((step) => (
            <option key={step} value={step}>
              {stepLabel(t, step)}
            </option>
          ))}
        </select>
      </Field>
      {needsDocument(form.toStep) ? (
        <Field id="enforcement-document" label={t('lnd.enforcement.field.document.label')} error={shown('document')} hint={t('lnd.enforcement.field.document.hint')}>
          <input id="enforcement-document" autoComplete="off" value={form.document} onChange={(event) => set({ document: event.target.value })} />
        </Field>
      ) : null}
      {form.toStep === 'EXECUTING' ? (
        <Field id="enforcement-planned" label={t('lnd.enforcement.field.planned.label')} error={shown('plannedOn')}>
          <input id="enforcement-planned" type="date" min={line.startedOn} value={form.plannedOn} onChange={(event) => set({ plannedOn: event.target.value })} />
        </Field>
      ) : null}
      {form.toStep === 'COMPLETED' ? (
        <Field id="enforcement-executed" label={t('lnd.enforcement.field.executed.label')} error={shown('executedOn')}>
          <input id="enforcement-executed" type="date" min={line.startedOn} max={today} value={form.executedOn} onChange={(event) => set({ executedOn: event.target.value })} />
        </Field>
      ) : null}
      {form.toStep === 'SUSPENDED' ? (
        <Field id="enforcement-reason" label={t('lnd.enforcement.field.reason.label')} error={shown('reason')} hint={t('lnd.enforcement.field.reason.hint', { max: TEXT_MAX })}>
          <textarea id="enforcement-reason" rows={3} value={form.reason} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
      ) : null}
    </CommandFrame>
  );
}
