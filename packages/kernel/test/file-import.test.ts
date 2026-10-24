import { DomainError } from '../src/errors.ts';
import {
  BUSINESS_KEY_INVALID_CODE,
  BUSINESS_KEY_MAX_LENGTH,
  MEASURE_INVALID_CODE,
  accept,
  assertRejection,
  checkDifference,
  fileSha256,
  isStorableMeasure,
  maskedPreview,
  planFileImport,
  reject,
  rowHash,
  signedDifference,
  sourceRowsOfTable,
} from '../src/file-import.ts';
import type { FileImportFormat, RowJudgement, SourceRow } from '../src/file-import.ts';
import { readTabularFile } from '../src/tabular-file.ts';

interface Statement {
  amount: string;
}

/** A tiny CSV format: statement_no, project_code, amount, account. Enough to exercise every rule of the plan. */
const FORMAT: FileImportFormat<Statement> = {
  connectorCode: 'TEST_STATEMENT_FILE',
  formatVersion: '1',
  parse: (bytes) => sourceRowsOfTable(readTabularFile(bytes)),
  judge(row): RowJudgement<Statement> {
    const { statement_no: no = '', project_code: project = '', amount = '' } = row.values;
    if (project === '') return reject('MISSING_PROJECT_CODE', 'project_code', no);
    return accept({ businessKey: no, fields: { statement_no: no, project_code: project, amount }, record: { amount }, measure: amount });
  },
  mask: (values) => ({ statement_no: values.statement_no ?? '', account: `***${(values.account ?? '').slice(-3)}` }),
};

const bytesOf = (text: string): Uint8Array => Buffer.from(text, 'utf8');
const HEADER = 'statement_no,project_code,amount,account\n';

describe('planFileImport', () => {
  it('hashes the file and judges every row with its line and its content hash', () => {
    const file = bytesOf(`${HEADER}S1,P1,100.50,123456789\nS2,,200,987654321\nS3,P3,300,111222333\n`);
    const plan = planFileImport(FORMAT, file);
    expect(plan.fileSha256).toBe(fileSha256(file));
    expect(plan.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.rows.map((row) => [row.line, row.accepted])).toEqual([
      [2, true],
      [3, false],
      [4, true],
    ]);
    const rejected = plan.rows[1];
    expect(rejected).toMatchObject({ accepted: false, rejection: { code: 'MISSING_PROJECT_CODE', field: 'project_code' }, businessKey: 'S2' });
    // The preview is what the format's mask allows, never the account number itself.
    expect(rejected?.accepted === false ? rejected.preview : undefined).toEqual({ statement_no: 'S2', account: '***321' });
  });

  it('gives the same file the same hash and a changed byte another one', () => {
    const one = bytesOf(`${HEADER}S1,P1,100,1\n`);
    expect(fileSha256(one)).toBe(fileSha256(bytesOf(`${HEADER}S1,P1,100,1\n`)));
    expect(fileSha256(one)).not.toBe(fileSha256(bytesOf(`${HEADER}S1,P1,101,1\n`)));
  });

  it('keeps no part of a rejected row when the format has no mask', () => {
    const plain: FileImportFormat<Statement> = { ...FORMAT };
    delete (plain as { mask?: unknown }).mask;
    const plan = planFileImport(plain, bytesOf(`${HEADER}S2,,200,987654321\n`));
    expect(plan.rows[0]).toMatchObject({ accepted: false, preview: null });
  });

  it('cuts a preview to a few short values', () => {
    const wide: FileImportFormat<Statement> = { ...FORMAT, mask: () => Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`f${index}`, 'x'.repeat(500)])) };
    const preview = maskedPreview(wide, {});
    expect(Object.keys(preview ?? {})).toHaveLength(30);
    expect((preview ?? {}).f0).toHaveLength(200);
  });

  it('refuses a file with no row and a file over the row limit', () => {
    expect(() => planFileImport(FORMAT, bytesOf(HEADER))).toThrow(expect.objectContaining({ code: 'IMPORT_EMPTY', status: 422 }));
    const many = bytesOf(`${HEADER}S1,P,1,1\nS2,P,1,1\nS3,P,1,1\n`);
    expect(() => planFileImport(FORMAT, many, 2)).toThrow(expect.objectContaining({ code: 'IMPORT_SCHEMA_INVALID', status: 422 }));
    expect(planFileImport(FORMAT, many, 3).rows).toHaveLength(3);
  });

  it('lets an unreadable file raise the error of the format', () => {
    const broken: FileImportFormat<Statement> = {
      ...FORMAT,
      parse: () => {
        throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');
      },
    };
    expect(() => planFileImport(broken, bytesOf('x'))).toThrow(expect.objectContaining({ code: 'IMPORT_SCHEMA_INVALID' }));
  });

  describe('what the framework cannot store is rejected, not left to the database', () => {
    const formatOf = (businessKey: string, measure?: string): FileImportFormat<Statement> => ({
      ...FORMAT,
      parse: (): SourceRow[] => [{ line: 2, values: {} }],
      judge: () => accept({ businessKey, fields: { k: businessKey }, record: { amount: measure ?? '' }, ...(measure === undefined ? {} : { measure }) }),
    });

    it.each<[string, string]>([
      ['an empty key', '   '],
      ['a key over the limit', 'K'.repeat(BUSINESS_KEY_MAX_LENGTH + 1)],
      ['a key with a control character', 'S1\u0007'],
    ])('rejects %s as BUSINESS_KEY_INVALID', (_name, key) => {
      expect(planFileImport(formatOf(key), bytesOf('x')).rows[0]).toMatchObject({ accepted: false, rejection: { code: BUSINESS_KEY_INVALID_CODE, field: 'business_key' }, businessKey: null });
    });

    it('never hands the database a rejected key it would refuse: a NUL, or a space left at the end by the cut', () => {
      const rejectedKey = (key: string) => {
        const format: FileImportFormat<Statement> = { ...FORMAT, parse: (): SourceRow[] => [{ line: 2, values: {} }], judge: () => reject('MISSING_PROJECT_CODE', 'project_code', key) };
        const row = planFileImport(format, bytesOf('x')).rows[0];
        return row?.accepted === false ? row.businessKey : 'accepted';
      };
      expect(rejectedKey('S1\u0000')).toBeNull();
      const cutAtASpace = `${'K'.repeat(BUSINESS_KEY_MAX_LENGTH - 1)} tail`;
      const kept = rejectedKey(cutAtASpace);
      expect(kept).toBe('K'.repeat(BUSINESS_KEY_MAX_LENGTH - 1));
    });

    it('drops a NUL from the masked preview, which jsonb cannot hold', () => {
      const format: FileImportFormat<Statement> = { ...FORMAT, mask: () => ({ account: 'a\u0000b' }) };
      expect(maskedPreview(format, {})).toEqual({ account: 'ab' });
    });

    it.each(['abc', '1,5','12345678901234567890123456', '1.1234567', '--1', '1e5', ''])('rejects the measure %p as MEASURE_INVALID', (measure) => {
      expect(planFileImport(formatOf('S1', measure), bytesOf('x')).rows[0]).toMatchObject({ accepted: false, rejection: { code: MEASURE_INVALID_CODE, field: 'measure' }, businessKey: 'S1' });
    });

    it('trims the key it keeps and accepts the widest measure of the column', () => {
      const widest = `${'9'.repeat(24)}.${'9'.repeat(6)}`;
      const row = planFileImport(formatOf('  S1  ', widest), bytesOf('x')).rows[0];
      expect(row).toMatchObject({ accepted: true, row: { businessKey: 'S1', measure: widest } });
    });
  });

  it('turns a rejection whose code is malformed into a defect, never a quarantined row', () => {
    const bad: FileImportFormat<Statement> = { ...FORMAT, judge: () => reject('missing project', 'project_code') };
    expect(() => planFileImport(bad, bytesOf(`${HEADER}S1,,1,1\n`))).toThrow('malformed rejection');
    expect(() => assertRejection({ code: 'OK_CODE', field: 'project.code' })).not.toThrow();
    expect(() => assertRejection({ code: 'OK_CODE', field: 'bad field' })).toThrow('malformed rejection');
  });
});

describe('rowHash', () => {
  it('is the same for the same content in any order of the cells, and differs when one value differs', () => {
    expect(rowHash({ a: '1', b: '2' })).toBe(rowHash({ b: '2', a: '1' }));
    expect(rowHash({ a: '1', b: '2' })).not.toBe(rowHash({ a: '1', b: '3' }));
    expect(rowHash({ a: '1', b: '2' })).toMatch(/^[0-9a-f]{64}$/);
    // A value moved to another column is another row.
    expect(rowHash({ a: '1', b: '' })).not.toBe(rowHash({ a: '', b: '1' }));
  });
});

describe('measures and differences', () => {
  it('recognises exact decimals within the column', () => {
    expect(['0', '-1', '1000000000', '0.000001', `${'9'.repeat(24)}`].every(isStorableMeasure)).toBe(true);
    expect(['', '1.', '.5', '1.0000001', '1 000'].some(isStorableMeasure)).toBe(false);
  });

  it('computes the signed difference exactly, and none for text that is not a decimal', () => {
    expect(signedDifference('1000.10', '1000.30')).toBe('0.20');
    expect(signedDifference('5', '3')).toBe('-2');
    expect(signedDifference('0.1', '0.2')).toBe('0.1');
    expect(signedDifference('2026-10-01', '2026-10-02')).toBeNull();
    expect(signedDifference(undefined, '1')).toBeNull();
  });

  it('refuses a difference with a malformed code or a negative due time', () => {
    expect(() => checkDifference({ code: 'AMOUNT_MISMATCH', dueAfterSeconds: 0 })).not.toThrow();
    expect(() => checkDifference({ code: 'amount mismatch' })).toThrow('malformed');
    expect(() => checkDifference({ code: 'AMOUNT_MISMATCH', dueAfterSeconds: -1 })).toThrow('due time');
    expect(() => checkDifference({ code: 'AMOUNT_MISMATCH', dueAfterSeconds: 1.5 })).toThrow('due time');
  });
});

describe('sourceRowsOfTable', () => {
  it('keeps the line each row starts on, even after a blank line and a quoted line break', () => {
    const table = readTabularFile(bytesOf(`${HEADER}S1,P1,1,"a\nb"\n\nS2,P2,2,x\n`));
    const rows = sourceRowsOfTable(table);
    expect(rows.map((row) => row.line)).toEqual([2, 5]);
    expect(rows[0]?.values).toEqual({ statement_no: 'S1', project_code: 'P1', amount: '1', account: 'a\nb' });
  });

  it('pads a short row with empty cells', () => {
    const rows = sourceRowsOfTable(readTabularFile(bytesOf(`${HEADER}S1,P1\n`)));
    expect(rows[0]?.values).toEqual({ statement_no: 'S1', project_code: 'P1', amount: '', account: '' });
  });
});
