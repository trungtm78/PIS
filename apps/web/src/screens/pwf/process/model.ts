import type { components } from '@machvon/contracts';
import type { Tone } from '../../../ui';
import { isDay } from '../model';
import type { TaskDetail, WorkflowDetail, WorkflowTask } from '../model';

type Schemas = components['schemas'];

/**
 * PWF-4: the processing workflow of a project in three tiers (phase, step, task with its checklist), the legal grounds of steps and tasks, the revision of the forms, and the kind of workflow chosen when a project is registered.
 * The pure side of the screens: what is asked of the server, what is sent, and how the tiers are grouped and counted.
 */

export type Suggestion = Schemas['PwfWorkflowSuggestion'];
export type SuggestionPreview = NonNullable<Suggestion['preview']>;
export type SuggestionTemplate = Suggestion['templates'][number];
export type SuggestionBasis = Suggestion['basis'];
export type LegalBasis = Schemas['PwfLegalBasisView'];
export type LegalState = LegalBasis['state'];
export type Selection = Schemas['PwfWorkflowSelection'];
export type SelectionMode = Selection['mode'];
export type WorkflowStep = NonNullable<WorkflowDetail['steps']>[number];
export type StepStatus = WorkflowStep['status'];
export type TaskForm = TaskDetail['form_templates'][number];
export type WorkflowChoiceBody = NonNullable<Schemas['PrjProjectCreate']['workflow']>;

export const FACT_VALUE = /^[A-Za-z0-9_.-]{1,40}$/;
export const MIN_SELECTION_REASON = 10;
export const MAX_SELECTION_REASON = 500;
/** The groups of a public investment project (the law's own names) and the sources of capital the shipped templates branch on. */
export const PROJECT_GROUPS = ['QTQG', 'A', 'B', 'C'] as const;
export const FUNDING_SOURCES = ['STATE_BUDGET', 'ODA', 'FOREIGN_LOAN', 'OTHER'] as const;

/** What the person holds in the section "kind of workflow". An empty template means "the one the rule suggests". */
export interface ChoiceForm {
  plannedStart: string;
  templateCode: string;
  projectGroup: string;
  fundingSource: string;
  reason: string;
}

export const EMPTY_CHOICE: ChoiceForm = { plannedStart: '', templateCode: '', projectGroup: '', fundingSource: '', reason: '' };

/** What the suggestion is asked for: a project that exists, or the unit and the type the registration form holds. */
export interface ChoiceContext {
  projectId?: string | undefined;
  ownerUnitId?: string | undefined;
  projectTypeVersionId?: string | undefined;
}

/** The query of `suggestProjectWorkflow`: only what is known and can be a fact; a day that is not one is left out (no preview) rather than sent. */
export function suggestionQuery(context: ChoiceContext, form: ChoiceForm): Record<string, string> {
  const query: Record<string, string> = {};
  if (context.projectId !== undefined && context.projectId !== '') query.project_id = context.projectId;
  else {
    if (context.ownerUnitId !== undefined && context.ownerUnitId !== '') query.owner_unit_id = context.ownerUnitId;
    if (context.projectTypeVersionId !== undefined && context.projectTypeVersionId !== '') query.project_type_master_version_id = context.projectTypeVersionId;
  }
  if (FACT_VALUE.test(form.projectGroup.trim())) query.project_group = form.projectGroup.trim();
  if (FACT_VALUE.test(form.fundingSource.trim())) query.funding_source = form.fundingSource.trim();
  if (form.templateCode.trim() !== '') query.template_code = form.templateCode.trim();
  if (isDay(form.plannedStart.trim())) query.planned_start_date = form.plannedStart.trim();
  return query;
}

/** The template the form stands for: the one chosen, else the suggested one, else none. */
export const effectiveTemplate = (form: ChoiceForm, suggestion: Suggestion | undefined): string | null => (form.templateCode.trim() !== '' ? form.templateCode.trim() : (suggestion?.suggested_template_code ?? null));

/** How the choice relates to the rule (the same four words the server records). */
export function selectionMode(form: ChoiceForm, suggestion: Suggestion | undefined): SelectionMode | null {
  const chosen = form.templateCode.trim();
  const suggested = suggestion?.suggested_template_code ?? null;
  if (chosen === '') return suggested === null ? null : 'AUTO';
  if (suggested === null) return 'MANUAL';
  return chosen === suggested ? 'CONFIRMED' : 'OVERRIDE';
}

export type ChoiceProblem = 'startRequired' | 'startInvalid' | 'templateRequired' | 'reasonRequired' | 'reasonTooLong' | 'factsRequired' | 'calendarMissing';

/**
 * What keeps the workflow from starting with the registration. An empty planned start is not a problem: the project is then registered without a workflow and the workflow starts later (PWF-05). With a day, the template must be
 * known, the facts its branches read must be given, the calendar must reach, and a choice against the rule needs its reason.
 */
export function choiceProblems(form: ChoiceForm, suggestion: Suggestion | undefined): ChoiceProblem[] {
  const day = form.plannedStart.trim();
  if (day === '') return [];
  const found: ChoiceProblem[] = [];
  if (!isDay(day)) return ['startInvalid'];
  if (effectiveTemplate(form, suggestion) === null) found.push('templateRequired');
  const reason = form.reason.trim();
  if (selectionMode(form, suggestion) === 'OVERRIDE' && reason.length < MIN_SELECTION_REASON) found.push('reasonRequired');
  if (reason.length > MAX_SELECTION_REASON) found.push('reasonTooLong');
  const preview = suggestion?.preview ?? null;
  if (preview !== null && preview.missing_facts.length > 0) found.push('factsRequired');
  if (preview !== null && preview.findings.some((finding) => finding.code === 'CALENDAR_UNAVAILABLE')) found.push('calendarMissing');
  return found;
}

/** Whether the registration carries a workflow: a planned start, the right to start one, and nothing in the way. */
export const startsWorkflow = (form: ChoiceForm, suggestion: Suggestion | undefined): boolean => form.plannedStart.trim() !== '' && suggestion?.can_start === true && choiceProblems(form, suggestion).length === 0;

/** The `workflow` of `createProject`: the template only when the person chose one (left out, the rule chooses on the server, on the same day), the facts typed, and the reason of an override. */
export function workflowBodyOf(form: ChoiceForm, suggestion: Suggestion | undefined): WorkflowChoiceBody {
  const facts: NonNullable<WorkflowChoiceBody['facts']> = {};
  if (form.projectGroup.trim() !== '') facts.project_group = form.projectGroup.trim();
  if (form.fundingSource.trim() !== '') facts.funding_source = form.fundingSource.trim();
  const body: WorkflowChoiceBody = { planned_start_date: form.plannedStart.trim() };
  if (form.templateCode.trim() !== '') body.template_code = form.templateCode.trim();
  if (Object.keys(facts).length > 0) body.facts = facts;
  if (selectionMode(form, suggestion) === 'OVERRIDE' && form.reason.trim() !== '') body.selection_reason = form.reason.trim();
  return body;
}

// ---- phase -> step -> task -> checklist ----------------------------------------------------------------------------------------------------------------------------------

export interface StepGroup {
  step: WorkflowStep;
  tasks: WorkflowTask[];
}

export interface PhaseGroup {
  code: string;
  name: string;
  order: number;
  requiredTotal: number;
  requiredDone: number;
  steps: StepGroup[];
  /** Tasks of the phase that belong to no step (a task the project added itself). */
  loose: WorkflowTask[];
}

/** The workflow as phase, step, task: every task under the step the server names for it; a workflow read from before steps existed has none and gives an empty list (the screen then keeps its older views). */
export function phaseGroups(detail: WorkflowDetail): PhaseGroup[] {
  const steps = detail.steps ?? [];
  if (steps.length === 0) return [];
  return [...detail.phases]
    .sort((left, right) => left.order - right.order)
    .map((phase) => {
      const inPhase = detail.tasks.filter((task) => task.phase_code === phase.code);
      const mine = steps.filter((step) => step.phase_code === phase.code).sort((left, right) => left.order - right.order);
      const known = new Set(mine.map((step) => step.code));
      return {
        code: phase.code,
        name: phase.name,
        order: phase.order,
        requiredTotal: phase.required_total,
        requiredDone: phase.required_done,
        steps: mine.map((step) => ({ step, tasks: inPhase.filter((task) => task.step_code === step.code) })),
        loose: inPhase.filter((task) => task.step_code === null || task.step_code === undefined || !known.has(task.step_code)),
      };
    });
}

/** A share as a whole percentage; nothing to count is no percentage at all (never 0 % of nothing, never NaN). */
export const percentOf = (done: number, total: number): number | null => (total <= 0 ? null : Math.round((Math.min(done, total) / total) * 100));

export function stepTone(status: StepStatus): Tone {
  switch (status) {
    case 'DONE':
      return 'success';
    case 'IN_PROGRESS':
      return 'info';
    case 'NOT_STARTED':
    case 'NOT_APPLICABLE':
      return 'neutral';
  }
}

export function stepIcon(status: StepStatus): string {
  switch (status) {
    case 'DONE':
      return '✓';
    case 'IN_PROGRESS':
      return '◐';
    case 'NOT_STARTED':
      return '○';
    case 'NOT_APPLICABLE':
      return '–';
  }
}

// ---- legal grounds --------------------------------------------------------------------------------------------------------------------------------------------------------

/** A document that must not be cited any more, or that the catalogue no longer knows. */
export const isLapsed = (state: LegalState): boolean => state === 'EXPIRED' || state === 'SUPERSEDED';
export const needsAttention = (state: LegalState): boolean => isLapsed(state) || state === 'UNKNOWN' || state === 'NOT_YET_IN_FORCE';

export function legalTone(state: LegalState): Tone {
  switch (state) {
    case 'IN_FORCE':
      return 'success';
    case 'NOT_YET_IN_FORCE':
      return 'info';
    case 'EXPIRED':
    case 'SUPERSEDED':
      return 'danger';
    case 'UNKNOWN':
      return 'warning';
  }
}

export function legalIcon(state: LegalState): string {
  switch (state) {
    case 'IN_FORCE':
      return '✓';
    case 'NOT_YET_IN_FORCE':
      return '◷';
    case 'EXPIRED':
    case 'SUPERSEDED':
      return '✕';
    case 'UNKNOWN':
      return '?';
  }
}

/** How many of the grounds of a workflow need a look: each document counted once. */
export function attentionCount(detail: WorkflowDetail): number {
  const seen = new Set<string>();
  for (const step of detail.steps ?? []) for (const basis of step.legal_basis) if (needsAttention(basis.state)) seen.add(basis.document_code);
  return seen.size;
}

// ---- forms ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Whether the read of a task carries the revision of its forms (an answer kept from before PWF-4 does not). */
export const hasRevisionFacts = (form: TaskForm): boolean => form.policy !== undefined;
