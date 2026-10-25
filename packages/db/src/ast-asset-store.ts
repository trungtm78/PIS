import { randomUUID } from 'node:crypto';
import { ASSET_STATUSES, DomainError, VALUE_BASES, assertAssetTransfer, assertDayBetween, assertValueWithinContract, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { AssetStatus, ValueBasis } from '@machvon/kernel';
import { CtrContractStore, SCOPE_FROM as CONTRACT_SCOPE_FROM, calendarDate, textOf, wholeAmount } from './ctr-contract-store.ts';
import type { ContractScopes } from './ctr-contract-store.ts';
import { assertTimestampCursor, timestampKey } from './keyset.ts';
import type { HandoverPlace, HandoverScopes } from './ast-handover-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_PAGE = 200;
const UNIQUE_VIOLATION = '23505';

const invalid = (field: string, reason?: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field, reason === undefined ? undefined : { extensions: { reason } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};
const optionalId = (value: string | undefined, field: string): string | null => (value === undefined ? null : idOf(value, field));
const optionalText = (value: string | undefined, field: string): string | null => (value === undefined ? null : textOf(value, field, MAX_TEXT));

export interface RegisterInput {
  projectId: string;
  handoverId: string;
  assetCode: string;
  name: string;
  assetClassMasterVersionId?: string | undefined;
  sourceContractId?: string | undefined;
  recipientUnitId: string;
  valueVnd: string;
  valueBasis: string;
  fundingOrigin?: string | undefined;
  warrantyUntil?: string | undefined;
}

export interface TransferInput {
  transferredOn: string;
  commissioningDocumentVersionId: string;
  externalAssetId?: string | undefined;
}

export interface AssetFilter {
  contractId?: string | undefined;
  handoverId?: string | undefined;
  status?: string | undefined;
  limit: number;
  after?: { code: string; id: string } | undefined;
}

/** What a command did to an asset: the facts the audit row and the event carry. */
export interface AssetResult {
  id: string;
  assetCode: string;
  name: string;
  handoverId: string;
  contractId: string;
  contractCode: string;
  projectId: string;
  recipientUnitId: string;
  valueVnd: string;
  valueBasis: ValueBasis;
  fromStatus: AssetStatus | null;
  status: AssetStatus;
  version: number;
  /** What the assets of the contract come to (this one included) and what the contract is worth. */
  registeredTotalVnd: string;
  contractValueVnd: string;
  transferredOn: string | null;
  externalAssetId: string | null;
}

export interface AssetLine {
  id: string;
  assetCode: string;
  name: string | null;
  handover: { id: string; handoverNo: string | null; status: string };
  contract: { id: string; code: string; valueVnd: string };
  projectId: string;
  recipientUnit: { id: string; code: string; name: string };
  assetClassMasterVersionId: string | null;
  valueVnd: string;
  valueBasis: ValueBasis;
  fundingOrigin: string | null;
  status: AssetStatus;
  registeredOn: string | null;
  transferredOn: string | null;
  warrantyUntil: string | null;
  commissioningDocumentVersionId: string | null;
  externalAssetId: string | null;
  /** What the assets of the contract come to: the value of the contract is the ceiling of it. */
  contractAssetsVnd: string;
  createdAt: string;
  version: number;
  reach: HandoverPlace;
}

interface LineSql {
  id: string;
  asset_code: string;
  name: string | null;
  handover_id: string;
  handover_no: string | null;
  handover_status: string;
  contract_id: string;
  contract_code: string;
  contract_value_vnd: string;
  project_id: string;
  recipient_unit_id: string;
  recipient_unit_code: string;
  recipient_unit_name: string;
  recipient_unit_path: string;
  asset_class_master_version_id: string | null;
  value_vnd: string;
  value_basis: ValueBasis;
  funding_origin: string | null;
  status: AssetStatus;
  registered_on: string | null;
  transferred_on: string | null;
  warranty_until: string | null;
  commissioning_document_version_id: string | null;
  external_asset_id: string | null;
  contract_assets_vnd: string;
  created_at: string;
  version: string;
  owner_unit_id: string;
  owner_unit_path: string;
  investor_unit_id: string | null;
  investor_unit_path: string | null;
}

const FROM = `${CONTRACT_SCOPE_FROM}
  join machvon.handover h on h.tenant_id = c.tenant_id and h.contract_id = c.id
  join machvon.asset_record a on a.tenant_id = h.tenant_id and a.handover_id = h.id
  join machvon.organization_unit ru on ru.tenant_id = a.tenant_id and ru.id = a.recipient_unit_id`;

const SELECT = `select a.id, a.asset_code, a.name, h.id as handover_id, h.handover_no, h.status as handover_status, c.id as contract_id, c.code as contract_code, c.contract_value_vnd::text as contract_value_vnd,
       c.project_id, a.recipient_unit_id, ru.code as recipient_unit_code, ru.name as recipient_unit_name, ru.path as recipient_unit_path, a.asset_class_master_version_id, a.value_vnd::text as value_vnd,
       a.value_basis, a.funding_origin, a.status, a.registered_on::text as registered_on, a.transferred_on::text as transferred_on, a.warranty_until::text as warranty_until,
       a.commissioning_document_version_id, a.external_asset_id,
       (select coalesce(sum(x.value_vnd), 0)::text from machvon.asset_record x where x.tenant_id = a.tenant_id and x.source_contract_id = c.id and x.status <> 'DISPOSED') as contract_assets_vnd,
       ${timestampKey('a.created_at')} as created_at, a.version::text as version, ou.id as owner_unit_id, ou.path as owner_unit_path, iu.id as investor_unit_id, iu.path as investor_unit_path
  from ${FROM}`;

const toLine = (row: LineSql): AssetLine => ({
  id: row.id,
  assetCode: row.asset_code,
  name: row.name,
  handover: { id: row.handover_id, handoverNo: row.handover_no, status: row.handover_status },
  contract: { id: row.contract_id, code: row.contract_code, valueVnd: row.contract_value_vnd },
  projectId: row.project_id,
  recipientUnit: { id: row.recipient_unit_id, code: row.recipient_unit_code, name: row.recipient_unit_name },
  assetClassMasterVersionId: row.asset_class_master_version_id,
  valueVnd: row.value_vnd,
  valueBasis: row.value_basis,
  fundingOrigin: row.funding_origin,
  status: row.status,
  registeredOn: row.registered_on,
  transferredOn: row.transferred_on,
  warrantyUntil: row.warranty_until,
  commissioningDocumentVersionId: row.commissioning_document_version_id,
  externalAssetId: row.external_asset_id,
  contractAssetsVnd: row.contract_assets_vnd,
  createdAt: row.created_at,
  version: Number(row.version),
  reach: {
    contractId: row.contract_id,
    projectId: row.project_id,
    ownerUnit: { id: row.owner_unit_id, path: row.owner_unit_path },
    investorUnit: row.investor_unit_id === null || row.investor_unit_path === null ? null : { id: row.investor_unit_id, path: row.investor_unit_path },
    recipientUnit: { id: row.recipient_unit_id, path: row.recipient_unit_path },
  },
});

interface Held {
  id: string;
  asset_code: string;
  name: string | null;
  handover_id: string;
  handover_status: string;
  contract_id: string;
  contract_code: string;
  contract_value_vnd: string;
  project_id: string;
  recipient_unit_id: string;
  value_vnd: string;
  value_basis: ValueBasis;
  status: AssetStatus;
  registered_on: string | null;
  external_asset_id: string | null;
  version: string;
}

/**
 * The assets a work produces (ST-AST-002, AST 3.2, BR-AST-02, UAT-AC389). An asset is registered after the handover of its work was accepted, for a unit of the tenant, with the value it is booked
 * at and the basis of that value; the assets of a contract never add up to more than the contract is worth (422 `VALUE_EXCEEDS_CONTRACT`), and the code is unique in a project (409
 * `ASSET_CODE_DUPLICATE`). The unit that receives the asset transfers it once, with the dossier of the commissioning and, typed by hand because no system of public assets is connected, the code it
 * is known by there.
 */
export class AstAssetStore {
  private readonly contracts: CtrContractStore;

  constructor(contracts: CtrContractStore = new CtrContractStore()) {
    this.contracts = contracts;
  }

  /** Registers an asset of an accepted handover; the contract is locked, so that two registrations cannot both fit under its value. */
  async register(tx: TenantTx, input: RegisterInput, actor: string, scopes: ContractScopes, now: Date): Promise<AssetResult> {
    const projectId = idOf(input.projectId, 'project_id');
    const handoverId = idOf(input.handoverId, 'handover_id');
    const assetCode = textOf(input.assetCode, 'asset_code', MAX_TEXT);
    const name = textOf(input.name, 'name', MAX_TEXT);
    const classId = optionalId(input.assetClassMasterVersionId, 'asset_class_master_version_id');
    const sourceId = optionalId(input.sourceContractId, 'source_contract_id');
    const recipientId = idOf(input.recipientUnitId, 'recipient_unit_id');
    const value = wholeAmount(input.valueVnd, 'value_vnd');
    const basis = VALUE_BASES.find((candidate) => candidate === input.valueBasis) ?? this.badField('value_basis');
    const funding = optionalText(input.fundingOrigin, 'funding_origin');
    const warrantyUntil = input.warrantyUntil === undefined ? null : calendarDate(input.warrantyUntil, 'warranty_until');
    const handovers = await tx.query<{ contract_id: string; project_id: string; status: string }>('select contract_id, project_id, status from machvon.handover where id = $1::uuid', [handoverId]);
    const handover = handovers[0];
    if (handover === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const contract = await this.contracts.lock(tx, handover.contract_id, scopes);
    if (handover.status !== 'ACCEPTED') throw new DomainError('HANDOVER_STATE_INVALID', 409, 'handover_id', { extensions: { status: handover.status } });
    if (handover.project_id !== projectId) throw invalid('project_id', 'NOT_THE_PROJECT_OF_THE_HANDOVER');
    if (sourceId !== null && sourceId !== handover.contract_id) throw invalid('source_contract_id', 'NOT_THE_CONTRACT_OF_THE_HANDOVER');
    if ((await tx.query('select 1 from machvon.organization_unit where id = $1::uuid', [recipientId])).length === 0) throw invalid('recipient_unit_id', 'NOT_FOUND');
    if (classId !== null && (await tx.query('select 1 from machvon.master_record_version where id = $1::uuid', [classId])).length === 0) throw invalid('asset_class_master_version_id', 'NOT_FOUND');
    const registered =
      (
        await tx.query<{ total: string }>("select coalesce(sum(value_vnd), 0)::text as total from machvon.asset_record where source_contract_id = $1::uuid and status <> 'DISPOSED'", [
          handover.contract_id,
        ])
      )[0]?.total ?? '0';
    assertValueWithinContract(contract.contractValueVnd, registered, value);
    const id = randomUUID();
    try {
      await tx.query(
        `insert into machvon.asset_record
           (tenant_id, id, project_id, handover_id, asset_code, value_vnd, recipient_unit_id, warranty_until, name, asset_class_master_version_id, source_contract_id, value_basis, funding_origin, status, registered_on,
            created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6::uuid, $7::date, $8, $9::uuid, $10::uuid, $11, $12, 'REGISTERED', $13::date, $14::uuid, $14::uuid, 1)`,
        [id, projectId, handoverId, assetCode, value, recipientId, warrantyUntil, name, classId, handover.contract_id, basis, funding, vietnamDateOf(now), actor],
      );
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('ASSET_CODE_DUPLICATE', 409, 'asset_code');
      throw error;
    }
    const code = (await tx.query<{ code: string }>('select code from machvon.contract where id = $1::uuid', [handover.contract_id]))[0]?.code ?? '';
    return {
      id,
      assetCode,
      name,
      handoverId,
      contractId: handover.contract_id,
      contractCode: code,
      projectId,
      recipientUnitId: recipientId,
      valueVnd: value,
      valueBasis: basis,
      fromStatus: null,
      status: 'REGISTERED',
      version: 1,
      registeredTotalVnd: (BigInt(registered) + BigInt(value)).toString(),
      contractValueVnd: contract.contractValueVnd,
      transferredOn: null,
      externalAssetId: null,
    };
  }

  /** Transfers a registered asset to the unit that operates it, on a day that is not before it was registered nor in the future, with the dossier of the commissioning and, by hand, the code it has elsewhere. */
  async transfer(tx: TenantTx, id: string, expectedVersion: number, input: TransferInput, actor: string, scopes: HandoverScopes, now: Date): Promise<AssetResult> {
    const transferredOn = calendarDate(input.transferredOn, 'transferred_on');
    const documentId = idOf(input.commissioningDocumentVersionId, 'commissioning_document_version_id');
    const external = optionalText(input.externalAssetId, 'external_asset_id');
    const held = await this.lock(tx, id, scopes);
    if (Number(held.version) !== expectedVersion) throw versionConflict(Number(held.version));
    if (held.handover_status !== 'ACCEPTED') throw new DomainError('HANDOVER_NOT_ACCEPTED', 422, 'id', { extensions: { status: held.handover_status } });
    assertAssetTransfer(held.status);
    assertDayBetween('transferred_on', transferredOn, held.registered_on, vietnamDateOf(now));
    const documents = await tx.query<{ scan_status: string }>('select scan_status from machvon.document_version where id = $1::uuid', [documentId]);
    if (documents[0] === undefined) throw invalid('commissioning_document_version_id', 'NOT_FOUND');
    if (documents[0].scan_status !== 'CLEAN') throw new DomainError('DOCUMENT_NOT_CLEAN', 422, 'commissioning_document_version_id');
    await tx.query(
      `update machvon.asset_record
          set status = 'TRANSFERRED', transferred_on = $2::date, transferred_by = $3::uuid, commissioning_document_version_id = $4::uuid, external_asset_id = coalesce($5, external_asset_id),
              updated_at = now(), updated_by = $3::uuid, version = version + 1
        where id = $1::uuid`,
      [held.id, transferredOn, actor, documentId, external],
    );
    const total =
      (
        await tx.query<{ total: string }>("select coalesce(sum(value_vnd), 0)::text as total from machvon.asset_record where source_contract_id = $1::uuid and status <> 'DISPOSED'", [
          held.contract_id,
        ])
      )[0]?.total ?? '0';
    return {
      id: held.id,
      assetCode: held.asset_code,
      name: held.name ?? '',
      handoverId: held.handover_id,
      contractId: held.contract_id,
      contractCode: held.contract_code,
      projectId: held.project_id,
      recipientUnitId: held.recipient_unit_id,
      valueVnd: held.value_vnd,
      valueBasis: held.value_basis,
      fromStatus: held.status,
      status: 'TRANSFERRED',
      version: Number(held.version) + 1,
      registeredTotalVnd: total,
      contractValueVnd: held.contract_value_vnd,
      transferredOn,
      externalAssetId: external ?? held.external_asset_id,
    };
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------

  /** The assets in the scope of the caller, the newest first; the cursor is the creation time and the id. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: AssetFilter): Promise<AssetLine[]> {
    const contract = filter.contractId === undefined ? null : idOf(filter.contractId, 'contract_id');
    const handover = filter.handoverId === undefined ? null : idOf(filter.handoverId, 'handover_id');
    const status = filter.status === undefined ? null : (ASSET_STATUSES.find((candidate) => candidate === filter.status) ?? this.badField('status'));
    if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_PAGE + 1) throw invalid('limit');
    assertTimestampCursor(filter.after?.code);
    const predicate = scope(6);
    const rows = await tx.query<LineSql>(
      `${SELECT} where ${predicate.sql} and ($1::uuid is null or c.id = $1::uuid) and ($2::uuid is null or h.id = $2::uuid) and ($3::text is null or a.status = $3)
          and ($4::text is null or (${timestampKey('a.created_at')}, a.id) < ($4::text, $5::uuid))
        order by a.created_at desc, a.id desc limit ${filter.limit}`,
      [contract, handover, status, filter.after?.code ?? null, filter.after?.id ?? null, ...predicate.params],
    );
    return rows.map(toLine);
  }

  async find(tx: TenantTx, id: string, scope: ScopeBuilder): Promise<AssetLine | undefined> {
    const predicate = scope(2);
    const rows = await tx.query<LineSql>(`${SELECT} where a.id = $1::uuid and ${predicate.sql}`, [id, ...predicate.params]);
    return rows[0] === undefined ? undefined : toLine(rows[0]);
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  private badField(field: string): never {
    throw invalid(field);
  }

  /** The asset locked for update inside the scope of the command; one the caller can read and not change is a refusal, one it cannot see does not exist. */
  private async lock(tx: TenantTx, id: string, scopes: HandoverScopes): Promise<Held> {
    const predicate = scopes.update(2);
    const columns = `a.id, a.asset_code, a.name, h.id as handover_id, h.status as handover_status, c.id as contract_id, c.code as contract_code, c.contract_value_vnd::text as contract_value_vnd, c.project_id,
              a.recipient_unit_id, a.value_vnd::text as value_vnd, a.value_basis, a.status, a.registered_on::text as registered_on, a.external_asset_id, a.version::text as version`;
    const rows = await tx.query<Held>(`select ${columns} from ${FROM} where a.id = $1::uuid and ${predicate.sql} for update of a`, [id, ...predicate.params]);
    const row = rows[0];
    if (row !== undefined) return row;
    const readable = scopes.read(2);
    const seen = await tx.query(`select a.id from ${FROM} where a.id = $1::uuid and ${readable.sql}`, [id, ...readable.params]);
    throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
  }
}
