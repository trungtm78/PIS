import { randomUUID } from 'node:crypto';
import { DomainError, compareDecimal } from '@machvon/kernel';
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

  /** The sections of a project in the scope of the caller, by code. */
  async listOfProject(tx: TenantTx, projectId: string, scope: ScopeBuilder): Promise<LandSectionRow[]> {
    const predicate = scope(2);
    const rows = await tx.query<SectionSql>(`select ${COLUMNS} from ${FROM} where s.project_id = $1::uuid and ${predicate.sql} order by s.code, s.id`, [projectId, ...predicate.params]);
    return rows.map(toRow);
  }
}
