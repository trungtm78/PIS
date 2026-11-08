import { DomainError, MAX_UNITS_PER_VERSION } from '@machvon/kernel';
import type { CompareUnit, UnitBox, UnitKind } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/**
 * Reads the text of a version in units (DOC-2, PD.01): the page of a viewer, the passage another feature cites, the units a comparison lines up. The caller has already judged that the version is in its scope; these
 * reads see only the version they are given. The text is the reading of the file, never edited (the table is append-only).
 */

export interface UnitRow {
  id: string;
  seq: number;
  citationId: string;
  kind: UnitKind;
  locatorKey: string;
  label: string;
  page: number | null;
  paragraph: number | null;
  sheet: string | null;
  cell: string | null;
  box: UnitBox | null;
  text: string;
  textSha256: string;
  confidence: string | null;
  openComments: number;
}

interface UnitSql {
  id: string;
  seq: number;
  citation_id: string;
  kind: UnitKind;
  locator_key: string;
  label: string;
  page_no: number | null;
  paragraph_no: number | null;
  sheet_name: string | null;
  cell_ref: string | null;
  box: UnitBox | null;
  text: string;
  text_sha256: string;
  confidence: string | null;
  open_comments: string;
}

const COLUMNS = `u.id, u.seq, u.citation_id, u.kind, u.locator_key, u.label, u.page_no, u.paragraph_no, u.sheet_name, u.cell_ref, u.box, u.text, u.text_sha256, u.confidence::text as confidence,
       (select count(*)::text from machvon.document_comment c where c.tenant_id = u.tenant_id and c.version_id = u.version_id and c.citation_id = u.citation_id and c.status = 'OPEN') as open_comments`;

const unitOf = (row: UnitSql): UnitRow => ({
  id: row.id,
  seq: row.seq,
  citationId: row.citation_id,
  kind: row.kind,
  locatorKey: row.locator_key,
  label: row.label,
  page: row.page_no,
  paragraph: row.paragraph_no,
  sheet: row.sheet_name,
  cell: row.cell_ref,
  box: row.box,
  text: row.text,
  textSha256: row.text_sha256,
  confidence: row.confidence,
  openComments: Number(row.open_comments),
});

const like = (text: string): string => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

export interface UnitFilter {
  page?: number | undefined;
  sheet?: string | undefined;
  q?: string | undefined;
}

export class DocumentTextStore {
  /** The units of a version in reading order, a page at a time (the cursor is the sequence number of the last unit). */
  async list(tx: TenantTx, versionId: string, filter: UnitFilter, page: { limit: number; afterSeq: number | undefined }): Promise<{ items: UnitRow[]; more: boolean }> {
    const params: unknown[] = [versionId];
    const where = ['u.version_id = $1::uuid'];
    const next = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filter.page !== undefined) where.push(`u.page_no = ${next(filter.page)}::integer`);
    if (filter.sheet !== undefined) where.push(`u.sheet_name = ${next(filter.sheet)}`);
    if (filter.q !== undefined) where.push(`u.text ilike ${next(like(filter.q))} escape '\\'`);
    if (page.afterSeq !== undefined) where.push(`u.seq > ${next(page.afterSeq)}::integer`);
    const rows = await tx.query<UnitSql>(`select ${COLUMNS} from machvon.document_text_unit u where ${where.join(' and ')} order by u.seq limit ${next(page.limit + 1)}`, params);
    return { items: rows.slice(0, page.limit).map(unitOf), more: rows.length > page.limit };
  }

  /** The pages and sheets a version has text for, so a viewer can offer them. */
  async outline(tx: TenantTx, versionId: string): Promise<{ pages: number[]; sheets: string[] }> {
    const pages = await tx.query<{ page_no: number }>('select distinct page_no from machvon.document_text_unit where version_id = $1::uuid and page_no is not null order by page_no', [versionId]);
    const sheets = await tx.query<{ sheet_name: string }>('select sheet_name from machvon.document_text_unit where version_id = $1::uuid and sheet_name is not null group by sheet_name order by min(seq)', [versionId]);
    return { pages: pages.map((row) => row.page_no), sheets: sheets.map((row) => row.sheet_name) };
  }

  /** One unit by its citation, with the unit before and the one after it (the context a citation is shown in); undefined when the version has no such unit. */
  async resolve(tx: TenantTx, versionId: string, citationId: string): Promise<{ unit: UnitRow; before: UnitRow | null; after: UnitRow | null } | undefined> {
    const rows = await tx.query<UnitSql>(`select ${COLUMNS} from machvon.document_text_unit u where u.version_id = $1::uuid and u.citation_id = $2`, [versionId, citationId]);
    const found = rows[0];
    if (found === undefined) return undefined;
    const around = await tx.query<UnitSql>(`select ${COLUMNS} from machvon.document_text_unit u where u.version_id = $1::uuid and u.seq in ($2::integer - 1, $2::integer + 1)`, [versionId, found.seq]);
    return {
      unit: unitOf(found),
      before: around.filter((row) => row.seq === found.seq - 1).map(unitOf)[0] ?? null,
      after: around.filter((row) => row.seq === found.seq + 1).map(unitOf)[0] ?? null,
    };
  }

  async hasCitation(tx: TenantTx, versionId: string, citationId: string): Promise<boolean> {
    const rows = await tx.query<{ n: string }>('select 1::text as n from machvon.document_text_unit where version_id = $1::uuid and citation_id = $2', [versionId, citationId]);
    return rows.length > 0;
  }

  /** Every unit of a version, for a comparison: bounded by what a version may hold. */
  async forCompare(tx: TenantTx, versionId: string): Promise<CompareUnit[]> {
    const rows = await tx.query<{ citation_id: string; kind: string; locator_key: string; label: string; text: string; text_sha256: string; seq: number }>(
      'select citation_id, kind, locator_key, label, text, text_sha256, seq from machvon.document_text_unit where version_id = $1::uuid order by seq limit $2',
      [versionId, MAX_UNITS_PER_VERSION],
    );
    if (rows.length >= MAX_UNITS_PER_VERSION) throw new DomainError('DOC_COMPARE_TOO_LARGE', 422, 'versions');
    return rows.map((row) => ({ citationId: row.citation_id, kind: row.kind, locatorKey: row.locator_key, label: row.label, text: row.text, textSha256: row.text_sha256, seq: row.seq }));
  }
}
