import { describe, expect, it } from 'vitest';
import type { AdoptResult } from '../model';
import { schedulePreview } from '../test/fixtures';
import {
  adoptBody,
  decisionsValid,
  dryRunKey,
  emptyDecision,
  emptyEvidence,
  emptyForm,
  evidenceProblem,
  factsOfProject,
  hasErrors,
  pendingDecisions,
  readiness,
  startBody,
  summarizeTemplate,
  templateCodes,
  treatmentCounts,
  treatmentsFor,
  validateDecision,
  validateForm,
} from './model';
import type { Decision, Decisions, StartForm } from './model';

const form = (over: Partial<StartForm> = {}): StartForm => ({ ...emptyForm('adopt'), templateCode: 'PUBLIC_INVESTMENT', plannedStart: '2026-01-05', effectiveDate: '2026-11-01', ...over });
const evidence = { ...emptyEvidence(), kind: 'DOCUMENT', documentId: '00000000-0000-4000-8000-000000000001' };
const done = (over: Partial<Decision> = {}): Decision => ({ ...emptyDecision('DONE'), actualFinish: '2026-06-30', evidence: [evidence], ...over });

const result = (tasks: AdoptResult['tasks']): AdoptResult => ({ dry_run: true, applied: false, workflow_id: null, template_code: 'PUBLIC_INVESTMENT', template_hash: 'h', effective_date: '2026-11-01', tasks, schedule: schedulePreview(), findings: [], as_of: '2026-11-12T03:00:00.000Z' });
const adoptTask = (code: string, treatment: AdoptResult['tasks'][number]['treatment'], needs = false) => ({ task_code: code, name: code, treatment, planned_start: null, planned_finish: null, needs_decision: needs });

describe('PWF-05 model: the form', () => {
  it('prefills the facts the project holds and leaves the funding source to be typed', () => {
    expect(factsOfProject({ projectGroup: 'B', projectType: { versionId: 'v', businessKey: 'CONSTRUCTION', label: 'Xây dựng' } })).toEqual({ project_group: 'B', funding_source: '', project_type: 'CONSTRUCTION' });
    expect(factsOfProject({ projectGroup: null, projectType: null })).toEqual({ project_group: '', funding_source: '', project_type: '' });
  });

  it('lists only the template codes that govern something today', () => {
    const entry = { codes: [{ code: 'A', inForce: 'RULE' }, { code: 'B', inForce: 'NONE' }, { code: 'C', inForce: 'DEFAULT' }] } as never;
    expect(templateCodes(entry).map((code) => code.code)).toEqual(['A', 'C']);
    expect(templateCodes(undefined)).toEqual([]);
  });

  it('asks for a template and a start day, and for an effective day only when adopting', () => {
    expect(validateForm(emptyForm('start'))).toEqual({ templateCode: 'pickOne', plannedStart: 'required' });
    expect(validateForm(emptyForm('adopt'))).toEqual({ templateCode: 'pickOne', plannedStart: 'required', effectiveDate: 'required' });
    expect(validateForm(form())).toEqual({});
    expect(validateForm(form({ plannedStart: '2026-02-30', effectiveDate: 'x' }))).toEqual({ plannedStart: 'invalidDay', effectiveDate: 'invalidDay' });
    expect(validateForm(form({ facts: { project_group: 'x'.repeat(81), funding_source: '', project_type: '' } }))).toEqual({ project_group: 'tooLong' });
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ a: 1 })).toBe(true);
  });

  it('sends only the facts that were given', () => {
    expect(startBody(form({ mode: 'start', templateCode: ' P ', plannedStart: ' 2026-01-05 ' }))).toEqual({ template_code: 'P', planned_start_date: '2026-01-05' });
    expect(startBody(form({ facts: { project_group: 'B', funding_source: '', project_type: '' } }))).toEqual({ template_code: 'PUBLIC_INVESTMENT', planned_start_date: '2026-01-05', facts: { project_group: 'B' } });
  });
});

describe('PWF-05 model: what is decided for a past task', () => {
  it('asks a finished task for its finish day and evidence, and a task in progress for its start and what remains', () => {
    expect(validateDecision(done())).toEqual({});
    expect(validateDecision(done({ actualFinish: '', evidence: [] }))).toEqual({ actualFinish: 'required', evidence: 'required' });
    expect(validateDecision(done({ actualStart: 'x', evidence: [{ ...emptyEvidence(), kind: 'DOCUMENT' }] }))).toEqual({ actualStart: 'invalidDay', evidence: 'pickOne' });
    expect(validateDecision(emptyDecision('NOT_TRACKED'))).toEqual({});
    expect(validateDecision(emptyDecision('TRACKED'))).toEqual({});
    expect(validateDecision(emptyDecision('IN_PROGRESS'))).toEqual({ actualStart: 'required', remaining: 'required' });
    expect(validateDecision({ ...emptyDecision('IN_PROGRESS'), actualStart: '2026-10-01', remaining: '5', percent: '120' })).toEqual({ percent: 'invalidNumber' });
    expect(validateDecision({ ...emptyDecision('IN_PROGRESS'), actualStart: '2026-10-01', remaining: '5', percent: '40' })).toEqual({});
  });

  it('wants evidence to say what it is and where it is', () => {
    expect(evidenceProblem(emptyEvidence())).toBe('required');
    expect(evidenceProblem({ ...emptyEvidence(), kind: 'LINK' })).toBe('pickOne');
    expect(evidenceProblem({ ...emptyEvidence(), kind: 'LINK', externalRef: 'https://x' })).toBeUndefined();
    expect(evidenceProblem({ ...emptyEvidence(), kind: 'LEGAL', legalDocType: 'INVESTMENT_DECISION' })).toBeUndefined();
  });

  it('tells whether every decision is complete', () => {
    expect(decisionsValid({ A: done(), B: emptyDecision('NOT_TRACKED') })).toBe(true);
    expect(decisionsValid({ A: done({ actualFinish: '' }) })).toBe(false);
  });
});

describe('PWF-05 model: the adoption payload', () => {
  it('splits the decisions into past tasks and tasks in progress, and says nothing of a tracked task', () => {
    const decisions: Decisions = {
      A: emptyDecision('NOT_TRACKED'),
      B: done({ actualStart: '2026-03-01', evidence: [{ ...evidence, legalDocType: 'REPORT', externalRef: 'https://x', note: ' ghi chú ' }] }),
      C: { ...emptyDecision('IN_PROGRESS'), actualStart: '2026-10-01', remaining: '5', percent: '40' },
      D: { ...emptyDecision('IN_PROGRESS'), actualStart: '2026-10-02', remaining: '0' },
      E: emptyDecision('TRACKED'),
    };
    expect(adoptBody(form({ facts: { project_group: 'B', funding_source: '', project_type: '' } }), decisions, true)).toEqual({
      template_code: 'PUBLIC_INVESTMENT',
      planned_start_date: '2026-01-05',
      effective_date: '2026-11-01',
      dry_run: true,
      facts: { project_group: 'B' },
      past_tasks: [
        { task_code: 'A', treatment: 'NOT_TRACKED' },
        { task_code: 'B', treatment: 'DONE', actual_start: '2026-03-01', actual_finish: '2026-06-30', evidence: [{ evidence_kind: 'DOCUMENT', document_id: '00000000-0000-4000-8000-000000000001', legal_doc_type: 'REPORT', external_ref: 'https://x', note: 'ghi chú' }] },
      ],
      in_progress_tasks: [
        { task_code: 'C', actual_start: '2026-10-01', remaining_working_days: 5, percent_complete: 40 },
        { task_code: 'D', actual_start: '2026-10-02', remaining_working_days: 0 },
      ],
    });
    expect(adoptBody(form(), {}, false)).toEqual({ template_code: 'PUBLIC_INVESTMENT', planned_start_date: '2026-01-05', effective_date: '2026-11-01', dry_run: false });
  });

  it('keys a dry run by the form it was run for', () => {
    expect(dryRunKey(form(), {})).toBe(dryRunKey(form(), {}));
    expect(dryRunKey(form(), {})).not.toBe(dryRunKey(form({ effectiveDate: '2026-11-02' }), {}));
  });
});

describe('PWF-05 model: reading a dry run', () => {
  const tasks = [adoptTask('A', 'TRACKED', true), adoptTask('B', 'NOT_TRACKED', true), adoptTask('C', 'TRACKED'), adoptTask('D', 'EXCLUDED')];

  it('offers a task that ended before the effective date "not tracked" or "done", any other "tracked" or "in progress"', () => {
    expect(treatmentsFor({ needs_decision: true })).toEqual(['NOT_TRACKED', 'DONE']);
    expect(treatmentsFor({ needs_decision: false })).toEqual(['TRACKED', 'IN_PROGRESS']);
  });

  it('lists the tasks still waiting for a decision', () => {
    expect(pendingDecisions(result(tasks), { B: emptyDecision('NOT_TRACKED') }).map((task) => task.task_code)).toEqual(['A']);
    expect(pendingDecisions(result(tasks), { A: done(), B: emptyDecision('NOT_TRACKED') })).toEqual([]);
  });

  it('counts the tasks by treatment', () => {
    expect(treatmentCounts(result(tasks))).toEqual({ TRACKED: 2, NOT_TRACKED: 1, DONE: 0, IN_PROGRESS: 0, EXCLUDED: 1 });
  });

  it('says what stands between the person and the apply button', () => {
    const run = result(tasks);
    expect(readiness(undefined, undefined, 'k', {})).toBe('noDryRun');
    expect(readiness(run, 'old', 'k', {})).toBe('stale');
    expect(readiness(run, 'k', 'k', {})).toBe('pending');
    expect(readiness(result([adoptTask('C', 'TRACKED')]), 'k', 'k', {})).toBe('ready');
  });
});

describe('PWF-05 model: the summary of a template', () => {
  it('reads the name, the project type and the size of the params, and tolerates what is not there', () => {
    expect(summarizeTemplate({ name: 'Mẫu', project_type: 'CONSTRUCTION', phases: [1, 2], tasks: [1, 2, 3] })).toEqual({ name: 'Mẫu', projectType: 'CONSTRUCTION', phases: 2, tasks: 3 });
    expect(summarizeTemplate({})).toEqual({ name: '', projectType: null, phases: 0, tasks: 0 });
  });
});
