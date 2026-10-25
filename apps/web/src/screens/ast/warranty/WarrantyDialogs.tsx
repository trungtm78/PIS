import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useAssets } from '../asset/hooks';
import type { HandoverLine } from '../handover/model';
import { useCloseWarranty, useCreateWarranty } from './hooks';
import { formProblemMessage, gradeLabel, problemMessage } from './labels';
import { CONSTRUCTION_GRADES, closeBody, createBody, describeProblem, emptyClose, emptyCreate, validateClose, validateCreate } from './model';
import type { CloseForm, ConstructionGrade, CreateForm, WarrantyLine } from './model';

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
  const { t } = useTranslation();
  const words = { close: t('ast.warranty.dialog.close'), cancel: t('ast.warranty.dialog.cancel'), pending: t('ast.warranty.dialog.pending') };
  return (
    <CommandFrame
      title={title}
      refusal={hasError ? problemMessage(t, describeProblem(error)) : undefined}
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

/**
 * Creating the warranty obligation of an accepted handover: what it covers (the whole handover or one of its assets), the day it starts, its term in months and the grade of the work, which decides
 * the shortest term the rule allows, and what covers it: a warranty guarantee of the contract, an amount held back, or both. The server judges the term against the rule again.
 */
export function CreateDialog({ handovers, initialHandoverId, onClose }: { handovers: readonly HandoverLine[]; initialHandoverId: string; onClose(): void }) {
  const { t } = useTranslation();
  const create = useCreateWarranty();
  const assets = useAssets('');
  const [form, setForm] = useState<CreateForm>(emptyCreate(handovers.some((handover) => handover.id === initialHandoverId) ? initialHandoverId : ''));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateCreate(form);
  const shown = (field: keyof CreateForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<CreateForm>): void => setForm({ ...form, ...patch });
  const handoverAssets = (assets.data ?? []).filter((asset) => asset.handover.id === form.handoverId);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    const handover = handovers.find((candidate) => candidate.id === form.handoverId);
    if (create.isPending || Object.keys(problems).length > 0 || handover === undefined) return;
    create.mutate(createBody(form, handover.contract.id), { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.warranty.create.title')}
      error={create.error}
      hasError={create.isError}
      pending={create.isPending}
      submitLabel={t('ast.warranty.create.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="warranty-handover" label={t('ast.warranty.field.handover')} error={shown('handoverId')}>
        <select id="warranty-handover" value={form.handoverId} onChange={(event) => set({ handoverId: event.target.value, assetId: '' })}>
          <option value="">{t('ast.warranty.field.handover.choose')}</option>
          {handovers.map((handover) => (
            <option key={handover.id} value={handover.id}>
              {`${handover.handoverNo} · ${handover.contract.code}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="warranty-asset" label={t('ast.warranty.field.asset')} error={shown('assetId')}>
        <select id="warranty-asset" value={form.assetId} onChange={(event) => set({ assetId: event.target.value })}>
          <option value="">{t('ast.warranty.field.asset.whole')}</option>
          {handoverAssets.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {`${asset.assetCode} · ${asset.name ?? ''}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="warranty-scope" label={t('ast.warranty.field.scope')} error={shown('scope')}>
        <textarea id="warranty-scope" rows={3} value={form.scope} onChange={(event) => set({ scope: event.target.value })} />
      </Field>
      <Field id="warranty-starts" label={t('ast.warranty.field.starts')} error={shown('startsOn')}>
        <input id="warranty-starts" type="date" value={form.startsOn} onChange={(event) => set({ startsOn: event.target.value })} />
      </Field>
      <Field id="warranty-period" label={t('ast.warranty.field.period')} error={shown('periodMonths')} hint={t('ast.warranty.field.period.hint')}>
        <input id="warranty-period" inputMode="numeric" autoComplete="off" value={form.periodMonths} onChange={(event) => set({ periodMonths: event.target.value })} />
      </Field>
      <Field id="warranty-grade" label={t('ast.warranty.field.grade')} error={shown('grade')} hint={t('ast.warranty.field.grade.hint')}>
        <select id="warranty-grade" value={form.grade} onChange={(event) => set({ grade: CONSTRUCTION_GRADES.find((grade): grade is ConstructionGrade => grade === event.target.value) ?? '' })}>
          <option value="">{gradeLabel(t, null)}</option>
          {CONSTRUCTION_GRADES.map((grade) => (
            <option key={grade} value={grade}>
              {gradeLabel(t, grade)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="warranty-guarantee" label={t('ast.warranty.field.guarantee')} error={shown('guaranteeId')} hint={t('ast.warranty.field.guarantee.hint')}>
        <input id="warranty-guarantee" autoComplete="off" value={form.guaranteeId} onChange={(event) => set({ guaranteeId: event.target.value })} />
      </Field>
      <Field id="warranty-retention" label={t('ast.warranty.field.retention')} error={shown('retentionVnd')} hint={t('ast.warranty.field.retention.hint')}>
        <input id="warranty-retention" inputMode="numeric" autoComplete="off" value={form.retentionVnd} onChange={(event) => set({ retentionVnd: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Closing an obligation that has run out: the retention and the warranty guarantee of the contract can be released once it is closed, and only while no claim is open. */
export function CloseDialog({ warranty, onClose }: { warranty: WarrantyLine; onClose(): void }) {
  const { t } = useTranslation();
  const close = useCloseWarranty();
  const [form, setForm] = useState<CloseForm>(emptyClose());
  const [submitted, setSubmitted] = useState(false);
  const problems = validateClose(form);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (close.isPending || Object.keys(problems).length > 0) return;
    close.mutate({ id: warranty.id, body: closeBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.warranty.close.title', { scope: warranty.scope })}
      error={close.error}
      hasError={close.isError}
      pending={close.isPending}
      submitLabel={t('ast.warranty.close.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="callout" role="note" data-testid="close-notice">
        {t('ast.warranty.close.notice')}
      </p>
      <Field id="warranty-note" label={t('ast.warranty.field.note')} error={submitted && problems.note !== undefined ? formProblemMessage(t, problems.note) : undefined}>
        <textarea id="warranty-note" rows={3} value={form.note} onChange={(event) => setForm({ note: event.target.value })} />
      </Field>
    </Frame>
  );
}
