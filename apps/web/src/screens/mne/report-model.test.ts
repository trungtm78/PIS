import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { describeReportProblem, dong, draftsOf, drillPath, isEditable, missingCells, narrativeChanges, shown } from './report-model';
import { toReport } from './types';
import type { ReportField } from './types';

const cell = (overrides: Partial<ReportField> & Pick<ReportField, 'key'>): ReportField => ({ label: overrides.key, kind: 'TEXT', required: false, locked: false, source: null, value: null, ...overrides });
const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

describe('the report of MNE-03 (ST-MNE-002)', () => {
  it('writes whole dong with dots, a negative amount with its sign, and a rate with its percent sign', () => {
    expect(dong('1250000000000')).toBe('1.250.000.000.000');
    expect(dong('-1500')).toBe('-1.500');
    expect(dong('0')).toBe('0');
    expect(shown(cell({ key: 'a', kind: 'MONEY', value: '600000000000' }))).toBe('600.000.000.000');
    expect(shown(cell({ key: 'b', kind: 'PERCENT', value: '48.0000' }))).toBe('48.0000%');
    expect(shown(cell({ key: 'c', kind: 'INTEGER', value: 4 }))).toBe('4');
    expect(shown(cell({ key: 'd', value: null }))).toBeNull();
  });

  it('lets a draft be written only by a person who prepares reports, outside the read-only mode', () => {
    expect(isEditable({ status: 'DRAFT' }, ['mne.report.prepare'], false)).toBe(true);
    expect(isEditable({ status: 'DRAFT' }, undefined, false)).toBe(true);
    expect(isEditable({ status: 'DRAFT' }, ['mne.read'], false)).toBe(false);
    expect(isEditable({ status: 'DRAFT' }, ['mne.report.prepare'], true)).toBe(false);
    expect(isEditable({ status: 'IN_REVIEW' }, ['mne.report.prepare'], false)).toBe(false);
  });

  it('sends only the written cells that changed, an emptied cell as null, and never a locked cell', () => {
    const report = {
      fields: [
        cell({ key: 'plan', kind: 'MONEY', locked: true, value: '1' }),
        cell({ key: 'assessment', value: 'Old' }),
        cell({ key: 'difficulties', value: 'Keep' }),
        cell({ key: 'outlook', value: null }),
      ],
    };
    const drafts = { ...draftsOf(report), assessment: ' New ', difficulties: 'Keep', outlook: '   ', plan: '999' };
    expect(narrativeChanges(report, drafts)).toEqual({ assessment: 'New' });
    expect(narrativeChanges(report, { ...draftsOf(report), difficulties: '' })).toEqual({ difficulties: null });
    expect(draftsOf(report)).toEqual({ assessment: 'Old', difficulties: 'Keep', outlook: '' });
  });

  it('finds the required cells that are still empty: a locked one without a figure, a written one without words', () => {
    const report = {
      fields: [
        cell({ key: 'rate', kind: 'PERCENT', required: true, locked: true, value: null }),
        cell({ key: 'plan', kind: 'MONEY', required: true, locked: true, value: '1' }),
        cell({ key: 'assessment', required: true }),
        cell({ key: 'outlook', required: false }),
      ],
    };
    expect(missingCells(report, { assessment: '   ', outlook: '' })).toEqual(['rate', 'assessment']);
    expect(missingCells(report, { assessment: 'Done' })).toEqual(['rate']);
  });

  it('points a locked cell to the HOME drill of its snapshot, and a written cell or an empty report to nothing', () => {
    const source = { kind: 'SNAPSHOT_METRIC' as const, detail: 'rate_pm_pct' };
    const path = drillPath({ snapshotId: 'S-1' }, { key: 'rate', source });
    const target = new URL(path ?? '', 'http://local');
    expect(target.pathname).toBe('/home/home-10');
    expect([target.searchParams.get('snapshot'), target.searchParams.get('source'), target.searchParams.get('detail'), target.searchParams.get('field')]).toEqual(['S-1', 'SNAPSHOT_METRIC', 'rate_pm_pct', 'rate']);
    expect(drillPath({ snapshotId: 'S-1' }, { key: 'text', source: null })).toBeUndefined();
    expect(drillPath({ snapshotId: null }, { key: 'rate', source })).toBeUndefined();
  });

  it('says why a command failed: the code, and the cells the server named', () => {
    expect(describeReportProblem(problem('FIELD_SOURCE_LOCKED', { fields: ['plan', 7] }))).toEqual({ reason: 'locked', fields: ['plan'] });
    expect(describeReportProblem(problem('VALIDATION_FAILED', { missing_fields: ['assessment'] }))).toEqual({ reason: 'missing', fields: ['assessment'] });
    expect(describeReportProblem(problem('VALIDATION_FAILED'))).toEqual({ reason: 'invalid', fields: [] });
    expect(describeReportProblem(problem('SNAPSHOT_REQUIRED'))).toEqual({ reason: 'snapshotRequired', fields: [] });
    expect(describeReportProblem(problem('VERSION_CONFLICT'))).toEqual({ reason: 'conflict', fields: [] });
    expect(describeReportProblem(problem('SOMETHING_ELSE'))).toEqual({ reason: 'general', fields: [] });
    expect(describeReportProblem(new Error('x'))).toEqual({ reason: 'general', fields: [] });
  });

  it('reads a report from its answer, and refuses an answer that lacks the form, the unit or a known status', () => {
    const answer = {
      id: 'R-1',
      form: { code: 'TT44-M02', revision: 2, title: 'Form', legal_confirmation_ref: 'CXN-REF', watermark_text: null },
      scope_unit: { code: 'U', name: 'Unit' },
      status: 'DRAFT',
      period_label: 'H1-2026',
      snapshot: { id: 'S-1', as_of_date: '2026-06-30' },
      fields: [
        { key: 'plan', label: 'Plan', kind: 'MONEY', required: true, locked: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' }, value: '10' },
        { key: 'count', label: 'Count', kind: 'INTEGER', locked: true, source: { kind: 'WARNING_COUNT', severity: null }, value: 3 },
        { key: 'broken', kind: 'NOPE' },
        { key: 'note', label: '', kind: 'TEXT', value: 'x' },
      ],
      version: 5,
    };
    const report = toReport(answer);
    expect(report).toMatchObject({ id: 'R-1', formRevision: 2, awaitingConfirmation: false, snapshotId: 'S-1', asOfDate: '2026-06-30', version: 5, periodLabel: 'H1-2026' });
    expect(report?.fields.map((field) => field.key)).toEqual(['plan', 'count', 'note']);
    expect(report?.fields[0]).toMatchObject({ locked: true, required: true, source: { kind: 'SNAPSHOT_METRIC', detail: 'plan_total_vnd' }, value: '10' });
    expect(report?.fields[2]).toMatchObject({ label: 'note', locked: false, source: null });
    expect(toReport({ ...answer, form: undefined })).toBeUndefined();
    expect(toReport({ ...answer, scope_unit: null })).toBeUndefined();
    expect(toReport({ ...answer, status: 'WHATEVER' })).toBeUndefined();
    expect(toReport({ ...answer, id: '' })).toBeUndefined();
    expect(toReport({ ...answer, snapshot: null })).toMatchObject({ snapshotId: null, asOfDate: null });
  });
});
