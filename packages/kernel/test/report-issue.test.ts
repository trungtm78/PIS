import { DomainError } from '../src/errors';
import { advanceIssue, assertAcceptable, assertDeliverable, assertDistinctSignatories, assertIntegrity, assertLineage, countsAsAcceptedCopy, isDemoCopy, issueKeyOf, issueMarksOf, nextIssueOf, seriesKeyOf } from '../src/report-issue';
import { DEMO_MARK } from '../src/report-layout';
import type { ReportLayout } from '../src/report-layout';
import type { IssueStep, IssuedCopyRef } from '../src/report-issue';

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.status}:${error.detail ?? ''}` : String(error);
  }
  return undefined;
};

const sha = (character: string): string => character.repeat(64);

const copy = (revision: number, overrides: Partial<IssuedCopyRef> = {}): IssuedCopyRef => ({
  id: `copy-${revision}`,
  orgId: 'org-1',
  layoutCode: 'MONTHLY-GROUP',
  layoutVersion: '1',
  period: '2026-M10',
  revision,
  supersedes: revision === 1 ? null : `copy-${revision - 1}`,
  sha256: sha(String(revision)),
  snapshot: { snapshotId: 'snap-1', revision, cutoff: '2026-10-31' },
  ...overrides,
});

describe('signatories', () => {
  it('needs three named, different people', () => {
    expect(codeOf(() => assertDistinctSignatories({ preparer: 'a', checker: 'b', approver: 'c' }))).toBeUndefined();
    expect(codeOf(() => assertDistinctSignatories({ preparer: 'a', checker: 'a', approver: 'c' }))).toBe('SELF_APPROVAL_DENIED:403:signatories');
    expect(codeOf(() => assertDistinctSignatories({ preparer: 'a', checker: 'b', approver: 'b' }))).toBe('SELF_APPROVAL_DENIED:403:signatories');
    expect(codeOf(() => assertDistinctSignatories({ preparer: 'a', checker: 'b', approver: 'a' }))).toBe('SELF_APPROVAL_DENIED:403:signatories');
    expect(codeOf(() => assertDistinctSignatories({ preparer: 'a', checker: ' ', approver: 'c' }))).toBe('VALIDATION_FAILED:422:signatories');
  });
});

describe('advanceIssue', () => {
  const draft: IssueStep = { state: 'DRAFT', actors: { preparer: 'a', checker: null, approver: null } };

  it('goes from draft to issued in order, by three different people', () => {
    const checked = advanceIssue(draft, 'CHECK', 'b');
    expect(checked).toEqual({ state: 'CHECKED', actors: { preparer: 'a', checker: 'b', approver: null } });
    const approved = advanceIssue(checked, 'APPROVE', 'c');
    expect(approved.state).toBe('APPROVED');
    const issued = advanceIssue(approved, 'ISSUE', 'c');
    expect(issued).toEqual({ state: 'ISSUED', actors: { preparer: 'a', checker: 'b', approver: 'c' } });
  });

  it('refuses a step out of order and a step out of an issued copy', () => {
    expect(codeOf(() => advanceIssue(draft, 'APPROVE', 'c'))).toBe('REPORT_STATE_INVALID:409:issue_state');
    expect(codeOf(() => advanceIssue(draft, 'ISSUE', 'c'))).toBe('REPORT_STATE_INVALID:409:issue_state');
    const issued = advanceIssue(advanceIssue(advanceIssue(draft, 'CHECK', 'b'), 'APPROVE', 'c'), 'ISSUE', 'c');
    expect(codeOf(() => advanceIssue(issued, 'CHECK', 'd'))).toBe('REPORT_STATE_INVALID:409:issue_state');
  });

  it('keeps the three roles apart', () => {
    expect(codeOf(() => advanceIssue(draft, 'CHECK', 'a'))).toBe('SELF_APPROVAL_DENIED:403:checker');
    const checked = advanceIssue(draft, 'CHECK', 'b');
    expect(codeOf(() => advanceIssue(checked, 'APPROVE', 'a'))).toBe('SELF_APPROVAL_DENIED:403:approver');
    expect(codeOf(() => advanceIssue(checked, 'APPROVE', 'b'))).toBe('SELF_APPROVAL_DENIED:403:approver');
    const approved = advanceIssue(checked, 'APPROVE', 'c');
    expect(codeOf(() => advanceIssue(approved, 'ISSUE', 'd'))).toBe('SELF_APPROVAL_DENIED:403:issuer');
    expect(codeOf(() => advanceIssue(draft, 'CHECK', ' '))).toBe('VALIDATION_FAILED:422:actor');
  });
});

describe('lineage', () => {
  it('has no head when nothing was issued and returns the newest copy otherwise', () => {
    expect(assertLineage([])).toBeNull();
    expect(assertLineage([copy(2), copy(1), copy(3)])?.revision).toBe(3);
  });

  it('refuses a chain with a gap, a wrong link, another series, or a bad hash', () => {
    expect(codeOf(() => assertLineage([copy(2)]))).toBe('VALIDATION_FAILED:422:lineage');
    expect(codeOf(() => assertLineage([copy(1, { supersedes: 'x' })]))).toBe('VALIDATION_FAILED:422:lineage');
    expect(codeOf(() => assertLineage([copy(1), copy(3)]))).toBe('VALIDATION_FAILED:422:lineage');
    expect(codeOf(() => assertLineage([copy(1), copy(2, { supersedes: 'copy-9' })]))).toBe('VALIDATION_FAILED:422:lineage');
    expect(codeOf(() => assertLineage([copy(1), copy(2, { period: '2026-M11' })]))).toBe('VALIDATION_FAILED:422:lineage');
    expect(codeOf(() => assertLineage([copy(1, { sha256: 'zz' })]))).toBe('VALIDATION_FAILED:422:sha256');
  });

  it('names a series and an issue', () => {
    expect(seriesKeyOf(copy(1))).toBe('org-1|MONTHLY-GROUP|2026-M10');
    expect(issueKeyOf(copy(2))).toBe('org-1|MONTHLY-GROUP|2026-M10|r2');
  });
});

describe('nextIssueOf', () => {
  it('makes revision 1 first, the next revision for new bytes, and nothing for the same bytes', () => {
    expect(nextIssueOf([], sha('a'), null)).toEqual({ outcome: 'NEW', revision: 1, supersedes: null });
    expect(nextIssueOf([copy(1)], sha('b'), 'Số thực tháng 10 đã sửa')).toEqual({ outcome: 'NEW', revision: 2, supersedes: 'copy-1' });
    expect(nextIssueOf([copy(1), copy(2)], sha('2'), null)).toEqual({ outcome: 'DUPLICATE', revision: 2, supersedes: 'copy-1' });
  });
  it('wants a reason for a correction and a well formed hash', () => {
    expect(codeOf(() => nextIssueOf([copy(1)], sha('b'), null))).toBe('VALIDATION_FAILED:422:reason');
    expect(codeOf(() => nextIssueOf([copy(1)], sha('b'), '  '))).toBe('VALIDATION_FAILED:422:reason');
    expect(codeOf(() => nextIssueOf([], 'nope', null))).toBe('VALIDATION_FAILED:422:sha256');
  });
});

describe('assertIntegrity', () => {
  it('compares the bytes in the store with the bytes issued', () => {
    expect(codeOf(() => assertIntegrity(copy(1), sha('1')))).toBeUndefined();
    expect(codeOf(() => assertIntegrity(copy(1), sha('2')))).toBe('HASH_MISMATCH:422:sha256');
  });
});

describe('assertDeliverable (R17)', () => {
  it('delivers the head to a receiver that has nothing, or an older revision', () => {
    expect(assertDeliverable(copy(1), copy(1), null)).toBe('DELIVER');
    expect(assertDeliverable(copy(2), copy(2), copy(1))).toBe('DELIVER');
  });
  it('repeats a push of what the receiver holds without effect', () => {
    expect(assertDeliverable(copy(2), copy(2), copy(2))).toBe('ALREADY_DELIVERED');
  });
  it('refuses a copy that a later one replaced, and says which revision is current', () => {
    try {
      assertDeliverable(copy(1), copy(2), null);
      throw new Error('should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('REPORT_OUT_OF_DATE');
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).extensions).toEqual({ current_revision: 2 });
    }
  });
  it('refuses a copy older than the one the receiver accepted', () => {
    expect(codeOf(() => assertDeliverable(copy(1), copy(1), copy(2)))).toBe('REPORT_OUT_OF_DATE:409:revision');
  });
  it('refuses other bytes under a revision the receiver already holds', () => {
    expect(codeOf(() => assertDeliverable(copy(2, { sha256: sha('f') }), copy(2, { sha256: sha('f') }), copy(2)))).toBe('REPORT_OUT_OF_DATE:409:revision');
  });
  it('refuses a copy made from an older revision of the snapshot than the one the receiver accepted', () => {
    const accepted = copy(1, { snapshot: { snapshotId: 'snap-1', revision: 3, cutoff: '2026-10-31' } });
    const stale = copy(2, { snapshot: { snapshotId: 'snap-1', revision: 2, cutoff: '2026-10-31' } });
    expect(codeOf(() => assertDeliverable(stale, stale, accepted))).toBe('REPORT_OUT_OF_DATE:409:revision');
    const fresh = copy(2, { snapshot: { snapshotId: 'snap-1', revision: 4, cutoff: '2026-10-31' } });
    expect(assertDeliverable(fresh, fresh, accepted)).toBe('DELIVER');
    // A snapshot of another id, or a copy without a snapshot, is not judged by revision.
    const other = copy(2, { snapshot: { snapshotId: 'snap-2', revision: 1, cutoff: '2026-10-31' } });
    expect(assertDeliverable(other, other, accepted)).toBe('DELIVER');
    const none = copy(2, { snapshot: null });
    expect(assertDeliverable(none, none, accepted)).toBe('DELIVER');
  });
  it('refuses a copy of another series and a revision beyond the head', () => {
    expect(codeOf(() => assertDeliverable(copy(1, { period: '2026-M09' }), copy(1), null))).toBe('VALIDATION_FAILED:422:series');
    expect(codeOf(() => assertDeliverable(copy(1), copy(1), copy(1, { orgId: 'org-2' })))).toBe('VALIDATION_FAILED:422:series');
    expect(codeOf(() => assertDeliverable(copy(3), copy(2), null))).toBe('VALIDATION_FAILED:422:revision');
  });
});

describe('copies made on a DEMO form (R18)', () => {
  const layoutOf = (status: ReportLayout['status']): ReportLayout => ({ code: 'X-DEMO', name: 'Mẫu demo', version: '1', status, formRef: null, sheetName: 'S', moneyScale: 'MILLION_VND', headerMode: 'KEEP', columns: [], preface: [], body: [] });
  const demoMarks = { formStatus: 'DEMO' as const, demoMark: DEMO_MARK };

  it('carries the status and the demo mark in its metadata, and only when demo mode is on', () => {
    expect(codeOf(() => issueMarksOf(layoutOf('DEMO')))).toBe('TEMPLATE_UNCONFIRMED:409:demo_forms_off');
    expect(issueMarksOf(layoutOf('DEMO'), { demoMode: true })).toEqual(demoMarks);
    expect(issueMarksOf(layoutOf('READY'))).toEqual({ formStatus: 'READY', demoMark: null });
    expect(codeOf(() => issueMarksOf(layoutOf('PENDING_EXTERNAL'), { demoMode: true }))).toBe('TEMPLATE_UNCONFIRMED:409:layout_status');
  });

  it('never counts as accepted', () => {
    expect(isDemoCopy(copy(1))).toBe(false);
    expect(isDemoCopy(copy(1, { marks: demoMarks }))).toBe(true);
    expect(isDemoCopy(copy(1, { marks: { formStatus: 'READY', demoMark: DEMO_MARK } }))).toBe(true);
    expect(countsAsAcceptedCopy(copy(1, { marks: { formStatus: 'READY', demoMark: null } }))).toBe(true);
    expect(codeOf(() => assertAcceptable(copy(1)))).toBeUndefined();
    expect(codeOf(() => assertAcceptable(copy(1, { marks: demoMarks })))).toBe('TEMPLATE_UNCONFIRMED:409:demo_not_acceptable');
  });

  it('is not an acceptance that holds back a delivery', () => {
    const second = copy(2);
    expect(assertDeliverable(second, second, copy(2, { marks: demoMarks, sha256: sha('9') }))).toBe('DELIVER');
    expect(codeOf(() => assertDeliverable(second, second, copy(2, { sha256: sha('9') })))).toBe('REPORT_OUT_OF_DATE:409:revision');
  });
});
