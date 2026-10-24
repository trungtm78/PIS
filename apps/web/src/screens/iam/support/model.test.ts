import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { DESCRIPTION_MAX, EMPTY_FORM, SUBJECT_MAX, describeProblem, formatInstant, hasErrors, isOverdue, ticketBody, toTicket, validateTicket } from './model';
import type { TicketForm } from './model';
import { ticket } from './test-support';

const form = (change: Partial<TicketForm> = {}): TicketForm => ({ category: 'ACCESS', subject: 'Tôi không mở được sổ đăng ký', description: 'Từ sáng nay sổ đăng ký báo tôi không có quyền.', ...change });
const problem = (code: string, detail?: string) => new ApiError({ status: 422, code, correlationId: 'c', extensions: {}, ...(detail === undefined ? {} : { detail }) });

describe('reading a ticket', () => {
  it('reads the code, the group, the subject, the priority, the state and the SLA, and whether it is the caller’s', () => {
    expect(toTicket(ticket(1))).toEqual({
      id: ticket(1).id,
      code: 'SUP-2026-000001',
      category: 'ACCESS',
      subject: 'Tôi không mở được sổ đăng ký dự án số 1',
      priority: 'P2',
      status: 'Open',
      slaDueAt: '2026-10-27T02:00:00.000000Z',
      createdAt: '2026-10-26T02:00:00.000000Z',
      attachmentCount: 0,
      own: true,
      version: 1,
    });
    expect(toTicket(ticket(1, { own: false, attachment_count: 2 }))).toMatchObject({ own: false, attachmentCount: 2 });
    expect(toTicket(ticket(1, { own: undefined, attachment_count: undefined }))).toMatchObject({ own: false, attachmentCount: 0 });
  });

  it.each([
    ['not an object', 'x'],
    ['no id', ticket(1, { id: undefined })],
    ['no code', ticket(1, { ticket_code: undefined })],
    ['a group that is not one', ticket(1, { category: 'OPINION' })],
    ['no subject', ticket(1, { subject: '' })],
    ['a priority that is not one', ticket(1, { priority: 'P9' })],
    ['a state that is not one', ticket(1, { status: 'Gone' })],
    ['no SLA time', ticket(1, { sla_due_at: undefined })],
    ['no creation time', ticket(1, { created_at: undefined })],
    ['a version that is not whole', ticket(1, { version: 1.5 })],
  ])('refuses %s', (_name, raw) => {
    expect(toTicket(raw)).toBeUndefined();
  });
});

describe('the moments', () => {
  it('shows a moment in Vietnam time, day first', () => {
    expect(formatInstant('2026-10-27T02:00:00.000000Z')).toBe('27/10/2026 09:00');
    expect(formatInstant('2026-12-31T17:30:00Z')).toBe('01/01/2027 00:30');
    expect(formatInstant('later')).toBe('later');
  });

  it('is overdue when the operator still owes an answer and the time has passed', () => {
    const now = new Date('2026-10-27T03:00:00Z');
    expect(isOverdue({ status: 'Open', slaDueAt: '2026-10-27T02:00:00Z' }, now)).toBe(true);
    expect(isOverdue({ status: 'InProgress', slaDueAt: '2026-10-27T02:00:00Z' }, now)).toBe(true);
    expect(isOverdue({ status: 'Open', slaDueAt: '2026-10-27T04:00:00Z' }, now)).toBe(false);
    for (const status of ['WaitingCustomer', 'Resolved', 'Closed'] as const) expect(isOverdue({ status, slaDueAt: '2026-10-27T02:00:00Z' }, now)).toBe(false);
  });
});

describe('validating the form before it is sent', () => {
  it('accepts a subject and a description within their lengths, a description over several lines', () => {
    expect(hasErrors(validateTicket(form()))).toBe(false);
    expect(hasErrors(validateTicket(form({ description: 'Dòng một của mô tả.\nDòng hai.\tCó cả tab.' })))).toBe(false);
    expect(hasErrors(validateTicket(form({ subject: 'x'.repeat(SUBJECT_MAX), description: 'y'.repeat(DESCRIPTION_MAX) })))).toBe(false);
  });

  it('says what is missing, too short, too long or not text', () => {
    expect(validateTicket(EMPTY_FORM)).toEqual({ subject: 'required', description: 'required' });
    expect(validateTicket(form({ subject: 'Help', description: 'Help me' }))).toEqual({ subject: 'tooShort', description: 'tooShort' });
    expect(validateTicket(form({ subject: 'x'.repeat(SUBJECT_MAX + 1), description: 'y'.repeat(DESCRIPTION_MAX + 1) }))).toEqual({ subject: 'tooLong', description: 'tooLong' });
    expect(validateTicket(form({ subject: 'Hai dòng\nthì không được', description: 'chuông\u0007 trong mô tả' }))).toEqual({ subject: 'invalidText', description: 'invalidText' });
  });
});

describe('the body of the command', () => {
  it('sends the group and the two texts, trimmed, and nothing the server decides', () => {
    expect(ticketBody(form({ subject: '  Tôi không mở được  ', description: '  Từ sáng nay.  ' }))).toEqual({ category: 'ACCESS', subject: 'Tôi không mở được', description: 'Từ sáng nay.' });
  });
});

describe('what the server refused', () => {
  it('names the reason and the field of the form it is about', () => {
    expect(describeProblem(problem('VALIDATION_FAILED', 'subject'))).toEqual({ reason: 'validation', field: 'subject' });
    expect(describeProblem(problem('VALIDATION_FAILED', 'description'))).toEqual({ reason: 'validation', field: 'description' });
    expect(describeProblem(problem('VALIDATION_FAILED', 'attachment_ids'))).toEqual({ reason: 'validation', field: undefined });
    expect(describeProblem(problem('FIELD_NOT_ALLOWED'))).toEqual({ reason: 'validation', field: undefined });
    expect(describeProblem(problem('INVALID_REQUEST'))).toEqual({ reason: 'validation', field: undefined });
    expect(describeProblem(problem('SCOPE_DENIED'))).toEqual({ reason: 'denied', field: undefined });
    expect(describeProblem(problem('PERMISSION_DENIED'))).toEqual({ reason: 'denied', field: undefined });
    expect(describeProblem(problem('SOMETHING_ELSE'))).toEqual({ reason: 'general', field: undefined });
    expect(describeProblem(new Error('offline'))).toEqual({ reason: 'general', field: undefined });
  });
});
