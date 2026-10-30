import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { CommandFrame } from '../../qms/CommandFrame';
import { Field } from '../components';
import { vietnamDay } from '../guarantee-model';
import { useApprove, useConfirm, useEvaluate, useRecord } from './hooks';
import {
  criterionLabel,
  formProblemMessage,
  kindLabel,
  penaltyLabel,
  problemMessage,
  ratingLabel,
  severityLabel,
  violationKindLabel,
} from './labels';
import {
  CRITERIA,
  EVALUATION_KINDS,
  PENALTY_KINDS,
  SEVERITIES,
  VIOLATION_KINDS,
  approvalBody,
  approvalProblem,
  confirmationBody,
  describeProblem,
  emptyConfirmation,
  emptyEvaluation,
  emptyViolation,
  evaluationBody,
  previewOf,
  scoresOf,
  validateConfirmation,
  validateEvaluation,
  validateViolation,
  violationBody,
} from './model';
import type { ConfirmForm, ContractOption, EvaluateForm, EvaluationKind, EvaluationLine, FormProblem, PenaltyKind, RecordForm, Rule, Severity, ViolationKind, ViolationLine } from './model';

function useWords() {
  const { t } = useTranslation();
  return { close: t('ctr.scorecard.dialog.close'), cancel: t('ctr.scorecard.dialog.cancel'), pending: t('ctr.scorecard.dialog.pending') };
}

/** The error under a field, shown once the person has tried to send. */
function useShown(submitted: boolean) {
  const { t } = useTranslation();
  return (problem: FormProblem | undefined): string | undefined => (submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined);
}

/**
 * A new evaluation of the contractor on one of the contracts the caller may evaluate: the kind, the period and the five scores. The overall score and the rating that the rule gives are shown as the scores are typed, and are the
 * figures the server keeps; it judges the kind against the state of the contract and refuses a second evaluation of the same period while one waits.
 */
export function EvaluateDialog({ contracts, rule, onClose }: { contracts: readonly ContractOption[]; rule: Rule; onClose(): void }) {
  const { t } = useTranslation();
  const evaluate = useEvaluate();
  const words = useWords();
  const [form, setForm] = useState<EvaluateForm>(() => emptyEvaluation(contracts.length === 1 ? (contracts[0]?.id ?? '') : ''));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateEvaluation(form);
  const shown = useShown(submitted);
  const scores = scoresOf(form);
  const preview = scores === undefined ? undefined : previewOf(scores, rule);
  const set = (patch: Partial<EvaluateForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (evaluate.isPending || Object.keys(problems).length > 0) return;
    evaluate.mutate({ contractId: form.contractId, body: evaluationBody(form) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('ctr.scorecard.evaluate.title')}
      refusal={evaluate.isError ? problemMessage(t, describeProblem(evaluate.error)) : undefined}
      pending={evaluate.isPending}
      submitLabel={t('ctr.scorecard.evaluate.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="evaluate-contract" label={t('ctr.scorecard.field.contract')} error={shown(problems.contractId)}>
        <select id="evaluate-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value })}>
          <option value="">{t('ctr.scorecard.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.code}
            </option>
          ))}
        </select>
      </Field>
      <Field id="evaluate-kind" label={t('ctr.scorecard.field.kind')} error={undefined}>
        <select id="evaluate-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value as EvaluationKind })}>
          {EVALUATION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="evaluate-period" label={t('ctr.scorecard.field.period')} error={shown(problems.period)} hint={t('ctr.scorecard.field.period.hint')}>
        <input id="evaluate-period" autoComplete="off" value={form.period} onChange={(event) => set({ period: event.target.value })} />
      </Field>
      {CRITERIA.map((criterion) => (
        <Field key={criterion} id={`evaluate-${criterion}`} label={t('ctr.scorecard.field.score', { criterion: criterionLabel(t, criterion), weight: rule.weights[criterion] })} error={shown(problems[criterion])}>
          <input id={`evaluate-${criterion}`} inputMode="numeric" autoComplete="off" value={form.scores[criterion]} onChange={(event) => set({ scores: { ...form.scores, [criterion]: event.target.value } })} />
        </Field>
      ))}
      <p className="callout" role="status" data-testid="preview">
        {preview === undefined ? t('ctr.scorecard.preview.none') : t('ctr.scorecard.preview.value', { score: preview.overall, rating: ratingLabel(t, preview.rating) })}
      </p>
      <Field id="evaluate-remarks" label={t('ctr.scorecard.field.remarks')} error={shown(problems.remarks)}>
        <textarea id="evaluate-remarks" rows={3} value={form.remarks} onChange={(event) => set({ remarks: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** The approval of an evaluation at the version read, with a note; whoever made the evaluation is refused by the server. */
export function ApproveDialog({ evaluation, onClose }: { evaluation: EvaluationLine; onClose(): void }) {
  const { t } = useTranslation();
  const approve = useApprove();
  const words = useWords();
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const shown = useShown(submitted);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (approve.isPending || approvalProblem(note) !== undefined) return;
    approve.mutate({ id: evaluation.id, version: evaluation.version, body: approvalBody(note) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('ctr.scorecard.approve.title', { contract: evaluation.contractCode, period: evaluation.periodLabel })}
      refusal={approve.isError ? problemMessage(t, describeProblem(approve.error)) : undefined}
      pending={approve.isPending}
      submitLabel={t('ctr.scorecard.approve.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="callout" role="note" data-testid="approving">
        {t('ctr.scorecard.approve.summary', { score: evaluation.overallScore, rating: ratingLabel(t, evaluation.rating) })}
      </p>
      <Field id="approve-note" label={t('ctr.scorecard.field.note')} error={shown(approvalProblem(note))}>
        <textarea id="approve-note" rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
    </CommandFrame>
  );
}

/** A violation recorded on one of the contracts the caller may record on; it waits for another person to confirm it. */
export function RecordDialog({ contracts, onClose }: { contracts: readonly ContractOption[]; onClose(): void }) {
  const { t } = useTranslation();
  const record = useRecord();
  const words = useWords();
  const [form, setForm] = useState<RecordForm>(() => emptyViolation(contracts.length === 1 ? (contracts[0]?.id ?? '') : ''));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateViolation(form, vietnamDay(new Date()));
  const shown = useShown(submitted);
  const set = (patch: Partial<RecordForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ contractId: form.contractId, body: violationBody(form) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('ctr.scorecard.record.title')}
      refusal={record.isError ? problemMessage(t, describeProblem(record.error)) : undefined}
      pending={record.isPending}
      submitLabel={t('ctr.scorecard.record.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="record-contract" label={t('ctr.scorecard.field.contract')} error={shown(problems.contractId)}>
        <select id="record-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value })}>
          <option value="">{t('ctr.scorecard.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {contract.code}
            </option>
          ))}
        </select>
      </Field>
      <Field id="record-kind" label={t('ctr.scorecard.field.violationKind')} error={undefined}>
        <select id="record-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value as ViolationKind })}>
          {VIOLATION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {violationKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="record-severity" label={t('ctr.scorecard.field.severity')} error={undefined}>
        <select id="record-severity" value={form.severity} onChange={(event) => set({ severity: event.target.value as Severity })}>
          {SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {severityLabel(t, severity)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="record-day" label={t('ctr.scorecard.field.occurredOn')} error={shown(problems.occurredOn)} hint={t('ctr.scorecard.field.occurredOn.hint')}>
        <input id="record-day" autoComplete="off" value={form.occurredOn} onChange={(event) => set({ occurredOn: event.target.value })} />
      </Field>
      <Field id="record-description" label={t('ctr.scorecard.field.description')} error={shown(problems.description)}>
        <textarea id="record-description" rows={3} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <Field id="record-evidence" label={t('ctr.scorecard.field.evidence')} error={shown(problems.evidence)} hint={t('ctr.scorecard.field.evidence.hint')}>
        <input id="record-evidence" autoComplete="off" value={form.evidence} onChange={(event) => set({ evidence: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** The confirmation of a violation with its sanction: a sanction needs the document that decides it, and an amount belongs to liquidated damages alone. */
export function ConfirmDialog({ violation, onClose }: { violation: ViolationLine; onClose(): void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const words = useWords();
  const [form, setForm] = useState<ConfirmForm>(() => emptyConfirmation(violation));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateConfirmation(form);
  const shown = useShown(submitted);
  const set = (patch: Partial<ConfirmForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (confirm.isPending || Object.keys(problems).length > 0) return;
    confirm.mutate({ id: violation.id, version: violation.version, body: confirmationBody(form) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('ctr.scorecard.confirm.title', { contract: violation.contractCode, kind: violationKindLabel(t, violation.kind) })}
      refusal={confirm.isError ? problemMessage(t, describeProblem(confirm.error)) : undefined}
      pending={confirm.isPending}
      submitLabel={t('ctr.scorecard.confirm.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="confirm-penalty" label={t('ctr.scorecard.field.penalty')} error={undefined}>
        <select id="confirm-penalty" value={form.penaltyKind} onChange={(event) => set({ penaltyKind: event.target.value as PenaltyKind })}>
          {PENALTY_KINDS.map((penalty) => (
            <option key={penalty} value={penalty}>
              {penaltyLabel(t, penalty)}
            </option>
          ))}
        </select>
      </Field>
      {form.penaltyKind === 'LIQUIDATED_DAMAGES' ? (
        <Field id="confirm-amount" label={t('ctr.scorecard.field.amount')} error={shown(problems.amount)}>
          <input id="confirm-amount" inputMode="numeric" autoComplete="off" value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
        </Field>
      ) : null}
      <Field id="confirm-decision" label={t('ctr.scorecard.field.decision')} error={shown(problems.decision)} hint={t('ctr.scorecard.field.decision.hint')}>
        <input id="confirm-decision" autoComplete="off" value={form.decision} onChange={(event) => set({ decision: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
