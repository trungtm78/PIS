import { VND3_AUDIENCE_PERMISSIONS, VND3_FACET_SEVERITY, VND3_SCREENS, VND3_TEXT, vietnamDateOf, vnd3Fill } from '@machvon/kernel';
import type { WorkKind } from '@machvon/kernel';
import { forAudience } from './home-integrity-sources.ts';
import type { WorkSeverity } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { VendorPortalPolicyReader } from './vnd3-portal-policy.ts';
import { VendorPortalStore } from './vnd-portal-store.ts';
import { VendorReconfirmationStore } from './vnd-reconfirmation-store.ts';
import { VendorRemediationStore } from './vnd-remediation-store.ts';

const CONSEQUENCE: Readonly<Record<string, string>> = {
  VENDOR_RECONFIRM_OVERDUE: VND3_TEXT.alert.consequence.vendor_reconfirm,
  VENDOR_PORTAL_REQUEST: VND3_TEXT.alert.consequence.vendor_portal_request,
  VENDOR_REMEDIATION_ACTION: VND3_TEXT.alert.consequence.vendor_remediation,
};

const severity = (facet: string, context: SourceContext): WorkSeverity => context.rules.VENDOR?.[facet] ?? VND3_FACET_SEVERITY[facet] ?? 'ACTION';

/**
 * The alerts of the contractor portal as a source of the alert centre (VND-3; docs/vendor-investigation.md section 9), read when the list is read (no job): a re-confirmation that is due or past (V-A15, `VENDOR_RECONFIRM_OVERDUE`),
 * a request to a contractor that was answered and waits for review or is due soon or overdue (`VENDOR_PORTAL_REQUEST`), and an action of a plan of remediation that is due soon or overdue (`VENDOR_REMEDIATION_ACTION`).
 * Severity and consequence come from the alert types; the time limits from the rules `VENDOR_RECONFIRMATION`, `VENDOR_PORTAL` and `VENDOR_REMEDIATION`.
 */
export class HomeVendorPortalSources {
  private readonly policies = new VendorPortalPolicyReader();
  private readonly requests = new VendorPortalStore();
  private readonly reconfirmations = new VendorReconfirmationStore();
  private readonly remediation = new VendorRemediationStore();

  async items(context: SourceContext): Promise<SourceRow[]> {
    const rows: SourceRow[] = [];
    rows.push(...(await forAudience(context, 'VENDOR', VND3_AUDIENCE_PERMISSIONS.reconfirm, await this.reconfirm(context), true)));
    rows.push(...(await forAudience(context, 'VENDOR', VND3_AUDIENCE_PERMISSIONS.request, await this.portalRequests(context), true)));
    rows.push(...(await forAudience(context, 'VENDOR', VND3_AUDIENCE_PERMISSIONS.remediation, await this.remediationActions(context), true)));
    return rows;
  }

  private row(kind: WorkKind, id: string, facet: string, context: SourceContext, fields: Pick<SourceRow, 'title' | 'subtitle' | 'status' | 'dueOn' | 'originalDueOn' | 'target'> & { startedAt?: string | null; causeKey: string }): SourceRow {
    return { ...base(kind), id, severity: severity(facet, context), consequence: CONSEQUENCE[kind] ?? null, ...fields };
  }

  private async reconfirm(context: SourceContext): Promise<SourceRow[]> {
    const policy = await this.policies.reconfirmation(context.tx, context.today);
    const due = await this.reconfirmations.alertable(context.tx, context.today, policy.value);
    return due.map((line) =>
      this.row('VENDOR_RECONFIRM_OVERDUE', line.contractorId, line.facet === 'OVERDUE' ? 'RECONFIRM_OVERDUE' : 'RECONFIRM_DUE', context, {
        title: vnd3Fill(VND3_TEXT.home.reconfirm_title, { name: line.contractorName }),
        subtitle: vnd3Fill(VND3_TEXT.home.reconfirm_detail, { due: line.dueOn ?? context.today }),
        status: line.state,
        dueOn: line.dueOn,
        originalDueOn: line.dueOn,
        causeKey: `vendor-reconfirm:${line.contractorId}`,
        target: { screen: VND3_SCREENS.portalManage, id: line.contractorId },
      }),
    );
  }

  private async portalRequests(context: SourceContext): Promise<SourceRow[]> {
    const items = await this.requests.alertable(context.tx, context.now);
    return items.map((request) => {
      const facet = request.status === 'RESPONDED' ? 'REQUEST_ANSWERED' : request.clock === 'OVERDUE' ? 'REQUEST_OVERDUE' : 'REQUEST_DUE_SOON';
      const due = vietnamDateOf(new Date(request.dueAt));
      return this.row('VENDOR_PORTAL_REQUEST', request.id, facet, context, {
        title: vnd3Fill(VND3_TEXT.home.request_title, { kind: request.kind, name: request.contractorName }),
        subtitle: vnd3Fill(VND3_TEXT.home.request_detail, { due, status: request.status }),
        status: request.status === 'RESPONDED' ? 'RESPONDED' : request.clock,
        dueOn: request.status === 'RESPONDED' ? context.today : due,
        originalDueOn: due,
        causeKey: `vendor-portal-request:${request.id}`,
        startedAt: request.respondedAt ?? request.requestedAt,
        target: { screen: VND3_SCREENS.portalManage, id: request.id },
      });
    });
  }

  private async remediationActions(context: SourceContext): Promise<SourceRow[]> {
    const items = await this.remediation.alertable(context.tx, context.today);
    return items.map((action) =>
      this.row('VENDOR_REMEDIATION_ACTION', action.id, action.facet, context, {
        title: vnd3Fill(VND3_TEXT.home.remediation_title, { name: action.contractorName }),
        subtitle: vnd3Fill(VND3_TEXT.home.remediation_detail, { due: action.dueOn, action: action.description.slice(0, 120) }),
        status: action.facet,
        dueOn: action.dueOn,
        originalDueOn: action.dueOn,
        causeKey: `vendor-remediation:${action.id}`,
        target: { screen: VND3_SCREENS.remediation, id: action.planId },
      }),
    );
  }
}
