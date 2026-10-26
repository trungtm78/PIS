import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { DialogFrame, Field, errorOf } from '../components';
import { useCoordinatorOptions, usePlaceOptions } from '../hooks';
import { todayInVietnam } from '../model';
import { useAssign, useAttachEvidence, useComplete, useDecide, useDispute, usePlan, useSubmit, useVerify } from './hooks';
import { disputeOutcomeLabel, remediationFormProblemMessage, remediationProblemMessage } from './labels';
import {
  DISPUTE_OUTCOMES,
  EMPTY_ASSIGN_FORM,
  EMPTY_COMPLETE_FORM,
  EMPTY_DECISION_FORM,
  EMPTY_DISPUTE_FORM,
  EMPTY_EVIDENCE_FORM,
  EMPTY_PLAN_FORM,
  EMPTY_VERIFY_FORM,
  assignBody,
  completeBody,
  decisionBody,
  describeRemediation,
  disputeBody,
  evidenceBody,
  planBody,
  validateAssign,
  validateComplete,
  validateDecision,
  validateDispute,
  validateEvidence,
  validatePlan,
  validateVerify,
  verifyBody,
} from './model';
import type { ActionItem, AssignForm, BoardItem, CompleteForm, DecisionForm, DisputeForm, EvidenceForm, PlanForm, RemediationFormProblem, VerifyForm } from './model';

interface Mutation {
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

/** The refusal a dialog shows once its command was refused, in words; none before. */
function refusalOf(t: ReturnType<typeof useTranslation>['t'], mutation: Mutation): string | undefined {
  if (!mutation.isError) return undefined;
  const described = describeRemediation(mutation.error);
  return remediationProblemMessage(t, described.problem, { deadline: described.deadline, remainingVnd: described.remainingVnd });
}

/** The state every dialog of these screens keeps: its form, whether the person tried to send it, and what is wrong with it. */
function useDialogForm<F>(empty: F, judge: (form: F) => Partial<Record<keyof F, RemediationFormProblem>>) {
  const [form, setForm] = useState<F>(empty);
  const [submitted, setSubmitted] = useState(false);
  const problems = judge(form);
  return { form, setForm, submitted, setSubmitted, problems, blocked: Object.keys(problems).length > 0 };
}

/** The assignment of a recommendation to a unit of the caller's scope and, when one is named, to a person, with the day it is due: not before today and not after the deadline of the conclusion. */
export function AssignDialog({ item, onClose }: { item: BoardItem; onClose(): void }) {
  const { t } = useTranslation();
  const assign = useAssign();
  const units = usePlaceOptions('UNIT', true);
  const people = useCoordinatorOptions(true);
  const today = todayInVietnam();
  const state = useDialogForm<AssignForm>(EMPTY_ASSIGN_FORM, (form) => validateAssign(form, today, item.implementationDueOn));
  const { form, setForm } = state;
  const error = (field: keyof AssignForm): string | undefined => errorOf(state.problems, state.submitted, field, (problem) => remediationFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    state.setSubmitted(true);
    if (assign.isPending || state.blocked) return;
    assign.mutate({ id: item.id, version: item.version, body: assignBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.assign.title', { code: item.code })} onClose={onClose} refusal={refusalOf(t, assign)} pending={assign.isPending} onSubmit={submit}>
      <Field id="assign-unit" label={t('aud.remediation.assign.unit.label')} error={error('ownerUnitId')} hint={t('aud.remediation.assign.unit.help')}>
        <select id="assign-unit" value={form.ownerUnitId} onChange={(event) => setForm({ ...form, ownerUnitId: event.target.value })}>
          <option value="">{t('aud.remediation.assign.unit.choose')}</option>
          {(units.data ?? []).map((unit) => (
            <option key={unit.id} value={unit.id}>
              {`${unit.code} · ${unit.name}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="assign-user" label={t('aud.remediation.assign.user.label')} error={error('ownerUserId')} hint={t('aud.remediation.assign.user.help')}>
        <select id="assign-user" value={form.ownerUserId} onChange={(event) => setForm({ ...form, ownerUserId: event.target.value })}>
          <option value="">{t('aud.remediation.assign.user.none')}</option>
          {(people.data ?? []).map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="assign-due"
        label={t('aud.remediation.assign.due.label')}
        error={error('dueOn')}
        hint={item.implementationDueOn === null ? undefined : t('aud.remediation.assign.due.help', { deadline: item.implementationDueOn })}
      >
        <input id="assign-due" type="date" min={today} {...(item.implementationDueOn === null ? {} : { max: item.implementationDueOn })} value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** An action the owner plans against a recommendation: a code used once in it, what will be done and the day. */
export function PlanDialog({ item, onClose }: { item: BoardItem; onClose(): void }) {
  const { t } = useTranslation();
  const plan = usePlan();
  const state = useDialogForm<PlanForm>(EMPTY_PLAN_FORM, validatePlan);
  const { form, setForm } = state;
  const error = (field: keyof PlanForm): string | undefined => errorOf(state.problems, state.submitted, field, (problem) => remediationFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    state.setSubmitted(true);
    if (plan.isPending || state.blocked) return;
    plan.mutate({ id: item.id, version: item.version, body: planBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.plan.title', { code: item.code })} onClose={onClose} refusal={refusalOf(t, plan)} pending={plan.isPending} onSubmit={submit}>
      <Field id="plan-code" label={t('aud.remediation.plan.code.label')} error={error('code')}>
        <input id="plan-code" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} />
      </Field>
      <Field id="plan-on" label={t('aud.remediation.plan.plannedOn.label')} error={error('plannedOn')}>
        <input id="plan-on" type="date" value={form.plannedOn} onChange={(event) => setForm({ ...form, plannedOn: event.target.value })} />
      </Field>
      <div className="wide">
        <Field id="plan-description" label={t('aud.remediation.plan.description.label')} error={error('description')}>
          <textarea id="plan-description" rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}

/** The completion of an action, with the day it was done and the document in force that shows it (BR-AUD-09). The version is the one of the action. */
export function CompleteDialog({ item, action, onClose }: { item: BoardItem; action: ActionItem; onClose(): void }) {
  const { t } = useTranslation();
  const complete = useComplete();
  const today = todayInVietnam();
  const state = useDialogForm<CompleteForm>(EMPTY_COMPLETE_FORM, (form) => validateComplete(form, today));
  const { form, setForm } = state;
  const error = (field: keyof CompleteForm): string | undefined => errorOf(state.problems, state.submitted, field, (problem) => remediationFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    state.setSubmitted(true);
    if (complete.isPending || state.blocked) return;
    complete.mutate({ id: action.id, version: action.version, body: completeBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.complete.title', { code: action.code, rec: item.code })} onClose={onClose} refusal={refusalOf(t, complete)} pending={complete.isPending} onSubmit={submit}>
      <Field id="complete-on" label={t('aud.remediation.complete.completedOn.label')} error={error('completedOn')}>
        <input id="complete-on" type="date" max={today} value={form.completedOn} onChange={(event) => setForm({ ...form, completedOn: event.target.value })} />
      </Field>
      <Field id="complete-evidence" label={t('aud.remediation.complete.evidence.label')} error={error('evidenceDocumentId')} hint={t('aud.remediation.complete.evidence.help')}>
        <input id="complete-evidence" value={form.evidenceDocumentId} onChange={(event) => setForm({ ...form, evidenceDocumentId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The report of the work for verification: the owner says the actions are done; what is still planned, and what is not yet recovered, the server tells. */
export function SubmitDialog({ item, onClose }: { item: BoardItem; onClose(): void }) {
  const { t } = useTranslation();
  const submitting = useSubmit();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (submitting.isPending) return;
    submitting.mutate({ id: item.id, version: item.version }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.submit.title', { code: item.code })} onClose={onClose} refusal={refusalOf(t, submitting)} pending={submitting.isPending} onSubmit={submit}>
      <p className="wide" data-testid="submit-note">
        {t('aud.remediation.submit.note')}
      </p>
    </DialogFrame>
  );
}

/** The explanation of an owner who holds that the recommendation should not stand: the words, and the document that carries them; the day it is due stops counting meanwhile. */
export function DisputeDialog({ item, onClose }: { item: BoardItem; onClose(): void }) {
  const { t } = useTranslation();
  const dispute = useDispute();
  const state = useDialogForm<DisputeForm>(EMPTY_DISPUTE_FORM, validateDispute);
  const { form, setForm } = state;
  const error = (field: keyof DisputeForm): string | undefined => errorOf(state.problems, state.submitted, field, (problem) => remediationFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    state.setSubmitted(true);
    if (dispute.isPending || state.blocked) return;
    dispute.mutate({ id: item.id, version: item.version, body: disputeBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.dispute.title', { code: item.code })} onClose={onClose} refusal={refusalOf(t, dispute)} pending={dispute.isPending} onSubmit={submit}>
      <div className="wide">
        <Field id="dispute-reason" label={t('aud.remediation.dispute.reason.label')} error={error('reason')} hint={t('aud.remediation.dispute.reason.help')}>
          <textarea id="dispute-reason" rows={4} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        </Field>
      </div>
      <div className="wide">
        <Field id="dispute-document" label={t('aud.remediation.dispute.document.label')} error={error('documentId')} hint={t('aud.remediation.dispute.document.help')}>
          <input id="dispute-document" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}

/** The answer of the authority to a dispute, with the document of its opinion; accepted, the recommendation goes to the verifier, rejected it goes back to work. */
export function DecisionDialog({ item, onClose }: { item: BoardItem; onClose(): void }) {
  const { t } = useTranslation();
  const decide = useDecide();
  const state = useDialogForm<DecisionForm>(EMPTY_DECISION_FORM, validateDecision);
  const { form, setForm } = state;
  const error = (field: keyof DecisionForm): string | undefined => errorOf(state.problems, state.submitted, field, (problem) => remediationFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    state.setSubmitted(true);
    if (decide.isPending || state.blocked) return;
    decide.mutate({ id: item.id, version: item.version, body: decisionBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.decision.title', { code: item.code })} onClose={onClose} refusal={refusalOf(t, decide)} pending={decide.isPending} onSubmit={submit}>
      {item.disputeReason === null ? null : (
        <p className="wide aud-words" data-testid="dispute-reason">
          {item.disputeReason}
        </p>
      )}
      <Field id="decision-outcome" label={t('aud.remediation.decision.outcome.label')} error={error('outcome')}>
        <select id="decision-outcome" value={form.outcome} onChange={(event) => setForm({ ...form, outcome: event.target.value as DecisionForm['outcome'] })}>
          <option value="">{t('aud.remediation.decision.outcome.choose')}</option>
          {DISPUTE_OUTCOMES.map((outcome) => (
            <option key={outcome} value={outcome}>
              {disputeOutcomeLabel(t, outcome)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="decision-document" label={t('aud.remediation.decision.document.label')} error={error('authorityDocumentId')} hint={t('aud.remediation.decision.document.help')}>
        <input id="decision-document" value={form.authorityDocumentId} onChange={(event) => setForm({ ...form, authorityDocumentId: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** The verification by someone who had no hand in the work: close it, naming the document it rests on when there is one, or send it back saying what is left to do. */
export function VerifyDialog({ item, onClose }: { item: BoardItem; onClose(): void }) {
  const { t } = useTranslation();
  const verify = useVerify();
  const state = useDialogForm<VerifyForm>(EMPTY_VERIFY_FORM, validateVerify);
  const { form, setForm } = state;
  const error = (field: keyof VerifyForm): string | undefined => errorOf(state.problems, state.submitted, field, (problem) => remediationFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    state.setSubmitted(true);
    if (verify.isPending || state.blocked) return;
    verify.mutate({ id: item.id, version: item.version, body: verifyBody(form) }, { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.verify.title', { code: item.code })} onClose={onClose} refusal={refusalOf(t, verify)} pending={verify.isPending} onSubmit={submit}>
      <Field id="verify-decision" label={t('aud.remediation.verify.decision.label')} error={error('decision')}>
        <select id="verify-decision" value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value as VerifyForm['decision'] })}>
          <option value="">{t('aud.remediation.verify.decision.choose')}</option>
          <option value="CLOSE">{t('aud.remediation.verify.decision.close')}</option>
          <option value="RETURN">{t('aud.remediation.verify.decision.return')}</option>
        </select>
      </Field>
      {form.decision === 'CLOSE' ? (
        <Field id="verify-basis" label={t('aud.remediation.verify.basis.label')} error={error('closureBasisDocumentId')} hint={t('aud.remediation.verify.basis.help')}>
          <input id="verify-basis" value={form.closureBasisDocumentId} onChange={(event) => setForm({ ...form, closureBasisDocumentId: event.target.value })} />
        </Field>
      ) : null}
      <div className="wide">
        <Field id="verify-comment" label={t('aud.remediation.verify.comment.label')} error={error('comment')} hint={form.decision === 'RETURN' ? t('aud.remediation.verify.comment.help') : undefined}>
          <textarea id="verify-comment" rows={3} value={form.comment} onChange={(event) => setForm({ ...form, comment: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}

/** A document in force put in the register of evidence of the recommendation or of one of its actions; the same document twice is the same row. */
export function EvidenceDialog({ item, onClose }: { item: BoardItem; onClose(): void }) {
  const { t } = useTranslation();
  const attach = useAttachEvidence();
  const state = useDialogForm<EvidenceForm>(EMPTY_EVIDENCE_FORM, validateEvidence);
  const { form, setForm } = state;
  const error = (field: keyof EvidenceForm): string | undefined => errorOf(state.problems, state.submitted, field, (problem) => remediationFormProblemMessage(t, problem));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    state.setSubmitted(true);
    if (attach.isPending || state.blocked) return;
    attach.mutate(evidenceBody(form, item.id), { onSuccess: onClose });
  };
  return (
    <DialogFrame title={t('aud.remediation.evidence.title', { code: item.code })} onClose={onClose} refusal={refusalOf(t, attach)} pending={attach.isPending} onSubmit={submit}>
      <Field id="evidence-target" label={t('aud.remediation.evidence.target.label')} error={error('target')}>
        <select id="evidence-target" value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value as EvidenceForm['target'] })}>
          <option value="RECOMMENDATION">{t('aud.remediation.evidence.target.recommendation')}</option>
          {item.actions.map((action) => (
            <option key={action.id} value={`ACTION:${action.id}`}>
              {t('aud.remediation.evidence.target.action', { code: action.code })}
            </option>
          ))}
        </select>
      </Field>
      <Field id="evidence-document" label={t('aud.remediation.evidence.document.label')} error={error('documentId')} hint={t('aud.remediation.evidence.document.help')}>
        <input id="evidence-document" value={form.documentId} onChange={(event) => setForm({ ...form, documentId: event.target.value })} />
      </Field>
      <div className="wide">
        <Field id="evidence-note" label={t('aud.remediation.evidence.note.label')} error={error('note')}>
          <textarea id="evidence-note" rows={2} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} />
        </Field>
      </div>
    </DialogFrame>
  );
}
