import { randomUUID } from 'node:crypto';
import { DomainError, HANDOVER_READY_PARCEL_STATUSES, assertDayBetween, compareDecimal, receivesSite, sectionStatusFor, versionConflict } from '@machvon/kernel';
import { LndLandSource } from './lnd-land-source.ts';
import { AREA_INTEGER_DIGITS, KILOMETRE_INTEGER_DIGITS, MAX_CODE, MAX_NAME, dateOf, fixedTwo, lowerId, textOf } from './lnd-values.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';
import { withUniqueClaim } from './unique-claim.ts';

const CODE_CONSTRAINT = 'land_section_code_uq';

export type LandSectionStatus = 'NOT_READY' | 'PARTIAL' | 'HANDED_OVER';

export interface NewLandSection {
  projectId: string;
  contractId?: string | undefined;
  code: string;
  name: string;
  fromKm?: string | undefined;
  toKm?: string | undefined;
  requiredAreaM2: string;
  targetDate?: string | undefined;
}

/** A section as the commands and the audit trail see it: the values as they were stored. */
export interface CreatedLandSection {
  id: string;
  projectId: string;
  contractId: string | null;
  code: string;
  requiredAreaM2: string;
  version: number;
  status: LandSectionStatus;
}

/** What a handover says: the area handed over so far (not the area of this step), the day, and the document it rests on. */
export interface SectionHandoverInput {
  handedAreaM2: string;
  handedOverOn: string;
  handoverDocumentVersionId: string;
}

/** A handover as the audit trail and the event see it. */
export interface SectionHandoverResult {
  id: string;
  projectId: string;
  contractId: string;
  code: string;
  fromStatus: LandSectionStatus;
  status: LandSectionStatus;
  version: number;
  requiredAreaM2: string;
  previousHandedAreaM2: string;
  handedAreaM2: string;
  handedOverOn: string;
  handoverDocumentVersionId: string;
  /** The parcels that were handed over with the last of the area. */
  parcelsHandedOver: number;
}

/** One line of the sections of a project (LND-10): what the screen shows, with the share handed over computed exactly. */
export interface LandSectionRow {
  id: string;
  projectId: string;
  contractId: string | null;
  code: string;
  name: string;
  fromKm: string | null;
  toKm: string | null;
  requiredAreaM2: string;
  handedAreaM2: string;
  targetDate: string | null;
  handedOverOn: string | null;
  status: LandSectionStatus;
  version: number;
}

interface SectionSql {
  id: string;
  project_id: string;
  contract_id: string | null;
  code: string;
  name: string;
  from_km: string | null;
  to_km: string | null;
  required_area_m2: string;
  handed_area_m2: string;
  target_date: string | null;
  handed_over_on: string | null;
  status: LandSectionStatus;
  version: string;
}

const COLUMNS = `s.id, s.project_id, s.contract_id, s.code, s.name, s.from_km::text as from_km, s.to_km::text as to_km, s.required_area_m2::text as required_area_m2,
  s.handed_area_m2::text as handed_area_m2, s.target_date::text as target_date, s.handed_over_on::text as handed_over_on, s.status, s.version::text as version`;

/** The section with the project and the two units the scope of its project is judged by (the aliases of the project register: `p`, `ou`, `iu`). */
const FROM = `machvon.land_handover_section s
  join machvon.project p on p.tenant_id = s.tenant_id and p.id = s.project_id
  join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
  left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id`;

interface SectionLockSql {
  id: string;
  project_id: string;
  contract_id: string | null;
  code: string;
  status: LandSectionStatus;
  version: string;
  required_area_m2: string;
  handed_area_m2: string;
  handed_over_on: string | null;
}

const toRow = (row: SectionSql): LandSectionRow => ({
  id: row.id,
  projectId: row.project_id,
  contractId: row.contract_id,
  code: row.code,
  name: row.name,
  fromKm: row.from_km,
  toKm: row.to_km,
  requiredAreaM2: row.required_area_m2,
  handedAreaM2: row.handed_area_m2,
  targetDate: row.target_date,
  handedOverOn: row.handed_over_on,
  status: row.status,
  version: Number(row.version),
});

/**
 * The sections of a project that land is handed over in, by kilometre or by area (ST-LND-001, LND 3.4 step 1, LND-10). A section is created
 * NOT_READY with nothing handed over; the handover itself is another command. The contract that receives the land is optional here and must be
 * a contract of the same project.
 */
export class LndSectionStore {
  private readonly source: LndLandSource;

  constructor(source: LndLandSource = new LndLandSource()) {
    this.source = source;
  }

  async create(tx: TenantTx, input: NewLandSection, actor: string): Promise<CreatedLandSection> {
    const code = textOf(input.code, 'code', 1, MAX_CODE);
    const name = textOf(input.name, 'name', 1, MAX_NAME);
    const required = fixedTwo(input.requiredAreaM2, AREA_INTEGER_DIGITS, 'required_area_m2');
    const fromKm = input.fromKm === undefined ? undefined : fixedTwo(input.fromKm, KILOMETRE_INTEGER_DIGITS, 'from_km');
    const toKm = input.toKm === undefined ? undefined : fixedTwo(input.toKm, KILOMETRE_INTEGER_DIGITS, 'to_km');
    if (fromKm !== undefined && toKm !== undefined && compareDecimal(fromKm, toKm) > 0) throw new DomainError('VALIDATION_FAILED', 422, 'to_km');
    const targetDate = input.targetDate === undefined ? undefined : dateOf(input.targetDate, 'target_date');
    const projectId = lowerId(input.projectId);
    const contractId = input.contractId === undefined ? undefined : lowerId(input.contractId);
    if (contractId !== undefined) await this.source.assertContractOfProject(tx, contractId, projectId, 'contract_id');
    const id = randomUUID();
    await withUniqueClaim(tx, { constraint: CODE_CONSTRAINT, code: 'SECTION_CODE_DUPLICATE' }, () =>
      tx.query(
        `insert into machvon.land_handover_section
           (tenant_id, id, project_id, contract_id, code, name, from_km, to_km, required_area_m2, handed_area_m2, target_date, status, version, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric, $8::numeric, 0, $9::date,
                 'NOT_READY', 1, $10::uuid, $10::uuid)`,
        [id, projectId, contractId ?? null, code, name, fromKm ?? null, toKm ?? null, required, targetDate ?? null, actor],
      ),
    );
    return { id, projectId, contractId: contractId ?? null, code, requiredAreaM2: required, version: 1, status: 'NOT_READY' };
  }

  /**
   * Hands over land to the construction contract of a section (LND 3.4, ST-LND-009). `handedAreaM2` is the whole area handed over by now: it has to grow, and it cannot pass the
   * area the section needs (422 HANDED_AREA_EXCEEDS_REQUIRED). Only an ACTIVE contract that builds receives land (409 CONTRACT_STATE_INVALID; a section with no contract, or one that
   * does not build, is a fault of the request). The last of the area hands over the parcels with it, so every parcel of the section has to be paid (422 PARCELS_NOT_READY).
   * The day is not in the future and not before the last handover, and the document is a clean file of the tenant. The status follows the area: PARTIAL, then HANDED_OVER.
   */
  async recordHandover(tx: TenantTx, id: string, expectedVersion: number, input: SectionHandoverInput, actor: string, today: string): Promise<SectionHandoverResult> {
    const handed = fixedTwo(input.handedAreaM2, AREA_INTEGER_DIGITS, 'handed_area_m2');
    const handedOverOn = dateOf(input.handedOverOn, 'handed_over_on');
    const documentVersionId = lowerId(input.handoverDocumentVersionId);
    const rows = await tx.query<SectionLockSql>(
      `select s.id, s.project_id, s.contract_id, s.code, s.status, s.version::text as version, s.required_area_m2::text as required_area_m2, s.handed_area_m2::text as handed_area_m2, s.handed_over_on::text as handed_over_on
         from machvon.land_handover_section s where s.id = $1::uuid for update`,
      [id],
    );
    const section = rows[0];
    if (section === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (Number(section.version) !== expectedVersion) throw versionConflict(Number(section.version));
    if (section.contract_id === null) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id', { extensions: { reason: 'NO_CONTRACT' } });
    const contract = await this.source.contractFacts(tx, section.contract_id);
    if (contract === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    if (contract.status !== 'ACTIVE') throw new DomainError('CONTRACT_STATE_INVALID', 409, 'contract_id', { extensions: { contract_status: contract.status } });
    if (!receivesSite(contract.advanceCategory)) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id', { extensions: { reason: 'NOT_A_CONSTRUCTION_CONTRACT' } });
    if (compareDecimal(handed, section.required_area_m2) > 0) {
      throw new DomainError('HANDED_AREA_EXCEEDS_REQUIRED', 422, 'handed_area_m2', { extensions: { required_area_m2: section.required_area_m2, handed_area_m2: handed } });
    }
    if (compareDecimal(handed, section.handed_area_m2) <= 0) throw new DomainError('VALIDATION_FAILED', 422, 'handed_area_m2', { extensions: { handed_area_m2: section.handed_area_m2 } });
    assertDayBetween('handed_over_on', handedOverOn, section.handed_over_on, today);
    await this.source.assertCleanDocumentVersion(tx, documentVersionId, 'handover_document_version_id');
    const status = sectionStatusFor(handed, section.required_area_m2);
    let parcelsHandedOver = 0;
    if (status === 'HANDED_OVER') {
      const parcels = await tx.query<{ id: string; status: string }>('select id, status from machvon.land_parcel where section_id = $1::uuid order by parcel_code for update', [id]);
      const notReady = parcels.filter((parcel) => !HANDOVER_READY_PARCEL_STATUSES.includes(parcel.status));
      if (notReady.length > 0) throw new DomainError('PARCELS_NOT_READY', 422, 'handed_area_m2', { extensions: { parcels_not_ready: notReady.length } });
      const paid = parcels.filter((parcel) => parcel.status === 'PAID').map((parcel) => parcel.id);
      if (paid.length > 0) {
        await tx.query("update machvon.land_parcel set status = 'HANDED_OVER', updated_at = now(), updated_by = $2::uuid, version = version + 1 where id = any($1::uuid[])", [paid, actor]);
      }
      parcelsHandedOver = paid.length;
    }
    await tx.query(
      `update machvon.land_handover_section
          set handed_area_m2 = $2::numeric, handed_over_on = $3::date, handover_document_version_id = $4::uuid, status = $5, updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [id, handed, handedOverOn, documentVersionId, status, actor],
    );
    return {
      id,
      projectId: section.project_id,
      contractId: section.contract_id,
      code: section.code,
      fromStatus: section.status,
      status,
      version: Number(section.version) + 1,
      requiredAreaM2: section.required_area_m2,
      previousHandedAreaM2: section.handed_area_m2,
      handedAreaM2: handed,
      handedOverOn,
      handoverDocumentVersionId: documentVersionId,
      parcelsHandedOver,
    };
  }

  /** The sections of a project in the scope of the caller, by code. */
  async listOfProject(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<LandSectionRow[]> {
    const predicate = scope(2);
    const rows = await tx.query<SectionSql>(`select ${COLUMNS} from ${FROM} where s.project_id = $1::uuid and ${predicate.sql} order by s.code, s.id`, [projectId, ...predicate.params]);
    return rows.map(toRow);
  }
}
