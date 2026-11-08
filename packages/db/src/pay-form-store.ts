import { randomUUID } from 'node:crypto';
import { DomainError, PAYMENT_FORM_CODES, formsMissing, versionConflict } from '@machvon/kernel';
import type { FormFacts, PaymentFormCode, PaymentKind, PaymentStatus } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, TIMESTAMP } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { PayClockStore } from './pay-clock-store.ts';
import { PayPaymentStore } from './pay-payment-store.ts';
import type { PaymentResult } from './pay-payment-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REF = 200;
const TENANT = `nullif(current_setting('app.tenant_id', true), '')::uuid`;
const CHECK_VIOLATION = '23514';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });

/** A request that is checked and its forms are to be drawn: the figures that fill them, and the request itself held for update. */
export interface FormRequest {
  id: string;
  version: number;
  status: PaymentStatus;
  facts: Omit<FormFacts, 'place'>;
  reach: ContractPlace;
}

/** A form as the screens read it: the file it is, the template revision it was drawn from with the legal basis of that revision, and whether it still stands. */
export interface FormView {
  id: string;
  paymentRequestId: string;
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

export interface RecordFormInput {
  requestId: string;
  formCode: PaymentFormCode;
  template: { id: string; code: string; revision: number; legalBasis: string };
  document: { documentId: string; versionId: string; checksum: string };
  payloadSha256: string;
  inputSha256: string;
  actor: string;
}

export interface SendToTreasuryInput {
  /** The day the file was sent, as the person entered it. */
  sentOn: string;
  /** The number the Treasury gave to the file, as the person entered it. */
  treasuryRef?: string | undefined;
  /** The forms that stand and go with the request. */
  formInstanceIds: string[];
}

interface RequestSql {
  id: string;
  version: string;
  status: PaymentStatus;
  request_no: string | null;
  request_kind: PaymentKind;
  contract_id: string;
  contract_code: string;
  contract_title: string | null;
  contractor_name: string | null;
  project_id: string;
  project_code: string;
  project_name: string;
  agency: string;
  plan_year: number | null;
  gross_vnd: string;
  advance_recovery_vnd: string;
  retention_vnd: string;
  tax_adjustment_vnd: string;
  net_vnd: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

interface FormSql {
  id: string;
  payment_request_id: string;
  form_code: string;
  status: FormView['status'];
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

const FORM_COLUMNS = `f.id, f.payment_request_id, f.form_code, f.status, f.template_code, f.template_revision, f.legal_basis, f.document_id, f.document_version_id, f.file_sha256, f.payload_sha256,
       ${TIMESTAMP('f.generated_at')} as generated_at, f.generated_by`;

const toForm = (row: FormSql): FormView => ({
  id: row.id,
  paymentRequestId: row.payment_request_id,
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
 * The Treasury forms of a payment request and the record that the file was sent (ST-PAY-005, PAY 3.3 steps 1 and 2). The forms are drawn by DOC from the template in force that is confirmed;
 * what is kept here is the proof: the template revision and its legal basis, the file and its hash, the hash of what filled it. A form is drawn for a request that is checked and replaces the
 * one before it (which is superseded, never changed); a request goes to the Treasury only with the day, the person and a standing form of each of the four kinds. Nothing here calls the Treasury:
 * the day and the number of the file are entered by hand.
 */
export class PayFormStore {
  private readonly contracts = new CtrContractStore();
  private readonly payments = new PayPaymentStore();
  private readonly clocks = new PayClockStore();

  /** The request locked for update inside the scope of the command, its contract locked first; it must be checked, and a stale version is 409 `VERSION_CONFLICT` when one is given. */
  async lockChecked(tx: TenantTx, requestId: string, scopes: ContractScopes, expectedVersion?: number): Promise<FormRequest> {
    const id = this.idOf(requestId, 'id');
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.payment_request where id = $1::uuid', [id]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const [row] = await tx.query<RequestSql>(
      `select pr.id, pr.version::text as version, pr.status, pr.request_no, pr.request_kind, c.id as contract_id, c.code as contract_code, c.title as contract_title, k.legal_name as contractor_name,
              c.project_id, p.code as project_code, p.name as project_name, coalesce(iu.name, ou.name) as agency, pr.plan_year, pr.gross_vnd::text as gross_vnd,
              pr.advance_recovery_vnd::text as advance_recovery_vnd, pr.retention_vnd::text as retention_vnd, pr.tax_adjustment_vnd::text as tax_adjustment_vnd, pr.net_vnd::text as net_vnd,
              ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
         from ${CONTRACT_SCOPE_FROM}
         join machvon.payment_request pr on pr.tenant_id = c.tenant_id and pr.contract_id = c.id
         left join machvon.contractor k on k.tenant_id = c.tenant_id and k.id = c.contractor_id
        where pr.id = $1::uuid for update of pr`,
      [id],
    );
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    if (row.status !== 'VERIFIED') throw new DomainError('PAYMENT_STATE_INVALID', 409, 'id', { extensions: { status: row.status } });
    return {
      id: row.id,
      version: Number(row.version),
      status: row.status,
      facts: {
        agency: row.agency,
        requestNo: row.request_no ?? row.id,
        requestKind: row.request_kind,
        contractCode: row.contract_code,
        contractTitle: row.contract_title ?? '',
        contractorName: row.contractor_name ?? '',
        projectCode: row.project_code,
        projectName: row.project_name,
        planYear: row.plan_year,
        grossVnd: row.gross_vnd,
        advanceRecoveryVnd: row.advance_recovery_vnd,
        retentionVnd: row.retention_vnd,
        taxAdjustmentVnd: row.tax_adjustment_vnd,
        netVnd: row.net_vnd,
      },
      reach: {
        contractId: row.contract_id,
        projectId: row.project_id,
        ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
        investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
      },
    };
  }

  /** The request as it stands, for the answer of a command that does not move it. */
  resultOf(tx: TenantTx, requestId: string): Promise<PaymentResult> {
    return this.payments.resultOf(tx, requestId, 'VERIFIED', []);
  }

  /** The legal basis of a revision of a template, as the DOC library keeps it. */
  async legalBasisOf(tx: TenantTx, templateId: string): Promise<string> {
    const [row] = await tx.query<{ legal_basis: string | null }>('select legal_basis from machvon.document_template where id = $1::uuid', [templateId]);
    return row?.legal_basis ?? '';
  }

  /** Keeps a form that was drawn: the form that stood for the same request and kind is superseded and this one stands. */
  async record(tx: TenantTx, input: RecordFormInput): Promise<FormView> {
    const id = randomUUID();
    try {
      await tx.query("update machvon.payment_form_instance set status = 'SUPERSEDED', updated_at = now(), updated_by = $3::uuid, version = version + 1 where payment_request_id = $1::uuid and form_code = $2 and status = 'GENERATED'", [
        input.requestId,
        input.formCode,
        input.actor,
      ]);
      await tx.query(
        `insert into machvon.payment_form_instance
           (tenant_id, id, subject_kind, payment_request_id, form_code, template_version_id, template_code, template_revision, document_id, document_version_id, file_sha256, payload_sha256, input_sha256,
            legal_basis, status, generated_at, generated_by, created_by, updated_by)
         values (${TENANT}, $1::uuid, 'PAYMENT_REQUEST', $2::uuid, $3, $4::uuid, $5, $6, $7::uuid, $8::uuid, $9, $10, $11, $12, 'GENERATED', now(), $13::uuid, $13::uuid, $13::uuid)`,
        [
          id,
          input.requestId,
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

  /** The forms of a request in the scope of the caller, the ones that stand first and then the ones they replaced, newest first; undefined when the request is not there for the caller. */
  async list(tx: TenantTx, requestId: string, scope: ScopeBuilder): Promise<FormView[] | undefined> {
    const predicate = scope(2);
    const [found] = await tx.query<{ id: string }>(
      `select pr.id from ${CONTRACT_SCOPE_FROM} join machvon.payment_request pr on pr.tenant_id = c.tenant_id and pr.contract_id = c.id where pr.id = $1::uuid and ${predicate.sql}`,
      [this.idOf(requestId, 'id'), ...predicate.params],
    );
    if (found === undefined) return undefined;
    const rows = await tx.query<FormSql>(
      `select ${FORM_COLUMNS} from machvon.payment_form_instance f where f.payment_request_id = $1::uuid order by (f.status = 'GENERATED') desc, f.form_code, f.created_at desc, f.id desc`,
      [found.id],
    );
    return rows.map(toForm);
  }

  /** How many of the four kinds stand for each request: the tracking board reads it. */
  async standing(tx: TenantTx, requestIds: readonly string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (requestIds.length === 0) return result;
    const rows = await tx.query<{ payment_request_id: string; form_code: string }>(
      "select payment_request_id, form_code from machvon.payment_form_instance where payment_request_id = any($1::uuid[]) and status = 'GENERATED' order by form_code",
      [requestIds],
    );
    for (const row of rows) result.set(row.payment_request_id, [...(result.get(row.payment_request_id) ?? []), row.form_code]);
    return result;
  }

  /**
   * Records that the file went to the Treasury, on the day and under the number the person entered (the platform calls nothing): the forms named must stand for this request and cover the four
   * kinds, else 422 `FORMS_NOT_GENERATED` names what is missing. The request goes from checked to sent to the Treasury.
   */
  async markSent(tx: TenantTx, requestId: string, expectedVersion: number, input: SendToTreasuryInput, actor: string, scopes: ContractScopes, today: string): Promise<PaymentResult> {
    if (!DATE.test(input.sentOn) || Number.isNaN(Date.parse(`${input.sentOn}T00:00:00Z`)) || new Date(`${input.sentOn}T00:00:00Z`).toISOString().slice(0, 10) !== input.sentOn) throw invalid('treasury_submitted_on');
    if (input.sentOn > today) throw invalid('treasury_submitted_on', 'IN_THE_FUTURE');
    const ref = input.treasuryRef === undefined ? null : input.treasuryRef.trim();
    if (ref !== null && (ref === '' || ref.length > MAX_REF)) throw invalid('treasury_ref');
    const ids = [...new Set(input.formInstanceIds.map((id) => this.idOf(id, 'form_instance_ids')))];
    if (ids.length === 0) throw invalid('form_instance_ids');
    const held = await this.lockChecked(tx, requestId, scopes, expectedVersion);
    const standing = await tx.query<{ id: string; form_code: string }>("select id, form_code from machvon.payment_form_instance where payment_request_id = $1::uuid and status = 'GENERATED'", [held.id]);
    const named = standing.filter((form) => ids.includes(form.id));
    if (named.length !== ids.length) throw invalid('form_instance_ids', 'NOT_STANDING_FORMS_OF_THIS_REQUEST');
    const missing = formsMissing(named.map((form) => form.form_code));
    if (missing.length > 0) throw new DomainError('FORMS_NOT_GENERATED', 422, 'form_instance_ids', { extensions: { missing_form_codes: missing, required_form_codes: [...PAYMENT_FORM_CODES] } });
    try {
      await tx.query(
        `update machvon.payment_request
            set status = 'SENT_TREASURY', treasury_submitted_on = $2::date, treasury_ref = $3, treasury_sent_by = $4::uuid, treasury_sent_at = now(), updated_at = now(), updated_by = $4::uuid, version = version + 1
          where id = $1::uuid`,
        [held.id, input.sentOn, ref, actor],
      );
    } catch (error) {
      throw this.mapRefusal(error);
    }
    // G1-17: the dossier is with the Treasury: its clock of working days starts at the instant the send recorded.
    await this.clocks.start(tx, { requestId: held.id, actor, now: new Date() });
    return this.payments.resultOf(tx, held.id, held.status, []);
  }

  private idOf(value: string, field: string): string {
    if (!UUID.test(value)) throw invalid(field);
    return value.toLowerCase();
  }

  /** What the database refused, in the words of the contract; anything else is not ours to explain. */
  private mapRefusal(error: unknown): unknown {
    const failure = error as { code?: string; message?: string };
    if (failure.code === CHECK_VIOLATION && typeof failure.message === 'string') {
      if (failure.message.startsWith('PAYMENT_STATE_INVALID')) return new DomainError('PAYMENT_STATE_INVALID', 409, 'id');
      if (failure.message.startsWith('FORMS_NOT_GENERATED')) return new DomainError('FORMS_NOT_GENERATED', 422, 'form_instance_ids');
    }
    return error;
  }
}
