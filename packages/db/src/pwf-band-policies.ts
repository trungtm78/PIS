import { DomainError, pwfDeadlineBand, resolveGovernanceRule } from '@machvon/kernel';
import { RULE_COLUMNS, toRuleVersion } from './governance-policy-port.ts';
import { policyVersionOf } from './home-work-policy.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The official tier of the three colours of a task (BR-PWF-22): the rule `DEADLINE_BAND_POLICY` of the source `PROJECT_TASK` in force on a day, as the whole tenant approved it and as a unit approved it for itself, the nearest unit
 * winning, and the built-in default (5, 2, 0 working days) where nobody approved anything. The rules are read ONCE and resolved for each unit the tasks belong to, so a board or a list of thousands of tasks asks the database one question.
 * Whatever a person set for themselves is not here: it can only change what that person sees (R40).
 */

export const BAND_SOURCE = 'PROJECT_TASK';

export interface BandPolicySet {
  /** The policy that holds in the unit whose path is given (the unit of the project of a task); `null`: the rule of the whole tenant. */
  forUnitPath(path: string | null): pwfDeadlineBand.BandPolicy;
  /** The version of the rule that decided it for that unit: `builtin` for the default of the platform, `v<n>` for an approved rule. */
  versionForUnitPath(path: string | null): string;
  /** The widest line of green of any rule in force and any override (a task farther than this has no colour under any of them); null when a rule has no green line, which makes every task green. */
  widestGreenDays: number | null;
  /** The farthest day-before-deadline any rule in force asks to be reminded at (0 when none asks). */
  widestReminderDays: number;
}

interface UnitRule {
  id: string;
  path: string;
}

export class PwfBandPolicies {
  async load(tx: TenantTx, today: string): Promise<BandPolicySet> {
    const rows = await tx.query<Parameters<typeof toRuleVersion>[0]>(
      `select ${RULE_COLUMNS}
         from machvon.governance_rule
        where rule_type = $1 and code = $2 and approved_at is not null and status in ('APPROVED', 'RETIRED')
          and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)`,
      [pwfDeadlineBand.DEADLINE_BAND_RULE_TYPE, BAND_SOURCE, today],
    );
    const versions = rows.map(toRuleVersion);
    const unitIds = [...new Set(versions.map((version) => version.unitId).filter((id): id is string => id !== null))];
    const units: UnitRule[] =
      unitIds.length === 0 ? [] : (await tx.query<{ id: string; path: string }>('select id, path from machvon.organization_unit where id = any($1::uuid[])', [unitIds])).map((row) => ({ id: row.id, path: row.path }));
    const cache = new Map<string, { policy: pwfDeadlineBand.BandPolicy; version: string }>();
    const resolveWithVersion = (chain: readonly string[]): { policy: pwfDeadlineBand.BandPolicy; version: string } => {
      const key = chain.join(',');
      const known = cache.get(key);
      if (known !== undefined) return known;
      const resolved = resolveGovernanceRule(versions, pwfDeadlineBand.DEADLINE_BAND_RULE_TYPE, BAND_SOURCE, today, { unitChain: [...chain] });
      if (resolved === undefined) throw new DomainError('GOVERNANCE_RULE_NOT_FOUND', 404, 'code');
      const found = { policy: pwfDeadlineBand.bandPolicyOf(resolved, BAND_SOURCE), version: policyVersionOf(resolved) };
      cache.set(key, found);
      return found;
    };
    const resolve = (chain: readonly string[]): pwfDeadlineBand.BandPolicy => resolveWithVersion(chain).policy;
    const chainOf = (path: string | null): string[] =>
      // The rules of the units above the one asked for (or the unit itself), nearest first.
      path === null ? [] : units.filter((unit) => path.startsWith(unit.path)).sort((left, right) => right.path.length - left.path.length).map((unit) => unit.id);
    // The policies that can apply anywhere: the tenant's and each unit's. The widest green line over them (and their overrides) bounds what a read of tasks has to look at.
    const everywhere = [resolve([]), ...units.map((unit) => resolve([unit.id]))];
    const lines = everywhere.flatMap((policy) => [policy.green_days, ...policy.overrides.map((override) => override.green_days)]);
    const widest = lines.some((line) => line === null) ? null : Math.max(...(lines as number[]));
    return {
      widestGreenDays: widest,
      widestReminderDays: Math.max(0, ...everywhere.flatMap((policy) => policy.reminder_days)),
      forUnitPath: (path) => resolve(chainOf(path)),
      versionForUnitPath: (path) => resolveWithVersion(chainOf(path)).version,
    };
  }
}
