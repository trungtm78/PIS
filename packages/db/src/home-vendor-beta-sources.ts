import { VENDOR_FACET_SEVERITY, VND2B_TEXT, vietnamDateOf, vnd2bText } from '@machvon/kernel';
import type { WorkKind } from '@machvon/kernel';
import { forAudience } from './home-integrity-sources.ts';
import { CONSEQUENCES, severityOf } from './home-work-rules.ts';
import { base } from './home-work-sources.ts';
import type { SourceContext, SourceRow } from './home-work-sources.ts';
import { VendorSecurityStore } from './vendor-security-store.ts';
import { VendorSubcontractStore } from './vendor-subcontract-store.ts';

/** The permissions the audiences of the alerts of bid security and subcontracts read them with, on the whole tenant (a register of contractors belongs to no unit). */
export const VENDOR_BETA_AUDIENCE_PERMISSIONS = { security: 'vnd.security.confirm', breach: 'vnd.subcontract.approve', payment: 'vnd.subcontract.pay' } as const;

const SECURITY_FACET = { FIRST: 'FIRST', SECOND: 'SECOND', EXPIRED: 'EXPIRED' } as const;

function row(kind: WorkKind, id: string, facet: string, context: SourceContext, fields: Pick<SourceRow, 'title' | 'subtitle' | 'status' | 'dueOn' | 'originalDueOn' | 'target'> & { causeKey: string }): SourceRow {
  return { ...base(kind), id, severity: severityOf('VENDOR', facet, context.rules) ?? VENDOR_FACET_SEVERITY[facet] ?? 'ACTION', consequence: CONSEQUENCES[kind] ?? null, ...fields };
}

/**
 * The alerts of bid security and subcontracts (VND-2, V10 and V11), read when the alert centre is read: a security in a warning window or past its last day (`VENDOR_SECURITY_EXPIRY`), an approved subcontract that is an
 * exception, was paid more than its value or whose subcontractor is under a restriction (`VENDOR_SUBCONTRACT_BREACH`), and a paid payment request whose payment to an approved subcontractor nobody recorded
 * (`VENDOR_SUB_PAYMENT_CONFIRM`, DUE_SOON and OVERDUE by the clock of the rule `VENDOR_SUBCONTRACT`).
 */
export async function betaVendorAlerts(context: SourceContext): Promise<SourceRow[]> {
  const out: SourceRow[] = [];
  const securities = await new VendorSecurityStore().alertable(context.tx, context.today);
  const expiry = securities.map((one) =>
    row('VENDOR_SECURITY_EXPIRY', one.id, SECURITY_FACET[one.expiryFacet as keyof typeof SECURITY_FACET] ?? 'FIRST', context, {
      title: vnd2bText(VND2B_TEXT.security_expiry_title, { no: one.securityNo, name: one.contractorName }),
      subtitle: vnd2bText(VND2B_TEXT.security_expiry_detail, { package: one.packageCode, until: one.validUntil, state: one.state }),
      status: one.expiryFacet ?? one.state,
      dueOn: one.validUntil,
      originalDueOn: one.validUntil,
      causeKey: `vendor-security:${one.id}`,
      target: { screen: 'VND-09', id: one.id },
    }),
  );
  out.push(...(await forAudience(context, 'VENDOR', VENDOR_BETA_AUDIENCE_PERMISSIONS.security, expiry, true)));

  const subcontracts = new VendorSubcontractStore();
  const breaches = (await subcontracts.breaches(context.tx, context.today)).map((one) =>
    row('VENDOR_SUBCONTRACT_BREACH', `${one.id}:${one.kind}`, 'OVERDUE', context, {
      title: vnd2bText(VND2B_TEXT.subcontract_breach_title, { name: one.subcontractorName, contract: one.contractCode }),
      subtitle: vnd2bText(VND2B_TEXT.subcontract_breach_detail, { kind: VND2B_TEXT.breach_kinds[one.kind], since: one.since }),
      status: one.kind,
      dueOn: context.today,
      originalDueOn: one.since,
      causeKey: `vendor-subcontract:${one.id}:${one.kind}`,
      target: { screen: 'VND-10', id: one.contractId },
    }),
  );
  out.push(...(await forAudience(context, 'VENDOR', VENDOR_BETA_AUDIENCE_PERMISSIONS.breach, breaches, true)));

  const pending = (await subcontracts.pending(context.tx, context.now)).filter((one) => one.clock === 'DUE_SOON' || one.clock === 'OVERDUE');
  const confirmations = pending.map((one) =>
    row('VENDOR_SUB_PAYMENT_CONFIRM', `${one.subcontractId}:${one.paymentRequestId}`, one.clock === 'OVERDUE' ? 'OVERDUE' : 'DUE_SOON', context, {
      title: vnd2bText(VND2B_TEXT.sub_payment_title, { name: one.subcontractorName, contract: one.contractCode }),
      subtitle: vnd2bText(VND2B_TEXT.sub_payment_detail, { paid: one.paidOn }),
      status: one.clock,
      dueOn: vietnamDateOf(context.now),
      originalDueOn: one.paidOn,
      causeKey: `vendor-sub-payment:${one.subcontractId}:${one.paymentRequestId}`,
      target: { screen: 'VND-10', id: one.contractId },
    }),
  );
  out.push(...(await forAudience(context, 'VENDOR', VENDOR_BETA_AUDIENCE_PERMISSIONS.payment, confirmations, true)));
  return out;
}
