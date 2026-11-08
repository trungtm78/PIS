import { ALERT_GOV_TEXT, escalationChainLabels, evaluateEscalation } from '@machvon/kernel';
import type { EscalationPolicy, WorkCalendarSource } from '@machvon/kernel';
import { AlertEscalationStore } from './alert-escalation-store.ts';
import type { ItemClimb } from './alert-escalation-store.ts';
import { actionKey } from './home-work-action-store.ts';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import type { WorkSeverity } from './home-work-rules.ts';
import { Params, SOURCE_LIMIT, base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import type { TenantTx } from './tenant-database.ts';

/** The permission of the people who manage covers and close the gaps in coverage (the audience of the alert `COVERAGE_GAP`, owner ALERT_COVER_MANAGER). */
export const COVER_MANAGER_PERMISSION = 'home.alert.cover.manage';
/** Where a gap in coverage is opened from: the screen of absences and covers. */
export const COVERAGE_SCREEN = 'ADM-25';

const label = (...parts: Array<string | null | undefined>): string | null => {
  const text = parts.filter((part): part is string => part !== null && part !== undefined && part !== '').join(' · ');
  return text === '' ? null : text;
};

const DETAIL = {
  FUNCTIONAL: ALERT_GOV_TEXT.source.escalation_detail_functional,
  HIERARCHICAL: ALERT_GOV_TEXT.source.escalation_detail_hierarchical,
} as const;

/**
 * Two sources of the alert centre that belong to the governance of the alert system (lane GOV-9a). ESCALATION: an item that was sent up to the reader by the chain of escalation (G2-3), shown with where it came from and opened where the
 * original is opened; it goes away when the item is done or gone. COVERAGE: a gap in the coverage of the receivers of alerts (a person away with nobody to cover, an absence about to start with no cover proposed, an owner who left with open
 * items), for the people who hold the permission to manage covers and whose unit scope reaches the person (G2-7). Both are read from their own tables, so a source that cannot be read is named, never shown as "nothing".
 */
export class HomeAlertSources {
  private readonly escalations = new AlertEscalationStore();

  async escalated(context: SourceContext): Promise<SourceRow[]> {
    // What was sent up to a person is theirs; a reader of a scope sees the monitor (NOT-19), not their own list filled with other people's levels.
    if (context.view === 'scope') return [];
    const rows = await this.escalations.openFor(context.tx, context.membershipId);
    return rows.slice(0, SOURCE_LIMIT).map((row) => {
      const kind = row.kind === 'PROMOTION' ? 'HIERARCHICAL' : row.kind;
      return {
        ...base('ESCALATED_ITEM'),
        id: row.id,
        dueOn: row.itemDueOn,
        originalDueOn: row.itemDueOn,
        title: ALERT_GOV_TEXT.source.escalation_title(row.itemTitle),
        subtitle: label(row.trigger === 'ORPHANED' ? ALERT_GOV_TEXT.source.escalation_detail_orphan : DETAIL[kind], row.itemSubtitle),
        status: row.status,
        severity: severityOf('ESCALATION', row.severity, context.rules),
        lifecycle: row.status === 'ACKNOWLEDGED' ? 'CLAIMED' : 'NEW',
        consequence: CONSEQUENCES.ESCALATED_ITEM ?? null,
        causeKey: null,
        startedAt: row.reachedAt,
        escalation: null,
        target: row.target,
      } satisfies SourceRow;
    });
  }

  async coverageGaps(context: SourceContext): Promise<SourceRow[]> {
    const params = new Params();
    const visible = params.scope(context.unitScope);
    const rows = await context.tx.query<{ id: string; kind: string; item_count: number; opened_at: string; absence_id: string | null; name: string | null; days: string }>(
      `select g.id, g.kind, g.item_count, to_char(g.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as opened_at, g.absence_id, d.display_name as name,
              greatest(0, floor(extract(epoch from (${params.add(context.now.toISOString())}::timestamptz - g.opened_at)) / 86400))::text as days
         from machvon.alert_routing_gap g
         join machvon.organization_unit u on u.tenant_id = g.tenant_id and u.id = g.unit_id
         left join machvon.tenant_user_directory d on d.tenant_id = g.tenant_id and d.membership_id = g.membership_id
        where g.closed_at is null and g.kind in ('ABSENT_NO_COVER', 'ABSENCE_STARTING_UNCOVERED', 'OWNER_INACTIVE') and ${visible}
        order by g.opened_at, g.id limit ${SOURCE_LIMIT}`,
      params.values,
    );
    const items: SourceRow[] = rows.map((row) => {
      const starting = row.kind === 'ABSENCE_STARTING_UNCOVERED';
      const name = row.name ?? '';
      return {
        ...base('COVERAGE_GAP'),
        id: row.id,
        dueOn: null,
        originalDueOn: null,
        title: row.kind === 'OWNER_INACTIVE' ? ALERT_GOV_TEXT.source.coverage_owner_inactive : starting ? ALERT_GOV_TEXT.source.coverage_starting(name) : ALERT_GOV_TEXT.source.coverage_absent(name),
        subtitle: ALERT_GOV_TEXT.source.coverage_detail(Number(row.days)),
        status: row.kind,
        severity: severityOf('COVERAGE', starting ? 'STARTING' : row.kind === 'OWNER_INACTIVE' ? 'OWNER_INACTIVE' : 'ABSENT', context.rules),
        lifecycle: 'NEW',
        consequence: CONSEQUENCES.COVERAGE_GAP ?? null,
        causeKey: `coverage:${row.id}`,
        startedAt: row.opened_at,
        target: { screen: COVERAGE_SCREEN, id: row.absence_id ?? row.id },
      } satisfies SourceRow;
    });
    return forAudience(context, 'COVERAGE', COVER_MANAGER_PERMISSION, items, false);
  }
}

/** An item that was only to be watched and has been raised one step (a `PROMOTION` row of the escalation ledger that is not closed) is shown to be acted on, with the step it came from. */
export async function applyPromotions(tx: TenantTx, rows: Array<{ source: string; id: string; severity: WorkSeverity; promotedFrom?: WorkSeverity | undefined }>): Promise<void> {
  const watched = rows.filter((row) => row.severity === 'WATCH' && row.source !== 'ESCALATION' && row.source !== 'COVERAGE');
  if (watched.length === 0) return;
  const found = await tx.query<{ source: string; source_id: string }>(
    `select e.source, e.source_id from machvon.alert_escalation e join unnest($1::text[], $2::text[]) as k (source, source_id) on k.source = e.source and k.source_id = e.source_id where e.kind = 'PROMOTION' and e.status <> 'CLOSED'`,
    [watched.map((row) => row.source), watched.map((row) => row.id)],
  );
  const promoted = new Set(found.map((row) => actionKey(row.source, row.source_id)));
  for (const row of watched) {
    if (!promoted.has(actionKey(row.source, row.id))) continue;
    row.promotedFrom = 'WATCH';
    row.severity = 'ACTION';
  }
}

/** The part of a row the overlay reads and writes. */
interface OverlayRow {
  source: string;
  id: string;
  severity: WorkSeverity;
  lifecycle: 'NEW' | 'CLAIMED' | 'IN_PROGRESS' | 'RESOLVED';
  snoozedUntil: string | null;
  clocks: { claim: unknown; resolve: unknown; needsReclaim: unknown; paused: unknown } | null;
  escalation: { level: number; of: number; nextAt: string | null; chain: string[] } | null;
}

/**
 * The climb of an item as the card shows it ("who receives it next, and when"): when the chain of escalation says an item is going up (a trigger holds, or a level was recorded), the card shows that chain, the owner first and then each
 * level marked functional or hierarchical, with the level the item stands at and the moment of the next one. An item the chain does not concern keeps what its own module says about its escalation.
 */
export function overlayEscalation(rows: readonly OverlayRow[], input: { policy: EscalationPolicy; climbs: ReadonlyMap<string, ItemClimb>; calendars: WorkCalendarSource | undefined; now: Date }): void {
  for (const row of rows) {
    if (row.source === 'ESCALATION' || row.source === 'COVERAGE') continue;
    const steps = input.policy.steps[row.severity];
    if (steps.length === 0) continue;
    const climb = input.climbs.get(actionKey(row.source, row.id));
    const evaluation = evaluateEscalation({
      severity: row.severity,
      now: input.now,
      lifecycle: row.lifecycle,
      clocks: row.clocks === null ? null : (row.clocks as never),
      paused: row.clocks?.paused !== null && row.clocks?.paused !== undefined,
      snoozedUntil: row.snoozedUntil === null ? null : new Date(row.snoozedUntil),
      orphaned: null,
      acknowledged: climb?.acknowledged ?? [],
      policy: input.policy,
      calendars: input.calendars,
    });
    const reached = Math.max(climb?.max ?? 0, evaluation.reached);
    if (reached === 0 && evaluation.anchor === null) continue;
    row.escalation = { level: Math.min(reached + 1, steps.length + 1), of: steps.length + 1, nextAt: evaluation.nextAt, chain: [ALERT_GOV_TEXT.chain_owner, ...escalationChainLabels(input.policy, row.severity)] };
  }
}
