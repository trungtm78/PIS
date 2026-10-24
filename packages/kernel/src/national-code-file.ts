import { DomainError } from './errors.ts';
import { accept, reject, sourceRowsOfTable } from './file-import.ts';
import type { FileImportFormat, SourceRow } from './file-import.ts';
import { readTabularFile } from './tabular-file.ts';

/**
 * The file of the national project codes (ST-PRJ-004, PRJ 3.1 F7): the file a planning officer downloads from the national public investment system
 * and reconciles with the register. The platform calls no API of that system (adapter PROPOSED, D05): it reads the file the person hands over.
 *
 * THE LAYOUT IS A WORKING ASSUMPTION. No sample of the file and no specification of the system were available (CXN-01), so the layout below is the
 * smallest one that identifies a project by what the register holds and carries the code: it is what the adapter reads until the agency that owns the
 * file confirms its format, and `formatVersion` is kept with every import so that a change of layout is visible in the evidence.
 *
 *   - a CSV (UTF-8; comma, semicolon or tab) or the first sheet of an XLSX, with a header row;
 *   - `internal_code`: the internal code of the project in the register of the tenant (`project.code`);
 *   - `national_project_code`: the code of the project in the national system;
 *   - any other column is ignored. Header names are read without regard to case or surrounding space.
 */
export const NATIONAL_CODE_CONNECTOR = 'NATIONAL_PIM_FILE';
export const NATIONAL_CODE_FORMAT_VERSION = 'WORKING-ASSUMPTION-2026.1';
/** The adapter is a proposal until the owner of the file confirms the format; it is shown as such on PRJ-21. */
export const NATIONAL_CODE_ADAPTER_STATUS = 'PROPOSED';
export const NATIONAL_CODE_MAX_LENGTH = 50;

const INTERNAL_COLUMN = 'internal_code';
const NATIONAL_COLUMN = 'national_project_code';
/** Set on the rows that repeat the national code of an earlier row of the same file: the format judges one row at a time. */
const DUPLICATE_MARK = '__duplicate_of_line';

export interface NationalCodeRow {
  internalCode: string;
  nationalCode: string;
}

const hasControlCharacter = (text: string): boolean => Array.from(text).some((character) => (character.codePointAt(0) ?? 0) < 0x20 || character.codePointAt(0) === 0x7f);

/**
 * The format of the file as a pure `FileImportFormat`. A row that repeats the national code of an earlier row of the same file is refused with
 * NATIONAL_CODE_DUPLICATE (the first row keeps the code): which of two rows is the right one is for the officer, and the file is judged the same
 * whatever the order the rows are applied in.
 */
export const nationalCodeFileFormat: FileImportFormat<NationalCodeRow> = {
  connectorCode: NATIONAL_CODE_CONNECTOR,
  formatVersion: NATIONAL_CODE_FORMAT_VERSION,

  parse(bytes: Uint8Array): SourceRow[] {
    const table = readTabularFile(bytes);
    const headers = table.headers.map((header) => header.trim().toLowerCase());
    if (!headers.includes(INTERNAL_COLUMN) || !headers.includes(NATIONAL_COLUMN)) throw new DomainError('IMPORT_SCHEMA_INVALID', 422, 'file');
    const rows = sourceRowsOfTable({ ...table, headers });
    const firstLineOf = new Map<string, number>();
    return rows.map((row) => {
      const code = (row.values[NATIONAL_COLUMN] ?? '').trim();
      if (code === '') return row;
      const first = firstLineOf.get(code);
      if (first === undefined) {
        firstLineOf.set(code, row.line);
        return row;
      }
      return { line: row.line, values: { ...row.values, [DUPLICATE_MARK]: String(first) } };
    });
  },

  judge(row: SourceRow) {
    const internalCode = (row.values[INTERNAL_COLUMN] ?? '').trim();
    const nationalCode = (row.values[NATIONAL_COLUMN] ?? '').trim();
    if (internalCode === '') return reject<NationalCodeRow>('INTERNAL_CODE_EMPTY', INTERNAL_COLUMN);
    if (internalCode.length > NATIONAL_CODE_MAX_LENGTH || hasControlCharacter(internalCode)) return reject<NationalCodeRow>('CODE_INVALID', INTERNAL_COLUMN, internalCode);
    if (nationalCode === '') return reject<NationalCodeRow>('NATIONAL_CODE_EMPTY', NATIONAL_COLUMN, internalCode);
    if (nationalCode.length > NATIONAL_CODE_MAX_LENGTH || hasControlCharacter(nationalCode)) return reject<NationalCodeRow>('CODE_INVALID', NATIONAL_COLUMN, internalCode);
    if (row.values[DUPLICATE_MARK] !== undefined) return reject<NationalCodeRow>('NATIONAL_CODE_DUPLICATE', NATIONAL_COLUMN, internalCode);
    return accept<NationalCodeRow>({
      businessKey: internalCode,
      fields: { [INTERNAL_COLUMN]: internalCode, [NATIONAL_COLUMN]: nationalCode },
      record: { internalCode, nationalCode },
    });
  },

  /** Both cells are codes of the register and of the national system: nothing personal, so they may be shown beside the error. */
  mask(values: Readonly<Record<string, string>>): Record<string, string> {
    return { [INTERNAL_COLUMN]: (values[INTERNAL_COLUMN] ?? '').trim(), [NATIONAL_COLUMN]: (values[NATIONAL_COLUMN] ?? '').trim() };
  },
};
