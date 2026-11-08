import { message } from '@machvon/kernel';
import { EgpObligationStore, clockOfRow } from './egp-posting-store.ts';
import type { EgpObligationRow } from './egp-posting-store.ts';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';

/** The permission of the audience of the alert: the procurement officers who prepare the postings (`EGP_POSTING_DUE`, owner PROCUREMENT_OFFICER), on the whole tenant (an obligation belongs to no unit). */
export const EGP_POSTING_AUDIENCE_PERMISSION = 'bid.egp.post.prepare';
const DAY_MS = 86_400_000;
/** The most open obligations one pass reads (the open ones, the earliest deadline first). */
const OPEN_LIMIT = 2000;

/**
 * The duties of posting to the national procurement network as a source of the alert centre (EGP-2, `docs/egp-connector.md` section 7). Two kinds, each with its ALERT_TYPE (owner: procurement officer; expected action: post
 * on the network and record the receipt; consequence: a late posting is a breach of the rules on publishing procurement information): `EGP_POSTING_DUE` while the clock of an open obligation is inside the reminder window
 * of its rule, `EGP_POSTING_OVERDUE` past the deadline. The severity follows the time that is left (the rule `EGP_POSTING_SEVERITY`, unverified: urgent when little time is left and once it is past the deadline, else to be
 * acted on). A posting that was submitted raises nothing, late or not: lateness is a figure on BID-25. The clock is computed when the list is read, so there is no job to run. The owner of the obligation always sees it; the
 * procurement officers who hold the right over the whole tenant see them all; anyone else sees an item somebody handed to them.
 */
export class HomeEgpPostingSources {
  private readonly obligations = new EgpObligationStore();

  async items(context: SourceContext): Promise<SourceRow[]> {
    const open = await this.obligations.list(context.tx, { group: 'OPEN' }, { limit: OPEN_LIMIT, after: undefined }, context.now);
    if (open.length === 0) return [];
    const severity = (await this.obligations.severityRule(context.tx, context.now)).params;
    const titles = new Map<string, string>();
    for (const kind of new Set(open.map((row) => row.kind))) {
      const rule = await this.obligations.deadlineRule(context.tx, kind, context.now);
      titles.set(kind, typeof rule.params.obligation === 'string' ? rule.params.obligation : kind);
    }
    const rows: Array<{ row: EgpObligationRow; item: SourceRow }> = [];
    for (const row of open) {
      const { alert, facet } = clockOfRow(row, context.now, severity);
      if (alert === undefined || facet === undefined) continue;
      const overdue = alert === 'EGP_POSTING_OVERDUE';
      const dueOn = new Date(Date.parse(row.dueAt) + 7 * 3_600_000).toISOString().slice(0, 10);
      rows.push({
        row,
        item: {
          ...base(alert),
          id: row.id,
          dueOn,
          originalDueOn: dueOn,
          title: message('home.source.egp_posting.title', { obligation: titles.get(row.kind) as string, subject: row.subjectCode }),
          subtitle: message('home.source.egp_posting.detail', { due: dueOn, state: message(`bid.egp.posting.state.${row.state.toLowerCase()}`) }),
          status: row.state,
          severity: severityOf('EGP_POSTING', facet, context.rules),
          lifecycle: 'NEW',
          consequence: CONSEQUENCES[alert] ?? null,
          causeKey: `egp-posting:${row.id}`,
          startedAt: overdue ? row.dueAt : new Date(Date.parse(row.dueAt) - row.remindBeforeDays * DAY_MS).toISOString(),
          target: { screen: 'BID-32', id: row.id },
        },
      });
    }
    const mine = rows.filter((entry) => entry.row.ownerId === context.membershipId).map((entry) => entry.item);
    const others = rows.filter((entry) => entry.row.ownerId !== context.membershipId).map((entry) => entry.item);
    return [...mine, ...(await forAudience(context, 'EGP_POSTING', EGP_POSTING_AUDIENCE_PERMISSION, others, true))];
  }
}
