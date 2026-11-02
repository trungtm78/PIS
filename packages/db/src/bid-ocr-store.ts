import { DomainError, asUuid, checkReview, classifyPage, financialGate, isConfidence, pageTablesMismatch, parseObjectKey } from '@machvon/kernel';
import type { FinancialGate, GatePage, OcrStatus } from '@machvon/kernel';
import { BidProposalReads } from './bid-proposal-reads.ts';
import type { ProposalFile, ProposalLine, ProposalViewer } from './bid-proposal-reads.ts';
import type { Page } from './bid-plan-reads.ts';
import type { TenantTx } from './tenant-database.ts';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const SHA256 = /^[0-9a-f]{64}$/;
const CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,9})$/;
export const MAX_RECORDED_PAGES = 2000;
export const MAX_ENGINE_VERSION = 120;

/** One page as the OCR engine read it: where its text is kept and how sure the engine is. */
export interface OcrPageInput {
  pageIndex: number;
  /** A decimal string from 0 to 1 with up to four digits after the point. */
  confidence: string;
  textSha256: string;
  textObjectKey: string;
  /** The tables of the page as `{ rows: [{ label, amount }], total }`; kept as read. */
  tables: unknown;
}

export interface RecordedPage {
  id: string;
  documentVersionId: string;
  pageIndex: number;
  status: OcrStatus;
  tableMismatch: boolean;
  /** False when the page had been recorded before: a page keeps the first reading of it. */
  created: boolean;
}

export interface OcrPageLine {
  id: string;
  documentVersionId: string;
  pageIndex: number;
  confidence: string;
  status: OcrStatus;
  tableMismatch: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
  note: string | null;
  engineVersion: string;
  textObjectKey: string;
  textSha256: string;
  correctedTextObjectKey: string | null;
  correctedTextSha256: string | null;
}

export interface OcrListing {
  proposal: ProposalLine;
  documents: ProposalFile[];
  pages: OcrPageLine[];
  more: boolean;
  last: { code: string; id: string } | undefined;
  gate: FinancialGate;
}

export type OcrListed = { kind: 'HIDDEN' } | { kind: 'DECLARATION_REQUIRED' } | ({ kind: 'SEEN' } & OcrListing);

/** The text a reviewer put in place of the reading of the engine, once the caller has read it from the store and checked it. */
export interface CorrectedText {
  sha256: string;
}

export interface ReviewInput {
  decision: unknown;
  correctedTextObjectKey?: unknown;
  note?: unknown;
}

/** What the review left, as the audit row, the event and the answer are written from: the stored values, never the request. */
export interface ReviewedPage {
  id: string;
  documentVersionId: string;
  pageIndex: number;
  proposalId: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  contractorId: string;
  previousStatus: OcrStatus;
  status: OcrStatus;
  hasNote: boolean;
  confidence: string;
  tableMismatch: boolean;
  /** Whether no page of the proposal waits for a person any longer. */
  financialReady: boolean;
}

interface PageSql {
  id: string;
  document_version_id: string;
  page_index: number;
  confidence: string;
  review_status: OcrStatus;
  table_mismatch: boolean;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  engine_version: string;
  text_object_key: string;
  text_sha256: string;
  corrected_text_object_key: string | null;
  corrected_text_sha256: string | null;
}

interface GateSql {
  id: string;
  page_index: number;
  review_status: OcrStatus;
}

const gatePageOf = (row: GateSql): GatePage => ({ id: row.id, pageIndex: row.page_index, status: row.review_status });

const PAGE_COLUMNS = `o.id, o.document_version_id, o.page_index, o.ocr_confidence::text as confidence, o.review_status, o.table_mismatch, o.reviewed_by,
  to_char(o.reviewed_at at time zone 'UTC', ${ISO}) as reviewed_at, o.review_note, o.engine_version, o.text_object_key, o.text_sha256, o.corrected_text_object_key, o.corrected_text_sha256`;

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const notFound = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

function lineOf(row: PageSql): OcrPageLine {
  return {
    id: row.id,
    documentVersionId: row.document_version_id,
    pageIndex: row.page_index,
    confidence: row.confidence,
    status: row.review_status,
    tableMismatch: row.table_mismatch,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    note: row.review_note,
    engineVersion: row.engine_version,
    textObjectKey: row.text_object_key,
    textSha256: row.text_sha256,
    correctedTextObjectKey: row.corrected_text_object_key,
    correctedTextSha256: row.corrected_text_sha256,
  };
}

/**
 * The OCR of the pages of a proposal and its review (ST-BID-008, BID 3 F3, BR-BID-03/06). The pipeline records each page with the confidence the engine gave it; a page below the threshold, or with a
 * table whose total is not the sum of its lines, waits for a member of the evaluation team to confirm or correct it, and the financial analysis of a proposal does not run while a page of it waits.
 * A page is seen and reviewed only by whoever has the full view of the proposal it belongs to (BidProposalReads): for anyone else it does not exist.
 */
export class BidOcrStore {
  private readonly proposals = new BidProposalReads();

  /**
   * Records the pages the engine read of a version of a document (the pipeline calls it, not a person). Each page gets the status the kernel gives its reading, and a page recorded before is
   * left as it is (the reading of the engine is a fact), so the same call twice leaves the same pages. 404 when the version is not the tenant's, 422 for a reading the column cannot keep.
   */
  async recordPages(tx: TenantTx, documentVersionId: string, pages: readonly OcrPageInput[], engineVersion: string): Promise<RecordedPage[]> {
    if (pages.length === 0 || pages.length > MAX_RECORDED_PAGES) throw invalid('pages');
    if (engineVersion.trim() === '' || engineVersion.length > MAX_ENGINE_VERSION) throw invalid('engine_version');
    const versions = await tx.query<{ page_count: number | null }>('select page_count from machvon.document_version where id = $1::uuid', [documentVersionId]);
    const version = versions[0];
    if (version === undefined) throw notFound();
    const seen = new Set<number>();
    for (const page of pages) {
      if (!Number.isInteger(page.pageIndex) || page.pageIndex < 0 || (version.page_count !== null && page.pageIndex >= version.page_count) || seen.has(page.pageIndex)) throw invalid('page_index');
      seen.add(page.pageIndex);
      if (!isConfidence(page.confidence)) throw invalid('ocr_confidence');
      if (!SHA256.test(page.textSha256)) throw invalid('text_sha256');
      if (parseObjectKey(page.textObjectKey) === undefined) throw invalid('text_object_key');
      if (!Array.isArray(page.tables)) throw invalid('tables');
    }
    const written = new Set<number>();
    for (const page of pages) {
      const inserted = await tx.query(
        `insert into machvon.document_page_ocr (tenant_id, id, document_version_id, page_index, ocr_confidence, text_sha256, text_object_key, tables_json, engine_version, review_status, table_mismatch)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2, $3::numeric, $4, $5, $6::jsonb, $7, $8, $9)
         on conflict (tenant_id, document_version_id, page_index) do nothing returning id`,
        [
          documentVersionId,
          page.pageIndex,
          page.confidence,
          page.textSha256,
          page.textObjectKey,
          JSON.stringify(page.tables),
          engineVersion,
          classifyPage({ confidence: page.confidence, tables: page.tables }),
          pageTablesMismatch(page.tables),
        ],
      );
      if (inserted.length > 0) written.add(page.pageIndex);
    }
    // A page kept from an earlier reading shows as it is.
    const kept = await tx.query<{ id: string; page_index: number; review_status: OcrStatus; table_mismatch: boolean }>(
      `select o.id, o.page_index, o.review_status, o.table_mismatch
         from machvon.document_page_ocr o where o.document_version_id = $1::uuid and o.page_index = any($2::int[]) order by o.page_index`,
      [documentVersionId, pages.map((page) => page.pageIndex)],
    );
    return kept.map((row) => ({ id: row.id, documentVersionId, pageIndex: row.page_index, status: row.review_status, tableMismatch: row.table_mismatch, created: written.has(row.page_index) }));
  }

  /**
   * The pages of a proposal for the caller who may see it in full, in the order of the files and of the pages, with the gate of the financial analysis for the whole proposal. A proposal the
   * caller may not see in full does not exist for them; one they would see but for the declaration they owe says so.
   */
  async listForProposal(tx: TenantTx, proposalId: string, viewer: ProposalViewer, filter: { documentVersionId?: string | undefined; status?: OcrStatus | undefined }, page: Page): Promise<OcrListed> {
    const found = await this.proposals.find(tx, proposalId, viewer);
    if (found.kind !== 'SEEN' || found.line.view !== 'FULL') return found.kind === 'DECLARATION_REQUIRED' ? { kind: 'DECLARATION_REQUIRED' } : { kind: 'HIDDEN' };
    const params: unknown[] = [proposalId];
    const where = ['pd.proposal_id = $1::uuid'];
    if (filter.documentVersionId !== undefined) where.push(`o.document_version_id = $${params.push(filter.documentVersionId)}::uuid`);
    if (filter.status !== undefined) where.push(`o.review_status = $${params.push(filter.status)}`);
    if (page.after !== undefined) {
      const match = CURSOR.exec(page.after.code);
      if (match === null) throw invalid('cursor');
      where.push(`(o.document_version_id, o.page_index) > ($${params.push(match[1])}::uuid, $${params.push(Number(match[2]))}::int)`);
    }
    const rows = await tx.query<PageSql>(
      `select ${PAGE_COLUMNS} from machvon.document_page_ocr o join machvon.proposal_document pd on pd.tenant_id = o.tenant_id and pd.document_version_id = o.document_version_id
        where ${where.join(' and ')} order by o.document_version_id, o.page_index limit $${params.push(page.limit + 1)}`,
      params,
    );
    const shown = rows.slice(0, page.limit);
    const tail = shown[shown.length - 1];
    return {
      kind: 'SEEN',
      proposal: found.line,
      documents: found.files,
      pages: shown.map(lineOf),
      more: rows.length > page.limit,
      last: tail === undefined ? undefined : { code: `${tail.document_version_id}:${tail.page_index}`, id: tail.id },
      gate: await this.gateOf(tx, proposalId),
    };
  }

  /**
   * Confirms or corrects a page that waits for a person (BR-BID-06). Refusals in order: the page is not one the caller has the full view of (404; 403 CONFLICT_UNDECLARED when the caller owes the
   * declaration), the page does not wait (409 OCR_STATE_INVALID), the body (422), the corrected text (422; `readCorrection` reads it from the store and says what it is). The reviewer is the caller and
   * the moment is the clock of the database.
   */
  async review(tx: TenantTx, id: string, input: ReviewInput, actor: string, viewer: ProposalViewer, readCorrection: (key: string) => Promise<CorrectedText>): Promise<ReviewedPage> {
    const owner = await tx.query<{ proposal_id: string }>(
      `select pd.proposal_id from machvon.document_page_ocr o join machvon.proposal_document pd on pd.tenant_id = o.tenant_id and pd.document_version_id = o.document_version_id
        where o.id = $1::uuid order by pd.proposal_id limit 1`,
      [id],
    );
    const proposalId = owner[0]?.proposal_id;
    if (proposalId === undefined) throw notFound();
    const found = await this.proposals.find(tx, proposalId, viewer);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (found.kind !== 'SEEN' || found.line.view !== 'FULL') throw notFound();

    // The readiness of the proposal is judged over all its pages: reviews of its pages go one after the other, so the last of them sees the others and reports the gate as it stands.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bid_ocr_review:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [proposalId]);
    const locked = await tx.query<PageSql>(`select ${PAGE_COLUMNS} from machvon.document_page_ocr o where o.id = $1::uuid for update`, [id]);
    const page = locked[0] as PageSql;
    const decision = checkReview(page.review_status, input);
    const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note : null;
    let corrected: { key: string; sha256: string } | undefined;
    if (decision === 'CORRECTED') {
      const key = input.correctedTextObjectKey as string;
      const taken = await tx.query(
        `select 1 from machvon.document_version where object_key = $1 union all select 1 from machvon.document_page_ocr where text_object_key = $1 or corrected_text_object_key = $1 limit 1`,
        [key],
      );
      if (taken.length > 0) throw invalid('corrected_text_object_key', 'FILE_ALREADY_ATTACHED');
      corrected = { key, sha256: (await readCorrection(key)).sha256 };
    }
    await tx.query(
      `update machvon.document_page_ocr
          set review_status = $2, reviewed_by = $3::uuid, reviewed_at = now(), review_note = $4, corrected_text_object_key = $5, corrected_text_sha256 = $6
        where id = $1::uuid`,
      [id, decision, actor, note, corrected?.key ?? null, corrected?.sha256 ?? null],
    );
    const gate = await this.gateOf(tx, proposalId);
    return {
      id,
      documentVersionId: page.document_version_id,
      pageIndex: page.page_index,
      proposalId,
      packageId: found.line.package.id,
      packageCode: found.line.package.code,
      projectId: found.line.project.id,
      contractorId: found.line.contractor.id,
      previousStatus: page.review_status,
      status: decision,
      hasNote: note !== null,
      confidence: page.confidence,
      tableMismatch: page.table_mismatch,
      financialReady: gate.ready,
    };
  }

  /** Whether the financial analysis of the given versions of documents may run: no page of them waits for a person. Used by the analysis, which has no viewer. */
  async gate(tx: TenantTx, documentVersionIds: readonly string[]): Promise<FinancialGate> {
    const ids = documentVersionIds.map((value) => asUuid(value)?.toLowerCase());
    if (ids.some((value) => value === undefined)) throw invalid('document_version_ids');
    const rows = await tx.query<GateSql>(
      'select o.id, o.page_index, o.review_status from machvon.document_page_ocr o where o.document_version_id = any($1::uuid[]) order by o.document_version_id, o.page_index',
      [ids],
    );
    return financialGate(rows.map(gatePageOf));
  }

  private async gateOf(tx: TenantTx, proposalId: string): Promise<FinancialGate> {
    const rows = await tx.query<GateSql>(
      `select o.id, o.page_index, o.review_status from machvon.document_page_ocr o join machvon.proposal_document pd on pd.tenant_id = o.tenant_id and pd.document_version_id = o.document_version_id
        where pd.proposal_id = $1::uuid order by o.document_version_id, o.page_index`,
      [proposalId],
    );
    return financialGate(rows.map(gatePageOf));
  }
}
