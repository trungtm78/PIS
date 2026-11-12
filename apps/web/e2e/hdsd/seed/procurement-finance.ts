import { taxCode, vnd, vndMillions } from './context.ts';
import type { CommandReply, Obj , SeedContext} from './context.ts';
import TEXTS from './data/procurement-finance.json' with { type: 'json' };
import { textsWithOverlay } from './overlay.ts';

const tx = textsWithOverlay('procurement-finance', TEXTS);

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

const MAKER = 'projectManager';
const CHECKER = 'owner';

// ---- documents -----------------------------------------------------------------------------------------------------------------------------

const DOC_TYPES = [
  { code: 'HSNL', name: tx('name.001'), register: 'SO-HSNL' },
  { code: 'HD', name: tx('name.002'), register: 'SO-HD' },
  { code: 'BB', name: tx('name.003'), register: 'SO-BB' },
  { code: 'CV', name: tx('name.004'), register: 'SO-CV' },
  { code: 'BL', name: tx('name.005'), register: 'SO-BL' },
];

/** The kinds of paper this group files: a document type that exists answers with a conflict, which is the "skip". */
async function defineDocumentTypes(ctx: SeedContext): Promise<void> {
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
      legal_basis: tx('legal_basis.006'),
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
async function paper(ctx: SeedContext, spec: { symbol: string; title: string; docType: string; sender: string; issuedOn: string }): Promise<Paper> {
  const letter = await ctx.letter({ symbol: spec.symbol, title: spec.title, docType: spec.docType, sender: spec.sender, issuedOn: spec.issuedOn });
  return { documentId: letter.documentId, versionId: await versionOf(ctx, letter.documentId) };
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
  { n: 1, name: tx('name.007'), form: 'TNHH', outcome: 'VERIFIED' },
  { n: 2, name: tx('name.008'), form: 'CP', outcome: 'VERIFIED' },
  { n: 3, name: tx('name.009'), form: 'CP', outcome: 'VERIFIED' },
  { n: 4, name: tx('name.010'), form: 'TNHH', outcome: 'VERIFIED' },
  { n: 5, name: tx('name.011'), form: 'CP', outcome: 'VERIFIED' },
  { n: 6, name: tx('name.012'), form: 'TNHH', outcome: 'VERIFIED' },
  { n: 7, name: tx('name.013'), form: 'CP', outcome: 'VERIFIED' },
  { n: 8, name: tx('name.014'), form: 'TNHH', outcome: 'VERIFIED' },
  { n: 9, name: tx('name.015'), form: 'TNHH MTV', outcome: 'VERIFIED' },
  { n: 10, name: tx('name.016'), form: 'CP', outcome: 'VERIFIED' },
  { n: 11, name: tx('name.017'), form: 'TNHH', outcome: 'VERIFIED' },
  { n: 12, name: tx('name.018'), form: 'TNHH', outcome: 'UNVERIFIED' },
  { n: 13, name: tx('name.019'), form: 'CP', outcome: 'UNVERIFIED' },
  { n: 14, name: tx('name.020'), form: 'TNHH', outcome: 'REJECTED' },
  { n: 15, name: tx('name.021'), form: 'TNHH', outcome: 'VERIFIED' },
  { n: 16, name: tx('name.022'), form: 'CP', outcome: 'VERIFIED' },
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
async function registerContractors(ctx: SeedContext): Promise<void> {
  const existing = await ctx.list<Obj>(MAKER, '/resources/contractor');
  const byName = new Map(existing.map((row) => [String(row.legal_name), row]));
  for (const spec of CONTRACTORS) {
    let row = byName.get(spec.name);
    if (row === undefined) {
      const profile = await paper(ctx, { symbol: `HSNL-${String(spec.n).padStart(3, '0')}/2026`, title: tx('title.023', spec.name), docType: 'HSNL', sender: spec.name, issuedOn: ctx.day(-120 - spec.n) });
      await ctx.command(MAKER, '/contractors', { tax_identifier: taxCode(spec.n), legal_name: spec.name, legal_form: spec.form, profile_document_id: profile.documentId });
      row = (await ctx.list<Obj>(MAKER, '/resources/contractor')).find((candidate) => candidate.legal_name === spec.name);
      if (row === undefined) throw new Error(`the contractor ${spec.name} cannot be found after its registration`);
      ctx.record({ module: 'BID', screen: 'BID-01', kind: 'contractor', id: String(row.id), code: taxCode(spec.n), note: 'registered' });
    }
    if (spec.outcome !== 'UNVERIFIED' && String(row.verification_status) === 'UNVERIFIED') {
      const evidence = await paper(ctx, { symbol: `CV-XM-${String(spec.n).padStart(3, '0')}/2026`, title: tx('title.024', spec.name), docType: 'BB', sender: tx('sender.025'), issuedOn: ctx.day(-90 - spec.n) });
      const current = await ctx.get<Obj>(CHECKER, `/resources/contractor/${String(row.id)}`);
      await ctx.command(CHECKER, `/contractors/${String(row.id)}/verification`, { decision: spec.outcome, verification_evidence_document_id: evidence.documentId }, { version: Number(current.version) });
      ctx.record({ module: 'BID', screen: 'BID-02', kind: 'contractor-verification', id: String(row.id), code: taxCode(spec.n), note: spec.outcome });
    }
  }
}

// ---- entry ---------------------------------------------------------------------------------------------------------------------------------

export async function seedProcurementFinance(ctx: SeedContext): Promise<void> {
  await ctx.step('DOC', 'document types of the papers', () => defineDocumentTypes(ctx));
  await ctx.step('BID', 'contractors', () => registerContractors(ctx));
  void vnd;
  void vndMillions;
}

export type { CommandReply };
