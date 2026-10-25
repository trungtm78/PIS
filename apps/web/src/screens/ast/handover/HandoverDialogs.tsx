import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import type { ContractLine } from '../../ctr/model';
import { usePlanUnits } from '../../cap/plan-hooks';
import { CommandFrame } from '../../qms/CommandFrame';
import { useAddPunchItem, useCreateHandover, useDecideHandover, useMarkPunchItemFixed, useVerifyPunchItem, useWaivePunchItem } from './hooks';
import { decisionLabel, formProblemMessage, kindLabel, problemMessage, severityLabel, verificationLabel } from './labels';
import {
  DECISIONS,
  EMPTY_FIX,
  EMPTY_VERIFY,
  HANDOVER_KINDS,
  SEVERITIES,
  VERIFICATIONS,
  createBody,
  decisionBody,
  describeProblem,
  emptyCreate,
  emptyDecision,
  emptyItem,
  fixBody,
  itemBody,
  validateCreate,
  validateDecision,
  validateFix,
  validateItem,
  validateReason,
  validateVerify,
  vietnamToday,
} from './model';
import type { CreateForm, DecisionForm, FixForm, FormProblem, HandoverLine, ItemForm, PunchItem, VerifyForm } from './model';

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
  const words = { close: t('ast.handover.dialog.close'), cancel: t('ast.handover.dialog.cancel'), pending: t('ast.handover.dialog.pending') };
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

/** Drafting a handover of a contract that is being performed or completed to a unit of the tenant, on the minutes of the acceptance of the completion. */
export function CreateDialog({ contracts, initialContractId, onClose }: { contracts: readonly ContractLine[]; initialContractId: string; onClose(): void }) {
  const { t } = useTranslation();
  const create = useCreateHandover();
  const units = usePlanUnits(true);
  const [form, setForm] = useState<CreateForm>(emptyCreate(contracts.some((contract) => contract.id === initialContractId) ? initialContractId : ''));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateCreate(form);
  const shown = (field: keyof CreateForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<CreateForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    const contract = contracts.find((candidate) => candidate.id === form.contractId);
    if (create.isPending || Object.keys(problems).length > 0 || contract === undefined) return;
    create.mutate(createBody(form, contract.projectId), { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.handover.create.title')}
      error={create.error}
      hasError={create.isError}
      pending={create.isPending}
      submitLabel={t('ast.handover.create.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="handover-contract" label={t('ast.handover.field.contract')} error={shown('contractId')}>
        <select id="handover-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value })}>
          <option value="">{t('ast.handover.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.title === null ? contract.code : `${contract.code} · ${contract.title}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="handover-kind" label={t('ast.handover.field.kind')} error={shown('kind')}>
        <select id="handover-kind" value={form.kind} onChange={(event) => set({ kind: HANDOVER_KINDS.find((kind) => kind === event.target.value) ?? '' })}>
          <option value="">{t('ast.handover.field.kind.choose')}</option>
          {HANDOVER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="handover-no" label={t('ast.handover.field.no')} error={shown('handoverNo')}>
        <input id="handover-no" autoComplete="off" value={form.handoverNo} onChange={(event) => set({ handoverNo: event.target.value })} />
      </Field>
      {units.isError ? (
        <p className="callout warning" role="status" data-testid="units-failed">
          {t('ast.handover.field.unit.failed')}
        </p>
      ) : null}
      <Field id="handover-unit" label={t('ast.handover.field.unit')} error={shown('recipientUnitId')}>
        <select id="handover-unit" value={form.recipientUnitId} onChange={(event) => set({ recipientUnitId: event.target.value })}>
          <option value="">{t('ast.handover.field.unit.choose')}</option>
          {(units.data ?? []).map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="handover-minutes" label={t('ast.handover.field.minutes')} error={shown('qualityAcceptanceId')} hint={t('ast.handover.field.minutes.hint')}>
        <input id="handover-minutes" autoComplete="off" value={form.qualityAcceptanceId} onChange={(event) => set({ qualityAcceptanceId: event.target.value })} />
      </Field>
      <Field id="handover-planned" label={t('ast.handover.field.planned')} error={shown('plannedOn')}>
        <input id="handover-planned" type="date" value={form.plannedOn} onChange={(event) => set({ plannedOn: event.target.value })} />
      </Field>
      <Field id="handover-document" label={t('ast.handover.field.document')} error={shown('documentVersionId')} hint={t('ast.handover.field.document.hint')}>
        <input id="handover-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => set({ documentVersionId: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Putting a defect on the list: what is wrong and where, how serious, the day it is to be put right by and the contractor that answers for it. */
export function ItemDialog({ handover, onClose }: { handover: HandoverLine; onClose(): void }) {
  const { t } = useTranslation();
  const today = vietnamToday();
  const add = useAddPunchItem();
  const [form, setForm] = useState<ItemForm>(emptyItem(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateItem(form, today);
  const shown = (field: keyof ItemForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const set = (patch: Partial<ItemForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (add.isPending || Object.keys(problems).length > 0) return;
    add.mutate({ id: handover.id, version: handover.version, body: itemBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.handover.item.title', { no: handover.handoverNo })}
      error={add.error}
      hasError={add.isError}
      pending={add.isPending}
      submitLabel={t('ast.handover.item.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="item-description" label={t('ast.handover.field.description')} error={shown('description')}>
        <textarea id="item-description" rows={3} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <Field id="item-severity" label={t('ast.handover.field.severity')} error={shown('severity')} hint={t('ast.handover.field.severity.hint')}>
        <select id="item-severity" value={form.severity} onChange={(event) => set({ severity: SEVERITIES.find((severity) => severity === event.target.value) ?? '' })}>
          <option value="">{t('ast.handover.field.severity.choose')}</option>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severityLabel(t, severity)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="item-location" label={t('ast.handover.field.location')} error={shown('locationText')}>
        <input id="item-location" autoComplete="off" value={form.locationText} onChange={(event) => set({ locationText: event.target.value })} />
      </Field>
      <Field id="item-due" label={t('ast.handover.field.due')} error={shown('dueOn')}>
        <input id="item-due" type="date" value={form.dueOn} onChange={(event) => set({ dueOn: event.target.value })} />
      </Field>
      <Field id="item-contractor" label={t('ast.handover.field.contractor')} error={shown('responsibleContractorId')} hint={t('ast.handover.field.contractor.hint')}>
        <input id="item-contractor" autoComplete="off" value={form.responsibleContractorId} onChange={(event) => set({ responsibleContractorId: event.target.value })} />
      </Field>
      <Field id="item-photo" label={t('ast.handover.field.photo')} error={shown('defectPhotoId')} hint={t('ast.handover.field.photo.hint')}>
        <input id="item-photo" autoComplete="off" value={form.defectPhotoId} onChange={(event) => set({ defectPhotoId: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Saying an item is put right: a clean photo of the contract or a clean document, and a note of what was done. */
export function FixDialog({ handover, item, onClose }: { handover: HandoverLine; item: PunchItem; onClose(): void }) {
  const { t } = useTranslation();
  const fix = useMarkPunchItemFixed();
  const [form, setForm] = useState<FixForm>(EMPTY_FIX);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateFix(form);
  const shown = (field: keyof FixForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (fix.isPending || Object.keys(problems).length > 0) return;
    fix.mutate({ id: item.id, body: fixBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.handover.fix.title', { no: handover.handoverNo, item: item.itemNo })}
      error={fix.error}
      hasError={fix.isError}
      pending={fix.isPending}
      submitLabel={t('ast.handover.fix.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="fix-item">
        {item.description}
      </p>
      <Field id="fix-photo" label={t('ast.handover.field.fixPhoto')} error={shown('photoId')} hint={t('ast.handover.field.fixPhoto.hint')}>
        <input id="fix-photo" autoComplete="off" value={form.photoId} onChange={(event) => setForm({ ...form, photoId: event.target.value })} />
      </Field>
      <Field id="fix-document" label={t('ast.handover.field.fixDocument')} error={shown('documentVersionId')}>
        <input id="fix-document" autoComplete="off" value={form.documentVersionId} onChange={(event) => setForm({ ...form, documentVersionId: event.target.value })} />
      </Field>
      <Field id="fix-note" label={t('ast.handover.field.fixNote')} error={shown('note')}>
        <textarea id="fix-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Verifying an item that was put right, or reopening it; what the contractor said was done is shown above the verdict. */
export function VerifyDialog({ handover, item, onClose }: { handover: HandoverLine; item: PunchItem; onClose(): void }) {
  const { t } = useTranslation();
  const verify = useVerifyPunchItem();
  const [form, setForm] = useState<VerifyForm>(EMPTY_VERIFY);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateVerify(form);
  const shown = (field: keyof VerifyForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    const outcome = form.outcome;
    if (verify.isPending || outcome === '' || Object.keys(problems).length > 0) return;
    verify.mutate({ id: item.id, body: { outcome, note: form.note.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.handover.verify.title', { no: handover.handoverNo, item: item.itemNo })}
      error={verify.error}
      hasError={verify.isError}
      pending={verify.isPending}
      submitLabel={t('ast.handover.verify.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="verify-item">
        {item.description}
      </p>
      {item.fixedNote === null ? null : (
        <p className="callout" data-testid="verify-fixed">
          {t('ast.handover.verify.fixed', { note: item.fixedNote })}
        </p>
      )}
      <Field id="verify-outcome" label={t('ast.handover.field.outcome')} error={shown('outcome')}>
        <select id="verify-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: VERIFICATIONS.find((outcome) => outcome === event.target.value) ?? '' })}>
          <option value="">{t('ast.handover.field.outcome.choose')}</option>
          {VERIFICATIONS.map((outcome) => (
            <option key={outcome} value={outcome}>
              {verificationLabel(t, outcome)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="verify-note" label={t('ast.handover.field.verifyNote')} error={shown('note')}>
        <textarea id="verify-note" rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
      </Field>
    </Frame>
  );
}

/** Waiving an item that is not critical: a reason, kept with the item. */
export function WaiveDialog({ handover, item, onClose }: { handover: HandoverLine; item: PunchItem; onClose(): void }) {
  const { t } = useTranslation();
  const waive = useWaivePunchItem();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = validateReason(reason);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (waive.isPending || problem !== undefined) return;
    waive.mutate({ id: item.id, body: { waiver_reason: reason.trim() } }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.handover.waive.title', { no: handover.handoverNo, item: item.itemNo })}
      error={waive.error}
      hasError={waive.isError}
      pending={waive.isPending}
      submitLabel={t('ast.handover.waive.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="sub" data-testid="waive-item">
        {item.description}
      </p>
      <Field
        id="waive-reason"
        label={t('ast.handover.field.waiverReason')}
        error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined}
        hint={t('ast.handover.field.waiverReason.hint')}
      >
        <textarea id="waive-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Frame>
  );
}

/** The decision of the receiving unit: accept (with the as-built dossier), give the handover back for more work on the list, or reject it. */
export function DecisionDialog({ handover, onClose }: { handover: HandoverLine; onClose(): void }) {
  const { t } = useTranslation();
  const decide = useDecideHandover();
  const [form, setForm] = useState<DecisionForm>(emptyDecision(handover));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDecision(form);
  const shown = (field: keyof DecisionForm): string | undefined => {
    const problem: FormProblem | undefined = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const allowed = DECISIONS.filter((decision) => (decision === 'approve' ? handover.allowed.approve : decision === 'return' ? handover.allowed.return : handover.allowed.reject));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ id: handover.id, version: handover.version, body: decisionBody(form) }, { onSuccess: onClose });
  };
  return (
    <Frame
      title={t('ast.handover.decide.title', { no: handover.handoverNo })}
      error={decide.error}
      hasError={decide.isError}
      pending={decide.isPending}
      submitLabel={t('ast.handover.decide.submit')}
      onSubmit={send}
      onClose={onClose}
    >
      {handover.openCriticalCount > 0 ? (
        <p className="callout warning" role="status" data-testid="decide-critical">
          {t('ast.handover.critical.notice', { count: handover.openCriticalCount })}
        </p>
      ) : null}
      <Field id="decide-decision" label={t('ast.handover.field.decision')} error={shown('decision')}>
        <select id="decide-decision" value={form.decision} onChange={(event) => setForm({ ...form, decision: allowed.find((decision) => decision === event.target.value) ?? '' })}>
          <option value="">{t('ast.handover.field.decision.choose')}</option>
          {allowed.map((decision) => (
            <option key={decision} value={decision}>
              {decisionLabel(t, decision)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="decide-reason" label={t('ast.handover.field.reason')} error={shown('reason')}>
        <textarea id="decide-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
      <Field id="decide-as-built" label={t('ast.handover.field.asBuilt')} error={shown('asBuilt')} hint={t('ast.handover.field.asBuilt.hint')}>
        <input id="decide-as-built" autoComplete="off" value={form.asBuilt} onChange={(event) => setForm({ ...form, asBuilt: event.target.value })} />
      </Field>
      <Field id="decide-manual" label={t('ast.handover.field.manual')} error={shown('manual')}>
        <input id="decide-manual" autoComplete="off" value={form.manual} onChange={(event) => setForm({ ...form, manual: event.target.value })} />
      </Field>
      <Field id="decide-certificate" label={t('ast.handover.field.certificate')} error={shown('certificate')}>
        <input id="decide-certificate" autoComplete="off" value={form.certificate} onChange={(event) => setForm({ ...form, certificate: event.target.value })} />
      </Field>
      <Field id="decide-evidence" label={t('ast.handover.field.evidence')} error={shown('evidence')} hint={t('ast.handover.field.evidence.hint')}>
        <textarea id="decide-evidence" rows={2} value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} />
      </Field>
    </Frame>
  );
}
