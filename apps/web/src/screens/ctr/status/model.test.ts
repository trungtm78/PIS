import { describe, expect, it } from 'vitest';
import { UUID_A } from '../workspace/test-support';
import { MAX_EXTENSION_DAYS, OPERATIONS, emptyHalt, haltBody, validateHalt } from './model';
import type { HaltForm } from './model';

const TODAY = '2026-10-25';
const form = (overrides: Partial<HaltForm> = {}): HaltForm => ({ ...emptyHalt(TODAY, 'suspend'), reason: 'A reason.', documentVersionId: UUID_A, ...overrides });

describe('validateHalt', () => {
  it('asks for an action before anything else', () => {
    expect(validateHalt(emptyHalt(TODAY, ''), TODAY)).toEqual({ action: 'required' });
  });

  it('asks for the reason, the document and the day of any action', () => {
    expect(validateHalt(emptyHalt(TODAY, 'suspend'), TODAY)).toEqual({ reason: 'required', documentVersionId: 'required' });
    expect(validateHalt(form({ reason: '  ', documentVersionId: '', day: '' }), TODAY)).toEqual({ reason: 'required', documentVersionId: 'required', day: 'required' });
    expect(validateHalt(form({ reason: 'x'.repeat(2001), documentVersionId: 'nope', day: '2026-02-30' }), TODAY)).toEqual({ reason: 'tooLong', documentVersionId: 'uuid', day: 'date' });
    expect(validateHalt(form({ day: '2026-10-26' }), TODAY)).toEqual({ day: 'future' });
    expect(validateHalt(form({ day: TODAY }), TODAY)).toEqual({});
  });

  it('takes an extension on a resumption only as whole days from 1 to the longest', () => {
    const resume = (extensionDays: string) => validateHalt(form({ action: 'resume', extensionDays }), TODAY);
    expect(resume('')).toEqual({});
    expect(resume(' 20 ')).toEqual({});
    expect(resume(String(MAX_EXTENSION_DAYS))).toEqual({});
    for (const wrong of ['0', String(MAX_EXTENSION_DAYS + 1), '1.5', '-3', 'abc', '123456']) expect(resume(wrong)).toEqual({ extensionDays: 'extension' });
    // The extension means nothing to the other actions.
    expect(validateHalt(form({ action: 'suspend', extensionDays: 'abc' }), TODAY)).toEqual({});
  });

  it('asks a termination for the guarantee action and the confirmation', () => {
    expect(validateHalt(form({ action: 'terminate' }), TODAY)).toEqual({ guaranteeAction: 'required', confirmed: 'confirm' });
    expect(validateHalt(form({ action: 'terminate', guaranteeAction: 'HOLD', confirmed: true }), TODAY)).toEqual({});
  });
});

describe('haltBody', () => {
  it('builds the body of a suspension, trimmed and lowercase', () => {
    expect(haltBody(form({ reason: ' Closed. ', documentVersionId: ` ${UUID_A.toUpperCase()} `, day: '2026-10-12' }))).toEqual({ reason: 'Closed.', decision_document_version_id: UUID_A, suspended_from: '2026-10-12' });
  });

  it('builds the body of a resumption with the extension only when there is one', () => {
    expect(haltBody(form({ action: 'resume', day: '2026-10-20', extensionDays: '20' }))).toEqual({ reason: 'A reason.', decision_document_version_id: UUID_A, resumed_on: '2026-10-20', extension_days: 20 });
    expect(haltBody(form({ action: 'resume', day: '2026-10-20' }))).toEqual({ reason: 'A reason.', decision_document_version_id: UUID_A, resumed_on: '2026-10-20' });
  });

  it('builds the body of a termination with the guarantee action', () => {
    expect(haltBody(form({ action: 'terminate', day: '2026-10-20', guaranteeAction: 'RELEASE' }))).toEqual({ reason: 'A reason.', decision_document_version_id: UUID_A, terminated_on: '2026-10-20', guarantee_action: 'RELEASE' });
    // A form that was never valid still produces a body that holds the guarantee rather than calling it.
    expect(haltBody(form({ action: 'terminate' }))).toMatchObject({ guarantee_action: 'HOLD' });
  });

  it('runs the operation of each action', () => {
    expect(OPERATIONS).toEqual({ suspend: 'suspendContract', resume: 'resumeContract', terminate: 'terminateContract' });
  });
});
