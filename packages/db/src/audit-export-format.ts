import { auditLeafHash, canonicalJson, merkleRoot, sealHashOf } from '@machvon/kernel';

/**
 * The sealed export of the audit trail (ST-ADM-016, ADM 3.11). One file holds typed records, in this order: one MANIFEST, the
 * SEALs that cover the exported sequence range, then every row of those seal windows in `seq` order, as an EVENT when it belongs
 * to the export and as a LEAF (its hash only) when it does not. With the leaves of a whole window a recipient recomputes the
 * Merkle root of the seal, then the seal hash and the chain link, without the database and without trusting the sender.
 */
export type ExportFormat = 'CSV' | 'JSONL';

export const EXPORT_FORMAT_VERSION = 1;

/** The columns of an audit row exactly as the sealer reads them (AUDIT_ROW_COLUMNS): the canonical JSON of these is the Merkle leaf. */
export const LEAF_FIELDS = [
  'id',
  'seq',
  'actor_id',
  'action',
  'resource_type',
  'resource_id',
  'safe_diff',
  'reason',
  'correlation_id',
  'request_id',
  'outcome',
  'classification',
  'impersonator_id',
  'on_behalf_of_id',
  'ip_hash',
  'schema_version',
  'occurred_at',
] as const;

export interface ExportManifest {
  record_type: 'MANIFEST';
  format_version: number;
  tenant_id: string;
  generated_at: string;
  period_from: string;
  period_to: string;
  resource_types: string[] | null;
  first_seq: number | null;
  last_seq: number | null;
  events: number;
  leaf_only: number;
  seals: number;
  unsealed_events: number;
}

export interface ExportSeal {
  record_type: 'SEAL';
  id: string;
  from_seq: number;
  to_seq: number;
  merkle_root: string;
  prev_seal_hash: string | null;
  seal_hash: string;
  sealed_at: string;
}

export interface ExportLeaf {
  record_type: 'LEAF';
  seq: number;
  leaf_hash: string;
}

export interface ExportEvent {
  record_type: 'EVENT';
  id: string;
  seq: number;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  safe_diff: unknown;
  reason: string | null;
  correlation_id: string;
  request_id: string;
  outcome: string;
  classification: string;
  impersonator_id: string | null;
  on_behalf_of_id: string | null;
  ip_hash: string | null;
  schema_version: number;
  occurred_at: string;
  /** The leaf of the row as it is stored (before any redaction on the way out). */
  leaf_hash: string;
  /** The seal that covers the row; null while the row waits for the next run of the sealer. */
  seal_id: string | null;
  /** True when the diff shown differs from the stored one because a sensitive value was removed on export: the leaf then cannot be recomputed from the row. */
  redacted: boolean;
}

export type ExportRecord = ExportManifest | ExportSeal | ExportLeaf | ExportEvent;

/** The columns of the CSV form, in order. A record leaves blank the columns of the other record types. */
export const CSV_COLUMNS = [
  'record_type',
  'format_version',
  'tenant_id',
  'generated_at',
  'period_from',
  'period_to',
  'resource_types',
  'first_seq',
  'last_seq',
  'events',
  'leaf_only',
  'seals',
  'unsealed_events',
  'id',
  'seq',
  'actor_id',
  'action',
  'resource_type',
  'resource_id',
  'safe_diff',
  'reason',
  'correlation_id',
  'request_id',
  'outcome',
  'classification',
  'impersonator_id',
  'on_behalf_of_id',
  'ip_hash',
  'schema_version',
  'occurred_at',
  'leaf_hash',
  'seal_id',
  'redacted',
  'from_seq',
  'to_seq',
  'merkle_root',
  'prev_seal_hash',
  'seal_hash',
  'sealed_at',
] as const;

// A spreadsheet reads a cell that begins with one of these as a formula: such a cell is written with a leading apostrophe.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line of the file for a record, without the line end. */
export function renderRecord(record: ExportRecord, format: ExportFormat): string {
  if (format === 'JSONL') return JSON.stringify(record);
  const values = record as unknown as Record<string, unknown>;
  return CSV_COLUMNS.map((column) => csvCell(values[column])).join(',');
}

/** The first line of the file in a format: the column header of a CSV, nothing for JSON lines. */
export function headerLine(format: ExportFormat): string | undefined {
  return format === 'CSV' ? CSV_COLUMNS.join(',') : undefined;
}

/** The leaf of a row: the hash of the canonical JSON of its sealed columns (what the sealer computes). */
export function leafOfFields(fields: Record<string, unknown>): string {
  const sealed: Record<string, unknown> = {};
  for (const field of LEAF_FIELDS) sealed[field] = fields[field];
  return auditLeafHash(canonicalJson(sealed));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Verification: what a recipient does, kept here so that the sender's code and the recipient's check are one specification.

export type VerifyFindingCode =
  | 'MANIFEST_MISSING'
  | 'COUNT_MISMATCH'
  | 'SEAL_ORDER'
  | 'ROOT_MISMATCH'
  | 'SEAL_HASH_MISMATCH'
  | 'CHAIN_LINK_MISMATCH'
  | 'EVENT_LEAF_MISMATCH';

export interface VerifyFinding {
  code: VerifyFindingCode;
  sealId?: string;
  seq?: number;
}

export interface ExportVerification {
  ok: boolean;
  findings: VerifyFinding[];
  seals: number;
  events: number;
  leafOnly: number;
  unsealedEvents: number;
  /** Events whose row was checked against its leaf: JSON lines only, and not the ones redacted on export. */
  boundEvents: number;
}

/** Splits RFC 4180 text into rows of cells. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['format_version', 'first_seq', 'last_seq', 'events', 'leaf_only', 'seals', 'unsealed_events', 'seq', 'schema_version', 'from_seq', 'to_seq']);

function recordsOfCsv(text: string): Array<Record<string, unknown>> {
  const [header, ...rows] = csvRows(text);
  if (header === undefined) return [];
  return rows
    .filter((cells) => cells.some((cell) => cell !== ''))
    .map((cells) => {
      const record: Record<string, unknown> = {};
      header.forEach((column, index) => {
        const cell = cells[index] ?? '';
        if (cell === '') return;
        record[column] = NUMERIC_COLUMNS.has(column) ? Number(cell) : cell;
      });
      return record;
    });
}

function recordsOfJsonl(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Checks an export the way its recipient does: every seal window must reproduce its Merkle root from the leaves in the file, every
 * seal its hash, and consecutive seals must chain. A JSON lines export also binds each EVENT to its leaf by recomputing it from the
 * row. A finding names the seal or the row; `ok` is true only without findings.
 */
export function verifyAuditExport(text: string, format: ExportFormat): ExportVerification {
  const records = format === 'JSONL' ? recordsOfJsonl(text) : recordsOfCsv(text);
  const findings: VerifyFinding[] = [];
  const manifest = records.find((record) => record.record_type === 'MANIFEST');
  if (manifest === undefined) findings.push({ code: 'MANIFEST_MISSING' });
  const seals = records.filter((record) => record.record_type === 'SEAL').sort((left, right) => Number(left.to_seq) - Number(right.to_seq));
  const events = records.filter((record) => record.record_type === 'EVENT');
  const leaves = records.filter((record) => record.record_type === 'LEAF');
  const leafBySeq = new Map<number, string>();
  for (const row of [...events, ...leaves]) leafBySeq.set(Number(row.seq), String(row.leaf_hash));

  let boundEvents = 0;
  if (format === 'JSONL') {
    for (const event of events) {
      if (event.redacted === true) continue;
      boundEvents += 1;
      if (leafOfFields(event) !== event.leaf_hash) findings.push({ code: 'EVENT_LEAF_MISMATCH', seq: Number(event.seq) });
    }
  }

  let previous: Record<string, unknown> | undefined;
  for (const seal of seals) {
    const sealId = String(seal.id);
    const from = Number(seal.from_seq);
    const to = Number(seal.to_seq);
    if (previous !== undefined) {
      if (from <= Number(previous.to_seq)) findings.push({ code: 'SEAL_ORDER', sealId });
      if ((seal.prev_seal_hash ?? null) !== previous.seal_hash) findings.push({ code: 'CHAIN_LINK_MISMATCH', sealId });
    }
    const window = [...leafBySeq.entries()].filter(([seq]) => seq >= from && seq <= to).sort(([left], [right]) => left - right);
    if (window.length === 0 || merkleRoot(window.map(([, leaf]) => leaf)) !== seal.merkle_root) findings.push({ code: 'ROOT_MISMATCH', sealId });
    if (sealHashOf((seal.prev_seal_hash as string | undefined) ?? null, String(seal.merkle_root), to) !== seal.seal_hash) findings.push({ code: 'SEAL_HASH_MISMATCH', sealId });
    previous = seal;
  }

  const unsealedEvents = events.filter((event) => !seals.some((seal) => Number(event.seq) >= Number(seal.from_seq) && Number(event.seq) <= Number(seal.to_seq))).length;
  if (manifest !== undefined && (manifest.events !== events.length || manifest.leaf_only !== leaves.length || manifest.seals !== seals.length || manifest.unsealed_events !== unsealedEvents)) {
    findings.push({ code: 'COUNT_MISMATCH' });
  }
  return { ok: findings.length === 0, findings, seals: seals.length, events: events.length, leafOnly: leaves.length, unsealedEvents, boundEvents };
}
