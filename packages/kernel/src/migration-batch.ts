import { DomainError } from './errors.ts';
import { DEFAULT_TABULAR_LIMITS } from './tabular-file.ts';
import type { TabularLimits } from './tabular-file.ts';

/**
 * The conversion of a file of legacy data into the platform (ST-ADM-020, ADM.md 3.10, BR-ADM-12, ADM-13). A file is judged against the mapping it was registered with: the columns it must have, a business key on every
 * row that no other row has, an amount (whole units, up to 24 digits, a sign allowed) where the mapping has one, and the references to rows that were migrated before. What the file says in all is its control
 * totals: the number of rows and the sum of the amounts, summed as integers so that no float touches a figure of money. Pure functions of their input.
 */
export const MIGRATION_ENTITY_PATTERN = /^[A-Z][A-Z0-9_]{1,49}$/;
export const MAX_MIGRATION_ROWS = 100_000;
/** The rows of a batch that a transaction writes (ADM.md 3.10): a batch that stops goes on from the lot it stopped at. */
export const MIGRATION_LOT_SIZE = 1000;
/** The table of a conversion file: up to 100,000 rows (the import file store itself holds at most its own limit of bytes). */
export const MIGRATION_TABULAR_LIMITS: TabularLimits = { ...DEFAULT_TABULAR_LIMITS, maxRows: MAX_MIGRATION_ROWS };
const MAX_KEY = 200;
const MAX_CELL = 2000;
const AMOUNT = /^-?\d{1,24}$/;
const SOURCE_SYSTEM = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,59}$/;
const MAX_ERRORS = 1000;

export interface MigrationReference {
  /** The column that holds the business key of a row of `entity`. */
  column: string;
  entity: string;
}

/** How the columns of a file of one source are read: which holds the business key, which the amount, and which must be filled. */
export interface MigrationMapping {
  version: string;
  businessKeyColumn: string;
  amountColumn: string | null;
  requiredColumns: readonly string[];
  references: readonly MigrationReference[];
}

/**
 * The mappings the platform knows. The mapping of a real source (which columns, which entity) waits for the decision on the source mapping (D04); until then a file is converted into rows of a target entity with its
 * business key, its amount and the rest of its columns kept as they came, and a mapping can name the entity its rows refer to.
 */
export const MIGRATION_MAPPINGS: ReadonlyMap<string, MigrationMapping> = new Map<string, MigrationMapping>([
  ['GENERIC-1', { version: 'GENERIC-1', businessKeyColumn: 'business_key', amountColumn: 'amount', requiredColumns: ['business_key'], references: [] }],
  [
    'GENERIC-CHILD-1',
    {
      version: 'GENERIC-CHILD-1',
      businessKeyColumn: 'business_key',
      amountColumn: 'amount',
      requiredColumns: ['business_key', 'parent_key'],
      references: [{ column: 'parent_key', entity: 'PARENT' }],
    },
  ],
]);

export interface JudgedRow {
  /** The place of the row among the rows of the file, from 1. */
  rowNumber: number;
  /** The line of the file it starts on (the header is line 1). */
  lineNumber: number;
  businessKey: string;
  /** The amount as whole units in text, or null. */
  amount: string | null;
  payload: Record<string, string>;
  refs: Array<{ entity: string; key: string }>;
}

export interface RowError {
  rowNumber: number;
  lineNumber: number;
  field: string;
  code: 'COLUMN_MISSING' | 'KEY_MISSING' | 'KEY_TOO_LONG' | 'DUPLICATE_KEY' | 'FIELD_MISSING' | 'FIELD_TOO_LONG' | 'AMOUNT_INVALID' | 'REFERENCE_UNKNOWN' | 'TOO_MANY_ROWS';
  message: string;
}

export interface ControlTotals {
  rows: number;
  amount: string;
}

export interface MigrationJudgement {
  rowCount: number;
  rows: JudgedRow[];
  /** At most 1000: the first problems found, which is what a person works through. */
  errors: RowError[];
  errorCount: number;
  totals: ControlTotals;
}

export function migrationMappingOf(version: string, mappings: ReadonlyMap<string, MigrationMapping> = MIGRATION_MAPPINGS): MigrationMapping {
  const mapping = mappings.get(version);
  if (mapping === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'mapping_version');
  return mapping;
}

/** What a registration has to say for itself: the entity, the source system and the mapping are named the way the rest of the platform names them. */
export function checkRegistration(input: { sourceSystem: string; targetEntity: string; mappingVersion: string }, mappings: ReadonlyMap<string, MigrationMapping> = MIGRATION_MAPPINGS): void {
  if (!SOURCE_SYSTEM.test(input.sourceSystem)) throw new DomainError('VALIDATION_FAILED', 422, 'source_system');
  if (!MIGRATION_ENTITY_PATTERN.test(input.targetEntity)) throw new DomainError('VALIDATION_FAILED', 422, 'target_entity');
  migrationMappingOf(input.mappingVersion, mappings);
}

const sumOf = (rows: readonly JudgedRow[]): bigint => rows.reduce((sum, row) => sum + (row.amount === null ? 0n : BigInt(row.amount)), 0n);

/**
 * Judges the table of a file against a mapping: nothing is written, every problem is listed with its row and its column (the first 1000), and the control totals are those of the rows that have none. A file with a
 * column missing, or with more rows than a batch can hold, is judged by that alone.
 */
export function judgeMigrationFile(table: { headers: readonly string[]; rows: readonly (readonly string[])[]; lines: readonly number[] }, mapping: MigrationMapping): MigrationJudgement {
  const errors: RowError[] = [];
  let errorCount = 0;
  const report = (error: RowError): void => {
    errorCount += 1;
    if (errors.length < MAX_ERRORS) errors.push(error);
  };
  const empty = (rowCount: number): MigrationJudgement => ({ rowCount, rows: [], errors, errorCount, totals: { rows: 0, amount: '0' } });
  const wanted = [
    ...new Set([mapping.businessKeyColumn, ...mapping.requiredColumns, ...(mapping.amountColumn === null ? [] : [mapping.amountColumn]), ...mapping.references.map((reference) => reference.column)]),
  ];
  const missing = wanted.filter((column) => !table.headers.includes(column));
  for (const column of missing) report({ rowNumber: 1, lineNumber: 1, field: column, code: 'COLUMN_MISSING', message: `the file has no column ${column}` });
  if (table.rows.length > MAX_MIGRATION_ROWS) {
    report({ rowNumber: 1, lineNumber: 1, field: 'file', code: 'TOO_MANY_ROWS', message: `a batch holds at most ${MAX_MIGRATION_ROWS} rows` });
    return empty(table.rows.length);
  }
  if (missing.length > 0) return empty(table.rows.length);

  const at = (name: string): number => table.headers.indexOf(name);
  const seen = new Map<string, number>();
  const judged: JudgedRow[] = [];
  table.rows.forEach((cells, index) => {
    const rowNumber = index + 1;
    const lineNumber = table.lines[index] ?? rowNumber + 1;
    let ok = true;
    const fail = (field: string, code: RowError['code'], message: string): void => {
      ok = false;
      report({ rowNumber, lineNumber, field, code, message });
    };
    const cell = (name: string): string => (cells[at(name)] ?? '').trim();
    const key = cell(mapping.businessKeyColumn);
    if (key === '') fail(mapping.businessKeyColumn, 'KEY_MISSING', 'the business key is empty');
    else if (key.length > MAX_KEY) fail(mapping.businessKeyColumn, 'KEY_TOO_LONG', `the business key is longer than ${MAX_KEY} characters`);
    else if (seen.has(key)) fail(mapping.businessKeyColumn, 'DUPLICATE_KEY', `the business key is also on row ${seen.get(key)}`);
    else seen.set(key, rowNumber);
    for (const column of mapping.requiredColumns) if (column !== mapping.businessKeyColumn && cell(column) === '') fail(column, 'FIELD_MISSING', `${column} is empty`);
    // A column is called what the source called it - `__proto__` and `constructor` included - so the payload is made of own properties, not assigned.
    const kept = new Map<string, string>();
    table.headers.forEach((header, position) => {
      const value = (cells[position] ?? '').trim();
      if (value.length > MAX_CELL) fail(header, 'FIELD_TOO_LONG', `${header} is longer than ${MAX_CELL} characters`);
      else if (value !== '') kept.set(header, value);
    });
    const payload: Record<string, string> = Object.fromEntries(kept);
    let amount: string | null = null;
    if (mapping.amountColumn !== null && cell(mapping.amountColumn) !== '') {
      const text = cell(mapping.amountColumn);
      if (AMOUNT.test(text)) amount = BigInt(text).toString();
      else fail(mapping.amountColumn, 'AMOUNT_INVALID', `${mapping.amountColumn} is not a whole amount of up to 24 digits`);
    }
    if (ok) {
      const refs = mapping.references.flatMap((reference) => (cell(reference.column) === '' ? [] : [{ entity: reference.entity, key: cell(reference.column) }]));
      judged.push({ rowNumber, lineNumber, businessKey: key, amount, payload, refs });
    }
  });
  return { rowCount: table.rows.length, rows: judged, errors, errorCount, totals: { rows: judged.length, amount: sumOf(judged).toString() } };
}

/**
 * The references of the rows that point at a row nobody migrated: `known` holds, for each entity, the keys that were migrated (and are not rolled back). Returns the rows that are left, the errors, and the totals
 * of the rows that are left; the judgement is the one of `judgeMigrationFile`, with these errors added to it.
 */
export function checkReferences(judgement: MigrationJudgement, mapping: MigrationMapping, known: ReadonlyMap<string, ReadonlySet<string>>): MigrationJudgement {
  const errors = [...judgement.errors];
  let errorCount = judgement.errorCount;
  const rows = judgement.rows.filter((row) => {
    const unknown = row.refs.filter((ref) => known.get(ref.entity)?.has(ref.key) !== true);
    for (const ref of unknown) {
      const column = mapping.references.find((reference) => reference.entity === ref.entity)?.column ?? ref.entity;
      errorCount += 1;
      if (errors.length < MAX_ERRORS)
        errors.push({ rowNumber: row.rowNumber, lineNumber: row.lineNumber, field: column, code: 'REFERENCE_UNKNOWN', message: `no ${ref.entity} was migrated under that key` });
    }
    return unknown.length === 0;
  });
  errors.sort((a, b) => a.rowNumber - b.rowNumber);
  return { rowCount: judgement.rowCount, rows, errors, errorCount, totals: { rows: rows.length, amount: sumOf(rows).toString() } };
}

/** Whether what was written is what the file said: the same number of rows and the same sum. */
export const totalsMatch = (expected: ControlTotals, actual: ControlTotals): boolean => expected.rows === actual.rows && expected.amount === actual.amount;
