import { judgeLinkage } from '@machvon/kernel';
import type { LinkageReading } from '@machvon/kernel';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM } from './ctr-contract-store.ts';
import { CtrContractSource } from './ctr-contract-source.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

export interface LinkageView {
  contract: { id: string; code: string; status: string; originalValueVnd: string; currentValueVnd: string; revisions: number };
  project: { id: string; code: string; name: string; group: string | null };
  package: { id: string; code: string; projectId: string } | null;
  contractor: { id: string; name: string } | null;
  award: { winnerContractorId: string; awardPriceVnd: string } | null;
  parties: Array<{ contractorId: string; name: string; lead: boolean; sharePct: string | null }>;
  reading: LinkageReading;
}

/**
 * The chain from a contract to its project, package and contractor as it stands on the record (G1-18): the facts are read and the kernel judges them (`judgeLinkage`). The rules are enforced when the contract is
 * made; this read proves they still hold. A contract outside the scope of the caller does not exist for them.
 */
export class CtrLinkageReads {
  private readonly source = new CtrContractSource();

  async read(tx: TenantTx, scope: ScopeBuilder, contractId: string): Promise<LinkageView | undefined> {
    const visible = scope(2);
    const rows = await tx.query<{
      id: string;
      code: string;
      status: string;
      project_id: string;
      package_id: string;
      contractor_id: string;
      is_joint_venture: boolean;
      current_value: string;
      project_code: string;
      project_name: string;
      project_group: string | null;
      contractor_name: string | null;
      original_value: string | null;
      revisions: string;
      effective_changes: string;
    }>(
      `select c.id, c.code, c.status, c.project_id, c.package_id, c.contractor_id, c.is_joint_venture, c.contract_value_vnd::text as current_value, p.code as project_code, p.name as project_name, p.project_group,
              kt.name as contractor_name,
              (select r.amount_vnd::text from machvon.contract_revision r where r.tenant_id = c.tenant_id and r.contract_id = c.id and r.revision = 1) as original_value,
              (select count(*)::text from machvon.contract_revision r where r.tenant_id = c.tenant_id and r.contract_id = c.id) as revisions,
              (select count(*)::text from machvon.contract_revision r where r.tenant_id = c.tenant_id and r.contract_id = c.id and r.revision > 1 and r.status in ('EFFECTIVE', 'SUPERSEDED')) as effective_changes
         from ${CONTRACT_SCOPE_FROM}
         left join machvon.contractor kt on kt.tenant_id = c.tenant_id and kt.id = c.contractor_id
        where c.id = $1::uuid and ${visible.sql}`,
      [contractId, ...visible.params],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const facts = await this.source.packageFacts(tx, row.package_id);
    const packageRow = (await tx.query<{ id: string; code: string; project_id: string }>('select id, code, project_id from machvon.procurement_package where id = $1::uuid', [row.package_id]))[0];
    const parties = await tx.query<{ contractor_id: string; name: string | null; lead: boolean; share_pct: string | null }>(
      `select cp.contractor_id, k.name, (cp.role in ('SOLE', 'LEAD')) as lead, cp.share_pct::text as share_pct
         from machvon.contract_party cp left join machvon.contractor k on k.tenant_id = cp.tenant_id and k.id = cp.contractor_id
        where cp.contract_id = $1::uuid and cp.status = 'ACTIVE' order by (cp.role in ('SOLE', 'LEAD')) desc, k.name nulls last, cp.contractor_id`,
      [contractId],
    );
    const original = row.original_value ?? row.current_value;
    const award = facts?.award === null || facts === undefined ? null : { winnerContractorId: facts.award.contractorId, awardPriceVnd: facts.award.priceVnd };
    const reading = judgeLinkage({
      contract: { projectId: row.project_id, packageId: row.package_id, contractorId: row.contractor_id, originalValueVnd: original, currentValueVnd: row.current_value, isJointVenture: row.is_joint_venture },
      package: packageRow === undefined ? null : { projectId: packageRow.project_id, code: packageRow.code },
      award,
      parties: parties.map((party) => ({ contractorId: party.contractor_id, lead: party.lead })),
      effectiveChangeCount: Number(row.effective_changes),
    });
    return {
      contract: { id: row.id, code: row.code, status: row.status, originalValueVnd: original, currentValueVnd: row.current_value, revisions: Number(row.revisions) },
      project: { id: row.project_id, code: row.project_code, name: row.project_name, group: row.project_group },
      package: packageRow === undefined ? null : { id: packageRow.id, code: packageRow.code, projectId: packageRow.project_id },
      contractor: { id: row.contractor_id, name: row.contractor_name ?? '' },
      award,
      parties: parties.map((party) => ({ contractorId: party.contractor_id, name: party.name ?? '', lead: party.lead, sharePct: party.share_pct })),
      reading,
    };
  }
}
