import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { DOC_STAGES, describeReportProblem, docStageOf, dong, draftsOf, drillPath, canFile, hasReason, instantOf, isEditable, isOwnReport, mayDecide, mayExport, mayRequestIssue, shortHash, missingCells, narrativeChanges, shown } from './report-model';
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

  describe('review, approval and issue (ST-MNE-003)', () => {
    const report = { status: 'IN_REVIEW' as const, createdBy: 'author', submittedBy: 'submitter' };

    it('lets a person approve a report in review only when they hold the right and neither wrote it nor handed it in', () => {
      const rights = ['mne.report.approve'];
      expect(mayDecide(report, rights, false, 'someone')).toBe(true);
      expect(mayDecide(report, rights, false, 'author')).toBe(false);
      expect(mayDecide(report, rights, false, 'submitter')).toBe(false);
      expect(mayDecide(report, ['mne.read'], false, 'someone')).toBe(false);
      expect(mayDecide(report, rights, true, 'someone')).toBe(false);
      expect(mayDecide({ ...report, status: 'APPROVED' }, rights, false, 'someone')).toBe(false);
      expect(mayDecide(report, undefined, false, undefined)).toBe(true);
      expect(isOwnReport(report, 'author')).toBe(true);
      expect(isOwnReport(report, 'someone')).toBe(false);
      expect(isOwnReport({ createdBy: 'author', submittedBy: null }, 'submitter')).toBe(false);
    });

    it('lets a person ask for the issue of an approved report only when they hold the right and the system is not read-only', () => {
      expect(mayRequestIssue({ status: 'APPROVED' }, ['mne.report.issue'], false)).toBe(true);
      expect(mayRequestIssue({ status: 'APPROVED' }, ['mne.report.approve'], false)).toBe(false);
      expect(mayRequestIssue({ status: 'APPROVED' }, ['mne.report.issue'], true)).toBe(false);
      for (const status of ['IN_REVIEW', 'ISSUING', 'ISSUED'] as const) expect(mayRequestIssue({ status }, ['mne.report.issue'], false)).toBe(false);
    });

    it('wants a reason of five characters once trimmed', () => {
      expect(hasReason('  ok  ')).toBe(false);
      expect(hasReason('fine!')).toBe(true);
    });

    it('reads the stage of the document from the state DOC keeps it in', () => {
      expect(DOC_STAGES).toEqual(['drafting', 'awaitingSignature', 'numbered', 'published']);
      expect(docStageOf(null)).toBe('none');
      expect(['DRAFT', 'IN_REVIEW'].map(docStageOf)).toEqual(['drafting', 'drafting']);
      expect(docStageOf('SUBMITTED')).toBe('awaitingSignature');
      expect(['SIGNED', 'NUMBERED', 'SEALED'].map(docStageOf)).toEqual(['numbered', 'numbered', 'numbered']);
      expect(['ISSUED', 'DELIVERED', 'ACKNOWLEDGED', 'FILED', 'ARCHIVED'].map(docStageOf)).toEqual(['published', 'published', 'published', 'published', 'published']);
      expect(['CANCELLED', 'RECALLED', 'REPLACED', 'CORRECTED', 'SOMETHING'].map(docStageOf)).toEqual(['withdrawn', 'withdrawn', 'withdrawn', 'withdrawn', 'withdrawn']);
    });

    it('says why a decision failed: the self-approval, the missing template', () => {
      expect(describeReportProblem(problem('SELF_APPROVAL_DENIED'))).toEqual({ reason: 'selfApproval', fields: [] });
      expect(describeReportProblem(problem('DOC_TEMPLATE_MISSING'))).toEqual({ reason: 'templateMissing', fields: [] });
    });
  });

  describe('the files of an issued report (ST-MNE-004)', () => {
    it('lets a person make files only of an issued report that was not recalled, when they hold the right and the system is not read-only', () => {
      const rights = ['mne.report.export'];
      for (const status of ['ISSUED', 'EXPORTED', 'SUBMITTED_EXTERNAL'] as const) expect(mayExport({ status, recalledAt: null }, rights, false)).toBe(true);
      for (const status of ['DRAFT', 'IN_REVIEW', 'APPROVED', 'ISSUING', 'RETURNED', 'SUPERSEDED'] as const) expect(mayExport({ status, recalledAt: null }, rights, false)).toBe(false);
      expect(mayExport({ status: 'ISSUED', recalledAt: '2026-10-01T00:00:00Z' }, rights, false)).toBe(false);
      expect(mayExport({ status: 'ISSUED', recalledAt: null }, ['mne.read'], false)).toBe(false);
      expect(mayExport({ status: 'ISSUED', recalledAt: null }, rights, true)).toBe(false);
      expect(mayExport({ status: 'ISSUED', recalledAt: null }, undefined, false)).toBe(true);
    });

    it('shows a hash by its first twelve characters and its last four, and a short one as it is', () => {
      expect(shortHash('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBe('a1b2c3d4e5f6…8f90');
      expect(shortHash('abcd')).toBe('abcd');
    });

    it('lets a package take its receipt only while it is offered', () => {
      expect(['GENERATED', 'DOWNLOADED'].map((status) => canFile({ status: status as 'GENERATED' }))).toEqual([true, true]);
      expect(['SUBMISSION_CONFIRMED', 'REJECTED', 'EXPIRED'].map((status) => canFile({ status: status as 'EXPIRED' }))).toEqual([false, false, false]);
    });

    it('reads the moment of a filing from a form field, and nothing from a field that is not a date', () => {
      expect(instantOf('2026-07-09T10:30')).toBe(new Date('2026-07-09T10:30').toISOString());
      expect(instantOf('')).toBeUndefined();
      expect(instantOf('not a date')).toBeUndefined();
    });

    it('says why a command on a package failed', () => {
      expect(describeReportProblem(problem('RECEIPT_REQUIRED'))).toEqual({ reason: 'receiptRequired', fields: [] });
      expect(describeReportProblem(problem('REPORT_NOT_ISSUED'))).toEqual({ reason: 'notIssued', fields: [] });
      expect(describeReportProblem(problem('EXPORT_FORMAT_UNSUPPORTED'))).toEqual({ reason: 'formatUnsupported', fields: [] });
      expect(describeReportProblem(problem('PACKAGE_STATE_INVALID'))).toEqual({ reason: 'packageState', fields: [] });
    });
  });
});
