import { DomainError, builtInCodes, resolveGovernanceRule, vietnamDateOf } from '@machvon/kernel';
import type { GovernanceRuleVersion, ResolveOptions, ResolvedGovernanceRule, RuleParams } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

interface RuleSql {
  id: string;
  rule_type: string;
  code: string;
  version: number;
  status: GovernanceRuleVersion['status'];
  params: RuleParams;
  effective_from: string;
  effective_to: string | null;
  unit_id: string | null;
}

export const toRuleVersion = (row: RuleSql): GovernanceRuleVersion => ({
  id: row.id,
  type: row.rule_type,
  code: row.code,
  version: row.version,
  status: row.status,
  params: row.params,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  unitId: row.unit_id,
});

export const RULE_COLUMNS = `id, rule_type, code, version, status, params, effective_from::text as effective_from, effective_to::text as effective_to, unit_id`;

/** The business day a decision is made on (Vietnam time), when the caller gives an instant. */
const dayOf = (at: string | Date): string => (typeof at === 'string' ? at : vietnamDateOf(at));

/**
 * The reader of the governance rules for every module (G0-1): `get(tx, type, code, asOf)` answers with the approved rule of the tenant in force on the business day `asOf` (`YYYY-MM-DD`, or an instant
 * that is read as its Vietnam day), else the built-in default of the kernel, with the version that decided (0 for a default) so the decision that used it (an alert, a health score, a gate review) can
 * name it. It reads inside the transaction of the caller, so row-level security keeps tenants apart, and it never writes.
 *
 * `options.unitChain` lists the organization unit of the thing that is decided and the units above it, nearest first: an override made for a nearer unit wins over one made for a farther unit, and
 * both win over the rule of the whole tenant. Without it only the rule of the whole tenant is read.
 */
export class GovernancePolicyPort {
  async get(tx: TenantTx, type: string, code: string, asOf: string | Date, options: ResolveOptions = {}): Promise<ResolvedGovernanceRule | undefined> {
    const day = dayOf(asOf);
    const chain = [...(options.unitChain ?? [])];
    const rows = await tx.query<RuleSql>(
      `select ${RULE_COLUMNS}
         from machvon.governance_rule
        where rule_type = $1 and code = $2 and approved_at is not null and status in ('APPROVED', 'RETIRED')
          and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)
          and (unit_id is null or unit_id = any($4::uuid[]))`,
      [type, code, day, chain],
    );
    return resolveGovernanceRule(rows.map(toRuleVersion), type, code, day, { unitChain: chain });
  }

  /** As `get`, for a caller that cannot go on without the rule: 404 GOVERNANCE_RULE_NOT_FOUND when there is neither an approved rule nor a built-in default. */
  async require(tx: TenantTx, type: string, code: string, asOf: string | Date, options: ResolveOptions = {}): Promise<ResolvedGovernanceRule> {
    const found = await this.get(tx, type, code, asOf, options);
    if (found === undefined) throw new DomainError('GOVERNANCE_RULE_NOT_FOUND', 404, 'code');
    return found;
  }

  /** Every code of a type that has a rule in force on the day or a built-in default, each resolved (the list a screen or a batch job reads at once). */
  async getAll(tx: TenantTx, type: string, asOf: string | Date, options: ResolveOptions = {}): Promise<ResolvedGovernanceRule[]> {
    const day = dayOf(asOf);
    const chain = [...(options.unitChain ?? [])];
    const rows = await tx.query<RuleSql>(
      `select ${RULE_COLUMNS}
         from machvon.governance_rule
        where rule_type = $1 and approved_at is not null and status in ('APPROVED', 'RETIRED')
          and effective_from <= $2::date and (effective_to is null or effective_to > $2::date)
          and (unit_id is null or unit_id = any($3::uuid[]))`,
      [type, day, chain],
    );
    const versions = rows.map(toRuleVersion);
    const codes = new Set<string>([...versions.map((version) => version.code), ...builtInCodes(type)]);
    const resolved: ResolvedGovernanceRule[] = [];
    for (const code of [...codes].sort()) {
      const one = resolveGovernanceRule(versions, type, code, day, { unitChain: chain });
      if (one !== undefined) resolved.push(one);
    }
    return resolved;
  }
}
