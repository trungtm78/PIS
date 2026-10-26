/** The permissions the register and document type commands need (x-permission in openapi.json). */
export const MANAGE_REGISTERS_PERMISSION = 'doc.register.manage';
export const MANAGE_TYPES_PERMISSION = 'doc.type.manage';

export const DIRECTIONS = ['OUTGOING', 'INCOMING'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const REGISTER_MODES = ['MANAGED', 'MIRRORED'] as const;
export type RegisterMode = (typeof REGISTER_MODES)[number];
export const REGISTER_STATUSES = ['OPEN', 'CLOSED'] as const;
export type RegisterStatus = (typeof REGISTER_STATUSES)[number];
export const SYMBOL_KINDS = ['DECISION', 'NAMED_TYPE', 'OFFICIAL_LETTER'] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** One number register as `listDocumentNumberRegisters` returns it. */
export interface Register {
  id: string;
  registerCode: string;
  name: string;
  direction: Direction;
  organizationUnitId: string;
  year: number;
  mode: RegisterMode;
  lastNumber: number;
  nextNumber: number;
  status: RegisterStatus;
  scopeDocTypes: string[];
  version: number;
}

export type EntryStatus = 'ALLOCATED' | 'VOIDED' | 'RECALLED';

/** One line of the log of a register (`listDocumentRegisterEntries`): the number as people read it, its symbol and its state. */
export interface RegisterEntry {
  allocationId: string;
  number: number;
  displayNumber: string;
  symbol: string;
  documentId: string;
  issuedOn: string;
  status: EntryStatus;
}

/** One revision of a document type, as the list of registers carries it next to the registers. */
export interface DocType {
  id: string;
  code: string;
  name: string;
  abbreviation: string | null;
  symbolKind: SymbolKind;
  symbolPattern: string;
  registerCode: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  status: string;
  version: number;
}

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.find((candidate) => candidate === value) ?? fallback);

export function toRegister(raw: unknown): Register {
  const row: Raw = isRecord(raw) ? raw : {};
  const last = count(row.last_number);
  return {
    id: text(row.id),
    registerCode: text(row.register_code),
    name: text(row.name),
    direction: oneOf(row.direction, DIRECTIONS, 'OUTGOING'),
    organizationUnitId: text(row.organization_unit_id),
    year: count(row.year),
    mode: oneOf(row.mode, REGISTER_MODES, 'MANAGED'),
    lastNumber: last,
    nextNumber: typeof row.next_number === 'number' ? row.next_number : last + 1,
    status: oneOf(row.status, REGISTER_STATUSES, 'OPEN'),
    scopeDocTypes: Array.isArray(row.scope_doc_types) ? row.scope_doc_types.filter((item): item is string => typeof item === 'string') : [],
    version: count(row.version),
  };
}

export function toEntry(raw: unknown): RegisterEntry {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    allocationId: text(row.allocation_id),
    number: count(row.number),
    displayNumber: text(row.display_number) || String(count(row.number)).padStart(2, '0'),
    symbol: text(row.symbol),
    documentId: text(row.document_id),
    issuedOn: text(row.issued_on),
    status: row.status === 'VOIDED' || row.status === 'RECALLED' ? row.status : 'ALLOCATED',
  };
}

export function toDocType(raw: unknown): DocType {
  const row: Raw = isRecord(raw) ? raw : {};
  return {
    id: text(row.id),
    code: text(row.code),
    name: text(row.name),
    abbreviation: nullableText(row.abbreviation),
    symbolKind: oneOf(row.symbol_kind, SYMBOL_KINDS, 'DECISION'),
    symbolPattern: text(row.symbol_pattern),
    registerCode: text(row.register_code),
    effectiveFrom: text(row.effective_from),
    effectiveUntil: nullableText(row.effective_until),
    status: text(row.status),
    version: count(row.version),
  };
}

export interface RegisterPage {
  items: Register[];
  docTypes: DocType[];
  nextCursor: string | undefined;
}

export function toRegisterPage(raw: unknown): RegisterPage {
  const page: Raw = isRecord(raw) ? raw : {};
  return {
    items: Array.isArray(page.items) ? page.items.map(toRegister) : [],
    docTypes: Array.isArray(page.doc_types) ? page.doc_types.map(toDocType) : [],
    nextCursor: typeof page.next_cursor === 'string' ? page.next_cursor : undefined,
  };
}

export interface EntryPage {
  register: Register | undefined;
  items: RegisterEntry[];
  nextCursor: string | undefined;
}

export function toEntryPage(raw: unknown): EntryPage {
  const page: Raw = isRecord(raw) ? raw : {};
  return {
    register: isRecord(page.register) ? toRegister(page.register) : undefined,
    items: Array.isArray(page.items) ? page.items.map(toEntry) : [],
    nextCursor: typeof page.next_cursor === 'string' ? page.next_cursor : undefined,
  };
}
