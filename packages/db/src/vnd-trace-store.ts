import { DomainError } from '@machvon/kernel';
import type { FieldCipher } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface NewSubmissionTrace {
  origin?: string | undefined;
  device?: string | undefined;
  agent?: string | undefined;
  submittedAt?: string | undefined;
  files?: Array<{ documentVersionId: string; author?: string | undefined; producer?: string | undefined; createdStamp?: string | undefined }> | undefined;
}

export interface SubmissionTraceRow {
  id: string;
  proposalId: string;
  packageId: string;
  contractorId: string;
  recordedBy: string;
  files: number;
}

const fold = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

/**
 * The trace of the submission of a proposal (VND-3, V6): where and with what a proposal was handed in. The officer who receives it records the address and the device of the submission and the author, the producing program
 * and the creation stamp of each file; every value becomes a blind index of the field cipher (so two proposals from one origin are found by equality and no address, device or author is stored). A trace is recorded once and
 * never rewritten (409 SUBMISSION_TRACE_EXISTS); a proposal without one is simply "not recorded" to the screening.
 */
export class VendorTraceStore {
  private readonly cipher: FieldCipher;

  constructor(cipher: FieldCipher) {
    this.cipher = cipher;
  }

  async record(tx: TenantTx, tenantId: string, proposalId: string, input: NewSubmissionTrace, actor: string): Promise<SubmissionTraceRow> {
    const [proposal] = await tx.query<{ package_id: string; contractor_id: string; document_version_ids: unknown }>('select package_id, contractor_id, document_version_ids from machvon.proposal where id = $1::uuid', [proposalId]);
    if (proposal === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [taken] = await tx.query<{ id: string }>('select id from machvon.proposal_submission_trace where proposal_id = $1::uuid', [proposalId]);
    if (taken !== undefined) throw new DomainError('SUBMISSION_TRACE_EXISTS', 409);
    const files = input.files ?? [];
    const hasFile = files.some((file) => [file.author, file.producer, file.createdStamp].some((value) => value !== undefined && value.trim() !== ''));
    if (input.origin === undefined && input.device === undefined && input.agent === undefined && !hasFile) throw invalid('origin');
    const submittedAt = input.submittedAt === undefined ? null : new Date(input.submittedAt);
    if (submittedAt !== null && Number.isNaN(submittedAt.getTime())) throw invalid('submitted_at');
    const key = (scope: string, value: string | undefined): string | null => (value === undefined || value.trim() === '' ? null : this.cipher.blindIndex(tenantId, scope, fold(value)));
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.proposal_submission_trace (tenant_id, proposal_id, package_id, contractor_id, origin_key, device_key, agent_key, submitted_at, recorded_by)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz, $8::uuid) returning id`,
      [proposalId, proposal.package_id, proposal.contractor_id, key('submission-origin', input.origin), key('submission-device', input.device), key('submission-agent', input.agent), submittedAt === null ? null : submittedAt.toISOString(), actor],
    );
    const id = (row as { id: string }).id;
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.documentVersionId)) throw invalid('files');
      seen.add(file.documentVersionId);
      const [belongs] = await tx.query<{ ok: boolean }>(
        `select (exists (select 1 from machvon.proposal_document d where d.proposal_id = $1::uuid and d.document_version_id = $2::uuid)
              or exists (select 1 from machvon.proposal p where p.id = $1::uuid and p.document_version_ids @> to_jsonb($2::text))) as ok`,
        [proposalId, file.documentVersionId],
      );
      if (belongs?.ok !== true) throw invalid('files');
      const fingerprint = [file.author, file.producer, file.createdStamp].map((value) => (value === undefined ? '' : fold(value))).join('|');
      if (fingerprint === '||') continue;
      await tx.query(
        `insert into machvon.proposal_submission_file (tenant_id, trace_id, document_version_id, file_key) values (${TENANT}, $1::uuid, $2::uuid, $3)`,
        [id, file.documentVersionId, this.cipher.blindIndex(tenantId, 'submission-file', fingerprint)],
      );
    }
    return { id, proposalId, packageId: proposal.package_id, contractorId: proposal.contractor_id, recordedBy: actor, files: seen.size };
  }
}
