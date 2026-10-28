import { INCOMING_STATUSES, assertIncomingTransition, incomingIdentity, isWorkable, stateSecretMarking, workingDaysLate } from '../src/index.ts';
import type { DomainError, IncomingCommand, IncomingStatus, WorkCalendarContent } from '../src/index.ts';

const thrown = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('did not throw');
};

describe('the chain of an incoming document (ST-DOC-011, DOC.md F10)', () => {
  it('AC-ST-DOC-011-1: UAT-AC419 goes from received to filed one step at a time, a reassignment keeps the letter assigned, and a rejection is only from received', () => {
    expect(assertIncomingTransition('register', 'RECEIVED')).toBe('REGISTERED');
    expect(assertIncomingTransition('assign', 'REGISTERED')).toBe('ASSIGNED');
    expect(assertIncomingTransition('assign', 'ASSIGNED')).toBe('ASSIGNED');
    expect(assertIncomingTransition('assign', 'PROCESSING')).toBe('ASSIGNED');
    expect(assertIncomingTransition('startProcessing', 'ASSIGNED')).toBe('PROCESSING');
    expect(assertIncomingTransition('resolve', 'PROCESSING')).toBe('RESOLVED');
    expect(assertIncomingTransition('file', 'RESOLVED')).toBe('FILED');
    expect(assertIncomingTransition('reject', 'RECEIVED')).toBe('REJECTED');
  });

  it('refuses every other step with 409 DOCUMENT_STATE_INVALID: no skipping, no going back, nothing after filed or rejected', () => {
    const allowed: Record<IncomingCommand, readonly IncomingStatus[]> = {
      register: ['RECEIVED'],
      assign: ['REGISTERED', 'ASSIGNED', 'PROCESSING'],
      startProcessing: ['ASSIGNED'],
      resolve: ['PROCESSING'],
      reject: ['RECEIVED'],
      file: ['RESOLVED'],
    };
    for (const [command, from] of Object.entries(allowed) as Array<[IncomingCommand, readonly IncomingStatus[]]>) {
      for (const status of INCOMING_STATUSES.filter((candidate) => !from.includes(candidate))) {
        const error = thrown(() => assertIncomingTransition(command, status));
        expect([command, status, error.code, error.status]).toEqual([command, status, 'DOCUMENT_STATE_INVALID', 409]);
        expect(error.extensions).toMatchObject({ incoming_status: status });
      }
    }
  });

  it('only a letter that is being worked can be overdue', () => {
    expect(INCOMING_STATUSES.filter(isWorkable)).toEqual(['ASSIGNED', 'PROCESSING']);
  });
});

describe('the state secret (BR-DOC-20, AC-ST-DOC-011-3)', () => {
  it('AC-ST-DOC-011-3: UAT-AC429 reads a level of secret from the marking as it is written on a letter, with or without marks', () => {
    for (const text of ['TỐI MẬT', 'Công văn TUYỆT MẬT số 12', 'TOI MAT - Bao cao', 'Độ mật: MẬT', 'ĐỘ MẬT - MẬT', 'Báo cáo (MẬT)', '[MẬT] Kế hoạch']) expect([text, stateSecretMarking(text)]).toEqual([text, true]);
  });

  it('does not take a word for a marking', () => {
    for (const text of ['Quy chế bảo mật thông tin', 'Tối mật độ dân số', 'MẬT ĐỘ XÂY DỰNG', 'Mật khẩu', 'Báo cáo về đảm bảo an ninh mạng', 'Độ mật của vữa']) expect([text, stateSecretMarking(text)]).toEqual([text, false]);
  });
});

describe('the duplicate (BR-DOC-18)', () => {
  it('names a letter by its sender, its symbol and its day, without case, marks or spaces', () => {
    const one = incomingIdentity({ senderName: 'Bộ Tài chính', originalSymbol: '1234/BTC-ĐTPT', originalIssuedOn: '2026-10-20' });
    expect(incomingIdentity({ senderName: '  BỘ  TÀI CHÍNH ', originalSymbol: '1234/btc-đtpt', originalIssuedOn: '2026-10-20' })).toBe(one);
    expect(incomingIdentity({ senderName: 'Bo Tai chinh', originalSymbol: '1234/BTC-DTPT', originalIssuedOn: '2026-10-20' })).toBe(one);
    expect(incomingIdentity({ senderName: 'Bộ Tài chính', originalSymbol: '1234/BTC-ĐTPT', originalIssuedOn: '2026-10-21' })).not.toBe(one);
    expect(incomingIdentity({ senderName: 'Bộ Kế hoạch', originalSymbol: '1234/BTC-ĐTPT', originalIssuedOn: '2026-10-20' })).not.toBe(one);
    // A letter with no symbol or no day cannot be matched.
    expect(incomingIdentity({ senderName: 'Bộ Tài chính', originalSymbol: undefined, originalIssuedOn: '2026-10-20' })).toBeUndefined();
    expect(incomingIdentity({ senderName: 'Bộ Tài chính', originalSymbol: '1', originalIssuedOn: undefined })).toBeUndefined();
  });
});

describe('the lateness of a letter (BR-DOC-18, AC-ST-DOC-011-2)', () => {
  const calendar = (overrides: Partial<WorkCalendarContent> = {}): WorkCalendarContent => ({ calendar_code: 'VN-STD', year: 2026, working_days: [1, 2, 3, 4, 5], holidays: [], legal_basis_ref: 'Labour Code 2019 art. 112', ...overrides });

  it('AC-ST-DOC-011-2: UAT-AC420 is one day late the day after the deadline, and not late on the deadline', () => {
    const source = { forYear: (year: number) => (year === 2026 ? calendar() : undefined) };
    expect(workingDaysLate('2026-10-27', '2026-10-28', source)).toBe(1);
    expect(workingDaysLate('2026-10-27', '2026-10-27', source)).toBe(0);
    expect(workingDaysLate('2026-10-27', '2026-10-26', source)).toBe(0);
  });

  it('counts working days only: a weekend and a holiday are not late', () => {
    // 2026-10-30 is a Friday; the 31st and the 1st are a weekend; the 2nd is a holiday; the 3rd is Tuesday.
    const source = { forYear: (year: number) => (year === 2026 ? calendar({ holidays: [{ date: '2026-11-02', name: 'Day off' }] }) : undefined) };
    expect(workingDaysLate('2026-10-30', '2026-11-01', source)).toBe(0);
    expect(workingDaysLate('2026-10-30', '2026-11-02', source)).toBe(0);
    expect(workingDaysLate('2026-10-30', '2026-11-03', source)).toBe(1);
    expect(workingDaysLate('2026-10-30', '2026-11-04', source)).toBe(2);
    // A compensated day is worked.
    const compensated = { forYear: (year: number) => (year === 2026 ? calendar({ compensated_workdays: ['2026-10-31'] }) : undefined) };
    expect(workingDaysLate('2026-10-30', '2026-10-31', compensated)).toBe(1);
  });

  it('counts the weekdays when no calendar is published, so that a reminder does not wait for one', () => {
    expect(workingDaysLate('2026-10-27', '2026-10-28', undefined)).toBe(1);
    expect(workingDaysLate('2026-10-30', '2026-11-04', undefined)).toBe(3);
    expect(workingDaysLate('2026-10-27', '2026-10-28', { forYear: () => undefined })).toBe(1);
  });
});
