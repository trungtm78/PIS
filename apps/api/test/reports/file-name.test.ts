import { unzipSync, zipSync } from 'fflate';
import { DomainError } from '@machvon/kernel';
import type { FormPeriod } from '@machvon/kernel';
import { sha256Hex } from '../../src/modules/reports/digest';
import { DEFAULT_FILE_NAME_RULE, asciiSlug, assertFileNameRule, reportFileName } from '../../src/modules/reports/file-name';
import type { FileNameParts, FileNameRule } from '../../src/modules/reports/file-name';
import { ZIP_EPOCH, normalizeZip, zipEntryNames, zipEntryText } from '../../src/modules/reports/zip-normalize';

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? `${error.code}:${error.detail ?? ''}` : String(error);
  }
  return undefined;
};

const SHA = 'a1b2c3d4'.padEnd(64, '0');
const MONTH: FormPeriod = { kind: 'MONTH', year: 2026, index: 10 };
const parts = (overrides: Partial<FileNameParts> = {}): FileNameParts => ({ code: 'MONTHLY-GROUP', period: MONTH, revision: 2, sha256: SHA, extension: 'xlsx', ...overrides });
const rule = (overrides: Partial<FileNameRule> = {}): FileNameRule => ({ ...DEFAULT_FILE_NAME_RULE, ...overrides });

describe('sha256Hex', () => {
  it('is the sha256 of the bytes', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('reportFileName', () => {
  it('UAT-PLAN-3410: names a file code_period_version_sha8.ext by default', () => {
    expect(reportFileName(parts())).toBe('MONTHLY-GROUP_2026-M10_v02_a1b2c3d4.xlsx');
    expect(reportFileName(parts({ period: { kind: 'QUARTER', year: 2026, index: 3 }, revision: 1, extension: 'docx' }))).toBe('MONTHLY-GROUP_2026-Q3_v01_a1b2c3d4.docx');
    expect(reportFileName(parts({ period: { kind: 'AS_OF', year: 2026, day: '2026-10-31' } }))).toBe('MONTHLY-GROUP_2026-10-31_v02_a1b2c3d4.xlsx');
  });

  it('follows a rule that is data: another order, an organisation, a date, another version style', () => {
    const custom = rule({ pattern: '{org}-{code}-{date}-{version}-{sha8}.{ext}', versionPrefix: 'R', versionDigits: 3 });
    expect(reportFileName(parts({ org: 'PVFCCo', issuedOn: '2026-11-08' }), custom)).toBe('PVFCCo-MONTHLY-GROUP-20261108-R002-a1b2c3d4.xlsx');
    expect(reportFileName(parts(), rule({ pattern: '{code}_{period}.{ext}', allowNoHash: true, versionPrefix: '' }))).toBe('MONTHLY-GROUP_2026-M10.xlsx');
    expect(reportFileName(parts(), rule({ versionPrefix: '' }))).toBe('MONTHLY-GROUP_2026-M10_02_a1b2c3d4.xlsx');
  });

  it('writes the code as plain ASCII', () => {
    expect(asciiSlug('Báo cáo tháng Đạm Phú Mỹ')).toBe('Bao_cao_thang_Dam_Phu_My');
    expect(asciiSlug('  --a/b\\c:d--  ')).toBe('a_b_c_d');
    expect(reportFileName(parts({ code: 'Báo cáo Đạm' }))).toBe('Bao_cao_Dam_2026-M10_v02_a1b2c3d4.xlsx');
  });

  it('shortens the code, never the hash or the extension, when the name is too long', () => {
    const name = reportFileName(parts({ code: 'A'.repeat(200) }), rule({ maxLength: 40 }));
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith('_2026-M10_v02_a1b2c3d4.xlsx')).toBe(true);
    expect(name.startsWith('AAAA')).toBe(true);
  });

  it('refuses a rule a file system would not take', () => {
    for (const bad of [
      rule({ pattern: '{code}_{period}_{sha8}' }),
      rule({ pattern: '{code}_{nope}_{sha8}.{ext}' }),
      rule({ pattern: '{code}/{sha8}.{ext}' }),
      rule({ pattern: '{code} {sha8}.{ext}' }),
      rule({ pattern: '{code}_{period}.{ext}' }),
      rule({ pattern: '{code}_{sha8}.{ext}{' }),
      rule({ versionDigits: 0 }),
      rule({ versionDigits: 5 }),
      rule({ versionPrefix: 'a-b' }),
      rule({ versionPrefix: 'abcde' }),
      rule({ maxLength: 10 }),
      rule({ maxLength: 300 }),
    ]) {
      expect(codeOf(() => assertFileNameRule(bad))).toBe('VALIDATION_FAILED:file_name_rule');
    }
  });

  it('refuses parts that make no name', () => {
    expect(codeOf(() => reportFileName(parts({ revision: 0 })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts({ revision: 100 })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts({ revision: 1.5 })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts({ sha256: 'abc' })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts({ code: '///' })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts(), rule({ pattern: '{org}_{sha8}.{ext}' })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts(), rule({ pattern: '{date}_{sha8}.{ext}' })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts({ code: 'CON' }), rule({ pattern: '{code}.{ext}', allowNoHash: true })))).toBe('VALIDATION_FAILED:file_name_parts');
    expect(codeOf(() => reportFileName(parts({ period: { kind: 'MONTH', year: 2026, index: 13 } })))).toBe('VALIDATION_FAILED:period');
  });

  it('refuses a name that cannot be made short enough', () => {
    expect(codeOf(() => reportFileName(parts({ org: 'O'.repeat(100) }), rule({ pattern: '{org}_{code}_{sha8}.{ext}', maxLength: 30 })))).toBe('VALIDATION_FAILED:file_name_length');
  });
});

describe('zip normalisation', () => {
  const entry = (text: string): Uint8Array => new TextEncoder().encode(text);
  const archive = (order: string[], mtime: Date): Uint8Array => zipSync(Object.fromEntries(order.map((name) => [name, [entry(`content of ${name}`), { mtime }] as [Uint8Array, { mtime: Date }]])));

  it('gives the same bytes for the same files whatever their order or time', () => {
    const one = normalizeZip(archive(['word/document.xml', '[Content_Types].xml', 'a.txt', '_rels/.rels'], new Date(2021, 5, 1)));
    const two = normalizeZip(archive(['_rels/.rels', 'a.txt', '[Content_Types].xml', 'word/document.xml'], new Date(2025, 1, 3)));
    expect(sha256Hex(one)).toBe(sha256Hex(two));
    expect(zipEntryNames(one)).toEqual(['[Content_Types].xml', '_rels/.rels', 'a.txt', 'word/document.xml']);
    expect(zipEntryText(one, 'a.txt')).toBe('content of a.txt');
    expect(zipEntryText(one, 'missing.txt')).toBeUndefined();
    expect(Object.keys(unzipSync(one))).toHaveLength(4);
    expect(ZIP_EPOCH.getFullYear()).toBe(2000);
  });

  it('rewrites the text of a named entry and keeps the others', () => {
    const out = normalizeZip(archive(['a.txt', 'b.txt'], new Date(2021, 5, 1)), { replace: { 'a.txt': (text) => text.toUpperCase() } });
    expect(zipEntryText(out, 'a.txt')).toBe('CONTENT OF A.TXT');
    expect(zipEntryText(out, 'b.txt')).toBe('content of b.txt');
  });

  it('refuses bytes that are not a zip', () => {
    expect(codeOf(() => normalizeZip(new Uint8Array([1, 2, 3])))).toBe('TEMPLATE_INVALID:zip');
    expect(codeOf(() => zipEntryNames(new Uint8Array([1, 2, 3])))).toBe('TEMPLATE_INVALID:zip');
  });
});
