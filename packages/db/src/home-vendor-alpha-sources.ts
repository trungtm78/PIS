import { VND2A_TEXT } from '@machvon/kernel';
import type { WorkKind } from '@machvon/kernel';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { VendorFinanceStore } from './vendor-finance-store.ts';
import { VendorIndependenceStore } from './vendor-independence-store.ts';
import { VendorPolicyReader } from './vendor-policy.ts';

/** The permissions the audiences of these alerts read them with, on the whole tenant (a register of contractors belongs to no unit). */
export const VENDOR_ALPHA_AUDIENCE = { independence: 'vnd.independence.decide', capacity: 'vnd.independence.read' } as const;

const CAPACITY_CONTRACTORS = 100;

const row = (kind: WorkKind, id: string, facet: string, context: SourceContext, fields: Pick<SourceRow, 'title' | 'subtitle' | 'status' | 'dueOn' | 'originalDueOn' | 'target'> & { startedAt?: string | null; causeKey: string }): SourceRow => ({
  ...base(kind),
  id,
  severity: severityOf('VENDOR', facet, context.rules) ?? (facet === 'FINDING_STRONG' ? 'URGENT' : facet === 'SIGNAL' ? 'WATCH' : 'ACTION'),
  consequence: CONSEQUENCES[kind] ?? null,
  ...fields,
});

/**
 * The alerts of the independence, finance and load controls (VND-2, V5, V7, V9; docs/vendor-controls-independence-finance.md), read when the alert centre is read:
 *  - `VENDOR_INDEPENDENCE_FINDING`: a finding of the latest check of a package that nobody decided (STRONG is urgent, MEDIUM is to be acted on).
 *  - `VENDOR_CAPACITY_FINANCE`: a contractor with a bid received for a package that has no contract yet whose finance test is below the lines or whose load is over its capacity (a signal to watch, never a refusal).
 */
export async function alphaVendorAlerts(context: SourceContext): Promise<SourceRow[]> {
  const out: SourceRow[] = [];
  const independence = new VendorIndependenceStore();
  const open = await independence.openFindings(context.tx);
  const findings = open.map((one) =>
    row('VENDOR_INDEPENDENCE_FINDING', one.id, one.strength === 'STRONG' ? 'FINDING_STRONG' : 'FINDING_MEDIUM', context, {
      title: VND2A_TEXT.findingTitle(one.packageCode, one.kind),
      subtitle: VND2A_TEXT.findingDetail(one.strength, one.raisedAt.slice(0, 10)),
      status: 'OPEN',
      dueOn: context.today,
      originalDueOn: one.raisedAt.slice(0, 10),
      causeKey: `vendor-independence:${one.id}`,
      startedAt: one.raisedAt,
      target: { screen: 'VND-07', id: one.packageId },
    }),
  );
  out.push(...(await forAudience(context, 'VENDOR', VENDOR_ALPHA_AUDIENCE.independence, findings, true)));

  const policies = new VendorPolicyReader();
  const finance = new VendorFinanceStore();
  const candidates = await context.tx.query<{ id: string; name: string }>(
    `select c.id, c.legal_name as name from machvon.contractor c
      where exists (select 1 from machvon.proposal x where x.tenant_id = c.tenant_id and x.contractor_id = c.id and x.status = 'RECEIVED'
                      and not exists (select 1 from machvon.contract k where k.tenant_id = x.tenant_id and k.package_id = x.package_id))
      order by c.legal_name, c.id limit $1`,
    [CAPACITY_CONTRACTORS],
  );
  if (candidates.length > 0) {
    const financePolicy = await policies.finance(context.tx, context.today);
    const capacityPolicy = await policies.capacity(context.tx, context.today);
    const signals: SourceRow[] = [];
    for (const one of candidates) {
      const reading = await finance.assessFor(context.tx, one.id, undefined, financePolicy);
      const capacity = await finance.capacity(context.tx, one.id, context.today, financePolicy, capacityPolicy);
      if (reading.assessment.overall !== 'BELOW' && capacity.assessment.status !== 'OVER') continue;
      signals.push(
        row('VENDOR_CAPACITY_FINANCE', one.id, 'SIGNAL', context, {
          title: VND2A_TEXT.capacityTitle(one.name),
          subtitle: VND2A_TEXT.capacityDetail(VND2A_TEXT.financeLabel[reading.assessment.overall] ?? reading.assessment.overall, VND2A_TEXT.loadLabel[capacity.assessment.status] ?? capacity.assessment.status),
          status: 'SIGNAL',
          dueOn: context.today,
          originalDueOn: context.today,
          causeKey: `vendor-capacity:${one.id}`,
          target: { screen: 'VND-08', id: one.id },
        }),
      );
    }
    out.push(...(await forAudience(context, 'VENDOR', VENDOR_ALPHA_AUDIENCE.capacity, signals, true)));
  }
  return out;
}
