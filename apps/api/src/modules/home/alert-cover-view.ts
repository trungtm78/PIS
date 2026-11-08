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
  /** The deepest chain of hands an alert may pass through (the policy `max_chain_depth`). */
  maxDepth?: number;
}

/** The sources of the alerts a chain of covers hands to the deputy: all of them, or only these. */
interface Reach {
  all: boolean;
  sources: Set<string>;
}

const covers = (reach: Reach, source: string): boolean => reach.all || reach.sources.has(source);

/** What a cover hands on, narrowed by what the chain before it handed (a cover for some sources of a deputy who is covered for others hands on the sources both name). */
function narrowed(edge: CoverEdge, before: Reach): Reach {
  if (edge.scopeKind === 'ALL') return { all: before.all, sources: new Set(before.sources) };
  if (before.all) return { all: false, sources: new Set(edge.sources) };
  return { all: false, sources: new Set(edge.sources.filter((source) => before.sources.has(source))) };
}

/**
 * The people whose alerts end with this deputy now, with the sources that do: the absent people a cover in force names this deputy for, and, when a deputy is away too, the people who named that deputy (A covered by B who is away and
 * covered by C: the alerts of A are C's), as far as the depth of the chain allows and never twice through one person. This is the same road `routeAlert` takes, so the person who is told of an alert finds it on their list.
 */
export function originsOf(input: Pick<CoveredWorkInput, 'deputyId' | 'now' | 'edges' | 'spans' | 'maxDepth'>): Map<string, Reach> {
  const away = (person: string): boolean => input.spans.some((span) => span.membershipId.toLowerCase() === person.toLowerCase() && absencePhaseAt(span, input.now) === 'ACTIVE');
  const live = input.edges.filter((edge) => coverInForce(edge, input.now));
  const found = new Map<string, Reach>();
  const deputy = input.deputyId.toLowerCase();
  let frontier = new Map<string, Reach>([[deputy, { all: true, sources: new Set() }]]);
  const visited = new Set<string>([deputy]);
  for (let depth = 0; depth < (input.maxDepth ?? 5) && frontier.size > 0; depth += 1) {
    const next = new Map<string, Reach>();
    for (const [holder, reach] of frontier) {
      for (const edge of live) {
        if (edge.deputyId.toLowerCase() !== holder || !away(edge.absentId)) continue;
        const absent = edge.absentId.toLowerCase();
        if (absent === deputy) continue;
        const handed = narrowed(edge, reach);
        if (!handed.all && handed.sources.size === 0) continue;
        const known = found.get(absent);
        found.set(absent, known === undefined ? handed : { all: known.all || handed.all, sources: new Set([...known.sources, ...handed.sources]) });
        if (!visited.has(absent)) {
          visited.add(absent);
          next.set(absent, handed);
        }
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * The work of the people a person stands in for now (G2-7): the list of each absent person whose alerts end with the deputy (their own work, found by their membership) read in the scope of the deputy and cut to the sources the chain of covers
 * names. The cover routes attention only: nothing here gives the deputy a right to read or decide more than their own grants allow, and a source that fails is named like any other.
 */
export async function coveredWork(tx: TenantTx, work: HomeWorkStore, input: CoveredWorkInput): Promise<{ rows: CoveredRow[]; unavailableSources: string[] }> {
  const rows: CoveredRow[] = [];
  const unavailable = new Set<string>();
  const origins = originsOf(input);
  const absentIds = [...origins.keys()];
  if (absentIds.length === 0) return { rows, unavailableSources: [] };
  const names = await tx.query<{ membership_id: string; display_name: string | null }>('select membership_id, display_name from machvon.tenant_user_directory where membership_id = any($1::uuid[])', [absentIds]);
  const nameOf = new Map(names.map((row) => [row.membership_id, row.display_name]));
  for (const [absentId, reach] of origins) {
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
    for (const row of collected.rows) {
      // The items that were derived for the absent person from the governance of the alerts (what was sent up to them, the gaps) are not theirs to hand over.
      if (row.source === 'ESCALATION' || row.source === 'COVERAGE') continue;
      if (!covers(reach, row.source)) continue;
      rows.push({ ...row, onBehalfOf: { id: absentId, name: nameOf.get(absentId) ?? null } });
    }
  }
  return { rows, unavailableSources: [...unavailable] };
}
