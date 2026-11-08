import { randomUUID } from 'node:crypto';
import { DomainError, MAX_FILE_TITLE, MAX_PROPOSAL_FILES, PROPOSAL_PARTS, momentOf, receiptRefusal } from '@machvon/kernel';
import type { ProposalPart } from '@machvon/kernel';
import { BidContractorStore } from './bid-contractor-store.ts';
import { bidWindowOf } from './bid-proposal-release.ts';
import { DocumentStore, SEALED_SUBJECT_MODULE } from './document-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorGate } from './vendor-gate.ts';

/** The document type the files of a proposal are kept under. */
export const PROPOSAL_FILE_DOC_TYPE = 'BID-PROPOSAL-FILE';
/** What the documents of a proposal are about: the reads of the document module leave the documents of this subject out. */
export const PROPOSAL_SUBJECT_MODULE = SEALED_SUBJECT_MODULE;
/**
 * A package takes proposals while its plan is in force. Approving a plan puts its packages in PLANNED (bid-plan-store), so a package of an approved plan is PLANNED;
 * APPROVED is kept for the packages that were given that status before.
 */
export const PACKAGE_STATUSES_OPEN_FOR_BIDS: readonly string[] = ['PLANNED', 'APPROVED'];
export const isOpenForBids = (status: string): boolean => PACKAGE_STATUSES_OPEN_FOR_BIDS.includes(status);

/** A file of a proposal as the controller read it from the shared upload pipeline: clean, with the digest and the page count read from its bytes. */
export interface ProposalFileInput {
  part: ProposalPart;
  title: string;
  objectKey: string;
  checksum: string;
  mime: string;
  pageCount: number;
  byteLength: number;
}

export interface NewProposalInput {
  packageId: string;
  contractorId: string;
  submittedAt: string;
  bidPriceVnd?: string | undefined;
  files: readonly ProposalFileInput[];
}

/** What the receipt left, as the audit row, the event and the answer are written from: the stored values, never the request. */
export interface ReceivedProposal {
  id: string;
  packageId: string;
  packageCode: string;
  projectId: string;
  contractorId: string;
  revision: number;
  version: number;
  submittedAt: string;
  accessReleasedAt: string;
  fileCount: number;
  hasPrice: boolean;
  /** The live proposal of the same contractor that this one replaced. */
  supersededId: string | null;
}

interface PackageSql {
  id: string;
  code: string;
  status: string;
  project_id: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const PRICE = /^[0-9]{1,24}$/;

/**
 * The receipt of a sealed proposal (ST-BID-004, BID 3 F3): a clerk of the scope of `bid.proposal.receive` logs the files a contractor handed in while the bids are open. The
 * package is locked first, as in every command on it. The proposal is stored with the moment its contents are released (the opening of the bids), each file becomes a
 * confidential attachment document about the proposal, and a proposal of the same contractor that is still live is replaced by this one as the next revision.
 */
export class BidProposalStore {
  private readonly contractors = new BidContractorStore();
  private readonly vendorGate = new VendorGate();
  private readonly documents = new DocumentStore();

  /**
   * Refusals in order: the shape of the request (422), the package (404 outside the scope, 409 PACKAGE_STATE_INVALID), the time (422 BID_OPENING_UNSET, BID_CLOSED), the
   * contractor (422 CONTRACTOR_RESTRICTED, CONTRACTOR_NOT_VERIFIED).
   */
  async receive(tx: TenantTx, input: NewProposalInput, actor: string, scope: ScopeBuilder, now: Date): Promise<ReceivedProposal> {
    const submittedAt = momentOf(input.submittedAt);
    if (submittedAt === undefined) throw invalid('submitted_at');
    if (input.bidPriceVnd !== undefined && !PRICE.test(input.bidPriceVnd)) throw invalid('bid_price_vnd');
    this.assertFiles(input.files);

    const pack = await this.lockPackage(tx, input.packageId, scope);
    if (!isOpenForBids(pack.status)) throw new DomainError('PACKAGE_STATE_INVALID', 409, 'package_id', { extensions: { package_status: pack.status } });
    const window = await bidWindowOf(tx, pack.id);
    const refusal = receiptRefusal(window, submittedAt, now);
    if (refusal === 'SUBMITTED_IN_FUTURE') throw invalid('submitted_at');
    if (refusal !== undefined) throw new DomainError(refusal, 422, 'submitted_at');
    const openingAt = window.openingAt as string;

    const contractor = await this.contractors.find(tx, input.contractorId);
    if (contractor === undefined) throw invalid('contractor_id');
    const restricted = (await this.contractors.restrictionsInForce(tx, [contractor.id])).get(contractor.id);
    if (restricted !== undefined) throw new DomainError('CONTRACTOR_RESTRICTED', 422, 'contractor_id', { extensions: { restriction_kind: restricted.kind } });
    if (contractor.verificationStatus !== 'VERIFIED') throw new DomainError('CONTRACTOR_NOT_VERIFIED', 422, 'contractor_id', { extensions: { verification_status: contractor.verificationStatus } });
    // VND-1: a restriction on a member of a joint venture the contractor leads also stops the bid, and the profile is asked for before a bid (a warning until the tenant makes it a block).
    await this.vendorGate.assertAllowed(tx, 'BID_SUBMISSION', { contractorId: contractor.id, packageId: pack.id, now });

    // A stored file is the file of one proposal: the key of a file that stands for a document already would carry one bidder's file into another bidder's bid.
    const taken = await tx.query('select 1 from machvon.document_version where object_key = any($1::text[]) limit 1', [input.files.map((file) => file.objectKey)]);
    if (taken.length > 0) throw new DomainError('VALIDATION_FAILED', 422, 'documents', { extensions: { reason: 'FILE_ALREADY_ATTACHED' } });

    const earlier = await tx.query<{ id: string; revision: number; status: string }>(
      'select id, revision, status from machvon.proposal where package_id = $1::uuid and contractor_id = $2::uuid order by revision desc for update',
      [pack.id, contractor.id],
    );
    const live = earlier.find((row) => row.status === 'RECEIVED');
    if (live !== undefined) await tx.query("update machvon.proposal set status = 'SUPERSEDED', version = version + 1 where id = $1::uuid", [live.id]);
    const revision = (earlier[0]?.revision ?? 0) + 1;

    const id = randomUUID();
    const versionIds: string[] = [];
    const parts: Array<{ versionId: string; part: ProposalPart }> = [];
    for (const file of input.files) {
      const document = await this.documents.insertDocument(tx, {
        docKind: 'ATTACHMENT',
        docTypeCode: PROPOSAL_FILE_DOC_TYPE,
        title: file.title,
        classification: 'CONFIDENTIAL',
        createdBy: actor,
        subjectModule: PROPOSAL_SUBJECT_MODULE,
        subjectId: id,
      });
      const version = await this.documents.appendVersion(tx, {
        documentId: document.id,
        objectKey: file.objectKey,
        checksum: file.checksum,
        mime: file.mime,
        pageCount: file.pageCount,
        classification: 'CONFIDENTIAL',
        stage: 'ATTACHMENT',
        byteLength: file.byteLength,
        createdBy: actor,
      });
      // The upload pipeline scanned the bytes and the controller read only a file it found clean.
      await this.documents.setScanResult(tx, version.id, 'CLEAN');
      versionIds.push(version.id);
      parts.push({ versionId: version.id, part: file.part });
    }
    await tx.query(
      `insert into machvon.proposal
         (tenant_id, id, project_id, package_id, contractor_id, document_version_ids, revision, status, submitted_at, bid_price_vnd, access_released_at, classification, created_by, version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6, 'RECEIVED', $7::timestamptz, $8::numeric, $9::timestamptz, 'CONFIDENTIAL', $10::uuid, 1)`,
      [id, pack.project_id, pack.id, contractor.id, JSON.stringify(versionIds), revision, submittedAt, input.bidPriceVnd ?? null, openingAt, actor],
    );
    for (const entry of parts) {
      await tx.query(
        `insert into machvon.proposal_document (tenant_id, id, proposal_id, document_version_id, part, received_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4::uuid)`,
        [id, entry.versionId, entry.part, actor],
      );
    }
    return {
      id,
      packageId: pack.id,
      packageCode: pack.code,
      projectId: pack.project_id,
      contractorId: contractor.id,
      revision,
      version: 1,
      submittedAt,
      accessReleasedAt: openingAt,
      fileCount: input.files.length,
      hasPrice: input.bidPriceVnd !== undefined,
      supersededId: live?.id ?? null,
    };
  }

  private assertFiles(files: readonly ProposalFileInput[]): void {
    if (files.length === 0 || files.length > MAX_PROPOSAL_FILES) throw invalid('documents');
    const seen = new Set<string>();
    for (const file of files) {
      if (!(PROPOSAL_PARTS as readonly string[]).includes(file.part)) throw invalid('documents');
      const title = file.title.trim();
      if (title === '' || title.length > MAX_FILE_TITLE || title !== file.title) throw invalid('documents');
      // One file handed in twice is one file: the second would only make the proposal look larger.
      if (seen.has(file.checksum)) throw new DomainError('VALIDATION_FAILED', 422, 'documents', { extensions: { reason: 'DUPLICATE_FILE' } });
      seen.add(file.checksum);
    }
  }

  private async lockPackage(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<PackageSql> {
    const predicate = scope(2);
    const rows = await tx.query<PackageSql>(
      `select k.id, k.code, k.status, k.project_id from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = $1::uuid and ${predicate.sql} for update of p, k`,
      [packageId, ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }
}
