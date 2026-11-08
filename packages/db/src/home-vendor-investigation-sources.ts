import { VND3_AUDIENCE_PERMISSIONS, VND3_FACET_SEVERITY, VND3_SCREENS, vnd3Fill, VND3_TEXT } from '@machvon/kernel';
import type { WorkKind } from '@machvon/kernel';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { Vnd3PolicyReader } from './vnd3-policy.ts';
import { VendorLeadStore } from './vnd-lead-store.ts';
import { VendorScreeningStore } from './vnd-screening-store.ts';

const severity = (facet: string, context: SourceContext): SourceRow['severity'] => context.rules.VENDOR?.[facet] ?? VND3_FACET_SEVERITY[facet] ?? 'ACTION';

/**
 * The investigation and the screening of contractors as a source of the alert centre (VND-3, docs/vendor-investigation.md section 9). Two kinds, each with its ALERT_TYPE (owner, expected action, consequence):
 *  - `VENDOR_LINK_LEAD` (V-A5): an open lead of the investigation, to the auditors only (a reader without the right gets nothing, not even a count, and a person who took part in the packages of a lead never gets it).
 *  - `VENDOR_SCREENING_HIT` (V-A14): a pending hit of the screening, urgent while it holds the contractor.
 * Read when the alert centre is read (no job).
 */
export class HomeVendorInvestigationSources {
  private readonly leads = new VendorLeadStore();
  private readonly screening = new VendorScreeningStore();
  private readonly policies = new Vnd3PolicyReader();

  async items(context: SourceContext): Promise<SourceRow[]> {
    const rows: SourceRow[] = [];
    if (context.holds?.(VND3_AUDIENCE_PERMISSIONS.lead, true) === true) rows.push(...(await this.leadRows(context)));
    rows.push(...(await forAudience(context, 'VENDOR', VND3_AUDIENCE_PERMISSIONS.screening, await this.hitRows(context), true)));
    return rows;
  }

  private row(kind: WorkKind, id: string, facet: string, context: SourceContext, fields: Pick<SourceRow, 'title' | 'subtitle' | 'status' | 'dueOn' | 'originalDueOn' | 'target'> & { startedAt?: string | null; causeKey: string }): SourceRow {
    return { ...base(kind), id, severity: severity(facet, context), consequence: CONSEQUENCES[kind] ?? null, ...fields };
  }

  private async leadRows(context: SourceContext): Promise<SourceRow[]> {
    const policy = await this.policies.investigation(context.tx, context.today);
    const found = await this.leads.alertable(context.tx, context.membershipId, policy.value);
    return found.map((lead) =>
      this.row('VENDOR_LINK_LEAD', lead.id, lead.high ? 'LEAD_HIGH' : 'LEAD_NEW', context, {
        title: vnd3Fill(VND3_TEXT.home.lead_title, { kind: lead.kind, count: lead.contractorCount, rank: lead.rank }),
        subtitle: vnd3Fill(VND3_TEXT.home.lead_detail, { since: lead.firstFlaggedAt.slice(0, 10), status: lead.status }),
        status: lead.status,
        dueOn: context.today,
        originalDueOn: lead.firstFlaggedAt.slice(0, 10),
        causeKey: `vendor-lead:${lead.id}`,
        startedAt: lead.firstFlaggedAt,
        target: { screen: VND3_SCREENS.lead, id: lead.id },
      }),
    );
  }

  private async hitRows(context: SourceContext): Promise<SourceRow[]> {
    const hits = await this.screening.alertable(context.tx);
    return hits.map((hit) =>
      this.row('VENDOR_SCREENING_HIT', hit.id, hit.hold ? 'SCREENING_HOLD' : 'SCREENING_HIT', context, {
        title: vnd3Fill(VND3_TEXT.home.screening_title, { source: hit.source, name: hit.contractorName }),
        subtitle: vnd3Fill(VND3_TEXT.home.screening_detail, { score: hit.score, basis: hit.basis.join(', '), hold: hit.hold ? VND3_TEXT.home.screening_hold : VND3_TEXT.home.screening_no_hold }),
        status: hit.status,
        dueOn: context.today,
        originalDueOn: hit.firstSeenAt.slice(0, 10),
        causeKey: `vendor-screening:${hit.id}`,
        startedAt: hit.firstSeenAt,
        target: { screen: VND3_SCREENS.screening, id: hit.id },
      }),
    );
  }
}
