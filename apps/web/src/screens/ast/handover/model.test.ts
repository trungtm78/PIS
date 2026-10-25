import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FIX,
  EMPTY_VERIFY,
  canDraft,
  createBody,
  decisionBody,
  describeProblem,
  emptyCreate,
  emptyDecision,
  emptyItem,
  evidenceIds,
  fixBody,
  itemBody,
  openCritical,
  toHandover,
  toHandoverList,
  toTrace,
  validateCreate,
  validateDecision,
  validateFix,
  validateItem,
  validateReason,
  validateVerify,
  vietnamToday,
} from './model';
import type { CreateForm, DecisionForm, ItemForm } from './model';
import { AS_BUILT, DOCUMENT, MINUTES, PHOTO, allowed, handover, handoverId, item, itemAllowed, itemId, trace, unitId } from './test-support';

const problem = (code: string, extensions: Record<string, unknown> = {}, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions });
const TODAY = '2026-10-25';

const filled = (overrides: Partial<CreateForm> = {}): CreateForm => ({
  contractId: 'c',
  kind: 'COMPLETION',
  handoverNo: ' BG-1 ',
  recipientUnitId: unitId(1),
  qualityAcceptanceId: MINUTES.toUpperCase(),
  plannedOn: '2026-11-10',
  documentVersionId: DOCUMENT,
  ...overrides,
});
const itemFilled = (overrides: Partial<ItemForm> = {}): ItemForm => ({ ...emptyItem(TODAY), description: ' Tay vịn lỏng ', severity: 'CRITICAL', dueOn: '2026-11-05', ...overrides });

describe('toHandover', () => {
  it('reads a handover with its unit, its documents, its count of critical defects and what the caller may do', () => {
    const line = toHandover(
      handover(1, { status: 'PUNCH_PENDING', open_critical_punch_count: 2, punch_item_count: 5, as_built_document_version_id: AS_BUILT, allowed: allowed({ add_item: true, approve: true }) }),
    );
    expect(line).toMatchObject({
      id: handoverId(1),
      handoverNo: 'BG-001',
      kind: 'COMPLETION',
      status: 'PUNCH_PENDING',
      contract: { code: 'HD-A-002', status: 'ACTIVE' },
      recipientUnit: { id: unitId(1), name: 'Sở Giao thông' },
      qualityAcceptanceId: MINUTES,
      openCriticalCount: 2,
      itemCount: 5,
      asBuiltDocumentVersionId: AS_BUILT,
      allowed: { addItem: true, approve: true, return: false, reject: false },
      version: 1,
    });
  });

  it('keeps what is missing as nothing and refuses what cannot be shown', () => {
    expect(toHandover({ ...handover(1), recipient_unit: null, allowed: null, contract: { id: 'c' } })).toMatchObject({
      recipientUnit: { id: '', name: '' },
      contract: { code: '' },
      allowed: { addItem: false, approve: false, return: false, reject: false },
    });
    expect(toHandover(null)).toBeUndefined();
    expect(toHandover({ ...handover(1), handover_kind: 'WHOLE' })).toBeUndefined();
    expect(toHandover({ ...handover(1), status: 'GONE' })).toBeUndefined();
    expect(toHandover({ ...handover(1), version: 'one' })).toBeUndefined();
    expect(toHandover({ ...handover(1), contract: {} })).toBeUndefined();
    expect(toHandover({ ...handover(1), id: 7 })).toBeUndefined();
    expect(toHandoverList({ items: [handover(1), { id: 'x' }, handover(2)] }).map((line) => line.id)).toEqual([handoverId(1), handoverId(2)]);
    expect(toHandoverList({ items: 'none' })).toEqual([]);
    expect(toHandoverList(undefined)).toEqual([]);
  });
});

describe('toTrace', () => {
  it('reads the punch list with what the caller may do with each item, the assets, the documents and the minutes', () => {
    const read = toTrace(
      trace({
        items: [
          item(1, { severity: 'CRITICAL', allowed: itemAllowed({ fix: true }), location_text: 'Cầu thang B' }),
          item(2, { status: 'FIXED', fixed_note: 'Đã siết', reopen_count: 1, allowed: itemAllowed({ verify: true, waive: true }), overdue: true }),
          { id: 'x' },
          item(3, { responsible_contractor: null }),
        ],
        assets: [{ id: 'a1', asset_code: 'AS-001', name: 'Trạm bơm', value_vnd: '3200000000', status: 'DRAFT' }, { id: 'a2' }, { asset_code: 'no id' }],
        documents: [{ role: 'MINUTES', document_version_id: DOCUMENT }, { role: 'AS_BUILT' }, { document_version_id: 'x' }],
      }),
    );
    expect(read?.items.map((entry) => [entry.itemNo, entry.severity, entry.status, entry.allowed.fix, entry.allowed.verify, entry.allowed.waive])).toEqual([
      [1, 'CRITICAL', 'OPEN', true, false, false],
      [2, 'MAJOR', 'FIXED', false, true, true],
      [3, 'MAJOR', 'OPEN', false, false, false],
    ]);
    expect(read?.items[0]).toMatchObject({ locationText: 'Cầu thang B', contractor: { name: 'Nhà thầu An Phát' } });
    expect(read?.items[1]).toMatchObject({ fixedNote: 'Đã siết', reopenCount: 1, overdue: true });
    expect(read?.items[2]?.contractor).toBeNull();
    expect(read?.assets).toEqual([
      { id: 'a1', assetCode: 'AS-001', name: 'Trạm bơm', valueVnd: '3200000000', status: 'DRAFT' },
      { id: 'a2', assetCode: '', name: null, valueVnd: '0', status: '' },
    ]);
    expect(read?.documents).toEqual([{ role: 'MINUTES', documentVersionId: DOCUMENT }]);
    expect(read?.qualityAcceptance).toEqual({ id: MINUTES, recordNo: 'QA-C-001', scope: 'COMPLETION', status: 'APPROVED' });
    expect(toTrace(trace({ quality_acceptance: null, items: 'none', assets: 'none', documents: 'none' }))).toMatchObject({ qualityAcceptance: null, items: [], assets: [], documents: [] });
    expect(toTrace(trace({ quality_acceptance: { id: MINUTES } }))?.qualityAcceptance).toMatchObject({ recordNo: MINUTES, scope: '', status: '' });
    expect(toTrace({ handover: null })).toBeUndefined();
    expect(toTrace(null)).toBeUndefined();
  });

  it('counts the critical items that are not verified', () => {
    const read = toTrace(trace({ items: [item(1, { severity: 'CRITICAL' }), item(2, { severity: 'CRITICAL', status: 'FIXED' }), item(3, { severity: 'CRITICAL', status: 'VERIFIED' }), item(4)] }));
    expect(openCritical(read?.items ?? []).map((entry) => entry.itemNo)).toEqual([1, 2]);
    expect(itemId(1)).toBeTruthy();
  });
});

describe('drafting a handover', () => {
  it('may be done by whoever holds the permission, or when it is not yet known, unless the session is read only', () => {
    expect(canDraft(['handover.manage'], 'FULL')).toBe(true);
    expect(canDraft(undefined, undefined)).toBe(true);
    expect(canDraft(['handover.manage'], 'READ_ONLY')).toBe(false);
    expect(canDraft(['handover.read'], 'FULL')).toBe(false);
  });

  it('sees what is wrong before it is sent: the minutes are needed for the handover of the completion and for no other', () => {
    expect(validateCreate(filled())).toEqual({});
    expect(Object.keys(validateCreate(emptyCreate())).sort()).toEqual(['contractId', 'documentVersionId', 'handoverNo', 'kind', 'recipientUnitId']);
    expect(validateCreate(emptyCreate('c'))).not.toHaveProperty('contractId');
    expect(validateCreate(filled({ kind: 'COMPLETION', qualityAcceptanceId: '' }))).toEqual({ qualityAcceptanceId: 'required' });
    expect(validateCreate(filled({ kind: 'PARTIAL', qualityAcceptanceId: '' }))).toEqual({});
    expect(validateCreate(filled({ qualityAcceptanceId: 'nope', documentVersionId: 'nope' }))).toEqual({ qualityAcceptanceId: 'uuid', documentVersionId: 'uuid' });
    expect(validateCreate(filled({ handoverNo: 'x'.repeat(2001), plannedOn: '2026-02-30' }))).toEqual({ handoverNo: 'tooLong', plannedOn: 'date' });
    expect(validateCreate(filled({ plannedOn: '' }))).toEqual({});
  });

  it('sends the project of the contract, the number trimmed and the identifiers in lower case, and leaves out what was not given', () => {
    expect(createBody(filled(), 'p')).toEqual({
      project_id: 'p',
      contract_id: 'c',
      recipient_unit_id: unitId(1),
      handover_kind: 'COMPLETION',
      handover_no: 'BG-1',
      document_version_id: DOCUMENT,
      quality_acceptance_id: MINUTES,
      planned_on: '2026-11-10',
    });
    expect(createBody(filled({ kind: 'PARTIAL', qualityAcceptanceId: '', plannedOn: '' }), 'p')).toEqual({
      project_id: 'p',
      contract_id: 'c',
      recipient_unit_id: unitId(1),
      handover_kind: 'PARTIAL',
      handover_no: 'BG-1',
      document_version_id: DOCUMENT,
    });
    expect(createBody(emptyCreate(), 'p').handover_kind).toBe('COMPLETION');
  });
});

describe('the punch list', () => {
  it('sees what is wrong with a defect before it is put on the list', () => {
    expect(validateItem(itemFilled(), TODAY)).toEqual({});
    expect(Object.keys(validateItem(emptyItem(TODAY), TODAY)).sort()).toEqual(['description', 'severity']);
    expect(validateItem(itemFilled({ dueOn: '2026-10-24' }), TODAY)).toEqual({ dueOn: 'past' });
    expect(validateItem(itemFilled({ dueOn: '2026-02-30' }), TODAY)).toEqual({ dueOn: 'date' });
    expect(validateItem(itemFilled({ dueOn: '' }), TODAY)).toEqual({ dueOn: 'required' });
    expect(validateItem(itemFilled({ locationText: 'x'.repeat(2001), responsibleContractorId: 'nope', defectPhotoId: 'nope' }), TODAY)).toEqual({
      locationText: 'tooLong',
      responsibleContractorId: 'uuid',
      defectPhotoId: 'uuid',
    });
    expect(vietnamToday(new Date('2026-10-25T18:00:00Z'))).toBe('2026-10-26');
    expect(vietnamToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('sends the defect with the words trimmed and the optional fields only when given', () => {
    expect(itemBody(itemFilled())).toEqual({ description: 'Tay vịn lỏng', severity: 'CRITICAL', due_on: '2026-11-05' });
    expect(itemBody(itemFilled({ locationText: ' Cầu thang B ', responsibleContractorId: ` ${PHOTO.toUpperCase()} `, defectPhotoId: PHOTO }))).toEqual({
      description: 'Tay vịn lỏng',
      severity: 'CRITICAL',
      due_on: '2026-11-05',
      location_text: 'Cầu thang B',
      responsible_contractor_id: PHOTO,
      evidence_photo_id: PHOTO,
    });
    expect(itemBody(emptyItem(TODAY)).severity).toBe('MINOR');
  });

  it('answers with a photo or a document and a note, and verifies with a verdict and a note', () => {
    expect(validateFix(EMPTY_FIX)).toEqual({ photoId: 'required', note: 'required' });
    expect(validateFix({ photoId: PHOTO, documentVersionId: '', note: 'Đã siết' })).toEqual({});
    expect(validateFix({ photoId: '', documentVersionId: DOCUMENT, note: 'Đã siết' })).toEqual({});
    expect(validateFix({ photoId: 'nope', documentVersionId: 'nope', note: 'x' })).toEqual({ photoId: 'uuid', documentVersionId: 'uuid' });
    expect(fixBody({ photoId: ` ${PHOTO.toUpperCase()} `, documentVersionId: '', note: ' Xong ' })).toEqual({ note: 'Xong', evidence_photo_id: PHOTO });
    expect(fixBody({ photoId: '', documentVersionId: DOCUMENT, note: 'Xong' })).toEqual({ note: 'Xong', evidence_document_version_id: DOCUMENT });
    expect(validateVerify(EMPTY_VERIFY)).toEqual({ outcome: 'required', note: 'required' });
    expect(validateVerify({ outcome: 'REOPEN', note: 'Vẫn lỏng' })).toEqual({});
    expect(validateReason('')).toBe('required');
    expect(validateReason('x'.repeat(2001))).toBe('tooLong');
    expect(validateReason('Chỉ là thẩm mỹ')).toBeUndefined();
  });
});

describe('the decision', () => {
  const base = (overrides: Partial<DecisionForm> = {}): DecisionForm => ({
    ...emptyDecision(toHandover(handover(1)) as never),
    decision: 'approve',
    reason: ' Đủ điều kiện ',
    asBuilt: AS_BUILT,
    ...overrides,
  });

  it('starts from the documents the handover already holds', () => {
    const held = toHandover(handover(1, { as_built_document_version_id: AS_BUILT, om_manual_document_version_id: DOCUMENT, warranty_certificate_document_version_id: PHOTO }));
    expect(emptyDecision(held as never)).toEqual({ decision: '', reason: '', asBuilt: AS_BUILT, manual: DOCUMENT, certificate: PHOTO, evidence: '' });
    expect(emptyDecision(toHandover(handover(1)) as never)).toMatchObject({ asBuilt: '', manual: '', certificate: '' });
  });

  it('sees what is wrong before it is sent: the acceptance needs the as-built dossier, the other decisions do not', () => {
    expect(validateDecision(base())).toEqual({});
    expect(Object.keys(validateDecision(base({ decision: '', reason: '' }))).sort()).toEqual(['decision', 'reason']);
    expect(validateDecision(base({ asBuilt: '' }))).toEqual({ asBuilt: 'required' });
    expect(validateDecision(base({ decision: 'return', asBuilt: '' }))).toEqual({});
    expect(validateDecision(base({ decision: 'reject', asBuilt: 'nope', manual: 'nope', certificate: 'nope' }))).toEqual({ asBuilt: 'uuid', manual: 'uuid', certificate: 'uuid' });
    expect(validateDecision(base({ evidence: 'nonsense' }))).toEqual({ evidence: 'uuid' });
    expect(validateDecision(base({ evidence: Array.from({ length: 51 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`).join('\n') }))).toEqual({ evidence: 'tooMany' });
    expect(evidenceIds(base({ evidence: `${DOCUMENT}\n${DOCUMENT.toUpperCase()}, ${AS_BUILT}` }))).toEqual([DOCUMENT, DOCUMENT, AS_BUILT]);
  });

  it('sends the documents only with an acceptance, and each evidence once', () => {
    expect(decisionBody(base({ manual: DOCUMENT, certificate: ` ${PHOTO.toUpperCase()} `, evidence: `${DOCUMENT}, ${DOCUMENT}` }))).toEqual({
      decision: 'approve',
      reason: 'Đủ điều kiện',
      evidence_ids: [DOCUMENT],
      as_built_document_version_id: AS_BUILT,
      om_manual_document_version_id: DOCUMENT,
      warranty_certificate_document_version_id: PHOTO,
    });
    expect(decisionBody(base({ decision: 'reject', manual: DOCUMENT }))).toEqual({ decision: 'reject', reason: 'Đủ điều kiện', evidence_ids: [] });
    expect(decisionBody(base({ decision: '', asBuilt: '' })).decision).toBe('return');
  });
});

describe('describeProblem', () => {
  it('words every refusal the commands can meet', () => {
    expect(describeProblem(problem('CONTRACT_STATE_INVALID', {}, 409))).toEqual({ problem: 'contractState', detail: [] });
    expect(describeProblem(problem('QUALITY_ACCEPTANCE_REQUIRED', { reason: 'MISSING' }))).toEqual({ problem: 'minutesRequired', detail: [] });
    expect(describeProblem(problem('PERMIT_GATE_BLOCKED', {}, 409))).toEqual({ problem: 'permitGate', detail: [] });
    expect(describeProblem(problem('HANDOVER_STATE_INVALID', {}, 409)).problem).toBe('handoverState');
    expect(describeProblem(problem('PUNCH_STATE_INVALID', {}, 409)).problem).toBe('punchState');
    expect(describeProblem(problem('OPEN_CRITICAL_PUNCH', { item_nos: [1, 3, 'x'] }))).toEqual({ problem: 'openCritical', detail: ['1', '3'] });
    expect(describeProblem(problem('OPEN_CRITICAL_PUNCH'))).toEqual({ problem: 'openCritical', detail: [] });
    expect(describeProblem(problem('AS_BUILT_REQUIRED')).problem).toBe('asBuiltRequired');
    expect(describeProblem(problem('CRITICAL_CANNOT_BE_WAIVED')).problem).toBe('criticalWaiver');
    expect(describeProblem(problem('EVIDENCE_REQUIRED')).problem).toBe('evidenceRequired');
    expect(describeProblem(problem('SELF_APPROVAL_DENIED', {}, 403)).problem).toBe('selfApproval');
    expect(describeProblem(problem('DOCUMENT_NOT_CLEAN')).problem).toBe('notClean');
    expect(describeProblem(problem('FILE_NOT_CLEAN')).problem).toBe('notClean');
    expect(describeProblem(problem('VERSION_CONFLICT', {}, 409)).problem).toBe('versionConflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(problem(code, {}, 400)).problem).toBe('validation');
    expect(describeProblem(problem('RESOURCE_NOT_FOUND', {}, 404)).problem).toBe('notFound');
    expect(describeProblem(problem('SCOPE_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('ENTITLEMENT_DENIED', {}, 403)).problem).toBe('denied');
    expect(describeProblem(problem('SESSION_EXPIRED', {}, 401)).problem).toBe('session');
    expect(describeProblem(problem('SOMETHING_ELSE', {}, 500)).problem).toBe('general');
    expect(describeProblem(new Error('x')).problem).toBe('general');
  });
});
