import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CorrectionPanel } from './CorrectionPanel';
import { ReportCreateForm } from './ReportCreateForm';
import { correctionBody, correctionProblem, createBody, createProblems, EMPTY_CREATE, mayCorrect, mayCreate, resourceIdOf } from './report-create-model';
import { toReport } from './types';
import { formRow, harness, mount } from './test-support';

const FORM = formRow(1).id as string;
const UNIT = '00000000-0000-4000-8000-0000000000b1';
const SNAPSHOT = '00000000-0000-4000-8000-0000000000c1';
const REPORT = '00000000-0000-4000-8000-0000000000d1';
const NEW_REPORT = '00000000-0000-4000-8000-0000000000d2';
const WRITER = ['mne.read', 'mne.report.prepare'];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const snapshotRow = { id: SNAPSHOT, period_id: '00000000-0000-4000-8000-0000000000e1', snapshot_kind: 'PERIOD_CLOSE', status: 'FROZEN', definition_status: 'SIGNED', treasury_cutoff_date: '2026-09-30', as_of_date: '2026-09-30', row_count: 4, version: 1 };

/** A client whose reads and lists are answered from the tables below. */
function client(command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation) => (operation === 'listPeriodSnapshots' ? { items: [snapshotRow], pending_reports: [] } : new Error(`unexpected read ${operation}`)), command);
  const lists: Record<string, unknown[] | Error> = {
    listMneForms: [formRow(1), formRow(2, { status: 'DRAFT' })],
    get_resources_organization_unit: [{ id: UNIT, code: 'CDT1', name: 'Investor one' }],
    get_resources_project: [{ id: '00000000-0000-4000-8000-0000000000a1', code: 'DA1', name: 'Project one' }],
  };
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => {
    const answer = lists[operation];
    return answer === undefined ? Promise.reject(new Error(`unexpected readAll ${operation}`)) : answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  return Object.assign(h, { lists });
}

describe('the model of the report forms', () => {
  it('wants a form, a unit, a year and a period of at most twenty characters', () => {
    expect(createProblems({ ...EMPTY_CREATE })).toEqual({ formId: 'required', unitId: 'required', reportYear: 'required', periodLabel: 'required' });
    expect(createProblems({ ...EMPTY_CREATE, formId: FORM, unitId: UNIT, reportYear: '1999', periodLabel: 'x'.repeat(21) })).toEqual({ reportYear: 'yearInvalid', periodLabel: 'periodLong' });
    expect(createProblems({ ...EMPTY_CREATE, formId: FORM, unitId: UNIT, reportYear: '2026', periodLabel: 'Q3' })).toEqual({});
  });

  it('leaves the project and the snapshot out of the body when none is chosen', () => {
    expect(createBody({ formId: FORM, unitId: UNIT, reportYear: '2026', periodLabel: ' Q3 ', projectId: '', snapshotId: '' })).toEqual({ form_id: FORM, report_year: 2026, period_label: 'Q3', scope_unit_id: UNIT });
    expect(createBody({ formId: FORM, unitId: UNIT, reportYear: '2026', periodLabel: 'Q3', projectId: 'p', snapshotId: SNAPSHOT })).toMatchObject({ project_id: 'p', snapshot_id: SNAPSHOT });
  });

  it('wants a reason of ten to two thousand characters and builds the body of a correction', () => {
    expect(correctionProblem('too short')).toBe('short');
    expect(correctionProblem('x'.repeat(2001))).toBe('long');
    expect(correctionProblem('The total was taken from the wrong snapshot')).toBeUndefined();
    expect(correctionBody('  The total was wrong  ', '')).toEqual({ correction_reason: 'The total was wrong' });
    expect(correctionBody('The total was wrong', SNAPSHOT)).toEqual({ correction_reason: 'The total was wrong', snapshot_id: SNAPSHOT });
  });

  it('offers the correction only for an issued report that was not recalled, to who prepares reports, outside the read-only mode', () => {
    expect(mayCorrect({ status: 'ISSUED', recalledAt: null }, WRITER, false)).toBe(true);
    expect(mayCorrect({ status: 'DRAFT', recalledAt: null }, WRITER, false)).toBe(false);
    expect(mayCorrect({ status: 'ISSUED', recalledAt: '2026-10-01T00:00:00Z' }, WRITER, false)).toBe(false);
    expect(mayCorrect({ status: 'ISSUED', recalledAt: null }, ['mne.read'], false)).toBe(false);
    expect(mayCorrect({ status: 'ISSUED', recalledAt: null }, WRITER, true)).toBe(false);
    expect(mayCreate(WRITER, false)).toBe(true);
    expect(mayCreate(['mne.read'], false)).toBe(false);
    expect(resourceIdOf({ resource_id: REPORT })).toBe(REPORT);
    expect(resourceIdOf(undefined)).toBe('');
  });
});

describe('MNE-03 making a report by hand (createMneReport)', () => {
  it('lists the published forms in force, the units and the frozen snapshots, and sends the chosen ones once', async () => {
    const h = client(() => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: NEW_REPORT }));
    const onCreated = vi.fn();
    mount(<ReportCreateForm onCreated={onCreated} onCancel={() => undefined} />, h, { permissions: WRITER });
    await screen.findByTestId('create-form');
    const form = document.getElementById('create-form-id') as HTMLSelectElement;
    await waitFor(() => expect(form.options.length).toBe(2));
    // The draft revision is not offered.
    expect(Array.from(form.options).map((option) => option.value)).toEqual(['', FORM]);
    fireEvent.change(form, { target: { value: FORM } });
    expect(screen.getByTestId('create-legal')).toBeTruthy();
    fireEvent.change(document.getElementById('create-period') as HTMLInputElement, { target: { value: 'Quarter 3' } });
    await waitFor(() => expect((document.getElementById('create-unit') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(document.getElementById('create-unit') as HTMLSelectElement, { target: { value: UNIT } });
    await waitFor(() => expect((document.getElementById('create-snapshot') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(document.getElementById('create-snapshot') as HTMLSelectElement, { target: { value: SNAPSHOT } });
    fireEvent.submit(screen.getByTestId('create-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('createMneReport', expect.objectContaining({ body: expect.objectContaining({ form_id: FORM, scope_unit_id: UNIT, period_label: 'Quarter 3', snapshot_id: SNAPSHOT }) }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(NEW_REPORT));
  });

  it('sends nothing while the form has problems, and marks each field', async () => {
    const h = client();
    mount(<ReportCreateForm onCreated={() => undefined} onCancel={() => undefined} />, h, { permissions: WRITER });
    await screen.findByTestId('create-form');
    fireEvent.submit(screen.getByTestId('create-form'));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(1);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says a report that exists already, and keeps the form', async () => {
    const h = client(() => problem(409, 'REPORT_EXISTS'));
    mount(<ReportCreateForm onCreated={() => undefined} onCancel={() => undefined} />, h, { permissions: WRITER });
    const form = document.getElementById('create-form-id') as HTMLSelectElement;
    await waitFor(() => expect(form.options.length).toBe(2));
    fireEvent.change(form, { target: { value: FORM } });
    fireEvent.change(document.getElementById('create-period') as HTMLInputElement, { target: { value: 'Q3' } });
    await waitFor(() => expect((document.getElementById('create-unit') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(document.getElementById('create-unit') as HTMLSelectElement, { target: { value: UNIT } });
    fireEvent.submit(screen.getByTestId('create-form'));
    expect(await screen.findByTestId('create-problem')).toBeTruthy();
    expect((document.getElementById('create-period') as HTMLInputElement).value).toBe('Q3');
  });

  it('says so when the forms cannot be read, with a way to read them again, and when no form is in force', async () => {
    const h = client();
    h.lists.listMneForms = new Error('down');
    mount(<ReportCreateForm onCreated={() => undefined} onCancel={() => undefined} />, h, { permissions: WRITER });
    expect(await screen.findByTestId('create-forms-error')).toBeTruthy();
    cleanup();
    const empty = client();
    empty.lists.listMneForms = [];
    mount(<ReportCreateForm onCreated={() => undefined} onCancel={() => undefined} />, empty, { permissions: WRITER });
    expect(await screen.findByTestId('create-no-forms')).toBeTruthy();
  });
});

describe('MNE-10 correcting an issued report (correctMneReport)', () => {
  const issued = (over: Record<string, unknown> = {}) =>
    toReport({
      id: REPORT,
      status: 'ISSUED',
      form: { code: 'TT44-M01', revision: 1, title: 'Form', legal_confirmation_ref: 'X' },
      scope_unit: { code: 'CDT1', name: 'Investor one' },
      period_label: 'Q3',
      report_year: 2026,
      revision: 1,
      version: 7,
      recalled_at: null,
      ...over,
    });

  it('sends the reason under the version of the report, and opens the revision it made', async () => {
    const h = client(() => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: NEW_REPORT }));
    const onCorrected = vi.fn();
    mount(<CorrectionPanel report={issued()!} onCorrected={onCorrected} />, h, { permissions: WRITER });
    fireEvent.click(screen.getByTestId('correct-open'));
    fireEvent.change(document.getElementById('correct-reason') as HTMLTextAreaElement, { target: { value: 'The total was taken from the wrong snapshot' } });
    fireEvent.submit(screen.getByTestId('correct-form'));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('correctMneReport', expect.objectContaining({ path: { id: REPORT }, ifMatchVersion: 7, body: { correction_reason: 'The total was taken from the wrong snapshot' } })));
    await waitFor(() => expect(onCorrected).toHaveBeenCalledWith(NEW_REPORT));
  });

  it('refuses a short reason before sending, and shows a refusal of the server', async () => {
    const h = client(() => problem(409, 'REPORT_STATE_INVALID'));
    mount(<CorrectionPanel report={issued()!} onCorrected={() => undefined} />, h, { permissions: WRITER });
    fireEvent.click(screen.getByTestId('correct-open'));
    fireEvent.change(document.getElementById('correct-reason') as HTMLTextAreaElement, { target: { value: 'short' } });
    fireEvent.submit(screen.getByTestId('correct-form'));
    expect(h.command).not.toHaveBeenCalled();
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    fireEvent.change(document.getElementById('correct-reason') as HTMLTextAreaElement, { target: { value: 'A reason that is long enough' } });
    fireEvent.submit(screen.getByTestId('correct-form'));
    expect(await screen.findByTestId('correct-problem')).toBeTruthy();
  });

  it('offers nothing for a draft, says why to a person without the right, and nothing for a recalled report', () => {
    const h = client();
    mount(<CorrectionPanel report={issued({ status: 'DRAFT' })!} onCorrected={() => undefined} />, h, { permissions: WRITER });
    expect(screen.queryByTestId('correct-open')).toBeNull();
    cleanup();
    mount(<CorrectionPanel report={issued()!} onCorrected={() => undefined} />, h, { permissions: ['mne.read'] });
    expect(screen.getByTestId('correct-denied')).toBeTruthy();
    cleanup();
    mount(<CorrectionPanel report={issued({ recalled_at: '2026-10-01T00:00:00.000Z' })!} onCorrected={() => undefined} />, h, { permissions: WRITER });
    expect(screen.queryByTestId('correct-open')).toBeNull();
  });
});
