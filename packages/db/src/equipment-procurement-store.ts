import { DomainError, disbursementPercent, equipmentStage, maskEquipmentFigures, planVariance } from '@machvon/kernel';
import type { EquipmentStage, MaskedFigure } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** One line of the equipment procurement view (CN.02): the plan, the choice of contractor, the contract, the payments and the code on the national network, from the modules that own each. */
export interface EquipmentLine {
  id: string;
  code: string;
  name: string;
  planRef: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  source: 'MANUAL' | 'EGP_FILE';
  stage: EquipmentStage;
  project: { id: string; code: string; name: string };
  ownerUnit: { id: string; name: string };
  plannedValueVnd: string;
  package: { id: string; code: string; title: string | null; status: string; externalCode: string | null } | null;
  selection: { outcome: 'AWARDED' | 'NO_ACCEPTABLE_BID' | 'CANCELLED'; status: string; awardPriceVnd: string | null; winnerName: string | null } | null;
  contract: { id: string; code: string; status: string } | null;
  /** Null where the caller may not read contracts or payments (named in `masked`). */
  contractValueVnd: string | null;
  planVarianceVnd: string | null;
  paidVnd: string | null;
  disbursementPercent: string | null;
  masked: MaskedFigure[];
  externalLink: { externalCode: string; diffStatus: string } | null;
  version: number;
}

interface LineSql {
  id: string;
  code: string;
  name: string;
  plan_ref: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  source: 'MANUAL' | 'EGP_FILE';
  planned_value_vnd: string;
  version: string;
  project_id: string;
  project_code: string;
  project_name: string;
  unit_id: string;
  unit_name: string;
  package_id: string | null;
  package_code: string | null;
  package_title: string | null;
  package_status: string | null;
  external_package_code: string | null;
  result_outcome: 'AWARDED' | 'NO_ACCEPTABLE_BID' | 'CANCELLED' | null;
  result_status: string | null;
  award_price_vnd: string | null;
  winner_name: string | null;
  contract_id: string | null;
  contract_code: string | null;
  contract_status: string | null;
  contract_value_vnd: string | null;
  paid_vnd: string;
  link_code: string | null;
  link_diff: string | null;
  may_contract: boolean;
  may_payment: boolean;
}

/**
 * The columns and joins of a line. `$1` is the id of one line or null, `$2` a project id or null, `$3` a stage filter is applied in code. The scope of the caller over the project is the first
 * predicate (parameters from `$4`); the right to read contracts and to read payments are evaluated per row as booleans, so a line stays visible and its money is masked.
 */
function lineSelect(scopes: { read: { sql: string }; contract: { sql: string }; payment: { sql: string } }): string {
  return `select i.id, i.code, i.name, i.plan_ref, i.status, i.source, i.planned_value_vnd::text as planned_value_vnd, i.version::text as version,
      p.id as project_id, p.code as project_code, p.name as project_name, ou.id as unit_id, ou.name as unit_name,
      k.id as package_id, k.code as package_code, k.title as package_title, k.status as package_status, k.external_package_code,
      rs.outcome as result_outcome, rs.status as result_status, rs.award_price_vnd::text as award_price_vnd, w.legal_name as winner_name,
      c.id as contract_id, c.code as contract_code, c.status as contract_status, cr.amount_vnd::text as contract_value_vnd,
      coalesce((select sum(pr.net_vnd) from machvon.payment_request pr where pr.tenant_id = c.tenant_id and pr.contract_id = c.id and pr.status = 'SETTLED'), 0)::text as paid_vnd,
      l.external_code as link_code, l.diff_status as link_diff,
      (${scopes.contract.sql}) as may_contract, (${scopes.payment.sql}) as may_payment
    from machvon.equipment_procurement_item i
    join machvon.project p on p.tenant_id = i.tenant_id and p.id = i.project_id
    join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
    left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
    left join machvon.procurement_package k on k.tenant_id = i.tenant_id and k.id = i.package_id
    left join lateral (select r.outcome, r.status, r.award_price_vnd, r.winner_contractor_id from machvon.procurement_result r
        where r.tenant_id = k.tenant_id and r.package_id = k.id order by (r.status = 'APPROVED') desc, r.updated_at desc, r.id limit 1) rs on true
    left join machvon.contractor w on w.tenant_id = i.tenant_id and w.id = rs.winner_contractor_id
    left join machvon.contract c on c.tenant_id = i.tenant_id and c.id = i.contract_id
    left join machvon.contract_revision cr on cr.tenant_id = c.tenant_id and cr.contract_id = c.id and cr.status = 'EFFECTIVE'
    left join machvon.procurement_external_link l on l.tenant_id = i.tenant_id and l.package_id = i.package_id`;
}

/** Appends three scope predicates for `p`, `ou` and `iu`, numbering their parameters after the ones already taken. */
function scopesFor(read: ScopeBuilder, contract: ScopeBuilder, payment: ScopeBuilder, first: number): { sql: { read: { sql: string }; contract: { sql: string }; payment: { sql: string } }; params: unknown[] } {
  const a = read(first);
  const b = contract(first + a.params.length);
  const c = payment(first + a.params.length + b.params.length);
  return { sql: { read: a, contract: b, payment: c }, params: [...a.params, ...b.params, ...c.params] };
}

const lineOf = (row: LineSql): EquipmentLine => {
  const contractValue = row.contract_value_vnd;
  const figures = {
    contractValueVnd: contractValue,
    paidVnd: row.contract_id === null ? null : row.paid_vnd,
    disbursementPercent: disbursementPercent(contractValue, row.paid_vnd),
    planVarianceVnd: planVariance(row.planned_value_vnd, contractValue),
  };
  const shown = maskEquipmentFigures(figures, { contract: row.may_contract, payment: row.may_payment });
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    planRef: row.plan_ref,
    status: row.status,
    source: row.source,
    stage: equipmentStage({
      itemStatus: row.status,
      packageId: row.package_id,
      result: row.result_outcome === null || row.result_status === null ? null : { outcome: row.result_outcome, status: row.result_status },
      contractId: row.contract_id,
      contractValueVnd: contractValue,
      paidVnd: row.paid_vnd,
    }),
    project: { id: row.project_id, code: row.project_code, name: row.project_name },
    ownerUnit: { id: row.unit_id, name: row.unit_name },
    plannedValueVnd: row.planned_value_vnd,
    package:
      row.package_id === null || row.package_code === null || row.package_status === null
        ? null
        : { id: row.package_id, code: row.package_code, title: row.package_title, status: row.package_status, externalCode: row.external_package_code },
    selection:
      row.result_outcome === null || row.result_status === null
        ? null
        : { outcome: row.result_outcome, status: row.result_status, awardPriceVnd: row.award_price_vnd, winnerName: row.winner_name },
    contract: row.contract_id === null || row.contract_code === null || row.contract_status === null ? null : { id: row.contract_id, code: row.contract_code, status: row.contract_status },
    contractValueVnd: shown.figures.contractValueVnd,
    planVarianceVnd: shown.figures.planVarianceVnd,
    paidVnd: shown.figures.paidVnd,
    disbursementPercent: shown.figures.disbursementPercent,
    masked: shown.masked,
    externalLink: row.link_code === null || row.link_diff === null ? null : { externalCode: row.link_code, diffStatus: row.link_diff },
    version: Number(row.version),
  };
};

export interface EquipmentListFilter {
  projectId?: string | undefined;
  stage?: EquipmentStage | undefined;
  includeCancelled?: boolean | undefined;
}

export interface EquipmentCreateInput {
  projectId: string;
  code: string;
  name: string;
  plannedValueVnd: string;
  planRef: string | undefined;
  source: 'MANUAL' | 'EGP_FILE';
  sourceRef: string | undefined;
}

export interface EquipmentPatch {
  name: string | undefined;
  planRef: string | null | undefined;
  packageId: string | undefined;
  contractId: string | undefined;
  cancelReason: string | undefined;
}

/**
 * The equipment lines of the investment plan and where each stands (CN.02, ENT-4e). The line and its planned value are ours; the choice of contractor, the contract value and the payments are read from BID, CTR and PAY
 * (eng-review R21: one read path), and a figure the caller may not read is masked, not zero. Reads are in the scope of the caller over the project; a write needs the same scope.
 */
export class EquipmentProcurementStore {
  async list(tx: TenantTx, scopes: { read: ScopeBuilder; contract: ScopeBuilder; payment: ScopeBuilder }, filter: EquipmentListFilter): Promise<EquipmentLine[]> {
    const built = scopesFor(scopes.read, scopes.contract, scopes.payment, 3);
    const rows = await tx.query<LineSql>(
      `${lineSelect(built.sql)} where ($1::uuid is null or p.id = $1::uuid) and ($2::boolean or i.status = 'ACTIVE') and ${built.sql.read.sql} order by p.code, i.code, i.id`,
      [filter.projectId ?? null, filter.includeCancelled === true, ...built.params],
    );
    const lines = rows.map(lineOf);
    return filter.stage === undefined ? lines : lines.filter((line) => line.stage === filter.stage);
  }

  async get(tx: TenantTx, scopes: { read: ScopeBuilder; contract: ScopeBuilder; payment: ScopeBuilder }, id: string): Promise<EquipmentLine | undefined> {
    const built = scopesFor(scopes.read, scopes.contract, scopes.payment, 2);
    const rows = await tx.query<LineSql>(`${lineSelect(built.sql)} where i.id = $1::uuid and ${built.sql.read.sql}`, [id, ...built.params]);
    return rows[0] === undefined ? undefined : lineOf(rows[0]);
  }

  /** The project must be in the scope of the caller, else it looks like a project that does not exist. */
  private async assertProject(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<void> {
    const predicate = scope(2);
    const found = await tx.query(`select 1 from ${SCOPE_FROM} where p.id = $1::uuid and ${predicate.sql}`, [projectId, ...predicate.params]);
    if (found.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'project_id');
  }

  async create(tx: TenantTx, scope: ScopeBuilder, actorId: string, input: EquipmentCreateInput): Promise<{ id: string; version: number }> {
    await this.assertProject(tx, scope, input.projectId);
    const taken = await tx.query('select 1 from machvon.equipment_procurement_item where project_id = $1::uuid and code = $2', [input.projectId, input.code]);
    if (taken.length > 0) throw new DomainError('EQUIPMENT_LINE_CODE_TAKEN', 409, 'code');
    const [made] = await tx.query<{ id: string; version: string }>(
      `insert into machvon.equipment_procurement_item (tenant_id, project_id, code, name, planned_value_vnd, plan_ref, source, source_ref, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::numeric, $5, $6, $7, $8::uuid, $8::uuid) returning id, version::text as version`,
      [input.projectId, input.code, input.name, input.plannedValueVnd, input.planRef ?? null, input.source, input.sourceRef ?? null, actorId],
    );
    if (made === undefined) throw new Error('equipment line insert returned no row');
    return { id: made.id, version: Number(made.version) };
  }

  /**
   * Changes a line under the version the caller saw (409 VERSION_CONFLICT): its name or plan reference, the package and the contract it became (each once), or its cancellation with a reason. A package or contract of
   * another project, or a contract of another package, is refused by the database guard (422 EQUIPMENT_LINK_INVALID).
   */
  async patch(tx: TenantTx, scope: ScopeBuilder, actorId: string, id: string, expectedVersion: number, patch: EquipmentPatch): Promise<{ id: string; version: number; before: { status: string; packageId: string | null; contractId: string | null; name: string } }> {
    const [current] = await tx.query<{ project_id: string; version: string; status: string; package_id: string | null; contract_id: string | null; name: string }>(
      'select project_id, version::text as version, status, package_id, contract_id, name from machvon.equipment_procurement_item where id = $1::uuid for update',
      [id],
    );
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.assertProject(tx, scope, current.project_id);
    if (Number(current.version) !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: Number(current.version) } });
    if (current.status === 'CANCELLED') throw new DomainError('EQUIPMENT_LINE_STATE_INVALID', 409, 'status');
    if (patch.packageId !== undefined && current.package_id !== null && patch.packageId !== current.package_id) throw new DomainError('EQUIPMENT_LINE_STATE_INVALID', 409, 'package_id');
    if (patch.contractId !== undefined && current.contract_id !== null && patch.contractId !== current.contract_id) throw new DomainError('EQUIPMENT_LINE_STATE_INVALID', 409, 'contract_id');
    const cancelling = patch.cancelReason !== undefined;
    try {
      const [changed] = await tx.query<{ version: string }>(
        `update machvon.equipment_procurement_item
            set name = coalesce($2, name), plan_ref = case when $3::boolean then $4 else plan_ref end, package_id = coalesce($5::uuid, package_id), contract_id = coalesce($6::uuid, contract_id),
                status = case when $7::boolean then 'CANCELLED' else status end, cancel_reason = case when $7::boolean then $8 else cancel_reason end,
                version = version + 1, updated_at = now(), updated_by = $9::uuid
          where id = $1::uuid returning version::text as version`,
        [id, patch.name ?? null, patch.planRef !== undefined, patch.planRef ?? null, patch.packageId ?? null, patch.contractId ?? null, cancelling, patch.cancelReason ?? null, actorId],
      );
      if (changed === undefined) throw new Error('equipment line update returned no row');
      return { id, version: Number(changed.version), before: { status: current.status, packageId: current.package_id, contractId: current.contract_id, name: current.name } };
    } catch (error) {
      if (error instanceof Error && (error as { code?: string }).code === '23514') throw new DomainError('EQUIPMENT_LINK_INVALID', 422, 'link');
      if (error instanceof Error && (error as { code?: string }).code === '23505') throw new DomainError('EQUIPMENT_LINE_CODE_TAKEN', 409, 'package_id');
      throw error;
    }
  }
}
