import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { ADAPTER_STATUSES, DIRECTIONS, MAX_ATTEMPTS, PAGE_SIZE, STATUSES, describeProblem, holds, linkOf, mayRetry, queryOf, toMessage, toPage } from './model';
import type { InteropMessage } from './model';
import { acked, dead, failed, incomingId, outgoingId, received } from './test-support';

const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const message = (raw: unknown): InteropMessage => {
  const read = toMessage(raw);
  if (read === undefined) throw new Error('the message was not read');
  return read;
};
const MANAGE = ['doc.interop.read', 'doc.interop.manage'];

describe('the model of the monitor of the LGSP (DOC-20)', () => {
  it('names the directions, the statuses, the adapters and the limits the server holds', () => {
    expect(DIRECTIONS).toEqual(['OUTBOUND', 'INBOUND']);
    expect(STATUSES).toEqual(['QUEUED', 'SENT', 'ACKED', 'REJECTED', 'FAILED', 'DEAD', 'RECEIVED', 'PROCESSED']);
    expect(ADAPTER_STATUSES).toEqual(['VERIFIED', 'PROPOSED', 'MOCK', 'MISSING']);
    expect([PAGE_SIZE, MAX_ATTEMPTS]).toEqual([50, 20]);
  });

  describe('reading a message', () => {
    it('keeps what the server says, and no more', () => {
      expect(toMessage(failed(1))).toEqual({
        id: failed(1).id,
        direction: 'OUTBOUND',
        status: 'FAILED',
        adapterCode: 'LGSP_EDXML',
        adapterStatus: 'MOCK',
        externalMessageId: null,
        senderCode: 'G08.SO-XD',
        receiverCode: 'G08.SKHDT',
        outgoingDocumentId: outgoingId(1),
        incomingDocumentId: null,
        attempts: 2,
        nextAttemptAt: '2026-11-03T03:03:00.000Z',
        errorCode: 'PROVIDER_UNAVAILABLE',
        processedAt: null,
        createdAt: '2026-11-03T03:00:00.000Z',
        updatedAt: '2026-11-03T03:01:00.000Z',
        canRetry: true,
        version: 4,
      });
    });

    it.each([
      ['no row', undefined],
      ['a row that is a list', []],
      ['no id', { ...failed(1), id: undefined }],
      ['a direction nobody knows', failed(1, { direction: 'SIDEWAYS' })],
      ['a status nobody knows', failed(1, { status: 'LOST' })],
      ['an adapter nobody knows', failed(1, { adapter_status: 'REAL' })],
      ['attempts that are not a whole number', failed(1, { attempts: 1.5 })],
      ['no version', failed(1, { version: undefined })],
      ['no creation time', failed(1, { created_at: undefined })],
      ['no update time', failed(1, { updated_at: 7 })],
    ])('leaves out %s', (_name, raw) => {
      expect(toMessage(raw)).toBeUndefined();
    });

    it('takes the permission to retry from the server and nothing else', () => {
      expect(message(failed(1, { actions: { retry: false } })).canRetry).toBe(false);
      expect(message(failed(1, { actions: undefined })).canRetry).toBe(false);
      expect(message(failed(1, { actions: { retry: 'yes' } })).canRetry).toBe(false);
    });

    it('tolerates text members that are missing', () => {
      expect(message({ ...failed(1), adapter_code: undefined, error_code: 7 })).toMatchObject({ adapterCode: '', errorCode: null });
    });
  });

  it('reads a page: the messages it can read, the cursor of the next page and the moment it was read', () => {
    const page = toPage({ items: [failed(1), { nonsense: true }, dead(2)], next_cursor: 'abc', as_of: '2026-11-03T03:10:00.000Z' });
    expect(page).toMatchObject({ next: 'abc', asOf: '2026-11-03T03:10:00.000Z' });
    expect(page.items.map((item) => item.status)).toEqual(['FAILED', 'DEAD']);
    expect(toPage({ items: [], next_cursor: null })).toEqual({ items: [], next: undefined, asOf: '' });
    expect(toPage(undefined)).toEqual({ items: [], next: undefined, asOf: '' });
    expect(toPage({ items: 'x' }).items).toEqual([]);
  });

  describe('the query of the read', () => {
    it('always carries the size of a page and only what is narrowed besides', () => {
      expect(queryOf({ status: '', direction: '' }, undefined)).toEqual({ limit: 50 });
      expect(queryOf({ status: 'DEAD', direction: 'OUTBOUND' }, 'next')).toEqual({ limit: 50, status: 'DEAD', direction: 'OUTBOUND', cursor: 'next' });
      expect(queryOf({ status: 'FAILED', direction: '' }, undefined)).toEqual({ limit: 50, status: 'FAILED' });
    });
  });

  describe('who is offered to send a message again', () => {
    it('offers it for a failed or dead message to a manager in a session that can write', () => {
      expect(mayRetry(message(failed(1)), MANAGE, 'FULL')).toBe(true);
      expect(mayRetry(message(dead(2)), MANAGE, undefined)).toBe(true);
      expect(mayRetry(message(dead(2)), undefined, 'FULL')).toBe(true);
    });

    it('does not offer it without the right to manage, in a read-only session, or for a message that is not failed or dead', () => {
      expect(mayRetry(message(failed(1)), ['doc.interop.read'], 'FULL')).toBe(false);
      expect(mayRetry(message(failed(1)), MANAGE, 'READ_ONLY')).toBe(false);
      expect(mayRetry(message(acked(3)), MANAGE, 'FULL')).toBe(false);
      expect(mayRetry(message(failed(1, { actions: { retry: false } })), MANAGE, 'FULL')).toBe(false);
      expect(mayRetry(message(failed(1, { status: 'QUEUED' })), MANAGE, 'FULL')).toBe(false);
    });
  });

  it('holds a right when the permissions are not known yet (the server judges) or when it is listed', () => {
    expect(holds(undefined, 'doc.interop.read')).toBe(true);
    expect(holds(['doc.interop.read'], 'doc.interop.read')).toBe(true);
    expect(holds(['doc.register.read'], 'doc.interop.read')).toBe(false);
  });

  it('leads a message to the distributions of its document, or to the letter it made, and nowhere else', () => {
    expect(linkOf(message(failed(1)))).toBe(`/doc/doc-08?doc=${outgoingId(1)}`);
    expect(linkOf(message(received(2)))).toBe(`/doc/doc-13?id=${incomingId(2)}`);
    expect(linkOf(message(received(3, { incoming_document_id: null, status: 'RECEIVED' })))).toBeUndefined();
  });

  describe('the refusals', () => {
    it.each([
      ['VERSION_CONFLICT', 'versionConflict'],
      ['INTEROP_STATE_INVALID', 'stateInvalid'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ])('words %s as %s', (code, expected) => {
      expect(describeProblem(problem(code))).toBe(expected);
    });

    it('words a failure that is not an answer of the server as a general one', () => {
      expect(describeProblem(new Error('boom'))).toBe('general');
      expect(describeProblem(undefined)).toBe('general');
    });
  });
});
