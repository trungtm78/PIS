import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { usePlanUnits } from '../../cap/plan-hooks';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import type { HandoverLine } from '../handover/model';
import { useRegisterAsset, useTransferAsset } from './hooks';
import { basisLabel, formProblemMessage, problemMessage } from './labels';
import { VALUE_BASES, describeProblem, emptyRegister, emptyTransfer, registerBody, transferBody, validateRegister, validateTransfer, vietnamToday } from './model';
import type { AssetLine, RegisterForm, TransferForm } from './model';

interface FrameProps {
  title: string;
  error: unknown;
  hasError: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit(event: FormEvent): void;
  onClose(): void;
  children: ReactNode;
}

/** The frame the commands are asked in: the title, the refusal of the server in words, the fields and the two buttons. */
function Frame({ title, error, hasError, pending, submitLabel, onSubmit, onClose, children }: FrameProps) {
  const { t, locale } = useTranslation();
  const words = { close: t('ast.asset.dialog.close'), cancel: t('ast.asset.dialog.cancel'), pending: t('ast.asset.dialog.pending') };
  return (
    <CommandFrame
      title={title}
      refusal={hasError ? problemMessage(t, describeProblem(error), locale) : undefined}
      pending={pending}
      submitLabel={submitLabel}
      words={words}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      {children}
    </CommandFrame>
  );
}

/** Registering an asset of an accepted handover: its code, its name, the unit that receives it and the value it is booked at; the assets of a contract never come to more than the contract is worth. */
export function RegisterDialog({ handovers, initialHandoverId, onClose }: { handovers: readonly HandoverLine[]; initialHandoverId: string; onClose(): void }) {
  const { t } = useTranslation();
  const register = useRegisterAsset();
  const units = usePlanUnits(true);
  const [form, setForm] = useState<RegisterForm>(emptyRegister(handovers.some((handover) => handover.id === initialHandoverId) ? initialHandoverId : ''));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRegister(form);
  const shown = (field: keyof RegisterForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<RegisterForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    const handover = handovers.find((candidate) => candidate.id === form.handoverId);
    if (register.isPending || Object.keys(problems).length > 0 || handover === undefined) return;
    register.mutate(registerBody(form, handover.projectId), { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.asset.register.title')}
      error={register.error}
      hasError={register.isError}
      pending={register.isPending}
      submitLabel={t('ast.asset.register.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="asset-handover" label={t('ast.asset.field.handover')} error={shown('handoverId')}>
        <select id="asset-handover" value={form.handoverId} onChange={(event) => set({ handoverId: event.target.value })}>
          <option value="">{t('ast.asset.field.handover.choose')}</option>
          {handovers.map((handover) => (
            <option key={handover.id} value={handover.id}>
              {`${handover.handoverNo} · ${handover.contract.code}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="asset-code" label={t('ast.asset.field.code')} error={shown('assetCode')} hint={t('ast.asset.field.code.hint')}>
        <input id="asset-code" autoComplete="off" value={form.assetCode} onChange={(event) => set({ assetCode: event.target.value })} />
      </Field>
      <Field id="asset-name" label={t('ast.asset.field.name')} error={shown('name')}>
        <input id="asset-name" autoComplete="off" value={form.name} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      {units.isError ? (
        <p className="callout warning" role="status" data-testid="units-failed">
          {t('ast.asset.field.unit.failed')}
        </p>
      ) : null}
      <Field id="asset-unit" label={t('ast.asset.field.unit')} error={shown('recipientUnitId')}>
        <select id="asset-unit" value={form.recipientUnitId} onChange={(event) => set({ recipientUnitId: event.target.value })}>
          <option value="">{t('ast.asset.field.unit.choose')}</option>
          {(units.data ?? []).map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="asset-value" label={t('ast.asset.field.value')} error={shown('valueVnd')} hint={t('ast.asset.field.value.hint')}>
        <input id="asset-value" inputMode="numeric" autoComplete="off" value={form.valueVnd} onChange={(event) => set({ valueVnd: event.target.value })} />
      </Field>
      <Field id="asset-basis" label={t('ast.asset.field.basis')} error={shown('valueBasis')}>
        <select id="asset-basis" value={form.valueBasis} onChange={(event) => set({ valueBasis: VALUE_BASES.find((basis) => basis === event.target.value) ?? '' })}>
          <option value="">{t('ast.asset.field.basis.choose')}</option>
          {VALUE_BASES.map((basis) => (
            <option key={basis} value={basis}>
              {basisLabel(t, basis)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="asset-funding" label={t('ast.asset.field.funding')} error={shown('fundingOrigin')}>
        <input id="asset-funding" autoComplete="off" value={form.fundingOrigin} onChange={(event) => set({ fundingOrigin: event.target.value })} />
      </Field>
      <Field id="asset-warranty" label={t('ast.asset.field.warranty')} error={shown('warrantyUntil')}>
        <input id="asset-warranty" type="date" value={form.warrantyUntil} onChange={(event) => set({ warrantyUntil: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Transferring a registered asset to the unit that operates it: the day, the dossier of the commissioning, and the code the asset has in the system of public assets, typed by hand. */
export function TransferDialog({ asset, onClose }: { asset: AssetLine; onClose(): void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const transfer = useTransferAsset();
  const [form, setForm] = useState<TransferForm>(emptyTransfer(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateTransfer(form, today);
  const shown = (field: keyof TransferForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (transfer.isPending || Object.keys(problems).length > 0) return;
    transfer.mutate({ id: asset.id, version: asset.version, body: transferBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.asset.transfer.title', { code: asset.assetCode })}
      error={transfer.error}
      hasError={transfer.isError}
      pending={transfer.isPending}
      submitLabel={t('ast.asset.transfer.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="transfer-day" label={t('ast.asset.field.transferDay')} error={shown('transferredOn')}>
        <input id="transfer-day" type="date" value={form.transferredOn} onChange={(event) => setForm({ ...form, transferredOn: event.target.value })} />
      </Field>
      <Field id="transfer-document" label={t('ast.asset.field.commissioning')} error={shown('documentVersionId')} hint={t('ast.asset.field.commissioning.hint')}>
        <input id="transfer-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />
      </Field>
      <Field id="transfer-external" label={t('ast.asset.field.external')} error={shown('externalAssetId')} hint={t('ast.asset.field.external.hint')}>
        <input id="transfer-external" autoComplete="off" value={form.externalAssetId} onChange={(event) => setForm({ ...form, externalAssetId: event.target.value })} />
      </Field>
    </Frame>
  );
}
