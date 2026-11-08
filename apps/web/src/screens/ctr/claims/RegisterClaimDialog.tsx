import { useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from './components';
import { describeProblem, formProblemText, todayInVietnam } from './common';
import type { Problem } from './common';
import { useContractChoices, useRegisterClaim, useReloadRegisters } from './hooks';
import { kindLabel, sideLabel } from './labels';
import { KINDS_BY_SIDE, SIDES, emptyRegister, registerBody, validateRegister } from './model';
import type { FormErrors, RegisterForm, Side } from './model';
import { RegisterDialog } from './RegisterDialog';

export interface RegisterClaimDialogProps {
  initialContract: string;
  /** The contract is already chosen (the claim is registered from a contract page): the choice is not offered. */
  fixedContract?: boolean;
  onClose: () => void;
  /** Called with the title of the claim after the command succeeded. */
  onDone: (title: string) => void;
}

/** Registers a claim: the side and the kind that go together, the event, the day the claimant became aware of it (the day the notice limit counts from) and, if known, what is asked for. */
export function RegisterClaimDialog({ initialContract, fixedContract = false, onClose, onDone }: RegisterClaimDialogProps) {
  const { t } = useTranslation();
  const today = todayInVietnam();
  const contracts = useContractChoices();
  const register = useRegisterClaim();
  const reload = useReloadRegisters();
  const [form, setForm] = useState<RegisterForm>(emptyRegister(today, initialContract));
  const [errors, setErrors] = useState<FormErrors<RegisterForm>>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const set = (patch: Partial<RegisterForm>): void => setForm((current) => ({ ...current, ...patch }));
  const message = (field: keyof RegisterForm): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : formProblemText(t, found);
  };
  const contract = (contracts.data ?? []).find((entry) => entry.id === form.contractId);

  const submit = (): void => {
    if (sending.current) return;
    const found = validateRegister(form, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    sending.current = true;
    setProblem(undefined);
    register.mutate(
      { contractId: form.contractId, body: registerBody(form) },
      {
        onSuccess: () => {
          sending.current = false;
          onDone(form.title.trim());
        },
        onError: (error) => {
          sending.current = false;
          setProblem(describeProblem(error));
        },
      },
    );
  };

  return (
    <RegisterDialog
      title={t('ctrClaim.registerDialog.title')}
      context={[{ label: t('ctrClaim.registerDialog.contract.label'), value: contract?.code ?? t('ctrClaim.registerDialog.noContract.text') }]}
      confirmLabel={t('ctrClaim.registerDialog.confirm.action')}
      pending={register.isPending}
      problem={problem}
      onSubmit={submit}
      onCancel={onClose}
      onReload={() => void reload()}
    >
      <p className="sub">{t('ctrClaim.registerDialog.effect.text')}</p>
      {!fixedContract && (
        <Field id="claim-contract" label={t('ctrClaim.registerDialog.contract.label')} error={message('contractId')}>
          <select id="claim-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value })}>
            <option value="">{t('ctrClaim.registerDialog.pick.option')}</option>
            {(contracts.data ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field id="claim-side" label={t('ctrClaim.registerDialog.side.label')} error={undefined}>
        <select
          id="claim-side"
          value={form.side}
          onChange={(event) => {
            const side = event.target.value as Side;
            set({ side, kind: KINDS_BY_SIDE[side][0] ?? '' });
          }}
        >
          {SIDES.map((side) => (
            <option key={side} value={side}>
              {sideLabel(t, side)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="claim-kind" label={t('ctrClaim.registerDialog.kind.label')} error={message('kind')}>
        <select id="claim-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value })}>
          {KINDS_BY_SIDE[form.side].map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="claim-title" label={t('ctrClaim.registerDialog.claimTitle.label')} error={message('title')}>
        <input id="claim-title" type="text" value={form.title} onChange={(event) => set({ title: event.target.value })} />
      </Field>
      <Field id="claim-description" label={t('ctrClaim.registerDialog.description.label')} error={message('description')}>
        <textarea id="claim-description" rows={3} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <Field id="claim-event" label={t('ctrClaim.registerDialog.eventOn.label')} error={message('eventOn')}>
        <input id="claim-event" type="date" value={form.eventOn} max={today} onChange={(event) => set({ eventOn: event.target.value })} />
      </Field>
      <Field id="claim-awareness" label={t('ctrClaim.registerDialog.awarenessOn.label')} hint={t('ctrClaim.registerDialog.awarenessOn.hint')} error={message('awarenessOn')}>
        <input id="claim-awareness" type="date" value={form.awarenessOn} max={today} onChange={(event) => set({ awarenessOn: event.target.value })} />
      </Field>
      <Field id="claim-amount" label={t('ctrClaim.registerDialog.amount.label')} hint={t('ctrClaim.registerDialog.amount.hint')} error={message('amount')}>
        <input id="claim-amount" type="text" inputMode="numeric" value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field id="claim-days" label={t('ctrClaim.registerDialog.days.label')} error={message('days')}>
        <input id="claim-days" type="text" inputMode="numeric" value={form.days} onChange={(event) => set({ days: event.target.value })} />
      </Field>
    </RegisterDialog>
  );
}
