import { AUDIT_STANDING_RULE_TYPE, auditStandingDefaults, auditStandingPolicyOf, rankStandings, standingOf } from '@machvon/kernel';
import type { AuditRecommendationStatus, AuditStandingPolicy, RankedStanding, RecommendationFact } from '@machvon/kernel';
import { DAY, readPolicy } from './gov12-policy.ts';
import type { PolicyReading } from './gov12-policy.ts';
import type { TenantTx } from './tenant-database.ts';

export interface InvestorStanding extends RankedStanding {
  unitName: string | null;
  /** The position of the unit in the latest frozen disbursement ranking (the plan the Prime Minister gave), or null when the unit is not ranked there; shown beside the standing, never mixed into it. */
  disbursementRank: number | null;
  disbursementRatePct: string | null;
}

export interface StandingReading {
  policy: PolicyReading<AuditStandingPolicy>;
  snapshotAsOf: string | null;
  units: InvestorStanding[];
}

export interface ProfileRecommendation {
  id: string;
  recCode: string;
  recType: string;
  status: AuditRecommendationStatus;
  dueOn: string | null;
  amountVnd: string | null;
  recoveredVnd: string;
  projectId: string | null;
  overdue: boolean;
}

type Raw = Record<string, unknown>;

/**
 * The standing of the investor units with the recommendations of the auditors (G4-10). A recommendation belongs to the investor of its project, or to the unit that owns it when it names no project. The standing is
 * the pure result of the kernel over those facts; the position in the latest frozen disbursement ranking is read beside it so a leader sees both, and the ranking of disbursement is not changed by any of this.
 */
export class AuditStandingStore {
  policy(tx: TenantTx, today: string): Promise<PolicyReading<AuditStandingPolicy>> {
    return readPolicy(tx, AUDIT_STANDING_RULE_TYPE, today, auditStandingPolicyOf, auditStandingDefaults);
  }

  private async facts(tx: TenantTx, unitId?: string): Promise<Array<{ unitId: string; unitCode: string | null; unitName: string | null; fact: RecommendationFact & { id: string; recCode: string; recType: string; projectId: string | null } }>> {
    const rows = await tx.query<Raw>(
      `select coalesce(p.investor_unit_id, r.owner_unit_id) as unit_id, u.code as unit_code, u.name as unit_name, r.id, r.rec_code, r.rec_type, r.status, ${DAY('r.due_on')} as due_on,
              r.amount_vnd::text as amount_vnd, r.recovered_vnd::text as recovered_vnd, r.project_id
         from machvon.audit_recommendation r
         left join machvon.project p on p.tenant_id = r.tenant_id and p.id = r.project_id
         left join machvon.organization_unit u on u.tenant_id = r.tenant_id and u.id = coalesce(p.investor_unit_id, r.owner_unit_id)
        where coalesce(p.investor_unit_id, r.owner_unit_id) is not null and ($1::uuid is null or coalesce(p.investor_unit_id, r.owner_unit_id) = $1::uuid)`,
      [unitId ?? null],
    );
    return rows.map((row) => ({
      unitId: row.unit_id as string,
      unitCode: (row.unit_code as string | null) ?? null,
      unitName: (row.unit_name as string | null) ?? null,
      fact: { id: row.id as string, recCode: row.rec_code as string, recType: row.rec_type as string, projectId: (row.project_id as string | null) ?? null, status: row.status as AuditRecommendationStatus, dueOn: (row.due_on as string | null) ?? null, amountVnd: (row.amount_vnd as string | null) ?? null, recoveredVnd: row.recovered_vnd as string },
    }));
  }

  /** The disbursement ranking of the latest frozen close snapshot by unit, for the denominator of the plan assigned by the Prime Minister. */
  private async rankings(tx: TenantTx): Promise<{ asOf: string | null; byUnit: Map<string, { rank: number | null; ratePct: string | null }> }> {
    const [snapshot] = await tx.query<{ id: string; as_of: string }>(`select id, ${DAY('as_of_date')} as as_of from machvon.period_snapshot where status = 'FROZEN' and snapshot_kind = 'PERIOD_CLOSE' order by frozen_at desc, created_at desc, id desc limit 1`);
    if (snapshot === undefined) return { asOf: null, byUnit: new Map() };
    const rows = await tx.query<{ unit_id: string; rank: number | null; rate_pct: string | null }>(`select unit_id, rank, rate_pct::text as rate_pct from machvon.disbursement_ranking where snapshot_id = $1::uuid and denominator_kind = 'PM_ASSIGNED'`, [snapshot.id]);
    return { asOf: snapshot.as_of, byUnit: new Map(rows.map((row) => [row.unit_id, { rank: row.rank, ratePct: row.rate_pct }])) };
  }

  /** Every unit with a recommendation, in the order of follow-up. */
  async standings(tx: TenantTx, today: string): Promise<StandingReading> {
    const policy = await this.policy(tx, today);
    const all = await this.facts(tx);
    const grouped = new Map<string, { code: string | null; name: string | null; facts: RecommendationFact[] }>();
    for (const row of all) {
      const entry = grouped.get(row.unitId) ?? { code: row.unitCode, name: row.unitName, facts: [] };
      entry.facts.push(row.fact);
      grouped.set(row.unitId, entry);
    }
    const ranking = await this.rankings(tx);
    const ranked = rankStandings([...grouped.entries()].map(([unitId, entry]) => standingOf({ unitId, unitCode: entry.code }, entry.facts, today, policy.policy)));
    const names = new Map([...grouped.entries()].map(([unitId, entry]) => [unitId, entry.name]));
    return {
      policy,
      snapshotAsOf: ranking.asOf,
      units: ranked.map((unit) => ({ ...unit, unitName: names.get(unit.unitId) ?? null, disbursementRank: ranking.byUnit.get(unit.unitId)?.rank ?? null, disbursementRatePct: ranking.byUnit.get(unit.unitId)?.ratePct ?? null })),
    };
  }

  /** The profile of one investor unit: its standing, its position in both orders, and its recommendations. */
  async profile(tx: TenantTx, unitId: string, today: string): Promise<{ standing: InvestorStanding; recommendations: ProfileRecommendation[]; policy: PolicyReading<AuditStandingPolicy>; snapshotAsOf: string | null; of: number } | undefined> {
    const reading = await this.standings(tx, today);
    const standing = reading.units.find((unit) => unit.unitId === unitId);
    if (standing === undefined) return undefined;
    const own = await this.facts(tx, unitId);
    const recommendations = own
      .map((row): ProfileRecommendation => ({ id: row.fact.id, recCode: row.fact.recCode, recType: row.fact.recType, status: row.fact.status, dueOn: row.fact.dueOn, amountVnd: row.fact.amountVnd, recoveredVnd: row.fact.recoveredVnd, projectId: row.fact.projectId, overdue: row.fact.dueOn !== null && row.fact.status !== 'CLOSED' && row.fact.status !== 'CANCELLED' && row.fact.status !== 'DISPUTED' && row.fact.dueOn < today }))
      .sort((a, b) => (a.dueOn ?? '9999') < (b.dueOn ?? '9999') ? -1 : a.dueOn === b.dueOn ? (a.id < b.id ? -1 : 1) : 1);
    return { standing, recommendations, policy: reading.policy, snapshotAsOf: reading.snapshotAsOf, of: reading.units.filter((unit) => unit.rank !== null).length };
  }
}
