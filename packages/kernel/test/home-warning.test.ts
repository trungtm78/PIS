import { warningHistory } from '../src/home-warning.ts';
import type { WarningHistoryInput } from '../src/home-warning.ts';

const base: WarningHistoryInput = {
  openedAt: '2027-10-01T03:00:00.000Z',
  acknowledgedAt: null,
  acknowledgedBy: null,
  acknowledgementNote: null,
  explanation: null,
  closedAt: null,
  closedBy: null,
  status: 'OPEN',
  resolutionReason: null,
};

describe('the history of a warning as the profile tells it (ST-HOME-003, HOME 3 F4)', () => {
  it('begins with the day it was opened, and says nothing else of a warning nobody has touched', () => {
    expect(warningHistory(base)).toEqual([{ event: 'OPENED', at: '2027-10-01T03:00:00.000Z', by: null, note: null }]);
  });

  it('tells the acknowledgement with who and why, the explanation that was asked for, and the way it closed, in the order they happened', () => {
    const history = warningHistory({
      ...base,
      status: 'RESOLVED',
      acknowledgedAt: '2027-10-02T03:00:00.000Z',
      acknowledgedBy: 'm-ack',
      acknowledgementNote: 'Taken up by the unit.',
      explanation: { requestedAt: '2027-10-03T03:00:00.000Z', requestedBy: 'm-ask', status: 'ACCEPTED', respondedAt: '2027-10-05T03:00:00.000Z', reviewedAt: null },
      closedAt: '2027-10-06T03:00:00.000Z',
      closedBy: 'm-close',
      resolutionReason: 'The works caught up.',
    });
    expect(history.map((entry) => [entry.event, entry.by, entry.note])).toEqual([
      ['OPENED', null, null],
      ['ACKNOWLEDGED', 'm-ack', 'Taken up by the unit.'],
      ['EXPLANATION_REQUESTED', 'm-ask', null],
      ['EXPLANATION_RESPONDED', null, null],
      ['RESOLVED', 'm-close', 'The works caught up.'],
    ]);
    expect(history.map((entry) => entry.at)).toEqual([...history.map((entry) => entry.at)].sort());
  });

  it('says a dismissed warning was dismissed, and leaves out what has no moment (an explanation not answered)', () => {
    const history = warningHistory({ ...base, status: 'DISMISSED', closedAt: '2027-10-04T03:00:00.000Z', closedBy: 'm-close', resolutionReason: 'Not a slow project.', explanation: { requestedAt: '2027-10-03T03:00:00.000Z', requestedBy: 'm-ask', status: 'REQUESTED', respondedAt: null, reviewedAt: null } });
    expect(history.map((entry) => entry.event)).toEqual(['OPENED', 'EXPLANATION_REQUESTED', 'DISMISSED']);
  });

  it('never puts a step before the day the warning was opened, whatever the clocks of the rows say', () => {
    const history = warningHistory({ ...base, acknowledgedAt: '2027-09-30T03:00:00.000Z', acknowledgedBy: 'm' });
    expect(history[0]?.event).toBe('OPENED');
    expect(history.map((entry) => entry.event)).toEqual(['OPENED', 'ACKNOWLEDGED']);
  });
});
