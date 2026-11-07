import { DomainError, contractAvailability, eacControl } from '@machvon/kernel';
import type { ContractAvailability, EacControl } from '@machvon/kernel';
import { evaluateAvc } from './cap-avc.ts';
import type { AvcFigures, AvcVerdict } from './cap-avc.ts';
import { CapAvcPolicyStore } from './cap-avc-policy-store.ts';
import { SCOPE_FROM as CONTRACT_SCOPE_FROM } from './ctr-contract-store.ts';
import { MoneyPolicyReader } from './money-policy-reader.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The change orders that do not price anything yet: assessed and waiting for a decision, or approved and waiting for their day. Increases only: they are what the capital has to carry. */
const PENDING_INCREASE_NUMERIC = `coalesce(sum(case
    when r.status = 'EVALUATED' and r.stage = 'CO' then greatest(coalesce(r.evaluated_delta_vnd, 0), 0)
    when r.status = 'APPROVED' and rv.status = 'PENDING_EFFECTIVE' then greatest(coalesce(r.approved_delta_vnd, 0), 0)
    else 0 end), 0)`;
const PENDING_INCREASE_SQL = `${PENDING_INCREASE_NUMERIC}::text`;

/** One change order against the capital line it would be paid from (CAP-17 down to the change). */
export interface ChangeOrderAvailability {
  id: string;
  code: string | null;
  status: string;
  deltaVnd: string;
  allocationLineId: string | null;
  /** The verdict of the line for this increase on top of what the line already carries; null for a decrease, a change with no line, or a line that no policy controls. */
  verdict: AvcVerdict | null;
}

/** What the contract position shows (CAP-17 extended to the contract): the price in force against the payments, and the capital line the contract commits against. */
export interface ContractAvcStatement {
  contract: { id: string; code: string; status: string; projectId: string; packageId: string };
  money: ContractAvailability;
  /** The capital line of the package of the contract and where it stands; null when the package names none. */
  line: { allocationLineId: string; figures: AvcFigures; verdict: AvcVerdict | null; committedVnd: string; contractCommitsWithinLine: boolean } | null;
  changeOrders: ChangeOrderAvailability[];
  asOf: string;
}

/** The estimate at completion of a project against its approved total investment (CAP/PRJ F03). */
export interface ProjectEacStatement {
  projectId: string;
  projectCode: string;
  control: EacControl;
  /** How the estimate was made: the method of the provider that gave it. */
  method: string;
  allocatedVnd: string;
  /** What the estimate lacks in capital that was allocated (zero when allocated covers it). */
  fundingGapVnd: string;
  contractCount: number;
  policy: { version: number | null; source: 'DEFAULT' | 'RULE'; eacAlertAbovePct: string };
  asOf: string;
}

/** Where an estimate at completion comes from. The EVM of lane B1 plugs in here and wins over the default when it has one for the project. */
export interface EacProvider {
  method: string;
  estimate(tx: TenantTx, projectId: string): Promise<string | undefined>;
}

/** The default estimate: the price in force of every contract that was signed and is not cancelled, plus the increases that wait for a decision or their day. Not an earned-value estimate: it knows only what is contracted. */
export const CONTRACT_PRICES_EAC: EacProvider = {
  method: 'CONTRACT_PRICES_PLUS_PENDING',
  async estimate(tx, projectId) {
    const [row] = await tx.query<{ total: string }>(
      `select (coalesce(sum(c.contract_value_vnd), 0) + coalesce((
                select ${PENDING_INCREASE_NUMERIC}
                  from machvon.change_request r
                  join machvon.contract c2 on c2.tenant_id = r.tenant_id and c2.id = r.contract_id
                  left join machvon.contract_revision rv on rv.tenant_id = r.tenant_id and rv.id = r.resulting_revision_id
                 where c2.project_id = $1::uuid and c2.status in ('SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED', 'CLOSED')), 0))::text as total
         from machvon.contract c where c.project_id = $1::uuid and c.status in ('SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED', 'CLOSED')`,
      [projectId],
    );
    return row?.total;
  },
};

/**
 * The availability control extended down to the contract and the change orders (governance deepening G1-6, CAP-17): the cumulative payments of a contract against its price in force, the capital
 * line it commits against, each change order against the line it would be paid from, and the estimate at completion of the project against its approved total investment. Reads only: the commands
 * that move money keep their own checks (`CapAvailabilityStore`, `PayClaimStore`); this is where a person sees why one of them refuses.
 */
export class CapContractAvcStore {
  private readonly policies = new CapAvcPolicyStore();
  private readonly money: MoneyPolicyReader;
  private readonly providers: readonly EacProvider[];

  constructor(money: MoneyPolicyReader = new MoneyPolicyReader(), providers: readonly EacProvider[] = [CONTRACT_PRICES_EAC]) {
    this.money = money;
    this.providers = providers;
  }

  /** The position of a contract in the scope of the caller; undefined when the caller does not reach it. */
  async contractStatement(tx: TenantTx, contractId: string, scope: ScopeBuilder, today: string): Promise<ContractAvcStatement | undefined> {
    if (!UUID.test(contractId)) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    const predicate = scope(2);
    const [contract] = await tx.query<{
      id: string;
      code: string;
      status: string;
      project_id: string;
      package_id: string;
      contract_value_vnd: string;
      requested_total_vnd: string;
      paid_total_vnd: string;
      advance_paid_vnd: string;
      advance_recovered_vnd: string;
      project_group: string | null;
      owner_unit_id: string;
      original_price_vnd: string | null;
      pending_increase_vnd: string;
      line_id: string | null;
    }>(
      `select c.id, c.code, c.status, c.project_id, c.package_id, c.contract_value_vnd::text as contract_value_vnd, c.requested_total_vnd::text as requested_total_vnd, c.paid_total_vnd::text as paid_total_vnd,
              c.advance_paid_vnd::text as advance_paid_vnd, c.advance_recovered_vnd::text as advance_recovered_vnd, p.project_group, p.owner_unit_id,
              (select b.amount_vnd::text from machvon.contract_revision b where b.tenant_id = c.tenant_id and b.contract_id = c.id order by b.revision limit 1) as original_price_vnd,
              (select ${PENDING_INCREASE_SQL} from machvon.change_request r left join machvon.contract_revision rv on rv.tenant_id = r.tenant_id and rv.id = r.resulting_revision_id where r.tenant_id = c.tenant_id and r.contract_id = c.id) as pending_increase_vnd,
              (select pk.allocation_line_id from machvon.procurement_package pk where pk.tenant_id = c.tenant_id and pk.id = c.package_id) as line_id
         from ${CONTRACT_SCOPE_FROM} where c.id = $1::uuid and ${predicate.sql}`,
      [contractId.toLowerCase(), ...predicate.params],
    );
    if (contract === undefined) return undefined;
    const money = contractAvailability({
      currentPriceVnd: contract.contract_value_vnd,
      originalPriceVnd: contract.original_price_vnd ?? contract.contract_value_vnd,
      requestedTotalVnd: contract.requested_total_vnd,
      paidTotalVnd: contract.paid_total_vnd,
      advancePaidVnd: contract.advance_paid_vnd,
      advanceRecoveredVnd: contract.advance_recovered_vnd,
      pendingIncreaseVnd: contract.pending_increase_vnd,
    });

    let line: ContractAvcStatement['line'] = null;
    const lineFigures = new Map<string, { figures: AvcFigures; thresholds: Awaited<ReturnType<CapAvcPolicyStore['governingLine']>> }>();
    const figuresOf = async (lineId: string) => {
      const known = lineFigures.get(lineId);
      if (known !== undefined) return known;
      const [row] = await tx.query<{ allocated: string; reserved: string; committed: string; disbursed: string; fund_key: string }>(
        `select ab.allocated_vnd::text as allocated, ab.reserved_vnd::text as reserved, ab.committed_vnd::text as committed, ab.disbursed_vnd::text as disbursed, fr.business_key as fund_key
           from machvon.allocation_line al
           join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id
           join machvon.master_record_version fv on fv.tenant_id = al.tenant_id and fv.id = al.fund_source_version_id
           join machvon.master_record fr on fr.tenant_id = fv.tenant_id and fr.id = fv.master_record_id
          where al.id = $1::uuid`,
        [lineId],
      );
      if (row === undefined) return undefined;
      const thresholds = await this.policies.governingLine(tx, { projectGroup: contract.project_group, unitId: contract.owner_unit_id, fundSourceKey: row.fund_key }, today);
      const entry = { figures: { allocatedVnd: row.allocated, reservedVnd: row.reserved, committedVnd: row.committed, disbursedVnd: row.disbursed }, thresholds };
      lineFigures.set(lineId, entry);
      return entry;
    };
    if (contract.line_id !== null) {
      const known = await figuresOf(contract.line_id);
      if (known !== undefined) {
        const [commit] = await tx.query<{ committed: string }>(
          "select coalesce(sum(amount_vnd), 0)::text as committed from machvon.capital_ledger_entry where source_ref_kind = 'CONTRACT' and source_ref_id = $1::uuid and entry_type = 'COMMIT' and allocation_line_id = $2::uuid",
          [contract.id, contract.line_id],
        );
        line = {
          allocationLineId: contract.line_id,
          figures: known.figures,
          verdict: evaluateAvc(known.figures, known.thresholds),
          committedVnd: commit?.committed ?? '0',
          // What the contract committed is within what the line was allocated.
          contractCommitsWithinLine: BigInt(commit?.committed ?? '0') <= BigInt(known.figures.allocatedVnd),
        };
      }
    }

    const changes = await tx.query<{ id: string; code: string | null; status: string; delta: string; line_id: string | null }>(
      `select r.id, r.code, r.status, coalesce(case when r.status = 'APPROVED' then r.approved_delta_vnd else r.evaluated_delta_vnd end, 0)::text as delta, r.evaluation_allocation_line_id as line_id
         from machvon.change_request r
         left join machvon.contract_revision rv on rv.tenant_id = r.tenant_id and rv.id = r.resulting_revision_id
        where r.contract_id = $1::uuid and r.stage = 'CO' and (r.status = 'EVALUATED' or (r.status = 'APPROVED' and rv.status = 'PENDING_EFFECTIVE'))
        order by r.created_at, r.id`,
      [contract.id],
    );
    const changeOrders: ChangeOrderAvailability[] = [];
    for (const change of changes) {
      let verdict: AvcVerdict | null = null;
      if (change.line_id !== null && BigInt(change.delta) > 0n) {
        const known = await figuresOf(change.line_id);
        if (known !== undefined) verdict = evaluateAvc(known.figures, known.thresholds, change.delta);
      }
      changeOrders.push({ id: change.id, code: change.code, status: change.status, deltaVnd: change.delta, allocationLineId: change.line_id, verdict });
    }
    return { contract: { id: contract.id, code: contract.code, status: contract.status, projectId: contract.project_id, packageId: contract.package_id }, money, line, changeOrders, asOf: new Date().toISOString() };
  }

  /** The estimate at completion of a project against its approved total investment; undefined when the caller does not reach the project. */
  async eacStatement(tx: TenantTx, projectId: string, scope: ScopeBuilder, today: string): Promise<ProjectEacStatement | undefined> {
    if (!UUID.test(projectId)) throw new DomainError('VALIDATION_FAILED', 422, 'id');
    const predicate = scope(2);
    const [project] = await tx.query<{ id: string; code: string; total: string }>(
      `select p.id, p.code, p.total_investment_vnd::text as total
         from machvon.project p
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where p.id = $1::uuid and ${predicate.sql}`,
      [projectId.toLowerCase(), ...predicate.params],
    );
    if (project === undefined) return undefined;
    let eac: string | undefined;
    let method = '';
    for (const provider of this.providers) {
      eac = await provider.estimate(tx, project.id);
      if (eac !== undefined) {
        method = provider.method;
        break;
      }
    }
    const reading = await this.money.get(tx, 'CONTRACT_AVC', today);
    const estimate = eac ?? '0';
    const [allocated] = await tx.query<{ allocated: string; contracts: string }>(
      `select coalesce((select sum(ab.allocated_vnd) from machvon.allocation_line al join machvon.allocation_balance ab on ab.tenant_id = al.tenant_id and ab.allocation_line_id = al.id where al.project_id = $1::uuid), 0)::text as allocated,
              (select count(*) from machvon.contract c where c.project_id = $1::uuid and c.status in ('SIGNED', 'ACTIVE', 'SUSPENDED', 'COMPLETED', 'CLOSED'))::text as contracts`,
      [project.id],
    );
    const allocatedVnd = allocated?.allocated ?? '0';
    return {
      projectId: project.id,
      projectCode: project.code,
      control: eacControl(estimate, project.total, reading.params.eacAlertAbovePct),
      method: method === '' ? CONTRACT_PRICES_EAC.method : method,
      allocatedVnd,
      fundingGapVnd: (BigInt(estimate) > BigInt(allocatedVnd) ? BigInt(estimate) - BigInt(allocatedVnd) : 0n).toString(),
      contractCount: Number(allocated?.contracts ?? '0'),
      policy: { version: reading.version, source: reading.source, eacAlertAbovePct: reading.params.eacAlertAbovePct },
      asOf: new Date().toISOString(),
    };
  }
}
