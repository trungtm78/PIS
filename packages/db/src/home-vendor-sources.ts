import { VENDOR_FACET_SEVERITY, expiryAlertFacet, message, vietnamDateOf } from '@machvon/kernel';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import type { WorkKind } from '@machvon/kernel';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { HomeVendorControlsSources } from './home-vendor-controls-sources.ts';
import { VendorPayeeStore } from './vendor-payee-store.ts';
import { VendorPolicyReader } from './vendor-policy.ts';
import { VendorQualificationStore } from './vendor-qualification-store.ts';
import { VendorReputationStore } from './vendor-reputation-store.ts';
import { RestrictionCaseStore } from './vendor-restriction-store.ts';

/** The permissions each audience of the alerts of the contractor register reads them with (the owners of the alert types), on the whole tenant: a register of contractors belongs to no unit. */
export const VENDOR_AUDIENCE_PERMISSIONS = {
  exposure: 'vnd.restriction.propose',
  reputation: 'vnd.reputation.post',
  debarment: 'vnd.restriction.decide',
  payee: 'vnd.bank.approve',
  qualification: 'vnd.qualification.write',
} as const;

const severity = (facet: string, context: SourceContext): SourceRow['severity'] => severityOf('VENDOR', facet, context.rules) ?? VENDOR_FACET_SEVERITY[facet] ?? 'ACTION';

/**
 * The management of contractors as a source of the alert centre (VND-1; docs/vendor-management.md section 8). Five kinds, each with its ALERT_TYPE (owner, expected action, consequence; registered in the kernel):
 *  - `VENDOR_RESTRICTED_EXPOSURE` (V-A1, URGENT): a contractor under a restriction in force who still has a contract that is signed, active or suspended, or a payment request that is not settled.
 *  - `VENDOR_REPUTATION_POST` (V-A2): an event of bid conduct recorded and not posted, within the reminder window (ACTION) or past its 7 working days (URGENT).
 *  - `VENDOR_DEBARMENT_DECISION` (V-A3): a case with no decision, within the reminder window (ACTION) or past its time limit (URGENT).
 *  - `VENDOR_PAYEE_ACCOUNT` (V-A6): a change of account awaiting its approvals or its call-back (ACTION), and an account that two contractors hold (URGENT).
 *  - `VENDOR_QUALIFICATION_EXPIRY` (V-A8): a certificate or a member of the key staff in its first warning window (WATCH), its second (ACTION) or past its end (URGENT).
 * The time limits come from the rules (`VENDOR_DEBARMENT`, `EGP_POSTING_DEADLINES`, `VENDOR_EXPIRY_WARNING`) through `GovernancePolicyPort` and are counted when the list is read, so there is no job to run and nothing to fall behind.
 */
export class HomeVendorSources {
  private readonly policies = new VendorPolicyReader();
  private readonly cases = new RestrictionCaseStore();
  private readonly reputation = new VendorReputationStore();
  private readonly payee = new VendorPayeeStore();
  private readonly qualifications = new VendorQualificationStore();
  private readonly controls = new HomeVendorControlsSources();

  async items(context: SourceContext): Promise<SourceRow[]> {
    const now = context.now;
    const rows: SourceRow[] = [];
    rows.push(...(await forAudience(context, 'VENDOR', VENDOR_AUDIENCE_PERMISSIONS.exposure, await this.exposure(context), true)));
    rows.push(...(await forAudience(context, 'VENDOR', VENDOR_AUDIENCE_PERMISSIONS.reputation, await this.reputationPosts(context, now), true)));
    rows.push(...(await forAudience(context, 'VENDOR', VENDOR_AUDIENCE_PERMISSIONS.debarment, await this.decisions(context, now), true)));
    rows.push(...(await forAudience(context, 'VENDOR', VENDOR_AUDIENCE_PERMISSIONS.payee, await this.accounts(context), true)));
    rows.push(...(await forAudience(context, 'VENDOR', VENDOR_AUDIENCE_PERMISSIONS.qualification, await this.expiries(context), true)));
    rows.push(...(await this.controls.items(context)));
    return rows;
  }

  private row(kind: WorkKind, id: string, facet: string, context: SourceContext, fields: Pick<SourceRow, 'title' | 'subtitle' | 'status' | 'dueOn' | 'originalDueOn' | 'target'> & { startedAt?: string | null; causeKey: string }): SourceRow {
    return { ...base(kind), id, severity: severity(facet, context), consequence: CONSEQUENCES[kind] ?? null, ...fields };
  }

  /** Restricted contractors that still have exposure: the contracts and the payments a restriction does not stop by itself. */
  private async exposure(context: SourceContext): Promise<SourceRow[]> {
    const found = await context.tx.query<{ contractor_id: string; name: string; contracts: number; payments: number; since: string }>(
      `select c.id as contractor_id, c.legal_name as name,
              (select count(*) from machvon.contract k where k.tenant_id = c.tenant_id and (k.contractor_id = c.id or exists (select 1 from machvon.contract_party p where p.tenant_id = k.tenant_id and p.contract_id = k.id and p.contractor_id = c.id)) and k.status in ('SIGNED', 'ACTIVE', 'SUSPENDED'))::int as contracts,
              (select count(*) from machvon.payment_request pr join machvon.contract k on k.tenant_id = pr.tenant_id and k.id = pr.contract_id where k.tenant_id = c.tenant_id and k.contractor_id = c.id and pr.status in ('DRAFT', 'SUBMITTED', 'VERIFIED', 'SENT_TREASURY', 'RETURNED'))::int as payments,
              (select min(r.effective_from)::text from machvon.contractor_restriction r where r.tenant_id = c.tenant_id and r.contractor_id = c.id and r.lifted_at is null and r.effective_from <= $1::date and (r.effective_until is null or r.effective_until >= $1::date)) as since
         from machvon.contractor c
        where exists (select 1 from machvon.contractor_restriction r where r.tenant_id = c.tenant_id and r.contractor_id = c.id and r.lifted_at is null and r.effective_from <= $1::date and (r.effective_until is null or r.effective_until >= $1::date))
        order by c.legal_name, c.id`,
      [context.today],
    );
    return found
      .filter((row) => row.contracts + row.payments > 0)
      .map((row) =>
        this.row('VENDOR_RESTRICTED_EXPOSURE', row.contractor_id, 'EXPOSED', context, {
          title: message('home.source.vendor.exposure.title', { name: row.name }),
          subtitle: message('home.source.vendor.exposure.detail', { contracts: row.contracts, payments: row.payments, since: row.since }),
          status: 'EXPOSED',
          dueOn: context.today,
          originalDueOn: row.since,
          causeKey: `vendor-restriction:${row.contractor_id}`,
          startedAt: `${row.since}T00:00:00.000Z`,
          target: { screen: 'VND-02', id: row.contractor_id },
        }),
      );
  }

  private async reputationPosts(context: SourceContext, now: Date): Promise<SourceRow[]> {
    const events = await this.reputation.alertable(context.tx, now);
    return events.map((event) =>
      this.row('VENDOR_REPUTATION_POST', event.id, event.clock === 'OVERDUE' ? 'OVERDUE' : 'DUE_SOON', context, {
        title: message('home.source.vendor.reputation.title', { name: event.contractorName }),
        subtitle: message('home.source.vendor.reputation.detail', { due: vietnamDateOf(new Date(event.postDueAt)), behaviour: event.behaviourCode }),
        status: event.clock,
        dueOn: vietnamDateOf(new Date(event.postDueAt)),
        originalDueOn: vietnamDateOf(new Date(event.postDueAt)),
        causeKey: `vendor-reputation:${event.id}`,
        startedAt: event.recordedAt,
        target: { screen: 'VND-06', id: event.id },
      }),
    );
  }

  private async decisions(context: SourceContext, now: Date): Promise<SourceRow[]> {
    const cases = await this.cases.alertable(context.tx, now);
    return cases.map((one) =>
      this.row('VENDOR_DEBARMENT_DECISION', one.id, one.clock === 'OVERDUE' ? 'OVERDUE' : 'DUE_SOON', context, {
        title: message('home.source.vendor.debarment.title', { case: one.caseNo, name: one.subjectName }),
        subtitle: message('home.source.vendor.debarment.detail', { due: vietnamDateOf(new Date(one.decideBy)), status: one.status }),
        status: one.clock,
        dueOn: vietnamDateOf(new Date(one.decideBy)),
        originalDueOn: vietnamDateOf(new Date(one.decideBy)),
        causeKey: `vendor-case:${one.id}`,
        startedAt: one.receivedAt,
        target: { screen: 'VND-03', id: one.id },
      }),
    );
  }

  private async accounts(context: SourceContext): Promise<SourceRow[]> {
    const rows: SourceRow[] = [];
    const open = (await this.payee.requests(context.tx, { status: 'REQUESTED', limit: 500 })).filter((request) => Date.parse(request.expiresAt) >= context.now.getTime());
    for (const request of open) {
      rows.push(
        this.row('VENDOR_PAYEE_ACCOUNT', request.id, 'CHANGE_STALLED', context, {
          title: message('home.source.vendor.payee.title', { name: request.contractorName }),
          subtitle: message('home.source.vendor.payee.detail', { missing: request.remaining.join(', '), expires: vietnamDateOf(new Date(request.expiresAt)) }),
          status: 'REQUESTED',
          dueOn: vietnamDateOf(new Date(request.expiresAt)),
          originalDueOn: vietnamDateOf(new Date(request.expiresAt)),
          causeKey: `vendor-bank-change:${request.id}`,
          startedAt: request.requestedAt,
          target: { screen: 'VND-04', id: request.contractorId },
        }),
      );
    }
    for (const shared of await this.payee.sharedAccounts(context.tx)) {
      const names = await context.tx.query<{ legal_name: string }>('select legal_name from machvon.contractor where id = any($1::uuid[]) order by legal_name', [shared.contractorIds]);
      rows.push(
        this.row('VENDOR_PAYEE_ACCOUNT', `shared:${shared.accountNoKey.slice(0, 16)}`, 'SHARED_ACCOUNT', context, {
          title: message('home.source.vendor.shared.title', { count: shared.contractorIds.length }),
          subtitle: names.map((row) => row.legal_name).join(', ').slice(0, 200),
          status: 'SHARED_ACCOUNT',
          dueOn: context.today,
          originalDueOn: context.today,
          causeKey: `vendor-shared-account:${shared.accountNoKey.slice(0, 16)}`,
          target: { screen: 'VND-04', id: shared.contractorIds[0] as string },
        }),
      );
    }
    return rows;
  }

  private async expiries(context: SourceContext): Promise<SourceRow[]> {
    const qualification = (await this.policies.expiry(context.tx, 'QUALIFICATION', context.today)).value;
    const keyStaff = (await this.policies.expiry(context.tx, 'KEY_STAFF', context.today)).value;
    const items = await this.qualifications.expiring(context.tx, context.today, { qualification, keyStaff });
    return items.map((item) => {
      const facet = expiryAlertFacet(item.state) ?? 'FIRST';
      return this.row('VENDOR_QUALIFICATION_EXPIRY', item.id, facet, context, {
        title: message('home.source.vendor.qualification.title', { label: item.label, name: item.contractorName }),
        subtitle: message('home.source.vendor.qualification.detail', { expires: item.expiresOn }),
        status: item.state,
        dueOn: item.expiresOn,
        originalDueOn: item.expiresOn,
        causeKey: `vendor-expiry:${item.id}`,
        target: { screen: 'VND-05', id: item.contractorId },
      });
    });
  }
}
