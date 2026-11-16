import type { components } from '@machvon/contracts';
import type { RuleTypeEntry } from '../../adm/governance/model';
import type { ProjectView } from '../../prj/model';
import { dayProblem, isDay, optionalText, wholeProblem } from '../model';
import type { AdoptResult, FormProblem } from '../model';
import { EMPTY_CHOICE, workflowBodyOf } from '../process/model';
import type { ChoiceForm, Suggestion } from '../process/model';

type Schemas = components['schemas'];

export type StartBody = Schemas['PwfWorkflowStart'];
export type AdoptBody = Schemas['PwfWorkflowAdopt'];
export type EvidenceBody = Schemas['PwfEvidenceInput'];
export type AdoptTask = AdoptResult['tasks'][number];

/** The way a task of a running project is treated when its workflow is adopted (BR-PWF-17). */
export type Treatment = 'TRACKED' | 'NOT_TRACKED' | 'DONE' | 'IN_PROGRESS';
export const PAST_TREATMENTS: readonly Treatment[] = ['NOT_TRACKED', 'DONE'];
export const OPEN_TREATMENTS: readonly Treatment[] = ['TRACKED', 'IN_PROGRESS'];

export type Mode = 'start' | 'adopt';

export const MAX_EVIDENCE_TEXT = 500;

export interface EvidenceDraft {
  kind: string;
  documentId: string;
  legalDocType: string;
  externalRef: string;
  note: string;
}

export interface Decision {
  treatment: Treatment;
  actualStart: string;
  actualFinish: string;
  remaining: string;
  percent: string;
  evidence: EvidenceDraft[];
}

export type Decisions = Readonly<Record<string, Decision>>;

export const emptyEvidence = (): EvidenceDraft => ({ kind: '', documentId: '', legalDocType: '', externalRef: '', note: '' });
export const emptyDecision = (treatment: Treatment): Decision => ({ treatment, actualStart: '', actualFinish: '', remaining: '', percent: '', evidence: [] });

/** What the process chooser starts from: the group and the kind of project the project already holds; the source of capital is not a field of the project, so it stays to be chosen. */
export function choiceOfProject(project: Pick<ProjectView, 'projectGroup' | 'projectType'>): ChoiceForm {
  return { ...EMPTY_CHOICE, projectGroup: project.projectGroup ?? '', projectType: project.projectType?.businessKey ?? '' };
}

/** The codes of the template rule type that govern something today (a rule of the tenant or the default that ships), in the order of the catalogue. */
export const templateCodes = (entry: RuleTypeEntry | undefined): RuleTypeEntry['codes'] => entry?.codes.filter((code) => code.inForce !== 'NONE') ?? [];

// ---- checks before anything is sent -----------------------------------------------------------------------------------------------------------------------------------

export const hasErrors = (errors: object): boolean => Object.keys(errors).length > 0;

export type DecisionField = 'actualStart' | 'actualFinish' | 'remaining' | 'percent' | 'evidence';
export type DecisionErrors = Partial<Record<DecisionField, FormProblem>>;

/** A task that was done before the effective date needs its day of finish and evidence of the right kind; a task in progress needs the day it really started and what remains (BR-PWF-17, BR-PWF-06). */
export function validateDecision(decision: Decision): DecisionErrors {
  const errors: DecisionErrors = {};
  if (decision.treatment === 'DONE') {
    const finish = dayProblem(decision.actualFinish);
    if (finish !== undefined) errors.actualFinish = finish;
    if (decision.actualStart.trim() !== '' && !isDay(decision.actualStart.trim())) errors.actualStart = 'invalidDay';
    if (decision.evidence.length === 0 || decision.evidence.some((item) => evidenceProblem(item) !== undefined)) errors.evidence = decision.evidence.length === 0 ? 'required' : 'pickOne';
  }
  if (decision.treatment === 'IN_PROGRESS') {
    const start = dayProblem(decision.actualStart);
    if (start !== undefined) errors.actualStart = start;
    const remaining = wholeProblem(decision.remaining, 0, 3650);
    if (remaining !== undefined) errors.remaining = remaining;
    if (decision.percent.trim() !== '') {
      const percent = wholeProblem(decision.percent, 0, 100);
      if (percent !== undefined) errors.percent = percent;
    }
  }
  return errors;
}

/** One piece of evidence says what kind it is and points at a document, a legal document type or an external reference. */
export function evidenceProblem(item: EvidenceDraft): FormProblem | undefined {
  if (item.kind.trim() === '') return 'required';
  if (item.documentId.trim() === '' && item.legalDocType.trim() === '' && item.externalRef.trim() === '') return 'pickOne';
  return undefined;
}

/** Whether every task that has been given a decision is complete enough to send. */
export const decisionsValid = (decisions: Decisions): boolean => Object.values(decisions).every((decision) => !hasErrors(validateDecision(decision)));

// ---- the bodies of the two commands --------------------------------------------------------------------------------------------------------------------------------

/** The body of the start: what the chooser holds (the template only when one was chosen, the facts given, the reason of an override, the units chosen for what the project could not name). */
export const startBodyOf = (form: ChoiceForm, suggestion: Suggestion | undefined): StartBody => workflowBodyOf(form, suggestion);

function evidenceBody(item: EvidenceDraft): EvidenceBody {
  const body: EvidenceBody = { evidence_kind: item.kind.trim() };
  const documentId = optionalText(item.documentId);
  const legal = optionalText(item.legalDocType);
  const external = optionalText(item.externalRef);
  const note = optionalText(item.note);
  if (documentId !== undefined) body.document_id = documentId;
  if (legal !== undefined) body.legal_doc_type = legal;
  if (external !== undefined) body.external_ref = external;
  if (note !== undefined) body.note = note;
  return body;
}

/** The adoption payload: the tasks that finished before the effective date with what the person decided, and the tasks in progress; a task kept as tracked says nothing. */
export function adoptBody(form: ChoiceForm, suggestion: Suggestion | undefined, decisions: Decisions, dryRun: boolean): AdoptBody {
  const entries = Object.entries(decisions);
  const past = entries
    .filter(([, decision]) => decision.treatment === 'NOT_TRACKED' || decision.treatment === 'DONE')
    .map(([code, decision]): NonNullable<AdoptBody['past_tasks']>[number] => {
      if (decision.treatment === 'NOT_TRACKED') return { task_code: code, treatment: 'NOT_TRACKED' };
      const start = optionalText(decision.actualStart);
      return { task_code: code, treatment: 'DONE', ...(start === undefined ? {} : { actual_start: start }), actual_finish: decision.actualFinish.trim(), evidence: decision.evidence.map(evidenceBody) };
    });
  const progress = entries
    .filter(([, decision]) => decision.treatment === 'IN_PROGRESS')
    .map(([code, decision]): NonNullable<AdoptBody['in_progress_tasks']>[number] => {
      const percent = optionalText(decision.percent);
      return { task_code: code, actual_start: decision.actualStart.trim(), remaining_working_days: Number(decision.remaining.trim()), ...(percent === undefined ? {} : { percent_complete: Number(percent) }) };
    });
  return {
    ...workflowBodyOf(form, suggestion),
    effective_date: form.effectiveDate.trim(),
    dry_run: dryRun,
    ...(past.length === 0 ? {} : { past_tasks: past }),
    ...(progress.length === 0 ? {} : { in_progress_tasks: progress }),
  };
}

/** The key of what a dry run was run for: a result is only the result of the form as it stood when it was asked. */
export const dryRunKey = (form: ChoiceForm, suggestion: Suggestion | undefined, decisions: Decisions): string => JSON.stringify(adoptBody(form, suggestion, decisions, true));

/** The treatments a task offers: a task that needs a decision (it ended before the effective date) is not tracked or done; any other is tracked or in progress. */
export const treatmentsFor = (task: Pick<AdoptTask, 'needs_decision'>): readonly Treatment[] => (task.needs_decision ? PAST_TREATMENTS : OPEN_TREATMENTS);

/** The tasks of a dry run still waiting for a decision (BR-PWF-17): needing one and treated as neither not tracked nor done. */
export const pendingDecisions = (result: AdoptResult, decisions: Decisions): AdoptTask[] =>
  result.tasks.filter((task) => task.needs_decision && decisions[task.task_code]?.treatment !== 'NOT_TRACKED' && decisions[task.task_code]?.treatment !== 'DONE');

/** The number of tasks by treatment of a dry run, for the summary line. */
export function treatmentCounts(result: AdoptResult): Record<AdoptTask['treatment'], number> {
  const counts: Record<AdoptTask['treatment'], number> = { TRACKED: 0, NOT_TRACKED: 0, DONE: 0, IN_PROGRESS: 0, EXCLUDED: 0 };
  for (const task of result.tasks) counts[task.treatment] += 1;
  return counts;
}

/** What the person has to do next on the adoption, so the button that applies says why it is off. */
export type AdoptReadiness = 'noDryRun' | 'stale' | 'pending' | 'ready';
export function readiness(result: AdoptResult | undefined, ranFor: string | undefined, current: string, decisions: Decisions): AdoptReadiness {
  if (result === undefined) return 'noDryRun';
  if (ranFor !== current) return 'stale';
  return pendingDecisions(result, decisions).length > 0 ? 'pending' : 'ready';
}
