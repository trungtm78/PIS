import type { HomeWorkStore, ScopeBuilder, TenantTx, WorkRow } from '@machvon/db';
import { absencePhaseAt, coverInForce } from '@machvon/kernel';
import type { AbsenceSpan, CoverEdge } from '@machvon/kernel';

/** An item of the alert centre of a person who is away, as the person who stands in for them reads it. */
export type CoveredRow = WorkRow & { onBehalfOf: { id: string; name: string | null } };

export interface CoveredWorkInput {
  deputyId: string;
  now: Date;
  today: string;
  edges: readonly CoverEdge[];
  spans: readonly AbsenceSpan[];
  /** The scope of the deputy, never of the absent person: a deputy sees what they may read, not more. */
  unitScope: ScopeBuilder;
  projectScope: ScopeBuilder;
  holds?: (permission: string, wholeTenant?: boolean) => boolean;
  mode: 'rows' | 'count';
}

/**
 * The work of the people a person stands in for now (G2-7): for each allowed cover in force whose deputy is this person and whose absent person is away, the list of the absent person (their own work, found by their membership) read in the
 * scope of the deputy and cut to the sources the cover names. The cover routes attention only: nothing here gives the deputy a right to read or decide more than their own grants allow, and a source that fails is named like any other.
 * The absent person still has their own list, read-only for the purpose of the cover (the work store does not move an item from them).
 */
export async function coveredWork(tx: TenantTx, work: HomeWorkStore, input: CoveredWorkInput): Promise<{ rows: CoveredRow[]; unavailableSources: string[] }> {
  const rows: CoveredRow[] = [];
  const unavailable = new Set<string>();
  const live = input.edges.filter((edge) => edge.deputyId.toLowerCase() === input.deputyId.toLowerCase() && coverInForce(edge, input.now) && input.spans.some((span) => span.membershipId === edge.absentId && absencePhaseAt(span, input.now) === 'ACTIVE'));
  const absentIds = [...new Set(live.map((edge) => edge.absentId))];
  if (absentIds.length === 0) return { rows, unavailableSources: [] };
  const names = await tx.query<{ membership_id: string; display_name: string | null }>('select membership_id, display_name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [absentIds]);
  const nameOf = new Map(names.map((row) => [row.membership_id, row.display_name]));
  for (const absentId of absentIds) {
    const collected = await work.collect(tx, {
      membershipId: absentId,
      now: input.now,
      today: input.today,
      view: 'mine',
      mode: input.mode,
      unitScope: input.unitScope,
      projectScope: input.projectScope,
      ...(input.holds === undefined ? {} : { holds: input.holds }),
    });
    for (const source of collected.unavailableSources) unavailable.add(source);
    const covering = live.filter((edge) => edge.absentId === absentId);
    for (const row of collected.rows) {
      // The items that were derived for the absent person from the governance of the alerts (what was sent up to them, the gaps) are not theirs to hand over.
      if (row.source === 'ESCALATION' || row.source === 'COVERAGE') continue;
      if (!covering.some((edge) => edge.scopeKind === 'ALL' || edge.sources.includes(row.source))) continue;
      rows.push({ ...row, onBehalfOf: { id: absentId, name: nameOf.get(absentId) ?? null } });
    }
  }
  return { rows, unavailableSources: [...unavailable] };
}
