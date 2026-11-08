import { DomainError } from '../src/errors';
import {
  CITATION_ID,
  assertSubmittable,
  assertVersionMove,
  assertVersionNotLocked,
  citationIdOf,
  citationRefOf,
  commentInputOf,
  effectivePeriodOf,
  effectiveStateOn,
  extractionStatusOf,
  isVersionLocked,
  locatorKeyOf,
  locatorLabelOf,
  nextVersionStatuses,
  normaliseExtraction,
  parseCitationRef,
  projectDocumentChangeOf,
  projectDocumentInputOf,
  repositoryFormatOf,
} from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);

describe('formats', () => {
  it('knows the three formats by content type, ignoring case and parameters', () => {
    expect(repositoryFormatOf('application/pdf')).toBe('PDF');
    expect(repositoryFormatOf('Application/PDF; charset=binary')).toBe('PDF');
    expect(repositoryFormatOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('DOCX');
    expect(repositoryFormatOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('XLSX');
    expect(repositoryFormatOf('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBeUndefined();
    expect(repositoryFormatOf('text/plain')).toBeUndefined();
  });
});

describe('the description of a project document', () => {
  const base = { project_id: PROJECT, doc_class: 'DESIGN', title: '  Thiết kế cơ sở gói thầu số 3  ' };

  it('normalises a valid document and defaults the security class to INTERNAL', () => {
    const input = projectDocumentInputOf({ ...base, reference: 'TK-03', effective_from: '2026-01-01', effective_to: '2026-12-31', contract_id: PROJECT.toUpperCase() });
    expect(input).toMatchObject({ projectId: PROJECT, contractId: PROJECT, packageId: null, docClass: 'DESIGN', title: 'Thiết kế cơ sở gói thầu số 3', reference: 'TK-03', securityClass: 'INTERNAL', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', note: null });
  });

  it('refuses an unknown class, a short title, a bad project id, a bad security class and control characters', () => {
    expect(refusal(() => projectDocumentInputOf({ ...base, doc_class: 'SECRET_STUFF' })).detail).toBe('doc_class');
    expect(refusal(() => projectDocumentInputOf({ ...base, title: 'ab' })).detail).toBe('title');
    expect(refusal(() => projectDocumentInputOf({ ...base, title: 'bad\u0000title' })).detail).toBe('title');
    expect(refusal(() => projectDocumentInputOf({ ...base, project_id: 'nope' })).detail).toBe('project_id');
    expect(refusal(() => projectDocumentInputOf({ ...base, security_class: 'TOP' })).detail).toBe('security_class');
    expect(refusal(() => projectDocumentInputOf({ ...base, package_id: 12 })).detail).toBe('package_id');
  });

  it('closes the effective period at both ends and refuses an end before the start or a day that does not exist', () => {
    expect(effectivePeriodOf(undefined, undefined)).toEqual({ effectiveFrom: null, effectiveTo: null });
    expect(refusal(() => effectivePeriodOf('2026-05-02', '2026-05-01')).extensions).toEqual({ reason: 'BEFORE_EFFECTIVE_FROM' });
    expect(refusal(() => effectivePeriodOf('2026-02-30', null)).detail).toBe('effective_from');
    expect(refusal(() => effectivePeriodOf(null, '26-1-1')).detail).toBe('effective_to');
    expect(effectivePeriodOf('2026-05-01', '2026-05-01')).toEqual({ effectiveFrom: '2026-05-01', effectiveTo: '2026-05-01' });
  });

  it('says where a document stands on a day: never in force without a date', () => {
    expect(effectiveStateOn({ effectiveFrom: null, effectiveTo: null }, '2026-06-01')).toBe('UNDATED');
    expect(effectiveStateOn({ effectiveFrom: '2026-07-01', effectiveTo: null }, '2026-06-30')).toBe('NOT_YET');
    expect(effectiveStateOn({ effectiveFrom: '2026-07-01', effectiveTo: null }, '2026-07-01')).toBe('IN_FORCE');
    expect(effectiveStateOn({ effectiveFrom: null, effectiveTo: '2026-07-31' }, '2026-07-31')).toBe('IN_FORCE');
    expect(effectiveStateOn({ effectiveFrom: null, effectiveTo: '2026-07-31' }, '2026-08-01')).toBe('EXPIRED');
  });

  it('applies only the members of a change that are present, keeps the project fixed and refuses an empty change', () => {
    const current = { effectiveFrom: '2026-01-01', effectiveTo: null };
    expect(projectDocumentChangeOf({ title: 'Tiêu đề mới của hồ sơ' }, current)).toEqual({ title: 'Tiêu đề mới của hồ sơ' });
    expect(projectDocumentChangeOf({ contract_id: null, effective_to: '2026-12-31' }, current)).toEqual({ contractId: null, effectiveTo: '2026-12-31' });
    expect(refusal(() => projectDocumentChangeOf({ effective_to: '2025-12-31' }, current)).detail).toBe('effective_to');
    expect(refusal(() => projectDocumentChangeOf({ project_id: PROJECT }, current)).extensions).toEqual({ reason: 'PROJECT_IS_FIXED' });
    expect(refusal(() => projectDocumentChangeOf({}, current)).extensions).toEqual({ reason: 'EMPTY_CHANGE' });
    expect(refusal(() => projectDocumentChangeOf({ security_class: 'X' }, current)).detail).toBe('security_class');
  });
});

describe('versions and the lock of an approved one', () => {
  it('moves a draft to review, a review to an end or back to draft, and nothing after an end', () => {
    expect(nextVersionStatuses('DRAFT')).toEqual(['IN_REVIEW']);
    expect(nextVersionStatuses('IN_REVIEW')).toEqual(['APPROVED', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'DRAFT']);
    for (const end of ['APPROVED', 'SUPPLEMENT_REQUESTED', 'REJECTED'] as const) expect(nextVersionStatuses(end)).toEqual([]);
    expect(() => assertVersionMove('IN_REVIEW', 'APPROVED')).not.toThrow();
    const error = refusal(() => assertVersionMove('APPROVED', 'DRAFT'));
    expect([error.code, error.status, error.extensions]).toEqual(['DOC_VERSION_STATE_INVALID', 409, { from: 'APPROVED', to: 'DRAFT' }]);
  });

  it('locks exactly the approved version', () => {
    expect(isVersionLocked('APPROVED')).toBe(true);
    for (const status of ['DRAFT', 'IN_REVIEW', 'SUPPLEMENT_REQUESTED', 'REJECTED'] as const) expect(isVersionLocked(status)).toBe(false);
    expect(refusal(() => assertVersionNotLocked('APPROVED')).code).toBe('DOC_VERSION_LOCKED');
    expect(() => assertVersionNotLocked('DRAFT')).not.toThrow();
  });

  it('sends only a draft to review', () => {
    expect(() => assertSubmittable('DRAFT')).not.toThrow();
    expect(refusal(() => assertSubmittable('IN_REVIEW')).code).toBe('DOC_VERSION_STATE_INVALID');
  });
});

describe('citations', () => {
  it('writes the place of a unit as a stable key', () => {
    expect(locatorKeyOf({ page: 3, paragraph: 2 })).toBe('p3/para2');
    expect(locatorKeyOf({ paragraph: 12 })).toBe('para12');
    expect(locatorKeyOf({ table: 2, row: 3, column: 4 })).toBe('t2/r3c4');
    expect(locatorKeyOf({ page: 5, table: 1, row: 1, column: 2 })).toBe('p5/t1/r1c2');
    expect(locatorKeyOf({ sheet: 'Dự toán', cell: 'B7' })).toBe('Dự toán!B7');
    expect(refusal(() => locatorKeyOf({})).detail).toBe('locator');
    expect(refusal(() => locatorKeyOf({ sheet: 'S1' })).detail).toBe('locator');
    expect(refusal(() => locatorKeyOf({ sheet: 'S1', cell: 'b7' })).detail).toBe('locator');
    expect(refusal(() => locatorKeyOf({ sheet: 'S/1', cell: 'B7' })).detail).toBe('locator');
    expect(refusal(() => locatorKeyOf({ page: 0, paragraph: 1 })).detail).toBe('locator');
    expect(refusal(() => locatorKeyOf({ table: 1, row: 1 })).detail).toBe('locator');
    expect(locatorLabelOf({ page: 3, paragraph: 2 })).toBe('p3 para2');
    expect(locatorLabelOf({ sheet: 'S1', cell: 'A1' })).toBe('S1!A1');
  });

  it('derives the citation from the file and the place, never from the text', () => {
    const id = citationIdOf(SHA, 'p1/para1');
    expect(id).toMatch(CITATION_ID);
    expect(citationIdOf(SHA, 'p1/para1')).toBe(id);
    expect(citationIdOf(SHA, 'p1/para2')).not.toBe(id);
    expect(citationIdOf('b'.repeat(64), 'p1/para1')).not.toBe(id);
  });

  it('round-trips a reference another feature stores', () => {
    const version = '22222222-2222-4222-8222-222222222222';
    const id = citationIdOf(SHA, 'para1');
    const ref = citationRefOf(version, id);
    expect(ref).toBe(`docver:${version}#${id}`);
    expect(parseCitationRef(ref)).toEqual({ versionId: version, citationId: id });
    expect(parseCitationRef('docver:nope#cit_x')).toBeUndefined();
    expect(parseCitationRef(`docver:${version}#cit_zz`)).toBeUndefined();
  });

  it('turns an extraction into numbered units with citations, dropping empty text and folding space', () => {
    const { units, truncated } = normaliseExtraction(SHA, [
      { kind: 'HEADING', locator: { page: 1, paragraph: 1 }, text: '  Điều 1.   Phạm vi  ', box: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 } },
      { kind: 'PARAGRAPH', locator: { page: 1, paragraph: 2 }, text: '   ' },
      { kind: 'PARAGRAPH', locator: { page: 1, paragraph: 3 }, text: 'Nội dung', confidence: '0.9100' },
    ]);
    expect(truncated).toBe(0);
    expect(units.map((unit) => [unit.seq, unit.locatorKey, unit.text, unit.confidence])).toEqual([
      [1, 'p1/para1', 'Điều 1. Phạm vi', null],
      [2, 'p1/para3', 'Nội dung', '0.9100'],
    ]);
    expect(units[0]?.citationId).toBe(citationIdOf(SHA, 'p1/para1'));
    expect(units[0]?.box).toEqual({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 });
    expect(units[0]?.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses two units at one place, a bad box, a bad confidence and an unknown kind, and reports a cut text', () => {
    const at = { page: 1, paragraph: 1 };
    expect(refusal(() => normaliseExtraction(SHA, [{ kind: 'PARAGRAPH', locator: at, text: 'a' }, { kind: 'PARAGRAPH', locator: at, text: 'b' }])).extensions).toEqual({ reason: 'DUPLICATE_PLACE' });
    expect(refusal(() => normaliseExtraction(SHA, [{ kind: 'PARAGRAPH', locator: at, text: 'a', box: { x0: 0.5, y0: 0, x1: 0.2, y1: 1 } }])).detail).toBe('box');
    expect(refusal(() => normaliseExtraction(SHA, [{ kind: 'PARAGRAPH', locator: at, text: 'a', confidence: '1.5' }])).detail).toBe('confidence');
    expect(refusal(() => normaliseExtraction(SHA, [{ kind: 'WIDGET' as 'PARAGRAPH', locator: at, text: 'a' }])).detail).toBe('kind');
    expect(refusal(() => normaliseExtraction(SHA, [{ kind: 'PARAGRAPH', locator: {}, text: 'a' }])).detail).toBe('locator');
    const cut = normaliseExtraction(SHA, [{ kind: 'PARAGRAPH', locator: at, text: 'x'.repeat(20_001) }]);
    expect(cut.truncated).toBe(1);
    expect(cut.units[0]?.text).toHaveLength(20_000);
  });

  it('tells a file with no text from a failed reading', () => {
    expect(extractionStatusOf(0, false)).toBe('NO_TEXT');
    expect(extractionStatusOf(3, false)).toBe('EXTRACTED');
    expect(extractionStatusOf(3, true)).toBe('FAILED');
  });
});

describe('comments', () => {
  const version = '22222222-2222-4222-8222-222222222222';
  it('anchors a comment to a version, optionally to a citation, optionally as a reply', () => {
    const citation = citationIdOf(SHA, 'para1');
    expect(commentInputOf({ version_id: version, body: '  Cần bổ sung căn cứ pháp lý  ', citation_id: citation })).toEqual({ versionId: version, citationId: citation, parentId: null, body: 'Cần bổ sung căn cứ pháp lý' });
    expect(commentInputOf({ version_id: version, body: 'Đã sửa', parent_id: PROJECT }).parentId).toBe(PROJECT);
  });

  it('refuses a body that is too short or too long, and ids that are not ids', () => {
    expect(refusal(() => commentInputOf({ version_id: version, body: 'a' })).detail).toBe('body');
    expect(refusal(() => commentInputOf({ version_id: version, body: 'x'.repeat(4001) })).detail).toBe('body');
    expect(refusal(() => commentInputOf({ version_id: 'nope', body: 'ok ok' })).detail).toBe('version_id');
    expect(refusal(() => commentInputOf({ version_id: version, body: 'ok ok', citation_id: 'cit_1' })).detail).toBe('citation_id');
    expect(refusal(() => commentInputOf({ version_id: version, body: 'ok ok', parent_id: 5 })).detail).toBe('parent_id');
  });
});
