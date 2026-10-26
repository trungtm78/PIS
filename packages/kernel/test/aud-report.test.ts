import { DomainError } from '../src/errors.ts';
import { payloadSha256 } from '../src/index.ts';
import {
  REPORT_EDGES,
  REPORT_STATUSES,
  assertAsOf,
  assertEngagementClosable,
  groupAsOf,
  groupDong,
  nextReportStatus,
  parseReportSourceRef,
  percentText,
  reportPayload,
  reportSourceRef,
  reportTotals,
} from '../src/aud-report.ts';
import type { ReportRecommendation } from '../src/aud-report.ts';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const row = (overrides: Partial<ReportRecommendation> = {}): ReportRecommendation => ({
  type: 'FINANCIAL_RECOVERY',
  status: 'CLOSED',
  amountVnd: '500000000',
  createdOn: '2026-10-15',
  closedOn: '2026-12-20',
  recoveredVnd: '500000000',
  ...overrides,
});

describe('the states of a report of results (AUD 3.6)', () => {
  it('moves a request to DOC to its answer, and an issued report only to recalled', () => {
    expect(nextReportStatus('DRAFT', 'request')).toBe('ISSUE_REQUESTED');
    expect(nextReportStatus('ISSUE_REQUESTED', 'issue')).toBe('ISSUED');
    expect(nextReportStatus('ISSUE_REQUESTED', 'reject')).toBe('REJECTED');
    expect(nextReportStatus('ISSUED', 'recall')).toBe('RECALLED');
  });

  it('refuses every other edge with 409 REPORT_STATE_INVALID, so that a rejected report cannot be issued', () => {
    for (const [action, edge] of Object.entries(REPORT_EDGES)) {
      for (const status of REPORT_STATUSES.filter((candidate) => !edge.from.includes(candidate))) {
        const error = refusal(() => nextReportStatus(status, action as keyof typeof REPORT_EDGES));
        expect([error.status, error.code]).toEqual([409, 'REPORT_STATE_INVALID']);
      }
    }
  });
});

describe('the name DOC knows a report by', () => {
  const ID = '00000000-0000-4000-8000-0000000000a1';

  it('is the id and the revision, so that a second revision is another request', () => {
    expect(reportSourceRef(ID.toUpperCase(), 2)).toBe(`AUD:audit_follow_up_report:${ID}:r2`);
    expect(parseReportSourceRef(reportSourceRef(ID, 12))).toEqual({ id: ID, revision: 12 });
  });

  it('is not read from anything else', () => {
    for (const bad of [undefined, 7, '', 'AUD:audit_follow_up_report:x:r1', `AUD:audit_follow_up_report:${ID}:r0`, `AUD:audit_follow_up_report:${ID}:r1:x`, `PAY:audit_follow_up_report:${ID}:r1`, `AUD:audit_follow_up_report:${ID.toUpperCase()}:r1`]) {
      expect(parseReportSourceRef(bad)).toBeUndefined();
    }
  });
});

describe('the day the figures are as of', () => {
  it('is today or a day before, and not before the conclusion was received', () => {
    expect(() => assertAsOf('2027-01-04', '2027-01-04', '2026-10-15')).not.toThrow();
    expect(() => assertAsOf('2026-10-15', '2027-01-04', '2026-10-15')).not.toThrow();
    for (const day of ['2027-01-05', '2026-10-14']) {
      const error = refusal(() => assertAsOf(day, '2027-01-04', '2026-10-15'));
      expect([error.status, error.code, error.detail]).toEqual([422, 'VALIDATION_FAILED', 'as_of_date']);
    }
  });
});

describe('the figures of a report (AC-ST-AUD-005-1, BR-AUD-04)', () => {
  it('AC-ST-AUD-005-1: R1 and R3 closed and R2 in progress, 1,200,000,000 recommended and 1,100,000,000 recovered', () => {
    const totals = reportTotals('2027-01-04', [
      row({ amountVnd: '500000000', recoveredVnd: '500000000' }),
      row({ status: 'IN_PROGRESS', closedOn: null, amountVnd: '400000000', recoveredVnd: '300000000' }),
      row({ amountVnd: '300000000', recoveredVnd: '300000000' }),
    ]);
    expect(totals).toMatchObject({ as_of_date: '2027-01-04', total: 3, closed: 2, in_progress: 1, open: 0, disputed: 0, amount: '1200000000', recovered: '1100000000', remaining: '100000000' });
    expect(totals.money_rate).toEqual({ numerator: '1100000000', denominator: '1200000000', percent: '91.67' });
    expect(totals.count_rate).toEqual({ numerator: '2', denominator: '3', percent: '66.67' });
  });

  it('counts what stood on the day: a recommendation closed after it was still in progress, one given after it is not there, one cancelled never counts', () => {
    const rows = [
      row({ closedOn: '2026-12-31' }),
      row({ closedOn: '2027-01-05', recoveredVnd: '100000000' }),
      row({ createdOn: '2027-01-05', status: 'OPEN', closedOn: null, recoveredVnd: '0' }),
      row({ status: 'CANCELLED', closedOn: null, recoveredVnd: '0' }),
      row({ status: 'DISPUTED', closedOn: null, amountVnd: '50', recoveredVnd: '0' }),
      row({ status: 'OPEN', closedOn: null, type: 'PROCESS_CORRECTION', amountVnd: null, recoveredVnd: '0' }),
      row({ status: 'PENDING_VERIFICATION', closedOn: null, type: 'ACCOUNTABILITY', amountVnd: null, recoveredVnd: '0' }),
    ];
    const totals = reportTotals('2027-01-04', rows);
    expect(totals).toMatchObject({ total: 5, closed: 1, in_progress: 2, open: 1, disputed: 1, amount: '1000000050', recovered: '600000000', remaining: '400000050' });
    expect(groupAsOf(rows[2] as ReportRecommendation, '2027-01-04')).toBeUndefined();
    expect(groupAsOf(rows[3] as ReportRecommendation, '2027-01-04')).toBeUndefined();
    expect(groupAsOf(rows[1] as ReportRecommendation, '2027-01-05')).toBe('closed');
    expect(groupAsOf(row({ closedOn: null }), '2027-01-04')).toBe('closed');
  });

  it('says a rate is not applicable, never 0 percent, when there is nothing to divide by', () => {
    const totals = reportTotals('2027-01-04', []);
    expect(totals).toMatchObject({ total: 0, amount: '0', recovered: '0', remaining: '0' });
    expect(totals.money_rate.percent).toBeNull();
    expect(totals.count_rate.percent).toBeNull();
  });

  it('never reports a negative remainder', () => {
    expect(reportTotals('2027-01-04', [row({ amountVnd: '10', recoveredVnd: '30' })]).remaining).toBe('0');
  });
});

describe('the payload of a report', () => {
  const totals = reportTotals('2027-01-04', [row({ amountVnd: '1200000000', recoveredVnd: '1100000000' })]);
  const facts = { agency: 'Ban Quản lý dự án', place: 'Cao Bằng', title: 'Thanh tra đầu tư cầu số 1', engagementCode: 'TTCP-2026-001', authorityName: 'Thanh tra Chính phủ', conclusionSymbol: '12/KL-TTCP', conclusionIssuedOn: '2026-10-10', totals };

  it('groups the dong by thousands and writes a percent with a comma, a dash when it is not applicable', () => {
    expect(groupDong('0')).toBe('0');
    expect(groupDong('999')).toBe('999');
    expect(groupDong('1200000000')).toBe('1.200.000.000');
    expect(percentText(totals.money_rate)).toBe('91,67%');
    expect(percentText(reportTotals('2027-01-04', []).money_rate)).toBe('-');
  });

  it('holds scalars only, none of them named amount_vnd, and the same figures give the same hash', () => {
    const payload = reportPayload(facts);
    expect(Object.values(payload).every((value) => typeof value === 'string' && value !== '')).toBe(true);
    expect(Object.keys(payload)).not.toContain('amount_vnd');
    expect(payload).toMatchObject({
      agency: 'Ban Quản lý dự án',
      place: 'Cao Bằng',
      engagement_code: 'TTCP-2026-001',
      as_of_date: '2027-01-04',
      recommendations_total: '1',
      recommended_vnd: '1.200.000.000',
      recovered_vnd: '1.100.000.000',
      remaining_vnd: '100.000.000',
      recovery_rate: '91,67%',
      completion_rate: '100,00%',
    });
    expect(payloadSha256(reportPayload(facts))).toBe(payloadSha256({ ...reportPayload(facts) }));
    expect(payloadSha256(reportPayload({ ...facts, conclusionSymbol: '13/KL-TTCP' }))).not.toBe(payloadSha256(payload));
  });
});

describe('the closure of an engagement', () => {
  it('AC-ST-AUD-005-1: a recommendation still open is 409 OPEN_RECOMMENDATIONS_REMAIN with how many', () => {
    const error = refusal(() => assertEngagementClosable({ openRecommendations: 1, conclusionsWithoutReport: 0 }));
    expect([error.status, error.code, error.extensions]).toEqual([409, 'OPEN_RECOMMENDATIONS_REMAIN', { open_recommendations: 1 }]);
  });

  it('asks for the open recommendations first and then for a report DOC issued for every conclusion that stands (422 FOLLOW_UP_REPORT_MISSING)', () => {
    expect(refusal(() => assertEngagementClosable({ openRecommendations: 2, conclusionsWithoutReport: 1 })).code).toBe('OPEN_RECOMMENDATIONS_REMAIN');
    const error = refusal(() => assertEngagementClosable({ openRecommendations: 0, conclusionsWithoutReport: 1 }));
    expect([error.status, error.code, error.extensions]).toEqual([422, 'FOLLOW_UP_REPORT_MISSING', { conclusions_without_report: 1 }]);
    expect(() => assertEngagementClosable({ openRecommendations: 0, conclusionsWithoutReport: 0 })).not.toThrow();
  });
});
