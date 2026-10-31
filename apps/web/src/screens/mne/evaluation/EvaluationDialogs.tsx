import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useDecideEvaluation, usePlanEvaluation, useSubmitEvaluation } from './hooks';
import type { ProjectChoice } from './hooks';
import { conclusionLabel, evaluatorLabel, fieldProblem, kindLabel, refusalLabel } from './labels';
import { CONCLUSIONS, EMPTY_DECIDE, EMPTY_PLAN, EVALUATOR_KINDS, KINDS, NAME_MAX, TEXT_MAX, decideBody, describeRefusal, findingLine, planBody, submitBody, submitFormOf, validateDecide, validatePlan, validateSubmit, vietnamToday } from './model';
import type { DecideField, DecideForm, Evaluation, PlanField, PlanForm, SubmitField, SubmitForm } from './model';

const NONE = '—';

function useWords() {
  const { t } = useTranslation();
  return { close: t('mne.evaluation.dialog.close'), cancel: t('mne.evaluation.dialog.cancel'), pending: t('mne.evaluation.dialog.pending') };
}

/** Planning an evaluation: the project, the kind that its stage allows (the server refuses another, naming the stage), who evaluates, the scope and the day planned. */
export function PlanDialog({ projects, initialProject, onClose }: { projects: readonly ProjectChoice[]; initialProject: string; onClose(): void }) {
  const { t } = useTranslation();
  const words = useWords();
  const plan = usePlanEvaluation();
  const [form, setForm] = useState<PlanForm>({ ...EMPTY_PLAN, projectId: projects.some((project) => project.id === initialProject) ? initialProject : '' });
  const [sent, setSent] = useState(false);
  const problems = validatePlan(form);
  const shown = (field: PlanField): string | undefined => (sent ? fieldProblem(t, problems[field]) : undefined);
  const set = (patch: Partial<PlanForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (plan.isPending || Object.keys(problems).length > 0) return;
    plan.mutate(planBody(form), { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('mne.evaluation.plan.title')}
      refusal={plan.isError ? refusalLabel(t, describeRefusal(plan.error)) : undefined}
      pending={plan.isPending}
      submitLabel={t('mne.evaluation.plan.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="evaluation-project" label={t('mne.evaluation.field.project')} error={shown('projectId')}>
        <select id="evaluation-project" value={form.projectId} onChange={(event) => set({ projectId: event.target.value })}>
          <option value="">{NONE}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {`${project.code} · ${project.name}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="evaluation-kind" label={t('mne.evaluation.field.kind')} error={shown('kind')} hint={t('mne.evaluation.field.kind.hint')}>
        <select id="evaluation-kind" value={form.kind} onChange={(event) => set({ kind: event.target.value })}>
          <option value="">{NONE}</option>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="evaluation-evaluator-kind" label={t('mne.evaluation.field.evaluatorKind')} error={shown('evaluatorKind')}>
        <select id="evaluation-evaluator-kind" value={form.evaluatorKind} onChange={(event) => set({ evaluatorKind: event.target.value })}>
          {EVALUATOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {evaluatorLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="evaluation-name" label={t('mne.evaluation.field.name')} error={shown('evaluatorName')} hint={t('mne.evaluation.field.name.hint', { max: NAME_MAX })}>
        <input id="evaluation-name" autoComplete="off" value={form.evaluatorName} onChange={(event) => set({ evaluatorName: event.target.value })} />
      </Field>
      <Field id="evaluation-scope" label={t('mne.evaluation.field.scope')} error={shown('scopeText')} hint={t('mne.evaluation.field.scope.hint')}>
        <textarea id="evaluation-scope" rows={3} value={form.scopeText} onChange={(event) => set({ scopeText: event.target.value })} />
      </Field>
      <Field id="evaluation-planned" label={t('mne.evaluation.field.planned')} error={shown('plannedDate')}>
        <input id="evaluation-planned" type="date" value={form.plannedDate} onChange={(event) => set({ plannedDate: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** Submitting an evaluation: what it found (a line for each finding), the conclusion, the recommendations, the day it was completed and, if there is one, the id of the report document. */
export function SubmitDialog({ evaluation, onClose }: { evaluation: Evaluation; onClose(): void }) {
  const { t } = useTranslation();
  const words = useWords();
  const submit = useSubmitEvaluation();
  const today = vietnamToday();
  // A returned evaluation is submitted again from what it said: nothing that is not changed is lost. The version sent is the one the form was loaded from: if somebody changed the evaluation meanwhile the server says so
  // and the dialog is opened again on what it says now, rather than the new version being put on a form that does not know it.
  const [loaded] = useState(evaluation.version);
  const [form, setForm] = useState<SubmitForm>(submitFormOf(evaluation));
  const [sent, setSent] = useState(false);
  const problems = validateSubmit(form, today);
  const shown = (field: SubmitField): string | undefined => (sent ? fieldProblem(t, problems[field]) : undefined);
  const set = (patch: Partial<SubmitForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (submit.isPending || Object.keys(problems).length > 0) return;
    submit.mutate({ id: evaluation.id, version: loaded, body: submitBody(form) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('mne.evaluation.submit.title', { project: evaluation.projectCode })}
      refusal={submit.isError ? refusalLabel(t, describeRefusal(submit.error)) : undefined}
      pending={submit.isPending}
      submitLabel={t('mne.evaluation.submit.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      {evaluation.decisionReason === null ? null : (
        <p className="callout warning" role="note" data-testid="returned-reason">
          {t('mne.evaluation.submit.returned', { reason: evaluation.decisionReason })}
        </p>
      )}
      <Field id="evaluation-findings" label={t('mne.evaluation.field.findings')} error={shown('findings')} hint={t('mne.evaluation.field.findings.hint')}>
        <textarea id="evaluation-findings" rows={4} value={form.findings} onChange={(event) => set({ findings: event.target.value })} />
      </Field>
      <Field id="evaluation-conclusion" label={t('mne.evaluation.field.conclusion')} error={shown('conclusion')}>
        <select id="evaluation-conclusion" value={form.conclusion} onChange={(event) => set({ conclusion: event.target.value })}>
          <option value="">{NONE}</option>
          {CONCLUSIONS.map((conclusion) => (
            <option key={conclusion} value={conclusion}>
              {conclusionLabel(t, conclusion)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="evaluation-recommendations" label={t('mne.evaluation.field.recommendations')} error={shown('recommendations')} hint={t('mne.evaluation.field.recommendations.hint', { max: TEXT_MAX })}>
        <textarea id="evaluation-recommendations" rows={3} value={form.recommendations} onChange={(event) => set({ recommendations: event.target.value })} />
      </Field>
      <Field id="evaluation-completed" label={t('mne.evaluation.field.completed')} error={shown('completedDate')}>
        <input id="evaluation-completed" type="date" max={today} value={form.completedDate} onChange={(event) => set({ completedDate: event.target.value })} />
      </Field>
      <Field id="evaluation-document" label={t('mne.evaluation.field.document')} error={shown('reportDocument')} hint={t('mne.evaluation.field.document.hint')}>
        <input id="evaluation-document" autoComplete="off" value={form.reportDocument} onChange={(event) => set({ reportDocument: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** Deciding a submitted evaluation: approve it, which links it to the next overall report, or return it with the reason. */
export function DecideDialog({ evaluation, onClose }: { evaluation: Evaluation; onClose(): void }) {
  const { t } = useTranslation();
  const words = useWords();
  const decide = useDecideEvaluation();
  // The decision is taken on what the dialog showed when it was opened: the version sent is that one.
  const [loaded] = useState(evaluation.version);
  const [form, setForm] = useState<DecideForm>(EMPTY_DECIDE);
  const [sent, setSent] = useState(false);
  const problems = validateDecide(form);
  const shown = (field: DecideField): string | undefined => (sent ? fieldProblem(t, problems[field]) : undefined);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSent(true);
    if (decide.isPending || Object.keys(problems).length > 0) return;
    decide.mutate({ id: evaluation.id, version: loaded, body: decideBody(form) }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('mne.evaluation.decide.title', { project: evaluation.projectCode })}
      refusal={decide.isError ? refusalLabel(t, describeRefusal(decide.error)) : undefined}
      pending={decide.isPending}
      submitLabel={t('mne.evaluation.decide.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <p className="callout" role="note" data-testid="to-decide">
        {evaluation.conclusion === null ? t('mne.evaluation.decide.noConclusion') : t('mne.evaluation.decide.conclusion', { conclusion: conclusionLabel(t, evaluation.conclusion), findings: evaluation.findings.length })}
      </p>
      <dl className="pay-facts" data-testid="submission">
        <dt>{t('mne.evaluation.field.scope')}</dt>
        <dd data-testid="submission-scope">{evaluation.scopeText}</dd>
        <dt>{t('mne.evaluation.field.findings')}</dt>
        <dd>
          <ul data-testid="submission-findings">
            {evaluation.findings.map((finding, at) => (
              <li key={at}>{findingLine(finding)}</li>
            ))}
          </ul>
        </dd>
        <dt>{t('mne.evaluation.field.recommendations')}</dt>
        <dd data-testid="submission-recommendations">{evaluation.recommendations ?? NONE}</dd>
        <dt>{t('mne.evaluation.field.completed')}</dt>
        <dd data-testid="submission-completed">{evaluation.completedDate ?? NONE}</dd>
        <dt>{t('mne.evaluation.field.document')}</dt>
        <dd data-testid="submission-document">{evaluation.reportDocumentId ?? NONE}</dd>
      </dl>
      <Field id="evaluation-decision" label={t('mne.evaluation.field.decision')} error={shown('decision')}>
        <select id="evaluation-decision" value={form.decision} onChange={(event) => setForm({ ...form, decision: event.target.value })}>
          <option value="">{NONE}</option>
          <option value="approve">{t('mne.evaluation.decision.approve')}</option>
          <option value="return">{t('mne.evaluation.decision.return')}</option>
        </select>
      </Field>
      <Field id="evaluation-reason" label={t('mne.evaluation.field.reason')} error={shown('reason')} hint={t('mne.evaluation.field.reason.hint')}>
        <textarea id="evaluation-reason" rows={3} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
