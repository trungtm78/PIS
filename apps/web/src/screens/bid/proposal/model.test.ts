import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DECIDE,
  EMPTY_DECLARE,
  EMPTY_INTAKE,
  canEvaluate,
  canReceive,
  declareBody,
  decideBody,
  describeProblem,
  hasProblems,
  momentText,
  openPackages,
  openingOf,
  orderedProposals,
  receiveBody,
  sizeText,
  toContractorOption,
  toDeclaration,
  toDeclarationList,
  toProposal,
  toUploadedProposalFile,
  validateDecide,
  validateDeclare,
  validateIntake,
} from './model';
import type { IntakeForm } from './model';
import { toTrackedPackage } from '../procurement/model';
import { declaration, files, opened, pack, proposal } from './test-support';

const NOW = new Date('2026-11-11T08:00:00.000Z');
const UPLOADED = { fileObjectKey: 'tenants/t/document/d', fileSha256: 'a'.repeat(64), sizeBytes: 1000, pageCount: 3 };
const form = (overrides: Partial<IntakeForm> = {}): IntakeForm => ({
  contractorId: 'c1',
  submittedAt: '2026-11-10T09:30',
  price: '17650000000',
  files: [{ uid: 1, part: 'TECHNICAL', title: 'Technical volume', fileName: 'v1.pdf', uploaded: UPLOADED }],
  ...overrides,
});

describe('the model of BID-05 (ST-BID-004)', () => {
  it('says who may receive and who may evaluate: the permission, and a session that is not read-only', () => {
    expect(canReceive(['bid.proposal.receive'], 'FULL')).toBe(true);
    expect(canReceive(['bid.proposal.receive'], undefined)).toBe(true);
    expect(canReceive(['bid.proposal.receive'], 'READ_ONLY')).toBe(false);
    expect(canReceive(['bid.evaluate'], 'FULL')).toBe(false);
    expect(canReceive(undefined, 'FULL')).toBe(false);
    expect(canEvaluate(['bid.evaluate'], 'FULL')).toBe(true);
    expect(canEvaluate(['bid.evaluate'], 'READ_ONLY')).toBe(false);
    expect(canEvaluate(['bid.proposal.receive'], 'FULL')).toBe(false);
  });

  it('keeps the packages that are open for bids, by code', () => {
    const shown = openPackages([pack(2), pack(4, { status: 'DRAFT' }), pack(3, { status: 'IN_REVIEW' }), pack(1)].flatMap((raw) => toTrackedPackage(raw) ?? []));
    expect(shown.map((item) => item.code)).toEqual(['GT-1', 'GT-2']);
  });

  it('reads the opening of a package: the day it happened, else the day it is planned for, else none', () => {
    const line = (kind: string, planned: string | null, actual: string | null) => ({ id: kind, packageId: 'p1', kind: kind as never, plannedAt: planned, actualAt: actual, source: 'MANUAL' as const });
    expect(openingOf('p1', [line('BID_OPENING', '2026-11-12T02:00:00.000Z', '2026-11-12T03:00:00.000Z')])).toBe('2026-11-12T03:00:00.000Z');
    expect(openingOf('p1', [line('BID_OPENING', '2026-11-12T02:00:00.000Z', null)])).toBe('2026-11-12T02:00:00.000Z');
    expect(openingOf('p1', [line('BID_CLOSING', '2026-11-12T01:00:00.000Z', null)])).toBeNull();
    expect(openingOf('p2', [line('BID_OPENING', '2026-11-12T02:00:00.000Z', null)])).toBeNull();
  });

  it('writes a moment as Vietnam wall-clock text', () => {
    expect(momentText('2026-11-12T02:00:00.000Z')).toBe('2026-11-12 09:00');
    expect(momentText(null)).toBe('');
  });

  describe('reading a proposal', () => {
    it('reads the receipt of a sealed proposal, without a price and without files', () => {
      expect(toProposal(proposal(1, 1))).toEqual({
        id: expect.any(String),
        packageId: expect.any(String),
        packageCode: 'GT-1',
        contractorId: expect.any(String),
        contractorName: 'Công ty nhà thầu 1',
        revision: 1,
        status: 'RECEIVED',
        submittedAt: '2026-11-10T02:00:00.000Z',
        accessReleasedAt: '2099-11-12T02:00:00.000Z',
        locked: true,
        fileCount: 2,
        access: 'METADATA',
        bidPriceVnd: null,
        documents: [],
        version: 1,
      });
    });

    it('reads a proposal in full with its price and its files', () => {
      const full = toProposal({ ...opened(1, 1), documents: files });
      expect(full).toMatchObject({ access: 'FULL', locked: false, bidPriceVnd: '17650000000' });
      expect(full?.documents.map((file) => [file.part, file.title, file.pageCount, file.sizeBytes])).toEqual([
        ['TECHNICAL', 'Đề xuất kỹ thuật', 120, 3 * 1024 * 1024],
        ['FINANCIAL', 'Đề xuất tài chính', 12, 200 * 1024],
      ]);
    });

    it('treats a proposal as locked unless the server says otherwise, and drops what is not a proposal', () => {
      expect(toProposal({ ...proposal(1, 1), locked: undefined })?.locked).toBe(true);
      for (const broken of [undefined, null, 'x', {}, { ...proposal(1, 1), access: 'EVERYTHING' }, { ...proposal(1, 1), status: 'LOST' }, { ...proposal(1, 1), revision: '1' }, { ...proposal(1, 1), contractor: {} }, { ...proposal(1, 1), package: null }]) {
        expect(toProposal(broken)).toBeUndefined();
      }
    });

    it('lists the live proposals first, the newest first, then the replaced ones', () => {
      const lines = [
        proposal(1, 1, { status: 'SUPERSEDED', submitted_at: '2026-11-11T02:00:00.000Z' }),
        proposal(2, 1, { submitted_at: '2026-11-10T02:00:00.000Z' }),
        proposal(3, 1, { submitted_at: '2026-11-11T01:00:00.000Z' }),
      ].flatMap((raw) => toProposal(raw) ?? []);
      expect(orderedProposals(lines).map((item) => [item.status, item.contractorName])).toEqual([
        ['RECEIVED', 'Công ty nhà thầu 3'],
        ['RECEIVED', 'Công ty nhà thầu 2'],
        ['SUPERSEDED', 'Công ty nhà thầu 1'],
      ]);
    });

    it('offers the verified contractors, and marks the one that is restricted', () => {
      expect(toContractorOption({ id: 'c', legal_name: 'A', verification_status: 'VERIFIED', restriction_in_force: null })).toEqual({ id: 'c', legalName: 'A', restricted: false });
      expect(toContractorOption({ id: 'c', legal_name: 'A', verification_status: 'VERIFIED', restriction_in_force: { id: 'r' } })?.restricted).toBe(true);
      expect(toContractorOption({ id: 'c', legal_name: 'A', verification_status: 'UNVERIFIED' })).toBeUndefined();
      expect(toContractorOption(null)).toBeUndefined();
    });

    it('reads the answer of the upload door', () => {
      expect(toUploadedProposalFile({ file_object_key: 'k', file_sha256: 'h', size_bytes: 5, page_count: 2 })).toEqual({ fileObjectKey: 'k', fileSha256: 'h', sizeBytes: 5, pageCount: 2 });
      expect(toUploadedProposalFile({ file_object_key: 'k' })).toBeUndefined();
      expect(toUploadedProposalFile(undefined)).toBeUndefined();
    });

    it('writes the size of a file in the unit a person reads', () => {
      expect(sizeText(null)).toBe('');
      expect(sizeText(100)).toBe('1 KB');
      expect(sizeText(200 * 1024)).toBe('200 KB');
      expect(sizeText(3 * 1024 * 1024)).toBe('3.0 MB');
    });
  });

  describe('reading the declarations', () => {
    it('reads a declaration with its words, its contractor and its decision', () => {
      expect(toDeclaration(declaration(1))).toMatchObject({ memberName: 'Chuyên gia 1', hasConflict: true, relationText: expect.stringContaining('anh em họ'), contractorName: 'Công ty nhà thầu 1', decision: null, standing: 'PENDING', own: false, version: 1 });
      const decided = toDeclaration(declaration(1, { decision: 'RECUSED', decision_reason: 'Done.', decided_by: { membership_id: 'm', display_name: 'Người duyệt' }, standing: 'RECUSED', is_own: true }));
      expect(decided).toMatchObject({ decision: 'RECUSED', decisionReason: 'Done.', deciderName: 'Người duyệt', standing: 'RECUSED', own: true });
      expect(toDeclaration(declaration(1, { contractor: null }))?.contractorName).toBeNull();
    });

    it('drops what is not a declaration and reads the list with the right to decide', () => {
      for (const broken of [undefined, {}, { ...declaration(1), standing: 'MAYBE' }, { ...declaration(1), has_conflict: 'yes' }, { ...declaration(1), version: 'x' }]) expect(toDeclaration(broken)).toBeUndefined();
      expect(toDeclarationList({ items: [declaration(1), { nope: true }], may_decide: true })).toEqual({ items: [expect.objectContaining({ standing: 'PENDING' })], mayDecide: true });
      expect(toDeclarationList(undefined)).toEqual({ items: [], mayDecide: false });
    });
  });

  describe('the intake form', () => {
    it('accepts a contractor, a real hand-in time, a price in whole VND and stored files', () => {
      expect(hasProblems(validateIntake(form(), NOW))).toBe(false);
      expect(hasProblems(validateIntake(form({ price: '' }), NOW))).toBe(false);
    });

    it('asks for what is missing: the contractor, the time and at least one file', () => {
      const problems = validateIntake(EMPTY_INTAKE, NOW);
      expect(problems).toMatchObject({ contractorId: 'required', submittedAt: 'required', files: 'files' });
      expect(hasProblems(problems)).toBe(true);
    });

    it('refuses a time that does not exist or lies in the future', () => {
      expect(validateIntake(form({ submittedAt: '2026-02-30T09:30' }), NOW).submittedAt).toBe('date');
      expect(validateIntake(form({ submittedAt: 'tomorrow' }), NOW).submittedAt).toBe('date');
      expect(validateIntake(form({ submittedAt: '2026-11-11T16:00' }), NOW).submittedAt).toBe('future');
      expect(validateIntake(form({ submittedAt: '2026-11-11T15:00' }), NOW).submittedAt).toBeUndefined();
    });

    it('refuses a price that is not whole VND', () => {
      for (const price of ['12.5', '-1', '1 000', 'abc', '1'.repeat(25)]) expect(validateIntake(form({ price }), NOW).price).toBe('digits');
    });

    it('refuses a file that has no name, a name that is too long and a file that is not stored yet', () => {
      const base = form().files[0] as IntakeForm['files'][number];
      expect(validateIntake(form({ files: [{ ...base, title: '   ' }] }), NOW).rows).toEqual({ 1: 'title' });
      expect(validateIntake(form({ files: [{ ...base, title: 'x'.repeat(201) }] }), NOW).rows).toEqual({ 1: 'title' });
      expect(validateIntake(form({ files: [{ ...base, uploaded: undefined }] }), NOW).rows).toEqual({ 1: 'notUploaded' });
      expect(validateIntake(form({ files: Array.from({ length: 501 }, (_, n) => ({ ...base, uid: n + 1 })) }), NOW).files).toBe('tooMany');
    });

    it('writes the body of the receipt: the time as an instant, the price only when there is one, the stored files by key and digest', () => {
      expect(receiveBody('p1', form())).toEqual({
        package_id: 'p1',
        contractor_id: 'c1',
        submitted_at: '2026-11-10T02:30:00.000Z',
        bid_price_vnd: '17650000000',
        documents: [{ part: 'TECHNICAL', title: 'Technical volume', file_object_key: UPLOADED.fileObjectKey, file_sha256: UPLOADED.fileSha256 }],
      });
      expect(receiveBody('p1', form({ price: '  ' }))).not.toHaveProperty('bid_price_vnd');
      const stored = form().files[0] as IntakeForm['files'][number];
      expect(receiveBody('p1', form({ files: [{ ...stored, uploaded: undefined }, { ...stored, uid: 2, title: ' Padded ' }] })).documents.map((document) => document.title)).toEqual(['Padded']);
    });
  });

  describe('the declaration form', () => {
    it('asks the question and never assumes the answer', () => {
      expect(validateDeclare(EMPTY_DECLARE)).toEqual({ hasConflict: 'answer' });
      expect(validateDeclare({ ...EMPTY_DECLARE, hasConflict: false })).toEqual({});
    });

    it('asks for the relation in words when there is a conflict, and caps them', () => {
      expect(validateDeclare({ ...EMPTY_DECLARE, hasConflict: true })).toEqual({ relation: 'relation' });
      expect(validateDeclare({ ...EMPTY_DECLARE, hasConflict: true, relation: '   ' })).toEqual({ relation: 'relation' });
      expect(validateDeclare({ ...EMPTY_DECLARE, hasConflict: true, relation: 'x'.repeat(2001) })).toEqual({ relation: 'tooLong' });
      expect(validateDeclare({ ...EMPTY_DECLARE, hasConflict: true, relation: 'My cousin.' })).toEqual({});
    });

    it('writes the body: a declaration of no conflict carries neither words nor contractor', () => {
      expect(declareBody({ hasConflict: false, relation: 'left over', contractorId: 'c1' })).toEqual({ has_conflict: false });
      expect(declareBody({ hasConflict: true, relation: '  My cousin.  ', contractorId: 'c1' })).toEqual({ has_conflict: true, relation_text: 'My cousin.', contractor_id: 'c1' });
      expect(declareBody({ hasConflict: true, relation: 'My cousin.', contractorId: '' })).toEqual({ has_conflict: true, relation_text: 'My cousin.' });
    });
  });

  describe('the decision form', () => {
    it('asks for a decision and reasons of at least 20 characters', () => {
      expect(validateDecide(EMPTY_DECIDE)).toEqual({ decision: 'required', reason: 'short' });
      expect(validateDecide({ decision: 'ALLOWED', reason: 'x'.repeat(19) })).toEqual({ reason: 'short' });
      expect(validateDecide({ decision: 'ALLOWED', reason: `${'x'.repeat(19)}   ` })).toEqual({ reason: 'short' });
      expect(validateDecide({ decision: 'ALLOWED', reason: 'x'.repeat(2001) })).toEqual({ reason: 'tooLong' });
      expect(validateDecide({ decision: 'RECUSED', reason: 'x'.repeat(20) })).toEqual({});
    });

    it('writes the body with the reasons trimmed', () => {
      expect(decideBody({ decision: 'BLOCKED', reason: `  ${'x'.repeat(20)}  ` })).toEqual({ decision: 'BLOCKED', decision_reason: 'x'.repeat(20) });
    });
  });

  describe('the refusals', () => {
    const refused = (code: string, status = 422, extensions: Record<string, unknown> = {}) => describeProblem(new ApiError({ status, code, correlationId: 'c', extensions }));

    it('names the refusals of the receipt, the declaration and the decision', () => {
      expect(refused('BID_CLOSED')).toBe('bidClosed');
      expect(refused('BID_OPENING_UNSET')).toBe('openingUnset');
      expect(refused('CONTRACTOR_RESTRICTED')).toBe('restricted');
      expect(refused('CONTRACTOR_NOT_VERIFIED')).toBe('notVerified');
      expect(refused('PACKAGE_STATE_INVALID', 409)).toBe('packageState');
      expect(refused('ALREADY_DECLARED')).toBe('alreadyDeclared');
      expect(refused('CONFLICT_UNDECLARED', 403)).toBe('undeclared');
      expect(refused('SELF_APPROVAL_DENIED', 403)).toBe('selfApproval');
      expect(refused('VERSION_CONFLICT', 409)).toBe('versionConflict');
      expect(refused('NO_CONFLICT_DECLARED')).toBe('noConflict');
    });

    it('names the refusals of the files', () => {
      expect(refused('UPLOAD_NOT_PDF')).toBe('notPdf');
      expect(refused('FILE_TYPE_NOT_ALLOWED')).toBe('notPdf');
      expect(refused('FILE_NOT_CLEAN')).toBe('notClean');
      expect(refused('SCAN_PENDING', 409)).toBe('notClean');
      expect(refused('PAYLOAD_TOO_LARGE', 413)).toBe('tooLarge');
      expect(refused('VALIDATION_FAILED', 422, { reason: 'FILE_ALREADY_ATTACHED' })).toBe('fileUsed');
      expect(refused('VALIDATION_FAILED')).toBe('validation');
    });

    it('names the refusals of access and of the session, and everything else is general', () => {
      expect(refused('RESOURCE_NOT_FOUND', 404)).toBe('notFound');
      expect(refused('SCOPE_DENIED', 403)).toBe('denied');
      expect(refused('SESSION_EXPIRED', 401)).toBe('session');
      expect(refused('SOMETHING_ELSE', 500)).toBe('general');
      expect(describeProblem(new Error('x'))).toBe('general');
    });
  });
});
