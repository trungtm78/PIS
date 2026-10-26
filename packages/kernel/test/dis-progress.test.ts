import { DomainError } from '../src/errors.ts';
import { ATTACHMENT_MAX_COUNT, NARRATIVE_MAX_CHARS, NARRATIVE_MAX_ISSUES, attachmentsOf, narrativeOf, progressOf } from '../src/dis-progress.ts';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};
const where = (work: () => unknown): [number, string, string | undefined] => {
  const error = refusal(work);
  return [error.status, error.code, error.detail];
};

const ISSUE_ONE = '00000000-0000-4000-8000-0000000000a1';
const ISSUE_TWO = '00000000-0000-4000-8000-0000000000a2';
const FILE_ONE = '00000000-0000-4000-8000-0000000000b1';
const FILE_TWO = '00000000-0000-4000-8000-0000000000b2';
const SHA = 'a'.repeat(64);

describe('the volumes of a report (AC-ST-DIS-004-1)', () => {
  const full = { construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000' };

  it('leaves the volumes of the draft as they are when the request names none', () => {
    expect(progressOf({})).toBeUndefined();
  });

  it('reads the four amounts and the percent with two decimals', () => {
    expect(progressOf({ ...full, physical_progress_pct: '37.5' })).toEqual({
      constructionVnd: '300000000',
      acceptanceVnd: '200000000',
      treasurySubmittedVnd: '150000000',
      preparingDossierVnd: '50000000',
      physicalProgressPct: '37.50',
    });
    expect(progressOf(full)?.physicalProgressPct).toBeNull();
    expect(progressOf({ ...full, construction_vnd: '000300' })?.constructionVnd).toBe('300');
    for (const pct of ['0', '100', '100.00', '99.99', '5']) expect(progressOf({ ...full, physical_progress_pct: pct })?.physicalProgressPct).toBe(Number(pct).toFixed(2));
  });

  it('wants the four amounts together: any that is named brings the others, and the first missing one is named', () => {
    expect(where(() => progressOf({ physical_progress_pct: '10' }))).toEqual([422, 'VALIDATION_FAILED', 'construction_vnd']);
    expect(where(() => progressOf({ construction_vnd: '1', acceptance_vnd: '1' }))).toEqual([422, 'VALIDATION_FAILED', 'treasury_submitted_vnd']);
    expect(where(() => progressOf({ ...full, preparing_dossier_vnd: undefined }))).toEqual([422, 'VALIDATION_FAILED', 'preparing_dossier_vnd']);
  });

  it('refuses a negative amount, a fraction, a word and a percent out of range, naming the member', () => {
    for (const member of ['construction_vnd', 'acceptance_vnd', 'treasury_submitted_vnd', 'preparing_dossier_vnd'] as const) {
      for (const bad of ['-1', '1.5', 'abc', '']) expect(where(() => progressOf({ ...full, [member]: bad }))).toEqual([422, 'VALIDATION_FAILED', member]);
    }
    for (const bad of ['-1', '100.01', '101', 'abc', '1.234', '', '1e2']) expect(where(() => progressOf({ ...full, physical_progress_pct: bad }))).toEqual([422, 'VALIDATION_FAILED', 'physical_progress_pct']);
  });
});

describe('the narrative of a report', () => {
  it('is none when the request has none, and none when what it has is empty', () => {
    expect(narrativeOf(undefined)).toBeNull();
    expect(narrativeOf({})).toBeNull();
    expect(narrativeOf({ results: '   ', causes: '', linked_issue_ids: [] })).toBeNull();
  });

  it('keeps each section trimmed and normalised, and the issues in the order they were named', () => {
    expect(narrativeOf({ results: '  Foundations done.  ', proposals: 'Release the next tranche', linked_issue_ids: [ISSUE_TWO, ISSUE_ONE.toUpperCase()] })).toEqual({
      resultsText: 'Foundations done.',
      causesText: null,
      solutionsText: null,
      proposalsText: 'Release the next tranche',
      linkedIssueIds: [ISSUE_TWO, ISSUE_ONE],
    });
    expect(narrativeOf({ causes: 'Café' })?.causesText).toBe('Café');
    expect(narrativeOf({ linked_issue_ids: [ISSUE_ONE] })).toMatchObject({ resultsText: null, linkedIssueIds: [ISSUE_ONE] });
  });

  it('refuses a section above 4000 characters, a text that is not a text, and issues that are not ids, are named twice or are too many', () => {
    expect(narrativeOf({ results: 'x'.repeat(NARRATIVE_MAX_CHARS) })?.resultsText).toHaveLength(NARRATIVE_MAX_CHARS);
    expect(where(() => narrativeOf({ solutions: 'x'.repeat(NARRATIVE_MAX_CHARS + 1) }))).toEqual([422, 'VALIDATION_FAILED', 'narrative.solutions']);
    expect(where(() => narrativeOf({ causes: 5 as unknown as string }))).toEqual([422, 'VALIDATION_FAILED', 'narrative.causes']);
    expect(where(() => narrativeOf({ linked_issue_ids: [ISSUE_ONE, 'nope'] }))).toEqual([422, 'VALIDATION_FAILED', 'narrative.linked_issue_ids[1]']);
    expect(where(() => narrativeOf({ linked_issue_ids: [ISSUE_ONE, ISSUE_ONE.toUpperCase()] }))).toEqual([422, 'VALIDATION_FAILED', 'narrative.linked_issue_ids[1]']);
    expect(where(() => narrativeOf({ linked_issue_ids: [7 as unknown as string] }))).toEqual([422, 'VALIDATION_FAILED', 'narrative.linked_issue_ids[0]']);
    const many = Array.from({ length: NARRATIVE_MAX_ISSUES + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    expect(where(() => narrativeOf({ linked_issue_ids: many }))).toEqual([422, 'VALIDATION_FAILED', 'narrative.linked_issue_ids']);
    expect(where(() => narrativeOf({ linked_issue_ids: 'x' as unknown as string[] }))).toEqual([422, 'VALIDATION_FAILED', 'narrative.linked_issue_ids']);
  });
});

describe('the files attached to a report (AC-ST-DIS-004-4)', () => {
  const file = (id: string, name = 'voucher.pdf', sha = SHA) => ({ file_object_id: id, file_sha256: sha, file_name: name });

  it('leaves the files of the draft as they are when the request names none, and takes a list as the whole list', () => {
    expect(attachmentsOf(undefined)).toBeUndefined();
    expect(attachmentsOf([])).toEqual([]);
    expect(attachmentsOf([file(FILE_ONE.toUpperCase(), '  Chứng từ 01.pdf '), file(FILE_TWO)])).toEqual([
      { fileObjectId: FILE_ONE, fileSha256: SHA, fileName: 'Chứng từ 01.pdf' },
      { fileObjectId: FILE_TWO, fileSha256: SHA, fileName: 'voucher.pdf' },
    ]);
  });

  it('refuses more than 20 files, a file twice, an id or hash that is not one, and a name that is empty, long or a path', () => {
    const many = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, index) => file(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`));
    expect(attachmentsOf(many.slice(0, ATTACHMENT_MAX_COUNT))).toHaveLength(ATTACHMENT_MAX_COUNT);
    expect(where(() => attachmentsOf(many))).toEqual([422, 'VALIDATION_FAILED', 'attachments']);
    expect(where(() => attachmentsOf('x' as unknown as []))).toEqual([422, 'VALIDATION_FAILED', 'attachments']);
    expect(where(() => attachmentsOf([file(FILE_ONE), file(FILE_ONE.toUpperCase())]))).toEqual([422, 'VALIDATION_FAILED', 'attachments[1].file_object_id']);
    expect(where(() => attachmentsOf([file('nope')]))).toEqual([422, 'VALIDATION_FAILED', 'attachments[0].file_object_id']);
    expect(where(() => attachmentsOf([null as unknown as ReturnType<typeof file>]))).toEqual([422, 'VALIDATION_FAILED', 'attachments[0].file_object_id']);
    expect(where(() => attachmentsOf([file(FILE_ONE, 'a.pdf', 'ABC')]))).toEqual([422, 'VALIDATION_FAILED', 'attachments[0].file_sha256']);
    for (const name of ['', '   ', 'x'.repeat(201), 'a/b.pdf', 'a\\b.pdf', 'a\u0000.pdf']) expect(where(() => attachmentsOf([file(FILE_ONE, name)]))).toEqual([422, 'VALIDATION_FAILED', 'attachments[0].file_name']);
    expect(where(() => attachmentsOf([{ file_object_id: FILE_ONE, file_sha256: SHA } as unknown as ReturnType<typeof file>]))).toEqual([422, 'VALIDATION_FAILED', 'attachments[0].file_name']);
  });
});
