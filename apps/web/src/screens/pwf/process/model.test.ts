import { describe, expect, it } from 'vitest';
import { workflowDetail, workflowTask } from '../test/fixtures';
import { EMPTY_CHOICE, attentionCount, choiceProblems, effectiveTemplate, isLapsed, needsAttention, percentOf, phaseGroups, registrationBlockers, selectionMode, startsWorkflow, suggestionQuery, workflowBodyOf } from './model';
import type { ChoiceForm, Suggestion } from './model';
import { legalBasis, step, suggestion } from './test/fixtures';

const form = (over: Partial<ChoiceForm> = {}): ChoiceForm => ({ ...EMPTY_CHOICE, ...over });

describe('the kind of workflow of a project: what is asked and what is sent', () => {
  it('asks for a project that exists by its id, and for one being registered by its unit and type', () => {
    expect(suggestionQuery({ projectId: 'p1', ownerUnitId: 'u1' }, form())).toEqual({ project_id: 'p1' });
    expect(suggestionQuery({ ownerUnitId: 'u1', projectTypeVersionId: 'v1' }, form({ projectGroup: ' B ', fundingSource: 'ODA', templateCode: 'PUBLIC_REPAIR', plannedStart: '2026-12-01' }))).toEqual({
      owner_unit_id: 'u1',
      project_type_master_version_id: 'v1',
      project_group: 'B',
      funding_source: 'ODA',
      template_code: 'PUBLIC_REPAIR',
      planned_start_date: '2026-12-01',
    });
  });

  it('never sends a value that cannot be a fact or a day that is not one', () => {
    expect(suggestionQuery({ ownerUnitId: '' }, form({ projectGroup: 'B; drop', plannedStart: '2026-13-40' }))).toEqual({});
  });

  it('names how the choice relates to the rule', () => {
    const suggested = suggestion();
    const none: Suggestion = suggestion({ suggested_template_code: null, basis: 'NONE' });
    expect(selectionMode(form(), suggested)).toBe('AUTO');
    expect(selectionMode(form({ templateCode: 'PUBLIC_INVESTMENT' }), suggested)).toBe('CONFIRMED');
    expect(selectionMode(form({ templateCode: 'PUBLIC_REPAIR' }), suggested)).toBe('OVERRIDE');
    expect(selectionMode(form({ templateCode: 'PUBLIC_REPAIR' }), none)).toBe('MANUAL');
    expect(selectionMode(form(), none)).toBeNull();
    expect(selectionMode(form(), undefined)).toBeNull();
    expect(effectiveTemplate(form(), suggested)).toBe('PUBLIC_INVESTMENT');
    expect(effectiveTemplate(form({ templateCode: 'PUBLIC_REPAIR' }), suggested)).toBe('PUBLIC_REPAIR');
    expect(effectiveTemplate(form(), none)).toBeNull();
  });

  it('finds nothing wrong with an empty planned start: the project is registered and the workflow starts later', () => {
    expect(choiceProblems(form({ templateCode: 'PUBLIC_REPAIR' }), suggestion())).toEqual([]);
    expect(startsWorkflow(form(), suggestion())).toBe(false);
  });

  it('says what keeps the workflow from starting with the registration', () => {
    expect(choiceProblems(form({ plannedStart: 'soon' }), suggestion())).toEqual(['startInvalid']);
    expect(choiceProblems(form({ plannedStart: '2026-12-01' }), suggestion({ suggested_template_code: null, basis: 'NONE' }))).toEqual(['templateRequired']);
    expect(choiceProblems(form({ plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR', reason: 'ngắn' }), suggestion())).toEqual(['reasonRequired']);
    expect(choiceProblems(form({ plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR', reason: 'x'.repeat(501) }), suggestion())).toEqual(['reasonTooLong']);
    expect(choiceProblems(form({ plannedStart: '2026-12-01' }), suggestion({ preview: { missing_facts: ['funding_source'] } }))).toEqual(['factsRequired']);
    expect(choiceProblems(form({ plannedStart: '2026-12-01' }), suggestion({ preview: { findings: [{ code: 'CALENDAR_UNAVAILABLE', task: 'T1', year: 2029 }] } }))).toEqual(['calendarMissing']);
    expect(choiceProblems(form({ plannedStart: '2026-12-01' }), suggestion())).toEqual([]);
  });

  it('never drops a planned start silently: without the answer of the rule the registration is stopped, and only a caller who may not start workflows goes on without one', () => {
    expect(choiceProblems(form({ plannedStart: '2026-12-01' }), undefined)).toEqual(['suggestionUnavailable']);
    expect(registrationBlockers(form({ plannedStart: '2026-12-01' }), undefined)).toEqual(['suggestionUnavailable']);
    expect(registrationBlockers(form(), undefined)).toEqual([]);
    expect(registrationBlockers(form({ plannedStart: '2026-12-01' }), suggestion({ can_start: false }))).toEqual([]);
    expect(registrationBlockers(form({ plannedStart: '2026-12-01' }), undefined, true)).toEqual([]);
    expect(registrationBlockers(form({ plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR' }), suggestion())).toEqual(['reasonRequired']);
    expect(registrationBlockers(form({ plannedStart: '2026-12-01' }), suggestion())).toEqual([]);
  });

  it('starts the workflow only with a planned start, the right to start one and nothing in the way', () => {
    expect(startsWorkflow(form({ plannedStart: '2026-12-01' }), suggestion())).toBe(true);
    expect(startsWorkflow(form({ plannedStart: '2026-12-01' }), suggestion({ can_start: false }))).toBe(false);
    expect(startsWorkflow(form({ plannedStart: '2026-12-01' }), undefined)).toBe(false);
    expect(startsWorkflow(form({ plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR' }), suggestion())).toBe(false);
  });

  it('sends the template only when the person chose one, the facts typed, and the reason of an override', () => {
    expect(workflowBodyOf(form({ plannedStart: ' 2026-12-01 ' }), suggestion())).toEqual({ planned_start_date: '2026-12-01' });
    expect(workflowBodyOf(form({ plannedStart: '2026-12-01', templateCode: 'PUBLIC_INVESTMENT', projectGroup: 'B', fundingSource: 'ODA', reason: 'không gửi vì không phải ghi đè' }), suggestion())).toEqual({
      planned_start_date: '2026-12-01',
      template_code: 'PUBLIC_INVESTMENT',
      facts: { project_group: 'B', funding_source: 'ODA' },
    });
    expect(workflowBodyOf(form({ plannedStart: '2026-12-01', templateCode: 'PUBLIC_REPAIR', reason: '  Dự án sửa chữa theo quyết định  ' }), suggestion())).toEqual({
      planned_start_date: '2026-12-01',
      template_code: 'PUBLIC_REPAIR',
      selection_reason: 'Dự án sửa chữa theo quyết định',
    });
  });
});

describe('phase, step, task', () => {
  const detail = workflowDetail({
    steps: [step('S2', 'PREPARATION', 2), step('S1', 'PREPARATION', 1, { legal_basis: [legalBasis({ state: 'SUPERSEDED' }), legalBasis({ document_code: 'LAW_X', state: 'IN_FORCE' })] }), step('S3', 'EXECUTION', 1, { legal_basis: [legalBasis({ state: 'SUPERSEDED' }), legalBasis({ document_code: 'GONE', state: 'UNKNOWN' })] })],
    tasks: [workflowTask(1, { step_code: 'S1' }), workflowTask(2, { step_code: 'S2' }), workflowTask(3, { step_code: null }), workflowTask(4, { phase_code: 'EXECUTION', step_code: 'S3' })],
  });

  it('puts every task under the step the server names, the steps in their order, and keeps apart a task in no step', () => {
    const groups = phaseGroups(detail);
    expect(groups.map((phase) => [phase.code, phase.steps.map((group) => `${group.step.code}:${group.tasks.map((task) => task.task_code).join('+')}`), phase.loose.map((task) => task.task_code)])).toEqual([
      ['PREPARATION', ['S1:T1', 'S2:T2'], ['T3']],
      ['EXECUTION', ['S3:T4'], []],
    ]);
  });

  it('gives no tiers for an answer kept from before steps existed', () => {
    expect(phaseGroups(workflowDetail())).toEqual([]);
    expect(attentionCount(workflowDetail())).toBe(0);
  });

  it('counts each document that needs a look once, and never divides by nothing', () => {
    expect(attentionCount(detail)).toBe(2);
    expect([isLapsed('EXPIRED'), isLapsed('SUPERSEDED'), isLapsed('IN_FORCE'), needsAttention('UNKNOWN'), needsAttention('NOT_YET_IN_FORCE'), needsAttention('IN_FORCE')]).toEqual([true, true, false, true, true, false]);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(5, 3)).toBe(100);
    expect(percentOf(0, 0)).toBeNull();
  });
});
