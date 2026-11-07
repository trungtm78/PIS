import { taxCode } from '../context.ts';
import type { Obj , SeedContext} from '../context.ts';

/**
 * Group `procurement-finance` (modules BID, CTR and PAY): from the procurement plan of a project to the money that leaves the Treasury.
 *
 * The story. The Project Management Board (`projectManager`) plans the selection of contractors of the funded projects of the year, the leader
 * (`capApprover`) approves the plans on a decision, the packages go to bid: contractors are registered by the board and verified by the owner of the
 * tenant (maker is not checker). Some packages are still planned, some are open for bids (the proposals are sealed until the opening), some are being
 * evaluated, some are awarded. Each awarded package becomes a contract: drafted, reviewed, signed by the leader, activated with a performance guarantee,
 * with a bill of quantities; the supervisors measure the work, the leader accepts it, and the accountant (`treasuryMaker`) draws up the payment requests,
 * has them verified, sends them to the Treasury and reconciles what the Treasury confirms. Every step is a command of the product: nothing here writes
 * to the database.
 *
 * Everything asks first and skips what exists (by business code), so a second run on the same stack does nothing twice.
 */

/** The people of the chain: the board makes, the owner of the tenant checks, the leader decides, the accountant pays. */
export const MAKER = 'projectManager';
export const CHECKER = 'owner';
export const LEADER = 'capApprover';
export const ACCOUNTANT = 'treasuryMaker';

// ---- documents -----------------------------------------------------------------------------------------------------------------------------

const DOC_TYPES = [
  { code: 'HSNL', name: 'Hồ sơ năng lực', register: 'SO-HSNL' },
  { code: 'HD', name: 'Hợp đồng', register: 'SO-HD' },
  { code: 'BB', name: 'Biên bản', register: 'SO-BB' },
  { code: 'CV', name: 'Công văn', register: 'SO-CV' },
  { code: 'BL', name: 'Bảo lãnh', register: 'SO-BL' },
];

/** The kinds of paper this group files: a document type that exists answers with a conflict, which is the "skip". */
export async function defineDocumentTypes(ctx: SeedContext): Promise<void> {
  const known = new Set<string>(((await ctx.get<Obj>(MAKER, '/document-number-registers')).doc_types as Obj[]).map((row) => String(row.code)));
  for (const type of DOC_TYPES) {
    if (known.has(type.code)) continue;
    await ctx.command(MAKER, '/document-types', {
      code: type.code,
      name: type.name,
      abbreviation: type.code,
      symbol_kind: 'NAMED_TYPE',
      symbol_pattern: '{number}/{type}-{agency}',
      register_code: type.register,
      legal_basis: 'Nghị định số 30/2020/NĐ-CP',
      effective_from: '2026-01-01',
    });
  }
}

export interface Paper {
  documentId: string;
  versionId: string;
}

let versionByDocument: Map<string, string> | undefined;

async function versionOf(ctx: SeedContext, documentId: string): Promise<string> {
  const found = versionByDocument?.get(documentId);
  if (found !== undefined) return found;
  versionByDocument = new Map();
  for (const row of await ctx.list<Obj>(MAKER, '/resources/document_version')) versionByDocument.set(String(row.document_id), String(row.id));
  const again = versionByDocument.get(documentId);
  if (again === undefined) throw new Error(`the document ${documentId} has no version`);
  return again;
}

/** A paper of a unit or a firm (a contract, a guarantee, a minute, a profile) as a letter of the register: its document and its version. */
export async function paper(ctx: SeedContext, spec: { symbol: string; title: string; docType: string; sender: string; issuedOn: string }): Promise<Paper> {
  const letter = await ctx.letter({ symbol: spec.symbol, title: spec.title, docType: spec.docType, sender: spec.sender, issuedOn: spec.issuedOn });
  return { documentId: letter.documentId, versionId: await versionOf(ctx, letter.documentId) };
}

/** A decision of the authority that is IN FORCE (issued by DOC), or undefined when the office has issued none yet. */
export async function decisionInForce(ctx: SeedContext, index: number): Promise<string | undefined> {
  const rows = await ctx.list<Obj>(MAKER, '/outgoing-documents');
  const issued = rows.filter((row) => row.status === 'ISSUED' && row.doc_type_code === 'QD').sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const row = issued[index % Math.max(issued.length, 1)];
  return row === undefined ? undefined : String(row.document_id);
}

// ---- contractors (BID-01, BID-02, BID-21) -------------------------------------------------------------------------------------------------

interface ContractorSpec {
  n: number;
  name: string;
  form: string;
  /** What the board and the owner do with the registration. */
  outcome: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED';
}

const CONTRACTORS: ContractorSpec[] = [
  { n: 1, name: 'Công ty TNHH Xây dựng Minh An', form: 'TNHH', outcome: 'VERIFIED' },
  { n: 2, name: 'Công ty Cổ phần Đầu tư và Xây dựng Hưng Thịnh', form: 'CP', outcome: 'VERIFIED' },
  { n: 3, name: 'Công ty Cổ phần Xây dựng Giao thông Cao Bằng', form: 'CP', outcome: 'VERIFIED' },
  { n: 4, name: 'Công ty TNHH Thương mại và Xây dựng Phúc Lộc', form: 'TNHH', outcome: 'VERIFIED' },
  { n: 5, name: 'Công ty Cổ phần Tư vấn Thiết kế và Giám sát Bắc Việt', form: 'CP', outcome: 'VERIFIED' },
  { n: 6, name: 'Công ty TNHH Thiết bị Y tế Đông Dương', form: 'TNHH', outcome: 'VERIFIED' },
  { n: 7, name: 'Công ty Cổ phần Thiết bị Giáo dục Việt Hưng', form: 'CP', outcome: 'VERIFIED' },
  { n: 8, name: 'Công ty TNHH Xây dựng và Cơ khí Tân Phát', form: 'TNHH', outcome: 'VERIFIED' },
  { n: 9, name: 'Công ty TNHH Một thành viên Xây lắp Sông Bằng', form: 'TNHH MTV', outcome: 'VERIFIED' },
  { n: 10, name: 'Công ty Cổ phần Công trình Thủy lợi Cao Bằng', form: 'CP', outcome: 'VERIFIED' },
  { n: 11, name: 'Công ty TNHH Xây dựng Hoàng Long', form: 'TNHH', outcome: 'VERIFIED' },
  { n: 12, name: 'Công ty TNHH Vật liệu và Xây dựng Thăng Long', form: 'TNHH', outcome: 'UNVERIFIED' },
  { n: 13, name: 'Công ty Cổ phần Cơ điện Đại Phong', form: 'CP', outcome: 'UNVERIFIED' },
  { n: 14, name: 'Công ty TNHH Xây dựng Quang Vinh', form: 'TNHH', outcome: 'REJECTED' },
  { n: 15, name: 'Công ty TNHH Tư vấn Xây dựng Cao Bằng', form: 'TNHH', outcome: 'VERIFIED' },
  { n: 16, name: 'Công ty Cổ phần Tư vấn Đầu tư Xây dựng Việt Đông', form: 'CP', outcome: 'VERIFIED' },
];

/** The contractors of the story by their number (BID-01): name, id and version in the register. */
export async function contractorsByNumber(ctx: SeedContext): Promise<Map<number, Obj>> {
  const rows = await ctx.list<Obj>(MAKER, '/resources/contractor');
  const byName = new Map(rows.map((row) => [String(row.legal_name), row]));
  const found = new Map<number, Obj>();
  for (const spec of CONTRACTORS) {
    const row = byName.get(spec.name);
    if (row !== undefined) found.set(spec.n, row);
  }
  return found;
}

/** The board registers each firm with its profile; the owner of the tenant verifies it on the evidence (or turns it down); two stay waiting. */
export async function registerContractors(ctx: SeedContext): Promise<void> {
  const existing = await ctx.list<Obj>(MAKER, '/resources/contractor');
  const byName = new Map(existing.map((row) => [String(row.legal_name), row]));
  for (const spec of CONTRACTORS) {
    let row = byName.get(spec.name);
    if (row === undefined) {
      const profile = await paper(ctx, { symbol: `HSNL-${String(spec.n).padStart(3, '0')}/2026`, title: `Hồ sơ năng lực của ${spec.name}`, docType: 'HSNL', sender: spec.name, issuedOn: ctx.day(-120 - spec.n) });
      await ctx.command(MAKER, '/contractors', { tax_identifier: taxCode(spec.n), legal_name: spec.name, legal_form: spec.form, profile_document_id: profile.documentId });
      row = (await ctx.list<Obj>(MAKER, '/resources/contractor')).find((candidate) => candidate.legal_name === spec.name);
      if (row === undefined) throw new Error(`the contractor ${spec.name} cannot be found after its registration`);
      ctx.record({ module: 'BID', screen: 'BID-01', kind: 'contractor', id: String(row.id), code: taxCode(spec.n), note: 'registered' });
    }
    if (spec.outcome !== 'UNVERIFIED' && String(row.verification_status) === 'UNVERIFIED') {
      const evidence = await paper(ctx, { symbol: `CV-XM-${String(spec.n).padStart(3, '0')}/2026`, title: `Biên bản xác minh pháp nhân ${spec.name}`, docType: 'BB', sender: 'Ban Quản lý dự án Sở Kế hoạch và Đầu tư', issuedOn: ctx.day(-90 - spec.n) });
      const current = await ctx.get<Obj>(CHECKER, `/resources/contractor/${String(row.id)}`);
      await ctx.command(CHECKER, `/contractors/${String(row.id)}/verification`, { decision: spec.outcome, verification_evidence_document_id: evidence.documentId }, { version: Number(current.version) });
      ctx.record({ module: 'BID', screen: 'BID-02', kind: 'contractor-verification', id: String(row.id), code: taxCode(spec.n), note: spec.outcome });
    }
  }
}

