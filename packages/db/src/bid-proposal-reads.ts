import { conflictStanding, proposalView } from '@machvon/kernel';
import type { ConflictStanding, ProposalPart, ProposalStatus, ProposalView } from '@machvon/kernel';
import { SqlParams } from './bid-plan-reads.ts';
import type { Page } from './bid-plan-reads.ts';
import { timestampKey } from './keyset.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** Who reads the proposals: the member, the projects in which they evaluate and the projects in which they receive proposals, at this moment. */
export interface ProposalViewer {
  membershipId: string;
  evaluate: ScopeBuilder;
  receive: ScopeBuilder;
  now: Date;
}

export interface ProposalFile {
  id: string;
  /** The version of the document that holds the file: what the pages of its OCR belong to. */
  documentVersionId: string;
  part: ProposalPart;
  title: string;
  mime: string;
  pageCount: number;
  sizeBytes: number | null;
  receivedAt: string;
}

export interface ProposalLine {
  id: string;
  package: { id: string; code: string; title: string | null };
  project: { id: string; code: string };
  contractor: { id: string; legalName: string };
  revision: number;
  status: ProposalStatus;
  submittedAt: string;
  accessReleasedAt: string;
  released: boolean;
  fileCount: number;
  classification: string;
  version: number;
  /** What the caller may see of it; HIDDEN never leaves the store as a line. */
  view: Exclude<ProposalView, 'HIDDEN'>;
  standing: ConflictStanding;
  /** Only in the full view. */
  bidPriceVnd: string | null;
  createdAtKey: string;
}

interface ProposalSql {
  id: string;
  package_id: string;
  package_code: string;
  package_title: string | null;
  project_id: string;
  project_code: string;
  contractor_id: string;
  legal_name: string;
  revision: number;
  status: ProposalStatus;
  submitted_at: string;
  access_released_at: string;
  released: boolean;
  file_count: number;
  classification: string;
  version: string;
  bid_price_vnd: string | null;
  created_at_key: string;
  is_evaluator: boolean;
  is_clerk: boolean;
  declared: boolean;
  decl_has_conflict: boolean | null;
  decl_decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null;
  decl_contractor_id: string | null;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The proposals for reading (BID-05, BR-BID-03). A proposal is CONFIDENTIAL: the clerk who receives proposals sees its metadata, and a member of the evaluation team sees
 * all of it from the opening of the bids when no conflict stands in the way. What a caller may see is decided here, in one place, by the kernel; a proposal the caller may
 * not see is not a line.
 */
export class BidProposalReads {
  /** A page of the proposals the caller may see, newest first. The page can hold fewer lines than its size when the next ones are hidden from the caller. */
  async list(tx: TenantTx, viewer: ProposalViewer, filter: { packageId?: string | undefined }, page: Page): Promise<{ lines: ProposalLine[]; more: boolean; last: { code: string; id: string } | undefined }> {
    const query = this.query(viewer);
    const where = [query.reach];
    if (filter.packageId !== undefined) where.push(`pr.package_id = ${query.params.add(filter.packageId)}::uuid`);
    if (page.after !== undefined) where.push(`(${timestampKey('pr.created_at')}, pr.id) < (${query.params.add(page.after.code)}::text, ${query.params.add(page.after.id)}::uuid)`);
    const rows = await tx.query<ProposalSql>(`${query.select} where ${where.join(' and ')} order by pr.created_at desc, pr.id desc limit ${query.params.add(page.limit + 1)}`, query.params.values);
    const shown = rows.slice(0, page.limit);
    const tail = shown[shown.length - 1];
    return {
      lines: shown.map((row) => this.line(row)).filter((line): line is ProposalLine => line !== undefined),
      more: rows.length > page.limit,
      last: tail === undefined ? undefined : { code: tail.created_at_key, id: tail.id },
    };
  }

  /** One proposal with what the caller may see of it. `hidden` when it does not exist for the caller; `declaration` when it would be shown to them but they have not declared. */
  async find(tx: TenantTx, id: string, viewer: ProposalViewer): Promise<{ kind: 'HIDDEN' } | { kind: 'DECLARATION_REQUIRED' } | { kind: 'SEEN'; line: ProposalLine; files: ProposalFile[] }> {
    const query = this.query(viewer);
    const rows = await tx.query<ProposalSql>(`${query.select} where pr.id = ${query.params.add(id)}::uuid and ${query.reach}`, query.params.values);
    const row = rows[0];
    if (row === undefined) return { kind: 'HIDDEN' };
    const seen = this.seen(row);
    if (seen === 'HIDDEN') return { kind: 'HIDDEN' };
    if (seen === 'DECLARATION_REQUIRED') return { kind: 'DECLARATION_REQUIRED' };
    const line = this.line(row);
    if (line === undefined) return { kind: 'HIDDEN' };
    return { kind: 'SEEN', line, files: line.view === 'FULL' ? await this.files(tx, id) : [] };
  }

  /** The files of a proposal: the part, the title and what the file is, never where it is stored. */
  private async files(tx: TenantTx, proposalId: string): Promise<ProposalFile[]> {
    const rows = await tx.query<{ id: string; document_version_id: string; part: ProposalPart; title: string; mime: string; page_count: number; byte_length: string | null; received_at: string }>(
      `select pd.id, pd.document_version_id, pd.part, d.title, v.mime, v.page_count, v.byte_length::text as byte_length, to_char(pd.received_at at time zone 'UTC', ${ISO}) as received_at
         from machvon.proposal_document pd
         join machvon.document_version v on v.tenant_id = pd.tenant_id and v.id = pd.document_version_id
         join machvon.document d on d.tenant_id = v.tenant_id and d.id = v.document_id
        where pd.proposal_id = $1::uuid order by pd.received_at, pd.id`,
      [proposalId],
    );
    return rows.map((row) => ({
      id: row.id,
      documentVersionId: row.document_version_id,
      part: row.part,
      title: row.title,
      mime: row.mime,
      pageCount: row.page_count,
      sizeBytes: row.byte_length === null ? null : Number(row.byte_length),
      receivedAt: row.received_at,
    }));
  }

  private query(viewer: ProposalViewer): { params: SqlParams; select: string; reach: string } {
    const params = new SqlParams();
    const member = params.add(viewer.membershipId);
    const now = params.add(viewer.now.toISOString());
    const evaluate = params.scope(viewer.evaluate);
    const receive = params.scope(viewer.receive);
    const select = `select pr.id, k.id as package_id, k.code as package_code, k.title as package_title, p.id as project_id, p.code as project_code,
      c.id as contractor_id, c.legal_name, pr.revision, pr.status, to_char(pr.submitted_at at time zone 'UTC', ${ISO}) as submitted_at,
      to_char(pr.access_released_at at time zone 'UTC', ${ISO}) as access_released_at, (pr.access_released_at <= ${now}::timestamptz) as released,
      (select count(*)::int from machvon.proposal_document pd where pd.proposal_id = pr.id) as file_count, pr.classification, pr.version::text as version,
      pr.bid_price_vnd::text as bid_price_vnd, ${timestampKey('pr.created_at')} as created_at_key,
      (${evaluate}) as is_evaluator, (${receive}) as is_clerk, (decl.id is not null) as declared,
      decl.has_conflict as decl_has_conflict, decl.decision as decl_decision, decl.contractor_id as decl_contractor_id
      from ${SCOPE_FROM}
      join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
      join machvon.proposal pr on pr.tenant_id = k.tenant_id and pr.package_id = k.id
      join machvon.contractor c on c.tenant_id = pr.tenant_id and c.id = pr.contractor_id
      left join machvon.bid_conflict_declaration decl on decl.tenant_id = pr.tenant_id and decl.package_id = pr.package_id and decl.user_id = ${member}::uuid`;
    return { params, select, reach: `((${evaluate}) or (${receive}))` };
  }

  private seen(row: ProposalSql): ProposalView {
    return proposalView({
      status: row.status,
      released: row.released,
      evaluator: row.is_evaluator,
      clerk: row.is_clerk,
      standing: this.standing(row),
    });
  }

  private standing(row: ProposalSql): ConflictStanding {
    return conflictStanding(row.declared && row.decl_has_conflict !== null ? { hasConflict: row.decl_has_conflict, decision: row.decl_decision, contractorId: row.decl_contractor_id } : undefined, row.contractor_id);
  }

  private line(row: ProposalSql): ProposalLine | undefined {
    const view = this.seen(row);
    if (view === 'HIDDEN') return undefined;
    return {
      id: row.id,
      package: { id: row.package_id, code: row.package_code, title: row.package_title },
      project: { id: row.project_id, code: row.project_code },
      contractor: { id: row.contractor_id, legalName: row.legal_name },
      revision: row.revision,
      status: row.status,
      submittedAt: row.submitted_at,
      accessReleasedAt: row.access_released_at,
      released: row.released,
      fileCount: row.file_count,
      classification: row.classification,
      version: Number(row.version),
      view,
      standing: this.standing(row),
      bidPriceVnd: view === 'FULL' ? row.bid_price_vnd : null,
      createdAtKey: row.created_at_key,
    };
  }
}
