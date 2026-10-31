import { randomUUID } from 'node:crypto';
import { DomainError, MATERIAL_RESULTS, MATERIAL_TEST_STATUSES, assertCanRecordResult, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { MaterialResult, MaterialTestStatus, NcrSeverity, NcrStatus } from '@machvon/kernel';
import { assertCleanDocument } from './ast-evidence.ts';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, calendarDate, textOf } from './ctr-contract-store.ts';
import type { ContractPlace, ContractScopes } from './ctr-contract-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import { QmsNonconformanceStore } from './qms-nonconformance-store.ts';
import type { NcrResult } from './qms-nonconformance-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WORDS = 200;
const MAX_PAGE = 200;
/** The values a laboratory reports are a small object (a few measurements and their units): more than this is a file, and the file is the report. */
const MAX_VALUES_BYTES = 65_536;
const UNIQUE_VIOLATION = '23505';

export const MATERIAL_TEST_RESOURCE = 'material_test';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const choice = <T extends string>(values: readonly T[], value: string, field: string): T => {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw invalid(field);
  return found;
};

export interface RegisterInput {
  contractId: string;
  boqItemId?: string | undefined;
  sampleCode: string;
  materialKind: string;
  labName: string;
  standardRef: string;
  sampledOn: string;
}

export interface ResultInput {
  result: string;
  testedOn: string;
  resultValues: Record<string, unknown>;
  reportDocumentVersionId: string;
}

/** A contract a sample can be registered on. */
export interface ContractOption {
  id: string;
  code: string;
  title: string | null;
  projectId: string;
}

export interface MaterialFilter {
  contractId?: string | undefined;
  status?: string | undefined;
  result?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a command did to a test: the facts the audit row and the event carry, and the non-conformance a failed result raised. */
export interface MaterialTestResult {
  id: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  sampleCode: string;
  materialKind: string;
  labName: string;
  standardRef: string;
  sampledOn: string;
  testedOn: string | null;
  result: MaterialResult | 'PENDING';
  fromStatus: MaterialTestStatus | null;
  status: MaterialTestStatus;
  version: number;
  nonconformance: NcrResult | null;
}

export interface MaterialTestLine {
  id: string;
  contract: { id: string; code: string };
  projectId: string;
  boqItemId: string | null;
  sampleCode: string;
  materialKind: string;
  labName: string;
  standardRef: string;
  sampledOn: string;
  testedOn: string | null;
  result: MaterialResult | 'PENDING';
  resultValues: Record<string, unknown>;
  reportDocumentVersionId: string | null;
  status: MaterialTestStatus;
  nonconformance: { id: string; ncrNo: string; severity: NcrSeverity; status: NcrStatus } | null;
  createdAt: string;
  version: number;
  reach: ContractPlace;
}

interface LineSql {
  id: string;
  contract_id: string;
  contract_code: string;
  project_id: string;
  boq_item_id: string | null;
  sample_code: string;
  material_kind: string;
  lab_name: string;
  standard_ref: string;
  sampled_on: string;
  tested_on: string | null;
  result: MaterialResult | 'PENDING';
  result_values: Record<string, unknown>;
  report_document_version_id: string | null;
  status: MaterialTestStatus;
  ncr_id: string | null;
  ncr_no: string | null;
  ncr_severity: NcrSeverity | null;
  ncr_status: NcrStatus | null;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const FROM = `${CONTRACT_SCOPE_FROM}
  join machvon.material_test t on t.tenant_id = c.tenant_id and t.contract_id = c.id
  left join machvon.quality_nonconformance n on n.tenant_id = t.tenant_id and n.id = t.nonconformance_id`;

const SELECT = `select t.id, c.id as contract_id, c.code as contract_code, c.project_id, t.boq_item_id, t.sample_code, t.material_kind, t.lab_name, t.standard_ref, t.sampled_on::text as sampled_on,
       t.tested_on::text as tested_on, t.result, t.result_values, t.report_document_version_id, t.status, n.id as ncr_id, n.ncr_no, n.severity as ncr_severity, n.status as ncr_status,
       ${timestampKey('t.created_at')} as created_at, t.version::text as version, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${FROM}`;

const toLine = (row: LineSql): MaterialTestLine => ({
  id: row.id,
  contract: { id: row.contract_id, code: row.contract_code },
  projectId: row.project_id,
  boqItemId: row.boq_item_id,
  sampleCode: row.sample_code,
  materialKind: row.material_kind,
  labName: row.lab_name,
  standardRef: row.standard_ref,
  sampledOn: row.sampled_on,
  testedOn: row.tested_on,
  result: row.result,
  resultValues: row.result_values,
  reportDocumentVersionId: row.report_document_version_id,
  status: row.status,
  nonconformance: row.ncr_id === null || row.ncr_no === null || row.ncr_severity === null || row.ncr_status === null ? null : { id: row.ncr_id, ncrNo: row.ncr_no, severity: row.ncr_severity, status: row.ncr_status },
  createdAt: row.created_at,
  version: Number(row.version),
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
  },
});

interface Held {
  id: string;
  contract_id: string;
  contract_code: string;
  project_id: string;
  sample_code: string;
  material_kind: string;
  lab_name: string;
  standard_ref: string;
  sampled_on: string;
  sampled_by: string;
  status: MaterialTestStatus;
  version: string;
}

/**
 * The testing of materials (ST-QMS-007, QMS 3.3, UC-QMS-03, UAT-AC362). A supervisor registers a sample against a contract being performed, with a code that is new in the contract (409 `SAMPLE_CODE_DUPLICATE`); the
 * laboratory's result is recorded once, with the day, the values and the report, which has to be a clean file (422 `DOCUMENT_NOT_CLEAN`). A result that failed raises a non-conformance in the same transaction, from the
 * material test, and the test keeps it; a result that passed raises none.
 */
export class QmsMaterialStore {
  private readonly contracts: CtrContractStore;
  private readonly nonconformances: QmsNonconformanceStore;

  constructor(contracts: CtrContractStore = new CtrContractStore(), nonconformances: QmsNonconformanceStore = new QmsNonconformanceStore(contracts)) {
    this.contracts = contracts;
    this.nonconformances = nonconformances;
  }

  async register(tx: TenantTx, input: RegisterInput, actor: string, scopes: ContractScopes, now: Date): Promise<MaterialTestResult> {
    const contractId = idOf(input.contractId, 'contract_id');
    const boqItemId = input.boqItemId === undefined ? null : idOf(input.boqItemId, 'boq_item_id');
    const sampleCode = textOf(input.sampleCode, 'sample_code', MAX_WORDS);
    const materialKind = textOf(input.materialKind, 'material_kind', MAX_WORDS);
    const labName = textOf(input.labName, 'lab_name', MAX_WORDS);
    const standardRef = textOf(input.standardRef, 'standard_ref', MAX_WORDS);
    const sampledOn = calendarDate(input.sampledOn, 'sampled_on');
    if (sampledOn > vietnamDateOf(now)) throw invalid('sampled_on', 'IN_THE_FUTURE');

    const contract = await this.contracts.lock(tx, contractId, scopes);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    if (boqItemId !== null) {
      const items = await tx.query('select 1 from machvon.boq_item where id = $1::uuid and contract_id = $2::uuid', [boqItemId, contractId]);
      if (items.length === 0) throw invalid('boq_item_id', 'NOT_IN_CONTRACT');
    }
    const code = (await tx.query<{ code: string }>('select code from machvon.contract where id = $1::uuid', [contractId]))[0]?.code ?? '';
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.material_test
           (tenant_id, id, project_id, contract_id, boq_item_id, sample_code, material_kind, lab_name, standard_ref, sampled_on, sampled_by, status, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::date, $10::uuid, 'REGISTERED', $10::uuid, $10::uuid, 1)`,
        [id, contract.projectId, contractId, boqItemId, sampleCode, materialKind, labName, standardRef, sampledOn, actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('SAMPLE_CODE_DUPLICATE', 409, 'sample_code');
      throw error;
    }
    return {
      id,
      contractId,
      contractCode: code,
      projectId: contract.projectId,
      sampleCode,
      materialKind,
      labName,
      standardRef,
      sampledOn,
      testedOn: null,
      result: 'PENDING',
      fromStatus: null,
      status: 'REGISTERED',
      version: 1,
      nonconformance: null,
    };
  }

  /** The result of the laboratory, once, at the version the caller saw; a result that failed raises the non-conformance of the test. */
  async recordResult(tx: TenantTx, id: string, expectedVersion: number, input: ResultInput, actor: string, scopes: ContractScopes, now: Date): Promise<MaterialTestResult> {
    const result = choice(MATERIAL_RESULTS, input.result, 'result');
    const testedOn = calendarDate(input.testedOn, 'tested_on');
    const reportId = idOf(input.reportDocumentVersionId, 'report_document_version_id');
    if (typeof input.resultValues !== 'object' || input.resultValues === null || Array.isArray(input.resultValues) || JSON.stringify(input.resultValues).length > MAX_VALUES_BYTES) throw invalid('result_values');
    // The contract is locked first and the test after it, the order in which a non-conformance is raised by hand (it locks the contract and then writes a row that points at the test): two commands on the same test
    // cannot wait for each other, and the number a failed result takes is the next of the contract whatever else is raised at the same time.
    const peek = await tx.query<{ contract_id: string }>('select contract_id from machvon.material_test where id = $1::uuid', [idOf(id, 'id')]);
    if (peek[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await this.contracts.lock(tx, peek[0].contract_id, scopes);
    const held = await this.lock(tx, idOf(id, 'id'), expectedVersion, scopes);
    assertCanRecordResult(held.status);
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'id', { extensions: { contract_status: contract.status } });
    if (testedOn < held.sampled_on) throw invalid('tested_on', 'BEFORE_SAMPLE');
    if (testedOn > vietnamDateOf(now)) throw invalid('tested_on', 'IN_THE_FUTURE');
    await assertCleanDocument(tx, reportId, 'report_document_version_id');

    let raised: NcrResult | null = null;
    if (result === 'FAIL') {
      // The person who took the sample answers for the non-conformance of its failure; one who has since left leaves it to the person who records the result.
      const members = await tx.query<{ id: string }>("select id from machvon.membership where id = $1::uuid and status = 'Active'", [held.sampled_by]);
      raised = await this.nonconformances.raiseFromMaterialTest(
        tx,
        { id: held.id, contractId: held.contract_id, projectId: held.project_id, sampleCode: held.sample_code, materialKind: held.material_kind, standardRef: held.standard_ref },
        members[0] === undefined ? actor : held.sampled_by,
        actor,
        now,
      );
    }
    await tx.query(
      `update machvon.material_test
          set status = 'RESULT_RECORDED', result = $2, tested_on = $3::date, result_values = $4::jsonb, report_document_version_id = $5::uuid, nonconformance_id = $6::uuid,
              updated_at = now(), updated_by = $7::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, result, testedOn, JSON.stringify(input.resultValues), reportId, raised?.id ?? null, actor],
    );
    return {
      id: held.id,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      projectId: held.project_id,
      sampleCode: held.sample_code,
      materialKind: held.material_kind,
      labName: held.lab_name,
      standardRef: held.standard_ref,
      sampledOn: held.sampled_on,
      testedOn,
      result,
      fromStatus: held.status,
      status: 'RESULT_RECORDED',
      version: Number(held.version) + 1,
      nonconformance: raised,
    };
  }

  /** The tests in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: MaterialFilter): Promise<MaterialTestLine[]> {
    const contract = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const status = filter.status === undefined ? null : choice(MATERIAL_TEST_STATUSES, filter.status, 'status');
    const result = filter.result === undefined ? null : choice(['PENDING', ...MATERIAL_RESULTS] as const, filter.result, 'result');
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(7);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or c.id = $1::uuid) and ($2::text is null or t.status = $2) and ($3::text is null or t.result = $3)
          and ($4::text is null or (${timestampKey('t.created_at')}, t.id) < ($4::text, $5::uuid))
        order by t.created_at desc, t.id desc limit $6`,
      [contract, status, result, filter.after?.code ?? null, filter.after?.id ?? null, filter.limit, ...predicate.params],
    );
    return rows.map(toLine);
  }

  /** The contracts being performed in the scope of the caller, by code: where a sample can be registered. The cursor is the code and the id of the last one. */
  async contractOptions(tx: TenantTx, scope: ScopeBuilder, page: { limit: number; after?: { code: string; id: string } | undefined }): Promise<ContractOption[]> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_PAGE + 1) throw invalid('limit');
    if (page.after !== undefined) idOf(page.after.id, 'cursor');
    const predicate = scope(4);
    const rows = await tx.query<{ id: string; code: string; title: string | null; project_id: string }>(
      `select c.id, c.code, c.title, c.project_id from ${CONTRACT_SCOPE_FROM}
        where ${predicate.sql} and c.status = 'ACTIVE' and ($1::text is null or (c.code, c.id) > ($1::text, $2::uuid))
        order by c.code, c.id limit $3`,
      [page.after?.code ?? null, page.after?.id ?? null, page.limit, ...predicate.params],
    );
    return rows.map((row) => ({ id: row.id, code: row.code, title: row.title, projectId: row.project_id }));
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  /** The test locked for update inside the scope of the command, at the version the caller saw. */
  private async lock(tx: TenantTx, id: string, expectedVersion: number, scopes: ContractScopes): Promise<Held> {
    const predicate = scopes.update(2);
    const columns = `t.id, c.id as contract_id, c.code as contract_code, c.project_id, t.sample_code, t.material_kind, t.lab_name, t.standard_ref, t.sampled_on::text as sampled_on,
              t.sampled_by, t.status, t.version::text as version`;
    const rows = await tx.query<Held>(`select ${columns} from ${FROM} where t.id = $1::uuid and ${predicate.sql} for update of t`, [id, ...predicate.params]);
    const row = rows[0];
    if (row === undefined) {
      const readable = scopes.read(2);
      const seen = await tx.query(`select t.id from ${FROM} where t.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    if (Number(row.version) !== expectedVersion) throw versionConflict(Number(row.version));
    return row;
  }
}
