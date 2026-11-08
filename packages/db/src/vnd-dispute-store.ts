import { disputeStats, ocdsParty } from '@machvon/kernel';
import type { DisputeFacts, DisputeStats, OcdsParty, OcdsPartySource } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';
import { VendorPortalPolicyReader } from './vnd3-portal-policy.ts';
import type { Policy } from './vendor-policy.ts';

export interface DisputeRow extends DisputeFacts {
  id: string;
  contractorId: string;
  contractorName: string;
  subjectCode: string | null;
  /** The status as the source module says it (the screen shows it next to the folded outcome). */
  sourceStatus: string;
}

export interface DisputeReport {
  items: DisputeRow[];
  stats: DisputeStats;
  petitions: DisputeStats;
  claims: DisputeStats;
  portfolio: DisputeStats;
}

type Outcome = DisputeFacts['outcome'];

/**
 * How the words of each source fold to four outcomes. A petition has no recorded decision of its own (it is answered by a resolution document), so an answered petition is folded as rejected and one passed up as still open; the
 * source status stays on every line so that a screen never hides what the source said. A claim of the contractor that was settled is upheld (the contractor got an amount or days), one declared barred is rejected, a withdrawn one
 * is withdrawn, one referred to the level above is still open (it is not decided here).
 */
export const PETITION_OUTCOMES: Readonly<Record<string, Outcome>> = { RECEIVED: 'OPEN', PROCESSING: 'OPEN', ESCALATED: 'OPEN', RESOLVED: 'REJECTED', WITHDRAWN: 'WITHDRAWN' };
export const CLAIM_OUTCOMES: Readonly<Record<string, Outcome>> = {
  EVENT_RECORDED: 'OPEN',
  NOTICE_SERVED: 'OPEN',
  PARTICULARS_SUBMITTED: 'OPEN',
  RESPONDED: 'OPEN',
  SETTLEMENT_PROPOSED: 'OPEN',
  REFERRED: 'OPEN',
  SETTLED: 'UPHELD',
  TIME_BARRED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
};

/** The petitions and the claims of the contractors (VND-3, V16): counts, the share upheld among the decided ones and the days to close, for one contractor and for the whole register. Counts only: the source modules keep the cases. */
export class VendorDisputeStore {
  async report(tx: TenantTx, contractorId: string | undefined): Promise<DisputeReport> {
    const petitions = await tx.query<{ id: string; contractor_id: string; contractor_name: string; code: string; status: string; opened: string; closed: string | null }>(
      `select p.id, p.contractor_id, c.legal_name as contractor_name, k.code, p.status, p.received_on::text as opened,
              case when p.status = 'RESOLVED' then (p.resolved_at at time zone 'Asia/Ho_Chi_Minh')::date::text when p.status = 'WITHDRAWN' then (p.updated_at at time zone 'Asia/Ho_Chi_Minh')::date::text else null end as closed
         from machvon.procurement_petition p join machvon.contractor c on c.tenant_id = p.tenant_id and c.id = p.contractor_id left join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.id = p.package_id
        order by p.received_on desc, p.id limit 5000`,
    );
    const claims = await tx.query<{ id: string; contractor_id: string; contractor_name: string; code: string; status: string; opened: string; closed: string | null }>(
      `select cl.id, k.contractor_id, c.legal_name as contractor_name, cl.code, cl.status, (cl.created_at at time zone 'Asia/Ho_Chi_Minh')::date::text as opened, cl.closed_on::text as closed
         from machvon.contract_claim cl join machvon.contract k on k.tenant_id = cl.tenant_id and k.id = cl.contract_id join machvon.contractor c on c.tenant_id = k.tenant_id and c.id = k.contractor_id
        where cl.claimant_side = 'CONTRACTOR' order by cl.created_at desc, cl.id limit 5000`,
    );
    const all: DisputeRow[] = [
      ...petitions.map((row): DisputeRow => {
        const outcome = PETITION_OUTCOMES[row.status] ?? 'OPEN';
        return { kind: 'PETITION', id: row.id, contractorId: row.contractor_id, contractorName: row.contractor_name, subjectCode: row.code, outcome, sourceStatus: row.status, openedOn: row.opened, closedOn: outcome === 'OPEN' ? null : row.closed };
      }),
      ...claims.map((row): DisputeRow => {
        const outcome = CLAIM_OUTCOMES[row.status] ?? 'OPEN';
        return { kind: 'CLAIM', id: row.id, contractorId: row.contractor_id, contractorName: row.contractor_name, subjectCode: row.code, outcome, sourceStatus: row.status, openedOn: row.opened, closedOn: outcome === 'OPEN' ? null : row.closed };
      }),
    ];
    const mine = contractorId === undefined ? all : all.filter((row) => row.contractorId === contractorId);
    return {
      items: mine.slice().sort((a, b) => (a.openedOn < b.openedOn ? 1 : a.openedOn > b.openedOn ? -1 : a.id < b.id ? -1 : 1)).slice(0, 500),
      stats: disputeStats(mine),
      petitions: disputeStats(mine.filter((row) => row.kind === 'PETITION')),
      claims: disputeStats(mine.filter((row) => row.kind === 'CLAIM')),
      portfolio: disputeStats(all),
    };
  }
}

/** The parties of an export in the shape of the Open Contracting Data Standard (VND-3, V18): the contractors that bid or hold a contract, with the tax code as identifier; the beneficial owners and the contact point only when the rule says so (default off: the legal basis for publishing them is not confirmed). */
export class VendorOcdsReader {
  private readonly policies: VendorPortalPolicyReader;

  constructor(policies: VendorPortalPolicyReader = new VendorPortalPolicyReader()) {
    this.policies = policies;
  }

  async parties(tx: TenantTx, filter: { contractorId?: string | undefined; packageId?: string | undefined }, today: string): Promise<{ parties: OcdsParty[]; policy: Policy<{ include_owners: boolean; include_contact: boolean }> }> {
    const policy = await this.policies.ocds(tx, today);
    const rows = await tx.query<{ id: string; legal_name: string; tax_identifier: string; registered_address: string | null; phone: string | null; email: string | null; legal_rep_name: string | null; tendered: boolean; supplies: boolean }>(
      `select c.id, c.legal_name, c.tax_identifier, c.registered_address, c.phone, c.email, c.legal_rep_name,
              exists (select 1 from machvon.proposal pr where pr.tenant_id = c.tenant_id and pr.contractor_id = c.id and ($2::uuid is null or pr.package_id = $2::uuid)) as tendered,
              (exists (select 1 from machvon.contract k where k.tenant_id = c.tenant_id and k.contractor_id = c.id and ($2::uuid is null or k.package_id = $2::uuid))
               or exists (select 1 from machvon.contract_party cp join machvon.contract k on k.tenant_id = cp.tenant_id and k.id = cp.contract_id where cp.tenant_id = c.tenant_id and cp.contractor_id = c.id and ($2::uuid is null or k.package_id = $2::uuid))) as supplies
         from machvon.contractor c
        where c.verification_status = 'VERIFIED' and ($1::uuid is null or c.id = $1::uuid)
          and (exists (select 1 from machvon.proposal pr where pr.tenant_id = c.tenant_id and pr.contractor_id = c.id and ($2::uuid is null or pr.package_id = $2::uuid))
               or exists (select 1 from machvon.contract k where k.tenant_id = c.tenant_id and k.contractor_id = c.id and ($2::uuid is null or k.package_id = $2::uuid))
               or exists (select 1 from machvon.contract_party cp join machvon.contract k on k.tenant_id = cp.tenant_id and k.id = cp.contract_id where cp.tenant_id = c.tenant_id and cp.contractor_id = c.id and ($2::uuid is null or k.package_id = $2::uuid)))
        order by c.tax_identifier, c.id limit 2000`,
      [filter.contractorId ?? null, filter.packageId ?? null],
    );
    const owners = new Map<string, OcdsPartySource['owners'][number][]>();
    if (policy.value.include_owners) {
      const found = await tx.query<{ contractor_id: string; owner_name: string; share_pct: string | null; owner_kind: 'PERSON' | 'ORGANISATION' }>(
        'select contractor_id, owner_name, share_pct::text as share_pct, owner_kind from machvon.contractor_owner where ended_on is null and contractor_id = any($1::uuid[]) order by contractor_id, owner_name',
        [rows.map((row) => row.id)],
      );
      for (const owner of found) owners.set(owner.contractor_id, [...(owners.get(owner.contractor_id) ?? []), { name: owner.owner_name, sharePct: owner.share_pct, kind: owner.owner_kind }]);
    }
    const parties = rows
      .filter((row) => row.tendered || row.supplies)
      .map((row) =>
        ocdsParty(
          {
            id: row.id,
            legalName: row.legal_name,
            taxIdentifier: row.tax_identifier,
            registeredAddress: row.registered_address,
            phone: row.phone,
            email: row.email,
            legalRepName: row.legal_rep_name,
            roles: [...(row.tendered ? (['tenderer'] as const) : []), ...(row.supplies ? (['supplier'] as const) : [])],
            owners: owners.get(row.id) ?? [],
          },
          { includeOwners: policy.value.include_owners, includeContact: policy.value.include_contact },
        ),
      );
    return { parties, policy };
  }
}
