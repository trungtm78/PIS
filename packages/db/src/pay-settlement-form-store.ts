import { randomUUID } from 'node:crypto';
import { DomainError } from '@machvon/kernel';
import type { SettlementFormCode, SettlementFormFacts, SettlementScope, SettlementStatus } from '@machvon/kernel';
import { TIMESTAMP } from './ctr-contract-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const CHECK_VIOLATION = '23514';

/** A settlement that is verified and its forms are to be drawn: the figures that fill them, and the settlement itself held for update. */
export interface SettlementFormRequest {
  id: string;
  version: number;
  status: SettlementStatus;
  scope: SettlementScope;
  projectId: string;
  /** The unit that owns the project: the unit that drafts the decision of the settlement. */
  draftingUnitId: string;
  facts: Omit<SettlementFormFacts, 'place' | 'scope'> & { scope: SettlementScope };
}

/** A form of a settlement as the screens read it: the file it is, the template revision it was drawn from with the legal basis of that revision, and whether it still stands. */
export interface SettlementFormView {
  id: string;
  settlementId: string;
  formCode: string;
  status: 'REQUESTED' | 'GENERATED' | 'FAILED' | 'SUPERSEDED';
  templateCode: string | null;
  templateRevision: number | null;
  legalBasis: string;
  documentId: string | null;
  documentVersionId: string | null;
  fileSha256: string | null;
  payloadSha256: string | null;
  generatedAt: string | null;
  generatedBy: string | null;
}

export interface RecordSettlementFormInput {
  settlementId: string;
  formCode: SettlementFormCode;
  template: { id: string; code: string; revision: number; legalBasis: string };
  document: { documentId: string; versionId: string; checksum: string };
  payloadSha256: string;
  inputSha256: string;
  actor: string;
}

interface SettlementSql {
  id: string;
  version: string;
  status: SettlementStatus;
  settlement_scope: SettlementScope;
  project_id: string;
  owner_unit_id: string;
  project_code: string;
  project_name: string;
  agency: string;
  fiscal_year: number | null;
  revision: number;
  project_group: string | null;
  settled_amount_vnd: string;
  outstanding_vnd: string;
  unrecovered_advance_vnd: string;
  submitted_on: string | null;
  verified_on: string | null;
}

interface FormSql {
  id: string;
  settlement_revision_id: string;
  form_code: string;
  status: SettlementFormView['status'];
  template_code: string | null;
  template_revision: number | null;
  legal_basis: string;
  document_id: string | null;
  document_version_id: string | null;
  file_sha256: string | null;
  payload_sha256: string | null;
  generated_at: string | null;
  generated_by: string | null;
}

const FORM_COLUMNS = `f.id, f.settlement_revision_id, f.form_code, f.status, f.template_code, f.template_revision, f.legal_basis, f.document_id, f.document_version_id, f.file_sha256, f.payload_sha256,
       ${TIMESTAMP('f.generated_at')} as generated_at, f.generated_by`;

/** The settlement with the project and the two units its scope is judged by: the aliases `sr`, `p`, `ou` and `iu` are those of `projectScope`. */
const FROM = `machvon.settlement_revision sr
  join machvon.project p on p.tenant_id = sr.tenant_id and p.id = sr.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

const toForm = (row: FormSql): SettlementFormView => ({
  id: row.id,
  settlementId: row.settlement_revision_id,
  formCode: row.form_code,
  status: row.status,
  templateCode: row.template_code,
  templateRevision: row.template_revision,
  legalBasis: row.legal_basis,
  documentId: row.document_id,
  documentVersionId: row.document_version_id,
  fileSha256: row.file_sha256,
  payloadSha256: row.payload_sha256,
  generatedAt: row.generated_at,
  generatedBy: row.generated_by,
});

/**
 * The forms of a settlement (ST-PAY-012, PAY 3.5 step 3). They are drawn by DOC from the confirmed template in force; what is kept here is the proof, as for the Treasury forms of a payment request: the template
 * revision and its legal basis, the file and its hash, the hash of what filled it. A form is drawn for a settlement that is verified and replaces the one before it (which is superseded, never changed).
 */
export class PaySettlementFormStore {
  /** The settlement locked for update inside the scope of the command; it must be verified (409 `SETTLEMENT_STATE_INVALID`), and one the caller cannot see is not there (404). */
  async lockVerified(tx: TenantTx, settlementId: string, scope: ScopeBuilder): Promise<SettlementFormRequest> {
    const id = this.idOf(settlementId);
    const predicate = scope(2);
    const [row] = await tx.query<SettlementSql>(
      `select sr.id, sr.version::text as version, sr.status, sr.settlement_scope, sr.project_id, ou.id as owner_unit_id, p.code as project_code, p.name as project_name, coalesce(iu.name, ou.name) as agency, sr.fiscal_year, sr.revision,
              sr.project_group, sr.settled_amount_vnd::text as settled_amount_vnd, sr.outstanding_vnd::text as outstanding_vnd, sr.unrecovered_advance_vnd::text as unrecovered_advance_vnd,
              sr.submitted_on::text as submitted_on, sr.verified_on::text as verified_on
         from ${FROM}
        where sr.id = $1::uuid and ${predicate.sql} for update of sr`,
      [id, ...predicate.params],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.status !== 'VERIFIED') throw new DomainError('SETTLEMENT_STATE_INVALID', 409, 'id', { extensions: { status: row.status } });
    return {
      id: row.id,
      version: Number(row.version),
      status: row.status,
      scope: row.settlement_scope,
      projectId: row.project_id,
      draftingUnitId: row.owner_unit_id,
      facts: {
        agency: row.agency,
        projectCode: row.project_code,
        projectName: row.project_name,
        scope: row.settlement_scope,
        fiscalYear: row.fiscal_year,
        revision: row.revision,
        projectGroup: row.project_group,
        settledAmountVnd: row.settled_amount_vnd,
        outstandingVnd: row.outstanding_vnd,
        unrecoveredAdvanceVnd: row.unrecovered_advance_vnd,
        submittedOn: row.submitted_on,
        verifiedOn: row.verified_on,
      },
    };
  }

  /** The legal basis of a revision of a template, as the DOC library keeps it. */
  async legalBasisOf(tx: TenantTx, templateId: string): Promise<string> {
    const [row] = await tx.query<{ legal_basis: string | null }>('select legal_basis from machvon.document_template where id = $1::uuid', [templateId]);
    return row?.legal_basis ?? '';
  }

  /** Keeps a form that was drawn: the form that stood for the same settlement and code is superseded and this one stands. */
  async record(tx: TenantTx, input: RecordSettlementFormInput): Promise<SettlementFormView> {
    const id = randomUUID();
    try {
      await tx.query("update machvon.payment_form_instance set status = 'SUPERSEDED', updated_at = now(), updated_by = $3::uuid, version = version + 1 where settlement_revision_id = $1::uuid and form_code = $2 and status = 'GENERATED'", [
        input.settlementId,
        input.formCode,
        input.actor,
      ]);
      await tx.query(
        `insert into machvon.payment_form_instance
           (tenant_id, id, subject_kind, settlement_revision_id, form_code, template_version_id, template_code, template_revision, document_id, document_version_id, file_sha256, payload_sha256, input_sha256,
            legal_basis, status, generated_at, generated_by, created_by, updated_by)
         values (${TENANT}, $1::uuid, 'SETTLEMENT', $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, $8::uuid, $9, $10, $11, $12, 'GENERATED', now(), $13::uuid, $13::uuid, $13::uuid)`,
        [
          id,
          input.settlementId,
          input.formCode,
          input.template.id,
          input.template.code,
          input.template.revision,
          input.document.documentId,
          input.document.versionId,
          input.document.checksum,
          input.payloadSha256,
          input.inputSha256,
          input.template.legalBasis,
          input.actor,
        ],
      );
    } catch (error) {
      throw this.mapRefusal(error);
    }
    const [row] = await tx.query<FormSql>(`select ${FORM_COLUMNS} from machvon.payment_form_instance f where f.id = $1::uuid`, [id]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toForm(row);
  }

  /** The forms of a settlement in the scope of the caller, the ones that stand first and then the ones they replaced, newest first; undefined when the settlement is not there for the caller. */
  async list(tx: TenantTx, settlementId: string, scope: ScopeBuilder): Promise<SettlementFormView[] | undefined> {
    const predicate = scope(2);
    const [found] = await tx.query<{ id: string }>(`select sr.id from ${FROM} where sr.id = $1::uuid and ${predicate.sql}`, [this.idOf(settlementId), ...predicate.params]);
    if (found === undefined) return undefined;
    const rows = await tx.query<FormSql>(
      `select ${FORM_COLUMNS} from machvon.payment_form_instance f where f.settlement_revision_id = $1::uuid order by (f.status = 'GENERATED') desc, f.form_code, f.created_at desc, f.id desc`,
      [found.id],
    );
    return rows.map(toForm);
  }

  private idOf(value: string): string {
    if (!UUID.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    return value.toLowerCase();
  }

  /** What the database refused, in the words of the contract; anything else is not ours to explain. */
  private mapRefusal(error: unknown): unknown {
    const failure = error as { code?: string; message?: string };
    if (failure.code === CHECK_VIOLATION && typeof failure.message === 'string' && failure.message.startsWith('SETTLEMENT_STATE_INVALID')) return new DomainError('SETTLEMENT_STATE_INVALID', 409, 'id');
    return error;
  }
}
