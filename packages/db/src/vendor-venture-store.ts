import { randomUUID } from 'node:crypto';
import { DomainError, assertVentureShares, hasControlChar, versionConflict } from '@machvon/kernel';
import type { JointVentureMemberFacts } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface VentureMemberRow {
  contractorId: string;
  contractorName: string;
  taxIdentifier: string;
  sharePct: string;
  lead: boolean;
}

export interface VentureRow {
  id: string;
  name: string;
  leadContractorId: string;
  agreementDocumentId: string | null;
  packageId: string | null;
  startsOn: string;
  endsOn: string | null;
  endedReason: string | null;
  status: 'ACTIVE' | 'ENDED';
  version: number;
  members: VentureMemberRow[];
}

export interface NewVenture {
  name: string;
  members: JointVentureMemberFacts[];
  agreementDocumentId?: string | undefined;
  packageId?: string | undefined;
  startsOn?: string | undefined;
}

interface VentureSql {
  id: string;
  name: string;
  lead_contractor_id: string;
  agreement_document_id: string | null;
  package_id: string | null;
  starts_on: string;
  ends_on: string | null;
  ended_reason: string | null;
  status: 'ACTIVE' | 'ENDED';
  version: string;
}

const SELECT = `select id, name, lead_contractor_id, agreement_document_id, package_id, starts_on::text as starts_on, ends_on::text as ends_on, ended_reason, status, version::text as version from machvon.joint_venture`;

/**
 * Joint ventures of contractors (VND-1, V2): a named group with one lead and shares that add up to a whole. A venture bids and signs together, so a restriction on it reaches every member and the gates ask about the
 * members (`membersOf`). A venture is set once and ends with a reason; its members are not changed in place (the database refuses it), a new venture is made instead.
 */
export class VendorVentureStore {
  async list(tx: TenantTx, filter: { status?: 'ACTIVE' | 'ENDED' | undefined; contractorId?: string | undefined; limit?: number | undefined }): Promise<VentureRow[]> {
    const rows = await tx.query<VentureSql>(
      `${SELECT} where ($1::text is null or status = $1) and ($2::uuid is null or id in (select joint_venture_id from machvon.joint_venture_member where contractor_id = $2::uuid)) order by created_at desc, id desc limit $3`,
      [filter.status ?? null, filter.contractorId ?? null, filter.limit ?? 200],
    );
    return Promise.all(rows.map(async (row) => this.rowOf(row, await this.members(tx, row.id))));
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<VentureRow | undefined> {
    const rows = await tx.query<VentureSql>(`${SELECT} where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return rows[0] === undefined ? undefined : this.rowOf(rows[0], await this.members(tx, id));
  }

  async members(tx: TenantTx, ventureId: string): Promise<VentureMemberRow[]> {
    const rows = await tx.query<{ contractor_id: string; name: string; tax: string; share_pct: string; is_lead: boolean }>(
      `select m.contractor_id, c.legal_name as name, c.tax_identifier as tax, m.share_pct::text as share_pct, m.is_lead from machvon.joint_venture_member m
         join machvon.contractor c on c.tenant_id = m.tenant_id and c.id = m.contractor_id where m.joint_venture_id = $1::uuid order by m.is_lead desc, c.legal_name, m.id`,
      [ventureId],
    );
    return rows.map((row) => ({ contractorId: row.contractor_id, contractorName: row.name, taxIdentifier: row.tax, sharePct: row.share_pct, lead: row.is_lead }));
  }

  private rowOf(row: VentureSql, members: VentureMemberRow[]): VentureRow {
    return { id: row.id, name: row.name, leadContractorId: row.lead_contractor_id, agreementDocumentId: row.agreement_document_id, packageId: row.package_id, startsOn: row.starts_on, endsOn: row.ends_on, endedReason: row.ended_reason, status: row.status, version: Number(row.version), members };
  }

  /** Makes a venture: at least two members, one lead, shares adding up to 100 with at most two decimals (422 `JOINT_VENTURE_SHARES_INVALID`), every member a contractor of the register, the agreement a document of the tenant. */
  async create(tx: TenantTx, input: NewVenture, actor: string, today: string): Promise<VentureRow> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 300 || hasControlChar(name)) throw invalid('name');
    assertVentureShares(input.members);
    const ids = input.members.map((member) => member.contractorId);
    const found = await tx.query<{ id: string }>('select id from machvon.contractor where id = any($1::uuid[])', [ids]);
    if (found.length !== ids.length) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'members');
    if (input.agreementDocumentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.agreementDocumentId])).length === 0) throw invalid('agreement_document_id');
    if (input.packageId !== undefined && (await tx.query('select 1 from machvon.procurement_package where id = $1::uuid', [input.packageId])).length === 0) throw invalid('package_id');
    const lead = input.members.find((member) => member.lead) as JointVentureMemberFacts;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.joint_venture (tenant_id, id, name, lead_contractor_id, agreement_document_id, package_id, starts_on, created_by, updated_by)
       values (${TENANT}, $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::uuid, $7::uuid)`,
      [id, name, lead.contractorId, input.agreementDocumentId ?? null, input.packageId ?? null, input.startsOn ?? today, actor],
    );
    for (const member of input.members) {
      await tx.query(`insert into machvon.joint_venture_member (tenant_id, id, joint_venture_id, contractor_id, share_pct, is_lead) values (${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, $3::numeric, $4)`, [id, member.contractorId, member.sharePct, member.lead]);
    }
    return (await this.find(tx, id)) as VentureRow;
  }

  /** Ends a venture with a reason (409 `STAGE_TRANSITION_DENIED` when it already ended). */
  async end(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, today: string): Promise<VentureRow> {
    const why = reason.trim();
    if (why.length < 5 || why.length > 500 || hasControlChar(why)) throw invalid('reason');
    const current = await this.find(tx, id, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    if (current.status === 'ENDED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    await tx.query("update machvon.joint_venture set status = 'ENDED', ends_on = greatest($2::date, starts_on), ended_reason = $3, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid", [id, today, why, actor]);
    return (await this.find(tx, id)) as VentureRow;
  }

  /** The other members of every active venture the contractor leads (for the gates: a venture that bids and signs under its lead cannot deal while any member is restricted). A venture tied to a package counts only for that package. */
  async membersLedBy(tx: TenantTx, contractorId: string, packageId?: string | undefined): Promise<string[]> {
    const rows = await tx.query<{ contractor_id: string }>(
      `select distinct m2.contractor_id from machvon.joint_venture_member m1
         join machvon.joint_venture v on v.tenant_id = m1.tenant_id and v.id = m1.joint_venture_id and v.status = 'ACTIVE'
         join machvon.joint_venture_member m2 on m2.tenant_id = v.tenant_id and m2.joint_venture_id = v.id
        where v.lead_contractor_id = $1::uuid and ($2::uuid is null or v.package_id is null or v.package_id = $2::uuid)`,
      [contractorId, packageId ?? null],
    );
    return rows.map((row) => row.contractor_id).filter((id) => id !== contractorId);
  }
}
