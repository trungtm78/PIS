import { DomainError } from '../src/errors.ts';
import { assertCheckerIsIndependent, assertApproverIsNotChecker, signOffLines, signOffOf } from '../src/bi-sign-off.ts';
import type { SignOffEntry } from '../src/bi-sign-off.ts';

const who = (id: string, name: string | null, at: string): SignOffEntry => ({ id, name, at });
const PREPARED = who('m1', 'Lan', '2026-11-01T01:00:00.000Z');
const CHECKED = who('m2', 'Minh', '2026-11-02T01:00:00.000Z');
const APPROVED = who('m3', 'Nam', '2026-11-03T01:00:00.000Z');

describe('the prepared, checked and approved block of a management report (BC.02)', () => {
  it('is complete only when the three people signed, and says which step it has reached', () => {
    expect(signOffOf({ versionId: 'v1', revision: 2, prepared: PREPARED, checked: CHECKED, approved: APPROVED })).toMatchObject({ state: 'APPROVED', complete: true, revision: 2 });
    expect(signOffOf({ versionId: 'v1', revision: 2, prepared: PREPARED, checked: CHECKED, approved: null })).toMatchObject({ state: 'CHECKED', complete: false });
    expect(signOffOf({ versionId: 'v1', revision: 2, prepared: PREPARED, checked: null, approved: null })).toMatchObject({ state: 'PREPARED', complete: false });
    expect(signOffOf({ versionId: null, revision: null, prepared: null, checked: null, approved: null })).toMatchObject({ state: 'UNSIGNED', complete: false });
  });

  it('keeps a publication that skipped the check step as approved but not complete: nobody is invented as the checker', () => {
    const block = signOffOf({ versionId: 'v1', revision: 1, prepared: PREPARED, checked: null, approved: APPROVED });
    expect(block.state).toBe('APPROVED');
    expect(block.checked).toBeNull();
    expect(block.complete).toBe(false);
  });

  it('prints three lines with the name and the day, and the word for a step nobody took', () => {
    const labels = { prepared: 'Prepared', checked: 'Checked', approved: 'Approved', none: 'not yet' };
    expect(signOffLines(signOffOf({ versionId: 'v', revision: 1, prepared: PREPARED, checked: null, approved: APPROVED }), labels)).toEqual([
      { key: 'prepared', label: 'Prepared', value: 'Lan, 2026-11-01' },
      { key: 'checked', label: 'Checked', value: 'not yet' },
      { key: 'approved', label: 'Approved', value: 'Nam, 2026-11-03' },
    ]);
  });

  it('prints the identifier when a person has no name in the directory, never a made-up name', () => {
    const labels = { prepared: 'P', checked: 'C', approved: 'A', none: '-' };
    const lines = signOffLines(signOffOf({ versionId: 'v', revision: 1, prepared: who('m9', null, '2026-11-01T01:00:00.000Z'), checked: null, approved: null }), labels);
    expect(lines[0]?.value).toBe('m9, 2026-11-01');
  });

  it('refuses a checker who asked for the publication or wrote the version, and an approver who checked it', () => {
    expect(() => assertCheckerIsIndependent('m1', { requestedBy: 'm1', preparedBy: 'm0' })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED', status: 403 }));
    expect(() => assertCheckerIsIndependent('m1', { requestedBy: 'm0', preparedBy: 'm1' })).toThrow(DomainError);
    expect(() => assertCheckerIsIndependent('m2', { requestedBy: 'm0', preparedBy: 'm1' })).not.toThrow();
    expect(() => assertCheckerIsIndependent('m2', { requestedBy: 'm0', preparedBy: null })).not.toThrow();
    expect(() => assertApproverIsNotChecker('m2', 'm2')).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED' }));
    expect(() => assertApproverIsNotChecker('m3', 'm2')).not.toThrow();
    expect(() => assertApproverIsNotChecker('m3', null)).not.toThrow();
  });
});
