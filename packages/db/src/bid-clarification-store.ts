import { randomUUID } from 'node:crypto';
import {
  DomainError,
  assertAnswerDocumentIsNotTheQuestion,
  assertAnswerable,
  clarificationDueOf,
  clarificationQuestionOf,
  conflictStanding,
  standingOpens,
} from '@machvon/kernel';
import type { ClarificationStatus, ConflictStanding } from '@machvon/kernel';
import { SqlParams } from './bid-plan-reads.ts';
import { timestampKey } from './keyset.ts';
import { DocumentStore, SEALED_SUBJECT_MODULE } from './document-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** What the letter of a clarification request is about: the reads of the document module leave the documents of this subject to the request, which serves them to the people it names. */
export const CLARIFICATION_SUBJECT_MODULE = 'BID_CLARIFICATION';
/** The document type of the letter that carries a question to a contractor. */
export const CLARIFICATION_DOC_TYPE = 'BID-CLARIFICATION';
const MAX_LIST = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const invalid = (field: string, extensions?: Record<string, unknown>): DomainError => new DomainError('VALIDATION_FAILED', 422, field, extensions === undefined ? undefined : { extensions });
const idOf = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const notFound = (): DomainError => new DomainError('RESOURCE_NOT_FOUND', 404);

export interface SendInput {
  proposalId: string;
  question: unknown;
  basisFindingId?: string | undefined;
  dueAt: unknown;
}

/** Who sends a request: a member of the evaluation team, judged over the project of the package and, for the proposal, by the declaration of the conflicts of interest. */
export interface SenderViewer {
  membershipId: string;
  evaluate: ScopeBuilder;
}

export interface AnswerInput {
  answerDocumentId: string;
}

/** Who reads or answers requests. A guest contractor reaches the requests of their own contractor and nothing else; the staff of the owner reach the projects of the scope of the permission. */
export interface ClarificationViewer {
  membershipId: string;
  /** The contractor the caller is a guest of; null for the staff of the owner. */
  guestContractorId: string | null;
  /** The projects in which the staff caller holds the permission of the operation. */
  reach: ScopeBuilder;
  /** The projects in which the caller is a member of the evaluation team: the declaration of conflicts of interest binds them on the requests of a contractor. */
  evaluate: ScopeBuilder;
}

/** What a command left, as the audit row, the event and the answer are written from. */
export interface ClarificationResult {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  proposalId: string;
  contractorId: string;
  basisFindingId: string | null;
  dueAt: string;
  fromStatus: ClarificationStatus | null;
  status: ClarificationStatus;
  sentDocumentId: string;
  answerDocumentId: string | null;
  answeredAt: string | null;
  answeredAsGuest: boolean | null;
  version: number;
}

export interface ClarificationLine {
  id: string;
  package: { id: string; code: string };
  project: { id: string; code: string };
  proposalId: string;
  contractor: { id: string; legalName: string };
  question: string;
  /** The criterion of the finding the question rests on. */
  basisFinding: { id: string; criterionCode: string } | null;
  dueAt: string;
  status: ClarificationStatus;
  sentDocumentId: string | null;
  answerDocumentId: string | null;
  answeredAt: string | null;
  answeredBy: { membershipId: string; displayName: string } | null;
  answeredAsGuest: boolean | null;
  askedBy: { membershipId: string; displayName: string };
  createdAt: string;
  version: number;
  /** The units that own and invest in the project of the package, so that the permission of the caller can be judged for the line. */
  reach: { ownerUnit: { id: string; path: string }; investorUnit: { id: string; path: string } | null };
}

export type FoundClarification = { kind: 'HIDDEN' } | { kind: 'DECLARATION_REQUIRED' } | { kind: 'SEEN'; line: ClarificationLine };

interface ProposalSql {
  id: string;
  status: string;
  package_id: string;
  package_code: string;
  project_id: string;
  contractor_id: string;
  released: boolean;
  declared: boolean;
  decl_has_conflict: boolean | null;
  decl_decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null;
  decl_contractor_id: string | null;
}

interface LineSql {
  id: string;
  package_id: string;
  package_code: string;
  project_id: string;
  project_code: string;
  proposal_id: string;
  contractor_id: string;
  contractor_name: string | null;
  question: string;
  basis_finding_id: string | null;
  basis_criterion: string | null;
  due_at: string;
  status: ClarificationStatus;
  sent_document_id: string | null;
  answer_document_id: string | null;
  answered_at: string | null;
  answered_by: string | null;
  answerer_name: string | null;
  answered_as_guest: boolean | null;
  created_by: string;
  asker_name: string | null;
  created_at: string;
  created_at_key: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
  is_evaluator: boolean;
  declared: boolean;
  decl_has_conflict: boolean | null;
  decl_decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null;
  decl_contractor_id: string | null;
}

interface HeldSql {
  id: string;
  package_id: string;
  package_code: string;
  project_id: string;
  proposal_id: string;
  contractor_id: string;
  basis_finding_id: string | null;
  due_at: string;
  status: ClarificationStatus;
  sent_document_id: string;
  version: string;
  is_evaluator: boolean;
  declared: boolean;
  decl_has_conflict: boolean | null;
  decl_decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null;
  decl_contractor_id: string | null;
}

const standingOf = (row: { declared: boolean; decl_has_conflict: boolean | null; decl_decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null; decl_contractor_id: string | null }, contractorId: string): ConflictStanding =>
  conflictStanding(row.declared && row.decl_has_conflict !== null ? { hasConflict: row.decl_has_conflict, decision: row.decl_decision, contractorId: row.decl_contractor_id } : undefined, contractorId);

/** The declaration of the caller about the package of the proposal in `declaration`, joined by the member the parameter at `member` names. */
const DECLARATION_JOIN = (member: string): string => `left join machvon.bid_conflict_declaration decl on decl.tenant_id = k.tenant_id and decl.package_id = k.id and decl.user_id = ${member}::uuid`;
const DECLARATION_COLUMNS = '(decl.id is not null) as declared, decl.has_conflict as decl_has_conflict, decl.decision as decl_decision, decl.contractor_id as decl_contractor_id';

const SELECT = `select c.id, k.id as package_id, k.code as package_code, p.id as project_id, p.code as project_code, c.proposal_id, pr.contractor_id, ct.legal_name as contractor_name,
       c.question, c.basis_finding_id, bf.criterion_id as basis_criterion, to_char(c.due_at at time zone 'UTC', ${ISO}) as due_at, c.status, c.sent_document_id, c.answer_document_id,
       to_char(c.answered_at at time zone 'UTC', ${ISO}) as answered_at, c.answered_by, au.display_name as answerer_name, c.answered_as_guest, c.created_by, cu.display_name as asker_name,
       to_char(c.created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('c.created_at')} as created_at_key, c.version::text as version,
       ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path`;

const FROM = `from ${SCOPE_FROM}
  join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
  join machvon.bid_clarification c on c.tenant_id = k.tenant_id and c.package_id = k.id
  join machvon.proposal pr on pr.tenant_id = c.tenant_id and pr.id = c.proposal_id
  left join machvon.contractor ct on ct.tenant_id = pr.tenant_id and ct.id = pr.contractor_id
  left join machvon.analysis_finding bf on bf.tenant_id = c.tenant_id and bf.id = c.basis_finding_id
  left join machvon.tenant_user_directory au on au.tenant_id = c.tenant_id and au.membership_id = c.answered_by
  left join machvon.tenant_user_directory cu on cu.tenant_id = c.tenant_id and cu.membership_id = c.created_by`;

/**
 * The clarification requests to contractors (ST-BID-011, BID 3 F6, BR-BID-03): a member of the evaluation team who has the full view of a proposal asks its contractor to explain something in it, in a letter
 * (a confidential document of DOC about the request) with a deadline; the contractor, as a guest of their own contractor, or the clerk who took their letter, answers with a document before the deadline. The
 * request is kept as it was asked and answered once; an answer after the deadline is refused and nothing changes. A guest reaches only the requests of their own contractor: another's is, for them, one that does
 * not exist.
 */
export class BidClarificationStore {
  private readonly documents = new DocumentStore();

  /** `listLimit` is the most requests one read of the list returns. */
  private readonly listLimit: number;

  constructor(listLimit = MAX_LIST) {
    this.listLimit = listLimit;
  }

  /**
   * Sends a request. Refusals in order: the shape (422 `VALIDATION_FAILED`, 422 `DUE_IN_PAST`), the proposal (404 when the caller does not evaluate the project, the bids are not opened for them or a conflict
   * of interest shuts them out; 403 `CONFLICT_UNDECLARED` while they owe the declaration; 409 `PROPOSAL_NOT_OPEN` for a proposal that was replaced or withdrawn), the finding the question rests on (422).
   */
  async send(tx: TenantTx, input: SendInput, viewer: SenderViewer, actor: string, now: Date): Promise<ClarificationResult> {
    const question = clarificationQuestionOf(input.question);
    const proposalId = idOf(input.proposalId, 'proposal_id');
    const basisFindingId = input.basisFindingId === undefined ? undefined : idOf(input.basisFindingId, 'basis_finding_id');
    const dueAt = clarificationDueOf(input.dueAt, now);

    const proposal = await this.proposalOf(tx, proposalId, viewer, now);
    if (basisFindingId !== undefined && !(await this.findingOfProposal(tx, basisFindingId, proposal.id))) throw invalid('basis_finding_id');

    const id = randomUUID();
    const letter = await this.documents.insertDocument(tx, {
      docKind: 'REFERENCE',
      docTypeCode: CLARIFICATION_DOC_TYPE,
      title: `Clarification request ${proposal.package_code}`,
      classification: 'CONFIDENTIAL',
      createdBy: actor,
      subjectModule: CLARIFICATION_SUBJECT_MODULE,
      subjectId: id,
    });
    await tx.query(
      `insert into machvon.bid_clarification
         (tenant_id, id, package_id, proposal_id, question, basis_finding_id, due_at, status, sent_document_id, created_by, updated_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz, 'SENT', $7::uuid, $8::uuid, $8::uuid, 1)`,
      [id, proposal.package_id, proposal.id, question, basisFindingId ?? null, dueAt, letter.id, actor],
    );
    return {
      id,
      packageId: proposal.package_id,
      packageCode: proposal.package_code,
      projectId: proposal.project_id,
      proposalId: proposal.id,
      contractorId: proposal.contractor_id,
      basisFindingId: basisFindingId ?? null,
      dueAt,
      fromStatus: null,
      status: 'SENT',
      sentDocumentId: letter.id,
      answerDocumentId: null,
      answeredAt: null,
      answeredAsGuest: null,
      version: 1,
    };
  }

  /**
   * Records the answer of the contractor: a document, within the deadline. Refusals in order: the shape (422), the request (404 for anyone who does not reach it, a guest of another contractor included; 403
   * `CONFLICT_UNDECLARED` for a member of the evaluation team who owes the declaration), the time and the state (409 `CLARIFICATION_EXPIRED` after the deadline whatever the state, 409
   * `CLARIFICATION_STATE_INVALID`), the version (409), the document (422: it must exist, not be the letter, nor a document that answers or asks another request, and a guest names only one they made themselves).
   */
  async answer(tx: TenantTx, id: string, expectedVersion: number, input: AnswerInput, viewer: ClarificationViewer, now: Date): Promise<ClarificationResult> {
    const documentId = idOf(input.answerDocumentId, 'answer_document_id');
    const held = await this.lock(tx, id, viewer);
    assertAnswerable({ status: held.status, dueAt: held.due_at, version: Number(held.version) }, expectedVersion, now);
    assertAnswerDocumentIsNotTheQuestion(documentId, held.sent_document_id);
    await this.assertAnswerDocument(tx, documentId, viewer);

    const guest = viewer.guestContractorId !== null;
    await tx.query(
      `update machvon.bid_clarification
          set status = 'ANSWERED', answer_document_id = $2::uuid, answered_at = $3::timestamptz, answered_by = $4::uuid, answered_as_guest = $5, updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, documentId, now.toISOString(), viewer.membershipId, guest],
    );
    return {
      id: held.id,
      packageId: held.package_id,
      packageCode: held.package_code,
      projectId: held.project_id,
      proposalId: held.proposal_id,
      contractorId: held.contractor_id,
      basisFindingId: held.basis_finding_id,
      dueAt: held.due_at,
      fromStatus: held.status,
      status: 'ANSWERED',
      sentDocumentId: held.sent_document_id,
      answerDocumentId: documentId,
      answeredAt: now.toISOString(),
      answeredAsGuest: guest,
      version: Number(held.version) + 1,
    };
  }

  /**
   * The requests the caller reaches, the newest first, optionally those of one package or one proposal. `owed` is true when the caller is a member of the evaluation team who has not declared about the package of
   * one that is left out: the declaration is theirs to make before they read.
   */
  async list(tx: TenantTx, viewer: ClarificationViewer, filter: { packageId?: string | undefined; proposalId?: string | undefined }): Promise<{ lines: ClarificationLine[]; owed: boolean }> {
    let owed = false;
    const lines: ClarificationLine[] = [];
    // What a conflict shuts the caller out of is decided by the declaration, row by row, so the limit counts the requests the caller may see: the pages are read until it is reached or the requests are all read.
    let after: { key: string; id: string } | undefined;
    while (lines.length < this.listLimit) {
      const query = this.query(viewer);
      const where = [query.reach];
      if (filter.packageId !== undefined) where.push(`k.id = ${query.params.add(filter.packageId)}::uuid`);
      if (filter.proposalId !== undefined) where.push(`c.proposal_id = ${query.params.add(filter.proposalId)}::uuid`);
      if (after !== undefined) where.push(`(${timestampKey('c.created_at')}, c.id) < (${query.params.add(after.key)}::text, ${query.params.add(after.id)}::uuid)`);
      const rows = await tx.query<LineSql>(`${query.select} where ${where.join(' and ')} order by c.created_at desc, c.id desc limit ${this.listLimit}`, query.params.values);
      for (const row of rows) {
        const seen = this.seen(row, viewer);
        if (seen === 'DECLARATION_REQUIRED') owed = true;
        else if (seen === 'SEEN' && lines.length < this.listLimit) lines.push(this.line(row));
      }
      const tail = rows[rows.length - 1];
      if (rows.length < this.listLimit || tail === undefined) break;
      after = { key: tail.created_at_key, id: tail.id };
    }
    return { lines, owed };
  }

  /** One request the caller reaches. `HIDDEN` when it does not exist for them (another contractor's, another tenant's, a conflict shuts them out). */
  async find(tx: TenantTx, id: string, viewer: ClarificationViewer): Promise<FoundClarification> {
    const query = this.query(viewer);
    const rows = await tx.query<LineSql>(`${query.select} where c.id = ${query.params.add(id)}::uuid and ${query.reach}`, query.params.values);
    const row = rows[0];
    if (row === undefined) return { kind: 'HIDDEN' };
    const seen = this.seen(row, viewer);
    return seen === 'SEEN' ? { kind: 'SEEN', line: this.line(row) } : { kind: seen };
  }

  // ---- internals --------------------------------------------------------------------------------------------------------

  /** The proposal a question is asked about, as the one who asks may see it: opened, theirs to evaluate, no conflict standing. */
  private async proposalOf(tx: TenantTx, proposalId: string, viewer: SenderViewer, now: Date): Promise<ProposalSql> {
    const params = new SqlParams();
    const member = params.add(viewer.membershipId);
    const at = params.add(now.toISOString());
    const evaluate = params.scope(viewer.evaluate);
    const rows = await tx.query<ProposalSql>(
      `select pr.id, pr.status, k.id as package_id, k.code as package_code, p.id as project_id, pr.contractor_id, (pr.access_released_at <= ${at}::timestamptz) as released, ${DECLARATION_COLUMNS}
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.proposal pr on pr.tenant_id = k.tenant_id and pr.package_id = k.id
         ${DECLARATION_JOIN(member)}
        where pr.id = ${params.add(proposalId)}::uuid and ${evaluate}`,
      params.values,
    );
    const proposal = rows[0];
    if (proposal === undefined) throw notFound();
    // Before the opening of the bids a proposal does not exist for an evaluator, and one that a conflict shuts them out of does not either.
    if (!proposal.released) throw notFound();
    const standing = standingOf(proposal, proposal.contractor_id);
    if (standing === 'UNDECLARED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (!standingOpens(standing)) throw notFound();
    if (proposal.status !== 'RECEIVED') throw new DomainError('PROPOSAL_NOT_OPEN', 409, 'proposal_id', { extensions: { proposal_status: proposal.status } });
    return proposal;
  }

  private async findingOfProposal(tx: TenantTx, findingId: string, proposalId: string): Promise<boolean> {
    const rows = await tx.query(
      `select 1 from machvon.analysis_finding f join machvon.analysis_run r on r.tenant_id = f.tenant_id and r.id = f.run_id where f.id = $1::uuid and r.proposal_id = $2::uuid`,
      [findingId, proposalId],
    );
    return rows.length > 0;
  }

  /** The request, locked, when the caller reaches it. */
  private async lock(tx: TenantTx, id: string, viewer: ClarificationViewer): Promise<HeldSql> {
    const query = this.query(viewer);
    const rows = await tx.query<HeldSql>(
      `select c.id, k.id as package_id, k.code as package_code, p.id as project_id, c.proposal_id, pr.contractor_id, c.basis_finding_id, to_char(c.due_at at time zone 'UTC', ${ISO}) as due_at,
              c.status, c.sent_document_id, c.version::text as version, ${query.evaluator} as is_evaluator, ${DECLARATION_COLUMNS}
         from ${SCOPE_FROM}
         join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.bid_clarification c on c.tenant_id = k.tenant_id and c.package_id = k.id
         join machvon.proposal pr on pr.tenant_id = c.tenant_id and pr.id = c.proposal_id
         ${DECLARATION_JOIN(query.member)}
        where c.id = ${query.params.add(id)}::uuid and ${query.reach} for update of c`,
      query.params.values,
    );
    const row = rows[0];
    if (row === undefined) throw notFound();
    const seen = this.seen(row, viewer);
    if (seen === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    if (seen === 'HIDDEN') throw notFound();
    return row;
  }

  /** The document that answers: one of DOC that is not about a sealed proposal and answers or asks no other request; a guest names only a document they made themselves. */
  private async assertAnswerDocument(tx: TenantTx, documentId: string, viewer: ClarificationViewer): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('bid_clarification_document:' || current_setting('app.tenant_id') || ':' || $1::text, 0))", [documentId]);
    const rows = await tx.query<{ created_by: string; subject_module: string | null; taken: boolean }>(
      `select d.created_by, d.subject_module,
              exists (select 1 from machvon.bid_clarification c where c.tenant_id = d.tenant_id and (c.answer_document_id = d.id or c.sent_document_id = d.id)) as taken
         from machvon.document d where d.id = $1::uuid`,
      [documentId],
    );
    const document = rows[0];
    if (document === undefined || document.subject_module === SEALED_SUBJECT_MODULE) throw invalid('answer_document_id');
    if (document.taken) throw invalid('answer_document_id', { reason: 'DOCUMENT_ALREADY_USED' });
    if (viewer.guestContractorId !== null && document.created_by !== viewer.membershipId) throw invalid('answer_document_id');
  }

  private query(viewer: ClarificationViewer): { params: SqlParams; member: string; evaluator: string; reach: string; select: string } {
    const params = new SqlParams();
    const member = params.add(viewer.membershipId);
    const evaluator = `(${params.scope(viewer.evaluate)})`;
    // A guest reaches the requests about the proposals of their own contractor, whichever the package; the staff reach the projects of the permission.
    const reach = viewer.guestContractorId === null ? `(${params.scope(viewer.reach)})` : `pr.contractor_id = ${params.add(viewer.guestContractorId)}::uuid`;
    const select = `${SELECT}, ${evaluator} as is_evaluator, ${DECLARATION_COLUMNS}
  ${FROM}
  ${DECLARATION_JOIN(member)}`;
    return { params, member, evaluator, reach, select };
  }

  /** A guest sees what asks their contractor; a member of the evaluation team sees it as they see the proposal: with the declaration made and no conflict standing; any other staff reader sees it. */
  private seen(row: { is_evaluator: boolean; contractor_id: string; declared: boolean; decl_has_conflict: boolean | null; decl_decision: 'ALLOWED' | 'RECUSED' | 'BLOCKED' | null; decl_contractor_id: string | null }, viewer: ClarificationViewer): 'SEEN' | 'HIDDEN' | 'DECLARATION_REQUIRED' {
    if (viewer.guestContractorId !== null || !row.is_evaluator) return 'SEEN';
    const standing = standingOf(row, row.contractor_id);
    if (standing === 'UNDECLARED') return 'DECLARATION_REQUIRED';
    return standingOpens(standing) ? 'SEEN' : 'HIDDEN';
  }

  private line(row: LineSql): ClarificationLine {
    return {
      id: row.id,
      package: { id: row.package_id, code: row.package_code },
      project: { id: row.project_id, code: row.project_code },
      proposalId: row.proposal_id,
      contractor: { id: row.contractor_id, legalName: row.contractor_name ?? '' },
      question: row.question,
      basisFinding: row.basis_finding_id === null ? null : { id: row.basis_finding_id, criterionCode: row.basis_criterion ?? '' },
      dueAt: row.due_at,
      status: row.status,
      sentDocumentId: row.sent_document_id,
      answerDocumentId: row.answer_document_id,
      answeredAt: row.answered_at,
      answeredBy: row.answered_by === null ? null : { membershipId: row.answered_by, displayName: row.answerer_name ?? '' },
      answeredAsGuest: row.answered_as_guest,
      askedBy: { membershipId: row.created_by, displayName: row.asker_name ?? '' },
      createdAt: row.created_at,
      version: Number(row.version),
      reach: {
        ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
        investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
      },
    };
  }
}
