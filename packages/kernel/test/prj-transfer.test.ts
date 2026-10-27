import { decidedStatus, isDueToday, stillFromUnit } from '../src/prj-transfer.ts';

describe('the transfer of a project between units (ST-PRJ-007)', () => {
  it('decides a request that waits: approve makes it approved, reject closes it for good, return closes it so that it is asked again', () => {
    expect(['approve', 'reject', 'return'].map((decision) => decidedStatus('REQUESTED', decision as 'approve'))).toEqual(['APPROVED', 'REJECTED', 'CANCELLED']);
  });

  it('decides nothing else: a request that was approved, applied or closed is 409 STAGE_TRANSITION_DENIED', () => {
    for (const status of ['APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED'] as const) {
      expect(() => decidedStatus(status, 'approve')).toThrow(expect.objectContaining({ code: 'STAGE_TRANSITION_DENIED', status: 409 }));
    }
  });

  it('makes a transfer on its day and after it, not before', () => {
    expect([isDueToday('2027-10-01', '2027-09-30'), isDueToday('2027-10-01', '2027-10-01'), isDueToday('2027-10-01', '2027-10-02')]).toEqual([false, true, true]);
  });

  it('starts from the unit the project has: a project that moved, or has none for the scope, is not the same', () => {
    expect([stillFromUnit('a', 'a'), stillFromUnit('b', 'a'), stillFromUnit(null, 'a')]).toEqual([true, false, false]);
  });
});
