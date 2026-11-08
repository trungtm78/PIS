import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { linesOf, projectOf } from '../procurement-finance/bid.ts';
import { CHECKER, LEADER, MAKER, ACCOUNTANT, paper } from '../procurement-finance/shared.ts';
import { ADVANCE_PACKAGE } from './public-contracts.ts';
import { clipPlan, clipText } from './plan.ts';

/**
 * Group `clip-public-payments`: measurement, acceptance, payment and advance of the active contracts, through the real commands (the Treasury forms are the DEMO templates of the
 * payment forms, stamped as demo). It runs in two stages, at two clocks of the stack (see DATASET_PHASES):
 *  - stage SEND, with the clock in the past: the officer measures the work, the leader approves the measurement, an acceptance is made and approved by a second person, the
 *    payment request is drawn up, checked by the accountant, its Treasury forms are drawn and it is SENT to the Treasury. The contract of the advance takes an advance of the
 *    ground clearance kind: its request is paid at once, with a confirmation dated long ago, so the advance stands over its recovery deadline when the clock comes back.
 *    The payment of the other contract stays sent and unconfirmed, so its payment clock runs out.
 *  - stage CLOSE, on the real day: the payment of the first contract is confirmed by the Treasury and matched, so it is settled.
 * Persons: the officer makes and sends nothing that he checks; the accountant checks, sends and matches; the leader approves; the owner is the second person of an acceptance.
 */

interface PaymentsBlock {
  place: string;
  formCodes: string[];
  invoicePrefix: string;
  advanceNote: string;
  stageSendClock: number;
}

const CONTRACT_PREFIX = 'HD-';

async function activeContract(ctx: SeedContext, packageCode: string): Promise<Obj | undefined> {
  const found = await ctx.find(MAKER, '/resources/contract', (row) => row.code === `${CONTRACT_PREFIX}${packageCode}`);
  return found !== undefined && found.status === 'ACTIVE' ? found : undefined;
}

async function reportingPeriodId(ctx: SeedContext, fiscalYear: number): Promise<string | undefined> {
  await ctx.attempt(MAKER, 'POST', '/reporting-periods/generate', { calendar_code: 'DEFAULT', fiscal_year: fiscalYear, period_type: 'MONTH' });
  const periods = await ctx.list<Obj>(MAKER, '/resources/reporting_period');
  const month = periods.filter((row) => row.period_type === 'MONTH' && Number(row.fiscal_year) === fiscalYear).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))[0];
  return month === undefined ? undefined : String(month.id);
}

/** A measurement of the work, approved; an acceptance made from it, submitted and approved by a second person. Returns the acceptance id. */
async function measuredAndAccepted(ctx: SeedContext, contract: Obj, periodId: string, tag: string): Promise<string | undefined> {
  const contractId = String(contract.id);
  const revision = (await ctx.list<Obj>(MAKER, '/resources/contract_revision')).find((row) => String(row.contract_id) === contractId);
  const line = (await ctx.list<Obj>(MAKER, '/resources/boq_line', { contract_id: contractId }))[0];
  if (revision === undefined || line === undefined) {
    ctx.warn(`the contract ${String(contract.code)} has no revision or bill of quantities`);
    return undefined;
  }
  const evidence = await paper(ctx, { symbol: `NT-${tag}/2026`, title: clipText('pay.measurementPaper', tag), docType: 'BB', sender: clipText('pay.supervisor'), issuedOn: ctx.day(-3) });
  const measured = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${contractId}/measurements`, {
    contract_revision_id: String(revision.id),
    boq_item_id: String(line.id),
    period_id: periodId,
    quantity_period: '300',
    reference_no: `KL-${tag}`,
    evidence_refs: [{ document_version_id: evidence.versionId }],
  });
  if (!measured.ok) return undefined;
  const id = measured.json.resource_id;
  const sent = await ctx.attempt<CommandReply>(MAKER, 'POST', `/measurements/${id}/submit`, {}, { version: measured.json.resource_version });
  if (!sent.ok) return undefined;
  const approved = await ctx.attempt(LEADER, 'POST', `/measurements/${id}/decision`, { decision: 'approve', reason: clipText('pay.measurementReason'), evidence_ids: [] }, { version: sent.json.resource_version });
  if (!approved.ok) return undefined;
  const document = await paper(ctx, { symbol: `BBNT-${tag}/2026`, title: clipText('pay.acceptancePaper', tag), docType: 'BB', sender: clipText('pay.supervisor'), issuedOn: ctx.day(-2) });
  const acceptance = await ctx.attempt<CommandReply>(LEADER, 'POST', `/contracts/${contractId}/acceptances`, { measurement_ids: [id], period_id: periodId, document_version_id: document.versionId });
  if (!acceptance.ok) return undefined;
  const submitted = await ctx.attempt<CommandReply>(LEADER, 'POST', `/acceptances/${acceptance.json.resource_id}/submit`, { signer_refs: [{ name: clipText('pay.investorRep'), role: 'INVESTOR' }] }, { version: acceptance.json.resource_version });
  if (!submitted.ok) return undefined;
  const decided = await ctx.attempt(CHECKER, 'POST', `/acceptances/${acceptance.json.resource_id}/decision`, { decision: 'approve', reason: clipText('pay.acceptanceReason'), evidence_ids: [] }, { version: submitted.json.resource_version });
  return decided.ok ? acceptance.json.resource_id : undefined;
}

interface Drawn {
  id: string;
  gross: string;
  net: string;
}

/** The request is drawn up by the officer, its invoice attached, submitted; the accountant checks it, draws the forms and sends it to the Treasury. */
async function sentToTreasury(ctx: SeedContext, block: PaymentsBlock, body: Record<string, unknown>, tag: string, treasuryRef: string): Promise<Drawn | undefined> {
  const made = await ctx.attempt<Obj>(MAKER, 'POST', '/payment-requests', body);
  if (!made.ok) return undefined;
  const id = String(made.json.resource_id);
  const invoice = await paper(ctx, { symbol: `${block.invoicePrefix}-${tag}`, title: clipText('pay.invoicePaper', tag), docType: 'HD', sender: clipText('pay.contractor'), issuedOn: ctx.day(-2) });
  await ctx.attempt(MAKER, 'POST', `/payment-requests/${id}/documents`, { document_version_id: invoice.versionId, doc_kind: 'INVOICE', invoice_no: `${block.invoicePrefix}-${tag}`, invoice_date: ctx.day(-2), signed: true });
  const detail = await ctx.get<Obj>(MAKER, `/resources/payment_request/${id}`);
  const gross = String(detail.gross_vnd ?? asObj(made.json).gross_vnd ?? '0');
  const net = String(detail.net_vnd ?? asObj(made.json).net_vnd ?? '0');
  const submitted = await ctx.attempt<CommandReply>(MAKER, 'POST', `/payment-requests/${id}/submit`, { expected_gross_vnd: gross, expected_net_vnd: net }, { version: Number(detail.version) });
  if (!submitted.ok) return undefined;
  const verified = await ctx.attempt<CommandReply>(ACCOUNTANT, 'POST', `/payment-requests/${id}/verify`, {}, { version: submitted.json.resource_version });
  if (!verified.ok) return undefined;
  const forms = await ctx.attempt(ACCOUNTANT, 'POST', `/payment-requests/${id}/forms`, { form_codes: block.formCodes, place: block.place }, { version: verified.json.resource_version });
  if (!forms.ok) return undefined;
  const listed = await ctx.get<Obj>(ACCOUNTANT, `/payment-requests/${id}/forms`);
  const instances = ((listed.items ?? listed.forms ?? []) as Obj[]).map((row) => String(row.id));
  const current = await ctx.get<Obj>(ACCOUNTANT, `/resources/payment_request/${id}`);
  const sent = await ctx.attempt(ACCOUNTANT, 'POST', `/payment-requests/${id}/send-treasury`, { treasury_submitted_on: ctx.today, treasury_ref: treasuryRef, form_instance_ids: instances }, { version: Number(current.version) });
  return sent.ok ? { id, gross, net } : undefined;
}

/** The Treasury confirms the payment on a day, and the accountant matches the transaction to the request, which settles it. */
async function confirmedAndMatched(ctx: SeedContext, drawn: Drawn, confirmedOn: string, tag: string): Promise<boolean> {
  const evidence = await paper(ctx, { symbol: `KB-${tag}`, title: clipText('pay.treasuryPaper', tag), docType: 'BB', sender: clipText('pay.treasury'), issuedOn: confirmedOn });
  const confirmed = await ctx.attempt<CommandReply>(ACCOUNTANT, 'POST', '/treasury-transactions', {
    payment_request_id: drawn.id,
    document_no: `KB-${tag}`,
    document_date: confirmedOn,
    amount_vnd: drawn.net,
    confirmed_at: `${confirmedOn}T03:00:00.000Z`,
    evidence_document_version_id: evidence.versionId,
  });
  if (!confirmed.ok) return false;
  const matched = await ctx.attempt(ACCOUNTANT, 'POST', `/treasury-transactions/${confirmed.json.resource_id}/match`, { payment_request_id: drawn.id }, { version: confirmed.json.resource_version });
  return matched.ok;
}

async function interimPayment(ctx: SeedContext, block: PaymentsBlock, packageCode: string, periodId: string, settle: boolean): Promise<void> {
  const contract = await activeContract(ctx, packageCode);
  if (contract === undefined) {
    ctx.warn(`the contract of ${packageCode} is not active: no payment`);
    return;
  }
  const requestNo = `DNTT-${packageCode}-01`;
  const known = (await ctx.list<Obj>(MAKER, '/resources/payment_request')).find((row) => row.request_no === requestNo);
  if (known !== undefined) return;
  const project = await projectOf(ctx, String(asObj(contract).project_code ?? ''));
  const lines = await linesOf(ctx, String(contract.project_id ?? project?.id));
  const acceptance = await measuredAndAccepted(ctx, contract, periodId, packageCode);
  const line = lines[0];
  if (acceptance === undefined || line === undefined) return;
  const drawn = await sentToTreasury(ctx, block, { contract_id: String(contract.id), request_kind: 'INTERIM', acceptance_id: acceptance, allocation_line_id: String(line.id), request_no: requestNo }, packageCode, `KB-${packageCode}`);
  if (drawn === undefined) return;
  ctx.record({ module: 'PAY', screen: 'PAY-01', kind: 'payment-request', id: drawn.id, code: requestNo, note: settle ? 'sent, to be settled' : 'sent and waiting for the Treasury' });
}

async function advancePayment(ctx: SeedContext, block: PaymentsBlock): Promise<void> {
  const contract = await activeContract(ctx, ADVANCE_PACKAGE);
  if (contract === undefined) return;
  const requestNo = `DNTT-${ADVANCE_PACKAGE}-TU`;
  if ((await ctx.list<Obj>(MAKER, '/resources/payment_request')).some((row) => row.request_no === requestNo)) return;
  const detail = await ctx.get<Obj>(MAKER, `/resources/contract/${String(contract.id)}`);
  const party = ((detail.parties ?? []) as Obj[])[0];
  const line = (await linesOf(ctx, String(contract.project_id)))[0];
  if (party === undefined || line === undefined) {
    ctx.warn('the contract of the advance has no party or no line of capital');
    return;
  }
  const value = Number(detail.contract_value_vnd ?? contract.contract_value_vnd);
  if (!Number.isFinite(value) || value <= 0) {
    ctx.warn('the contract of the advance has no readable value');
    return;
  }
  const amount = String(Math.floor(value * 0.1));
  const advance = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${String(contract.id)}/advances`, { party_id: String(party.id), kind: 'GPMB', amount_vnd: amount, allocation_line_id: String(line.id) });
  if (!advance.ok) return;
  const drawn = await sentToTreasury(ctx, block, { contract_id: String(contract.id), request_kind: 'ADVANCE', advance_id: advance.json.resource_id, allocation_line_id: String(line.id), request_no: requestNo }, 'TU', 'KB-TU');
  if (drawn === undefined) return;
  // Paid long ago: the recovery deadline (thirty days after the payment) has passed when the clock comes back.
  const paid = await confirmedAndMatched(ctx, drawn, ctx.day(-45), 'TU');
  ctx.record({ module: 'PAY', screen: 'PAY-05', kind: 'advance', id: advance.json.resource_id, code: requestNo, note: paid ? 'paid long ago, recovery overdue when the clock returns' : 'sent' });
}

export async function seedClipPayments(ctx: SeedContext): Promise<void> {
  const block = (clipPlan()?.payments ?? undefined) as PaymentsBlock | undefined;
  if (block === undefined) {
    ctx.warn('no clip plan with a payments block: nothing to do');
    return;
  }
  const stage = process.env.CLIP_PAY_STAGE ?? 'SEND';
  const periodId = await reportingPeriodId(ctx, Number(ctx.today.slice(0, 4)));
  if (stage === 'SEND') {
    if (periodId === undefined) {
      ctx.warn('no reporting period: no measurement');
      return;
    }
    await ctx.step('PAY', 'payment of the first contract sent to the Treasury', () => interimPayment(ctx, block, 'DT205-XL01', periodId, true));
    await ctx.step('PAY', 'payment of the second contract sent and left waiting', () => interimPayment(ctx, block, 'NN031-XL01', periodId, false));
    await ctx.step('PAY', 'advance paid long ago', () => advancePayment(ctx, block));
    return;
  }
  // CLOSE: the Treasury confirms the first payment (the sent request of the earlier stage).
  await ctx.step('PAY', 'the Treasury confirms the first payment', async () => {
    const request = (await ctx.list<Obj>(ACCOUNTANT, '/resources/payment_request')).find((row) => row.request_no === 'DNTT-DT205-XL01-01' && row.status === 'SENT_TREASURY');
    if (request === undefined) return;
    await confirmedAndMatched(ctx, { id: String(request.id), gross: String(request.gross_vnd), net: String(request.net_vnd) }, ctx.day(-1), 'DT205-XL01');
  });
}
