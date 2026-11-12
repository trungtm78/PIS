import { describe, expect, it } from 'vitest';
import { taskDetail, uuid } from '../test/fixtures';
import {
  EMPTY_EVIDENCE,
  EMPTY_EXCEPTION,
  actionsOf,
  approvedWaivers,
  blockerRows,
  completeBody,
  decisionBody,
  evidenceBody,
  exceptionBody,
  historyGroups,
  kpiInputs,
  returnBody,
  startBody,
  statusTone,
  validateEvidence,
  validateException,
} from './model';
import type { EvidenceForm, ExceptionForm } from './model';

const exceptionForm = (over: Partial<ExceptionForm> = {}): ExceptionForm => ({ ...EMPTY_EXCEPTION, kind: 'PAUSE', validFrom: '2026-12-01', reason: 'Chờ cơ quan có thẩm quyền trả lời văn bản', ...over });
const evidenceForm = (over: Partial<EvidenceForm> = {}): EvidenceForm => ({ ...EMPTY_EVIDENCE, evidenceKind: 'DOCUMENT', externalRef: 'https://example.org/bien-ban', ...over });

describe('PWF-04 which buttons show', () => {
  it('follows the can_* flags of the server and nothing else', () => {
    const all = taskDetail({ can_start: true, can_complete: true, can_approve: true, can_return: true, can_request_exception: true, can_resume: true, can_assign: true });
    expect(actionsOf(all, false)).toEqual({ start: true, complete: true, approve: true, return: true, resume: true, requestException: true, decideException: true, work: true, assign: true });
    const none = taskDetail({ can_start: false, can_complete: false, can_approve: false, can_return: false, can_request_exception: false, can_resume: false, can_assign: false });
    expect(Object.values(actionsOf(none, false)).every((value) => value === false)).toBe(true);
  });

  it('hides every writing control in a read-only session', () => {
    const all = taskDetail({ can_start: true, can_complete: true, can_approve: true, can_return: true, can_request_exception: true, can_resume: true, can_assign: true });
    expect(Object.values(actionsOf(all, true)).every((value) => value === false)).toBe(true);
  });
});

describe('PWF-04 what blocks the completion', () => {
  it('joins the blockers with what a waiver could cover, each once', () => {
    const task = taskDetail({
      completion: {
        ok: false,
        blockers: [
          { code: 'CHECKLIST_ITEM_OPEN', subject: 'C1' },
          { code: 'MAKER_IS_APPROVER', subject: 'U1' },
        ],
        coverable: [{ code: 'CHECKLIST_ITEM_OPEN', subject: 'C1' }, { code: 'FORM_MISSING', subject: 'F1' }],
      },
    });
    expect(blockerRows(task.completion)).toEqual([
      { code: 'CHECKLIST_ITEM_OPEN', subject: 'C1', coverable: true },
      { code: 'MAKER_IS_APPROVER', subject: 'U1', coverable: false },
      { code: 'FORM_MISSING', subject: 'F1', coverable: true },
    ]);
    expect(blockerRows({ ok: true, blockers: [], coverable: [] })).toEqual([]);
  });

  it('offers only the approved waivers that cover a requirement', () => {
    const task = taskDetail({
      exceptions: [
        { id: uuid(1), task_id: uuid(2), kind: 'WAIVE_REQUIREMENT', items: ['C1'], valid_from: null, valid_to: null, reason: 'x'.repeat(20), evidence_ref: null, status: 'APPROVED', requested_by: uuid(3), decided_by: uuid(4), decided_at: null, decision_note: null, version: 2 },
        { id: uuid(5), task_id: uuid(2), kind: 'WAIVE_REQUIREMENT', items: ['C2'], valid_from: null, valid_to: null, reason: 'x'.repeat(20), evidence_ref: null, status: 'REQUESTED', requested_by: uuid(3), decided_by: null, decided_at: null, decision_note: null, version: 1 },
        { id: uuid(6), task_id: uuid(2), kind: 'PAUSE', items: [], valid_from: '2026-12-01', valid_to: null, reason: 'x'.repeat(20), evidence_ref: null, status: 'APPROVED', requested_by: uuid(3), decided_by: uuid(4), decided_at: null, decision_note: null, version: 2 },
      ],
    });
    expect(approvedWaivers(task).map((item) => item.id)).toEqual([uuid(1)]);
  });
});

describe('PWF-04 exception request', () => {
  it('asks for a reason of at least 20 characters', () => {
    expect(validateException(exceptionForm({ reason: 'ngắn' })).reason).toBe('tooShort');
    expect(validateException(exceptionForm({ reason: '' })).reason).toBe('required');
    expect(validateException(exceptionForm())).toEqual({});
  });

  it('asks for the items of a waiver and for the first day of a pause or an external delay', () => {
    expect(validateException(exceptionForm({ kind: 'WAIVE_REQUIREMENT', items: '  ' })).items).toBe('required');
    expect(validateException(exceptionForm({ kind: 'WAIVE_REQUIREMENT', items: 'C1' }))).toEqual({});
    expect(validateException(exceptionForm({ kind: 'PAUSE', validFrom: '' })).validFrom).toBe('required');
    expect(validateException(exceptionForm({ kind: 'EXTERNAL_DELAY', validFrom: '' })).validFrom).toBe('required');
    expect(validateException(exceptionForm({ kind: 'CANCEL_TASK', validFrom: '' }))).toEqual({});
  });

  it('checks the days, the end not before the start', () => {
    expect(validateException(exceptionForm({ validFrom: '2026-13-01' })).validFrom).toBe('invalidDay');
    expect(validateException(exceptionForm({ validTo: 'x' })).validTo).toBe('invalidDay');
    expect(validateException(exceptionForm({ validTo: '2026-11-30' })).validTo).toBe('invalidDay');
    expect(validateException(exceptionForm({ validTo: '2026-12-05' }))).toEqual({});
    expect(validateException(exceptionForm({ kind: 'CANCEL_TASK', validFrom: 'x' })).validFrom).toBe('invalidDay');
  });

  it('sends the items one by one, the days that were given and the reference that was given', () => {
    expect(exceptionBody(exceptionForm({ kind: 'WAIVE_REQUIREMENT', items: ' C1, F1 ,, ', validFrom: '', evidenceRef: ' QD-12 ' }))).toEqual({ kind: 'WAIVE_REQUIREMENT', items: ['C1', 'F1'], reason: 'Chờ cơ quan có thẩm quyền trả lời văn bản', evidence_ref: 'QD-12' });
    expect(exceptionBody(exceptionForm({ validTo: '2026-12-05' }))).toEqual({ kind: 'PAUSE', valid_from: '2026-12-01', valid_to: '2026-12-05', reason: 'Chờ cơ quan có thẩm quyền trả lời văn bản' });
  });
});

describe('PWF-04 evidence', () => {
  it('asks for a kind and for a document or a link to one', () => {
    expect(validateEvidence(evidenceForm())).toEqual({});
    expect(validateEvidence(evidenceForm({ evidenceKind: ' ' })).evidenceKind).toBe('required');
    expect(validateEvidence(evidenceForm({ externalRef: '' })).externalRef).toBe('pickOne');
    expect(validateEvidence(evidenceForm({ externalRef: '', documentId: uuid(9) }))).toEqual({});
    expect(validateEvidence(evidenceForm({ externalRef: '', documentId: 'abc' })).documentId).toBe('pickOne');
  });

  it('sends only what was filled in', () => {
    expect(evidenceBody(evidenceForm())).toEqual({ evidence_kind: 'DOCUMENT', external_ref: 'https://example.org/bien-ban' });
    expect(evidenceBody(evidenceForm({ externalRef: '', documentId: uuid(9), itemCode: 'C1', legalDocType: 'INVESTMENT_DECISION', formTemplateCode: 'FORM_REPORT', note: ' ghi chú ' }))).toEqual({
      evidence_kind: 'DOCUMENT',
      document_id: uuid(9),
      item_code: 'C1',
      legal_doc_type: 'INVESTMENT_DECISION',
      form_template_code: 'FORM_REPORT',
      note: 'ghi chú',
    });
  });
});

describe('PWF-04 command bodies', () => {
  it('sends a reason or a note only when there is one', () => {
    expect(startBody(undefined)).toEqual({});
    expect(startBody(' sớm hơn tiền nhiệm vì được phép ')).toEqual({ early_start_reason: 'sớm hơn tiền nhiệm vì được phép' });
    expect(completeBody({ actualFinish: '', exceptionId: '', note: '' })).toEqual({});
    expect(completeBody({ actualFinish: '2026-12-10', exceptionId: uuid(1), note: ' xong ' })).toEqual({ actual_finish: '2026-12-10', exception_id: uuid(1), note: 'xong' });
    expect(decisionBody('APPROVE', undefined)).toEqual({ decision: 'APPROVE' });
    expect(decisionBody('REJECT', ' không đủ căn cứ ')).toEqual({ decision: 'REJECT', note: 'không đủ căn cứ' });
    expect(returnBody(' thiếu biên bản nghiệm thu ')).toEqual({ reason: 'thiếu biên bản nghiệm thu' });
  });
});

describe('PWF-04 presentation helpers', () => {
  it('gives every status a tone', () => {
    expect(['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'DONE', 'ON_HOLD', 'CANCELLED'].map((status) => statusTone(status as never))).toEqual(['neutral', 'info', 'warning', 'success', 'neutral', 'danger']);
  });

  it('groups the history by the day in Vietnam time, newest day first, newest entry first', () => {
    const groups = historyGroups([
      { id: 'a', kind: 'START', at: '2026-12-01T01:00:00.000Z', actor: null, reason: null },
      { id: 'b', kind: 'RETURNED', at: '2026-12-01T18:00:00.000Z', actor: null, reason: 'thiếu' },
      { id: 'c', kind: 'COMPLETED', at: '2026-12-02T02:00:00.000Z', actor: null, reason: null },
    ]);
    expect(groups.map((group) => group.date)).toEqual(['2026-12-02', '2026-12-01']);
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual(['c', 'b']);
    expect(groups[1]?.entries.map((entry) => entry.id)).toEqual(['a']);
  });

  it('lists the inputs of a KPI result as name and value pairs, text for anything that is not a plain value', () => {
    expect(kpiInputs({ due: '2026-12-10', days: 3, done: true, nothing: null, nested: { a: 1 } })).toEqual([
      ['days', '3'],
      ['done', 'true'],
      ['due', '2026-12-10'],
      ['nested', '{"a":1}'],
      ['nothing', '–'],
    ]);
  });
});
