import { asObj } from '../context.ts';
import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { linesOf } from '../procurement-finance/bid.ts';
import { ACCOUNTANT, CHECKER, LEADER, MAKER, paper } from '../procurement-finance/shared.ts';
import TEXTS from '../data/enterprise-execution.json' with { type: 'json' };
import { textsOf } from '../../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * Group `clip-ent-execution`: the performance of the active contracts of the enterprise dataset, told over time as a real contract grows (CTR-06, 07, 08, 10, 12, 13, 19, 21, 27, 32/33 and PAY).
 *
 *  - stage A (the clock a few days after the contracts took effect): the advance of each contract that can take one is guaranteed (bank guarantee verified by a second person), planned, asked for and
 *    paid, with the recovery plan that follows from the rule of the category;
 *  - stage B (the clock early October): the work of September is measured (approved by the leader), accepted (approved by a second person), the payment request is drawn up by the officer, checked by the
 *    accountant, its forms drawn and sent to the bank, and the bank confirms it: the request is settled and the advance starts to be recovered, the retention is held;
 *  - stage C (the real day): the work of October is measured, accepted, requested and sent (the bank has not answered yet), the work of November is measured and its acceptance waits for a second person;
 *    then the chains of changes (event, price, order): on HD-PMDT105-XL01 a cut approved (in force in three days) and an increase (tier 2) covered by a drawdown of the contingency of the project and approved to take effect in ten days,
 *    a request waiting at each tier on other contracts and one withdrawn, and the claim for delay damages of the equipment contract (its term approved by a second person).
 * DATASET_PHASES runs stage A at -46 days and stage B at -36 days (env CLIP_EXEC_STAGE), stage C at the real day. With no stage asked (CLIP_EXEC_STAGE unset) the three run one after the other at the clock of the stack,
 * so one `apply --groups clip-ent-execution` gives the whole story (dates then fall on one day) and the real-day phase also completes whatever an earlier stage left half done.
 * Every step asks first and skips what exists, so a second run does nothing twice.
 *
 * A payment is made to a party of the contract, and only a joint venture has parties (the product's rule: PARTY_REQUIRED otherwise). Payments and advances are therefore made on the contracts that have a party;
 * the measurements, acceptances, changes and claims do not need one and are made on all of them.
 * Persons: the officer measures, drafts and sends nothing he checks; the leader approves a measurement and draws up the acceptance; the owner is the second person (acceptance, evaluation, guarantee, terms); the accountant checks, draws the forms, sends and matches.
 */

const ACCEPTANCE_DECIDER = CHECKER;
const FORM_CODES = ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT'];
const STAGE = (process.env.CLIP_EXEC_STAGE ?? 'ALL').toUpperCase();
const runs = (stage: 'A' | 'B' | 'C'): boolean => STAGE === 'ALL' || STAGE === stage;

const TARGETS = ['HD-PMDT105-XL01', 'HD-PMDT105-XL02', 'HD-PMDT105-TV01', 'HD-PMDT114-XL01', 'HD-PMDT114-XL02', 'HD-PMDT114-TV01', 'HD-PMTB164-TB01', 'HD-PMTB168-TB01'];

/** What each contract does over the periods: the quantity measured per mille of the bill (the bill has one line of 1000), by month, and the advance as a percent of the work of the lead. */
interface Course {
  /** Quantity (of 1000) measured in the months of September, October and November. */
  qty: [number, number, number];
  advancePct?: number;
}
const COURSES: Record<string, Course> = {
  'HD-PMDT105-XL01': { qty: [40, 85, 60], advancePct: 15 },
  'HD-PMDT105-XL02': { qty: [25, 60, 35], advancePct: 15 },
  'HD-PMDT105-TV01': { qty: [80, 90, 70], advancePct: 20 },
  'HD-PMDT114-XL01': { qty: [30, 70, 45], advancePct: 15 },
  'HD-PMDT114-XL02': { qty: [0, 40, 30], advancePct: 15 },
  'HD-PMDT114-TV01': { qty: [100, 100, 80], advancePct: 20 },
  'HD-PMTB164-TB01': { qty: [0, 300, 0] },
  'HD-PMTB168-TB01': { qty: [0, 250, 100] },
};

// ---- reads -------------------------------------------------------------------------------------------------------------------------------

interface ContractFacts {
  row: Obj;
  id: string;
  code: string;
  revisionId: string;
  boqItemId: string;
  unitPrice: string;
  boqDescription: string;
  parties: Obj[];
  lead?: Obj;
}

async function contractFacts(ctx: SeedContext, code: string): Promise<ContractFacts | undefined> {
  const row = await ctx.find(MAKER, '/resources/contract', (candidate) => candidate.code === code);
  if (row === undefined || row.status !== 'ACTIVE') return undefined;
  const id = String(row.id);
  const detail = await ctx.get<Obj>(MAKER, `/resources/contract/${id}`);
  const revisions = (detail.revisions ?? []) as Obj[];
  const inForce = revisions.find((revision) => revision.status === 'EFFECTIVE') ?? revisions[0];
  const line = (await ctx.list<Obj>(MAKER, '/resources/boq_line', { contract_id: id })).find((candidate) => String(candidate.contract_revision_id) === String(inForce?.id));
  if (inForce === undefined || line === undefined) {
    ctx.warn(`the contract ${code} has no revision in force or no bill of quantities`);
    return undefined;
  }
  const parties = ((detail.parties ?? []) as Obj[]).filter((party) => party.status === undefined || party.status === 'ACTIVE');
  return { row, id, code, revisionId: String(inForce.id), boqItemId: String(line.boq_item_id), unitPrice: String(line.unit_price), boqDescription: String(line.description), parties, lead: parties.find((party) => party.role === 'LEAD') };
}

async function periodId(ctx: SeedContext, month: number): Promise<string | undefined> {
  const code = `M${ctx.year}-${String(month).padStart(2, '0')}`;
  const found = await ctx.find(MAKER, '/resources/reporting_period', (row) => row.code === code);
  if (found === undefined) ctx.warn(`the period ${code} does not exist`);
  return found === undefined ? undefined : String(found.id);
}

// ---- measurement, acceptance ---------------------------------------------------------------------------------------------------------------

type Settled = { acceptanceId?: string; measurementId?: string; amountVnd?: string };

/** One month of work of a contract: measured (officer), approved (leader), accepted (leader draws up and sends, the owner approves). `accept` false leaves the acceptance as a draft sent and waiting. */
async function workOfMonth(ctx: SeedContext, facts: ContractFacts, month: number, quantity: number, accept: boolean): Promise<Settled> {
  const tag = `${facts.code.replace('HD-', '')}-T${String(month).padStart(2, '0')}`;
  const period = await periodId(ctx, month);
  if (period === undefined || quantity <= 0) return {};
  const known = (await ctx.list<Obj>(MAKER, '/resources/measurement', { contract_id: facts.id })).find((row) => row.reference_no === `KL-${tag}` && row.status !== 'REJECTED');
  let measurementId: string | undefined = known === undefined ? undefined : String(known.id);
  let status = known === undefined ? 'NEW' : String(known.status);
  if (known === undefined) {
    const evidence = await paper(ctx, { symbol: `XNKL-${tag}/2026`, title: tx('measurement.paper', facts.code, `${String(month).padStart(2, '0')}/${ctx.year}`), docType: 'BB', sender: tx('supervisor'), issuedOn: ctx.day(-1) });
    const made = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${facts.id}/measurements`, {
      contract_revision_id: facts.revisionId,
      boq_item_id: facts.boqItemId,
      period_id: period,
      quantity_period: String(quantity),
      reference_no: `KL-${tag}`,
      ...(facts.lead === undefined ? {} : { party_id: String(facts.lead.id) }),
      evidence_refs: [{ document_version_id: evidence.versionId }],
    });
    if (!made.ok) return {};
    measurementId = made.json.resource_id;
    const sent = await ctx.attempt<CommandReply>(MAKER, 'POST', `/measurements/${measurementId}/submit`, {}, { version: made.json.resource_version });
    if (!sent.ok) return { measurementId };
    const approved = await ctx.attempt(LEADER, 'POST', `/measurements/${measurementId}/decision`, { decision: 'approve', reason: tx('measurement.reason'), evidence_ids: [] }, { version: sent.json.resource_version });
    if (!approved.ok) return { measurementId };
    status = 'APPROVED';
  }
  if (known !== undefined && (status === 'DRAFT' || status === 'SUBMITTED')) {
    let version = Number(known.version);
    if (status === 'DRAFT') {
      const sent = await ctx.attempt<CommandReply>(MAKER, 'POST', `/measurements/${measurementId}/submit`, {}, { version });
      if (!sent.ok) return { measurementId };
      version = sent.json.resource_version;
    }
    const approved = await ctx.attempt(LEADER, 'POST', `/measurements/${measurementId}/decision`, { decision: 'approve', reason: tx('measurement.reason'), evidence_ids: [] }, { version });
    if (!approved.ok) return { measurementId };
    status = 'APPROVED';
  }
  if (measurementId === undefined || status !== 'APPROVED') return { measurementId };
  const acceptances = await ctx.list<Obj>(LEADER, '/resources/acceptance', { contract_id: facts.id });
  const mine = acceptances.find((row) => row.status !== 'REJECTED' && row.status !== 'REVOKED' && ((row.lines ?? []) as Obj[]).some((line) => String(line.measurement_id) === measurementId));
  if (mine !== undefined) {
    if (mine.status === 'APPROVED') return { measurementId, acceptanceId: String(mine.id), amountVnd: String(mine.accepted_amount_vnd ?? '') };
    if (!accept) return { measurementId };
    // An acceptance left half way by an earlier run: sent if it is still a draft, then decided by the second person.
    let version = Number(mine.version);
    if (mine.status === 'DRAFT') {
      const sent = await ctx.attempt<CommandReply>(LEADER, 'POST', `/acceptances/${String(mine.id)}/submit`, { signer_refs: [{ name: tx('investorRep'), role: 'INVESTOR' }] }, { version });
      if (!sent.ok) return { measurementId };
      version = sent.json.resource_version;
    }
    const decided = await ctx.attempt(ACCEPTANCE_DECIDER, 'POST', `/acceptances/${String(mine.id)}/decision`, { decision: 'approve', reason: tx('acceptance.reason'), evidence_ids: [] }, { version });
    return decided.ok ? { measurementId, acceptanceId: String(mine.id) } : { measurementId };
  }
  if (!accept) {
    const drawn = await drawAcceptance(ctx, facts, measurementId, period, tag, month);
    if (drawn !== undefined) await ctx.attempt(LEADER, 'POST', `/acceptances/${drawn.id}/submit`, { signer_refs: [{ name: tx('investorRep'), role: 'INVESTOR' }] }, { version: drawn.version });
    return { measurementId };
  }
  const drawn = await drawAcceptance(ctx, facts, measurementId, period, tag, month);
  if (drawn === undefined) return { measurementId };
  const submitted = await ctx.attempt<CommandReply>(LEADER, 'POST', `/acceptances/${drawn.id}/submit`, { signer_refs: [{ name: tx('investorRep'), role: 'INVESTOR' }] }, { version: drawn.version });
  if (!submitted.ok) return { measurementId };
  const decided = await ctx.attempt(ACCEPTANCE_DECIDER, 'POST', `/acceptances/${drawn.id}/decision`, { decision: 'approve', reason: tx('acceptance.reason'), evidence_ids: [] }, { version: submitted.json.resource_version });
  return decided.ok ? { measurementId, acceptanceId: drawn.id } : { measurementId };
}

async function drawAcceptance(ctx: SeedContext, facts: ContractFacts, measurementId: string, period: string, tag: string, month: number): Promise<{ id: string; version: number } | undefined> {
  const document = await paper(ctx, { symbol: `BBNT-${tag}/2026`, title: tx('acceptance.paper', facts.code, `${String(month).padStart(2, '0')}/${ctx.year}`), docType: 'BB', sender: tx('supervisor'), issuedOn: ctx.day(0) });
  const made = await ctx.attempt<CommandReply>(LEADER, 'POST', `/contracts/${facts.id}/acceptances`, { measurement_ids: [measurementId], period_id: period, document_version_id: document.versionId });
  return made.ok ? { id: made.json.resource_id, version: made.json.resource_version } : undefined;
}

// ---- payments ----------------------------------------------------------------------------------------------------------------------------

async function requestByNo(ctx: SeedContext, requestNo: string): Promise<Obj | undefined> {
  return ctx.find(MAKER, '/resources/payment_request', (row) => row.request_no === requestNo);
}

/** Takes a payment request as far as its story goes, from whatever state it is in: the officer attaches the invoice and sends it for checking, the accountant checks it, draws the forms and sends it to the bank; the bank confirms it when `settle`. */
async function drive(ctx: SeedContext, requestId: string, tag: string, settle: boolean): Promise<string> {
  for (let round = 0; round < 8; round += 1) {
    const row = await ctx.get<Obj>(MAKER, `/resources/payment_request/${requestId}`);
    const status = String(row.status);
    const version = Number(row.version);
    const gross = String(row.gross_vnd ?? '0');
    const net = String(row.net_vnd ?? '0');
    if (status === 'DRAFT' || status === 'RETURNED') {
      if (status === 'DRAFT') {
        const invoice = await paper(ctx, { symbol: `HDDT-${tag}`, title: tx('invoice.paper', tag), docType: 'HD', sender: tx('bank'), issuedOn: ctx.day(-1) });
        await ctx.attempt(MAKER, 'POST', `/payment-requests/${requestId}/documents`, { document_version_id: invoice.versionId, doc_kind: 'INVOICE', invoice_no: `HDDT-${tag}`, invoice_date: ctx.day(-1), signed: true });
      }
      const current = await ctx.get<Obj>(MAKER, `/resources/payment_request/${requestId}`);
      const sent = await ctx.attempt(MAKER, 'POST', `/payment-requests/${requestId}/submit`, { expected_gross_vnd: gross, expected_net_vnd: net }, { version: Number(current.version) });
      if (!sent.ok) return status;
    } else if (status === 'SUBMITTED') {
      const verified = await ctx.attempt(ACCOUNTANT, 'POST', `/payment-requests/${requestId}/verify`, {}, { version });
      if (!verified.ok) return status;
    } else if (status === 'VERIFIED') {
      let listed = await ctx.get<Obj>(ACCOUNTANT, `/payment-requests/${requestId}/forms`);
      let instances = ((listed.items ?? listed.forms ?? []) as Obj[]).map((candidate) => String(candidate.id));
      if (instances.length === 0) {
        const forms = await ctx.attempt(ACCOUNTANT, 'POST', `/payment-requests/${requestId}/forms`, { form_codes: FORM_CODES, place: tx('place') }, { version });
        if (!forms.ok) return status;
        listed = await ctx.get<Obj>(ACCOUNTANT, `/payment-requests/${requestId}/forms`);
        instances = ((listed.items ?? listed.forms ?? []) as Obj[]).map((candidate) => String(candidate.id));
      }
      const current = await ctx.get<Obj>(ACCOUNTANT, `/resources/payment_request/${requestId}`);
      const sent = await ctx.attempt(ACCOUNTANT, 'POST', `/payment-requests/${requestId}/send-treasury`, { treasury_submitted_on: ctx.today, treasury_ref: `NH-${tag}`, form_instance_ids: instances }, { version: Number(current.version) });
      if (!sent.ok) return status;
    } else if (status === 'SENT_TREASURY') {
      if (settle) await confirmedAndMatched(ctx, { id: requestId, net }, tag);
      return String((await ctx.get<Obj>(MAKER, `/resources/payment_request/${requestId}`)).status);
    } else {
      return status;
    }
  }
  return 'UNFINISHED';
}

/** The bank confirms the payment and the accountant matches the transaction to the request: the request is settled. */
async function confirmedAndMatched(ctx: SeedContext, drawn: { id: string; net: string }, tag: string): Promise<boolean> {
  const evidence = await paper(ctx, { symbol: `NH-${tag}`, title: tx('treasury.paper', tag), docType: 'BB', sender: tx('treasury.sender'), issuedOn: ctx.today });
  const confirmed = await ctx.attempt<CommandReply>(ACCOUNTANT, 'POST', '/treasury-transactions', {
    payment_request_id: drawn.id,
    document_no: `NH-${tag}`,
    document_date: ctx.today,
    amount_vnd: drawn.net,
    confirmed_at: new Date(ctx.asOf.getTime() - 60_000).toISOString(),
    evidence_document_version_id: evidence.versionId,
  });
  if (!confirmed.ok) return false;
  const matched = await ctx.attempt(ACCOUNTANT, 'POST', `/treasury-transactions/${confirmed.json.resource_id}/match`, { payment_request_id: drawn.id }, { version: confirmed.json.resource_version });
  return matched.ok;
}

async function allocationLine(ctx: SeedContext, facts: ContractFacts): Promise<string | undefined> {
  const projectId = String(facts.row.project_id);
  const line = (await linesOf(ctx, projectId)).find((candidate) => candidate.plan_status === 'PUBLISHED' && Number(candidate.source_year) === ctx.year);
  if (line === undefined) ctx.warn(`the project of ${facts.code} has no line of capital`);
  return line === undefined ? undefined : String(line.id);
}

/** The payment request of an accepted month; settled by the bank when `settle`, else left sent. */
async function interimPayment(ctx: SeedContext, facts: ContractFacts, month: number, acceptanceId: string, settle: boolean): Promise<void> {
  const tag = `${facts.code.replace('HD-', '')}-${String(month).padStart(2, '0')}`;
  const requestNo = `DNTT-${tag}`;
  if (facts.parties.length === 0) return;
  let request = await requestByNo(ctx, requestNo);
  if (request === undefined) {
    const line = await allocationLine(ctx, facts);
    if (line === undefined) return;
    const made = await ctx.attempt<Obj>(MAKER, 'POST', '/payment-requests', { contract_id: facts.id, request_kind: 'INTERIM', acceptance_id: acceptanceId, allocation_line_id: line, request_no: requestNo });
    if (!made.ok) return;
    request = { id: made.json.resource_id };
  }
  const status = await drive(ctx, String(request.id), tag, settle);
  ctx.record({ module: 'PAY', screen: 'PAY-01', kind: 'payment-request', id: String(request.id), code: requestNo, note: status });
}

/** The advance of a contract: guaranteed, planned, asked for and paid. */
async function advancePayment(ctx: SeedContext, facts: ContractFacts, course: Course): Promise<void> {
  if (course.advancePct === undefined || facts.lead === undefined) return;
  const tag = `${facts.code.replace('HD-', '')}-TU`;
  const requestNo = `DNTT-${tag}`;
  const known = await requestByNo(ctx, requestNo);
  if (known !== undefined) {
    await drive(ctx, String(known.id), tag, true);
    return;
  }
  const leadValue = Number(facts.lead.work_value_vnd);
  const amount = String(Math.floor((leadValue * course.advancePct) / 100 / 1_000_000) * 1_000_000);
  const bankPaper = await paper(ctx, { symbol: `BLTU-${tag}/2026`, title: tx('guarantee.advance.paper', facts.code), docType: 'BL', sender: tx('bank'), issuedOn: ctx.day(-1) });
  const guarantee = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${facts.id}/guarantees`, {
    kind: 'ADVANCE',
    issuer: tx('bank'),
    guarantee_no: `BLTU-${tag}`,
    amount_vnd: amount,
    valid_from: ctx.day(-1),
    expires_at: new Date(Date.parse(`${ctx.day(420)}T00:00:00+07:00`)).toISOString(),
    document_version_id: bankPaper.versionId,
  });
  if (guarantee.ok) await ctx.attempt(CHECKER, 'POST', `/guarantees/${guarantee.json.resource_id}/verify`, { outcome: 'VERIFIED', method: tx('guarantee.method'), evidence_document_version_id: bankPaper.versionId }, { version: guarantee.json.resource_version });
  const line = await allocationLine(ctx, facts);
  if (line === undefined) return;
  const planned = (await ctx.list<Obj>(ACCOUNTANT, '/advances')).find((row) => String(asObj(row.contract).code ?? row.contract_code) === facts.code && row.status === 'PLANNED');
  let advanceId = planned === undefined ? undefined : String(planned.id);
  if (advanceId === undefined) {
    const advance = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${facts.id}/advances`, { party_id: String(facts.lead.id), kind: 'CONTRACT', amount_vnd: amount, allocation_line_id: line, ...(guarantee.ok ? { guarantee_id: guarantee.json.resource_id } : {}) });
    if (!advance.ok) return;
    advanceId = advance.json.resource_id;
  }
  const made = await ctx.attempt<Obj>(MAKER, 'POST', '/payment-requests', { contract_id: facts.id, request_kind: 'ADVANCE', advance_id: advanceId, allocation_line_id: line, request_no: requestNo });
  if (!made.ok) return;
  const status = await drive(ctx, String(made.json.resource_id), tag, true);
  ctx.record({ module: 'PAY', screen: 'PAY-07', kind: 'advance', id: advanceId, code: requestNo, note: `advance ${course.advancePct}%: ${status}` });
}

// ---- the stages -------------------------------------------------------------------------------------------------------------------------

async function payableContracts(ctx: SeedContext): Promise<ContractFacts[]> {
  const found: ContractFacts[] = [];
  for (const code of TARGETS) {
    const facts = await contractFacts(ctx, code);
    if (facts !== undefined) found.push(facts);
  }
  if (found.some((facts) => facts.parties.length > 0)) return found;
  ctx.warn('none of the active contracts is a joint venture (the product pays a party, and only a joint venture has parties): payments are skipped, measurements and acceptances go on');
  return found;
}

async function stageA(ctx: SeedContext, contracts: ContractFacts[]): Promise<void> {
  for (const facts of contracts) {
    const course = COURSES[facts.code];
    if (course === undefined || facts.parties.length === 0) continue;
    await ctx.step('PAY', `advance of ${facts.code}`, () => advancePayment(ctx, facts, course));
  }
}

async function stageB(ctx: SeedContext, contracts: ContractFacts[]): Promise<void> {
  for (const facts of contracts) {
    const course = COURSES[facts.code];
    const quantity = course?.qty[0] ?? 0;
    if (course === undefined || quantity <= 0) continue;
    await ctx.step('CTR', `work of September of ${facts.code}`, async () => {
      const done = await workOfMonth(ctx, facts, 9, quantity, true);
      if (done.acceptanceId !== undefined) await interimPayment(ctx, facts, 9, done.acceptanceId, true);
    });
  }
}

async function stageC(ctx: SeedContext, contracts: ContractFacts[]): Promise<void> {
  for (const facts of contracts) {
    const course = COURSES[facts.code];
    if (course === undefined) continue;
    const [, october, november] = course.qty;
    if (october > 0) {
      await ctx.step('CTR', `work of October of ${facts.code}`, async () => {
        const done = await workOfMonth(ctx, facts, 10, october, true);
        if (done.acceptanceId !== undefined) await interimPayment(ctx, facts, 10, done.acceptanceId, false);
      });
    }
    if (november > 0) await ctx.step('CTR', `work of November of ${facts.code}`, () => workOfMonth(ctx, facts, 11, november, false));
  }
}

// ---- the chain of changes (CTR-07, 08, 19, 27) ---------------------------------------------------------------------------------------------

interface ChainStep {
  id: string;
  version: number;
}

async function setTiers(ctx: SeedContext, projectId: string): Promise<void> {
  const chain = await ctx.call<Obj>(CHECKER, 'GET', `/projects/${projectId}/change-chain`);
  if (chain.ok && asObj(chain.json.config).tier_count !== undefined) return;
  await ctx.attempt(CHECKER, 'POST', `/projects/${projectId}/change-chain-config`, { tier_count: 3 });
}

/** A request raised at the first tier of the chain by the officer. */
async function raise(ctx: SeedContext, facts: ContractFacts, input: { reason: string; kind: string; estimated: string; days: number }): Promise<ChainStep | undefined> {
  const made = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${facts.id}/change-requests`, {
    stage: 'EVENT',
    baseline_revision_id: facts.revisionId,
    event_kind: input.kind,
    reason: input.reason,
    estimated_delta_vnd: input.estimated,
    schedule_impact_days: input.days,
  });
  return made.ok ? { id: made.json.resource_id, version: made.json.resource_version } : undefined;
}

async function promote(ctx: SeedContext, from: ChainStep, reason: string): Promise<ChainStep | undefined> {
  const done = await ctx.attempt<CommandReply>(MAKER, 'POST', `/change-requests/${from.id}/promote`, { reason }, { version: from.version });
  return done.ok ? { id: done.json.resource_id, version: done.json.resource_version } : undefined;
}

async function evaluate(ctx: SeedContext, step: ChainStep, input: { delta: string; days: number; line?: string }): Promise<ChainStep | undefined> {
  const done = await ctx.attempt<CommandReply>(
    CHECKER,
    'POST',
    `/change-requests/${step.id}/evaluate`,
    { evaluated_delta_vnd: input.delta, schedule_impact_days: input.days, funding_impact_note: tx('change.evaluate.funding'), scope_impact_note: tx('change.evaluate.scope'), ...(input.line === undefined ? {} : { allocation_line_id: input.line }) },
    { version: step.version },
  );
  return done.ok ? { id: step.id, version: done.json.resource_version } : undefined;
}

async function changesOf(ctx: SeedContext, contractId: string, reason: string): Promise<Obj[]> {
  return (await ctx.list<Obj>(MAKER, '/resources/change_request')).filter((row) => String(asObj(row.contract).id) === contractId && row.reason === reason);
}

/** An increase needs a source (tier 2): the officer asks the reserve of the project to cover it, the leader decides the drawdown, and the leader then approves the order, which takes effect in ten days. */
async function coverAndApprove(ctx: SeedContext, facts: ContractFacts, changeId: string, delta: number): Promise<void> {
  const projectId = String(facts.row.project_id);
  const amount = String(delta);
  const reserve = await ctx.call<Obj>(MAKER, 'GET', `/projects/${projectId}/reserve`);
  const funds = (reserve.ok ? ((reserve.json.funds ?? []) as Obj[]) : []).filter((fund) => fund.kind === 'CONTINGENCY');
  const already = funds.some((fund) => ((fund.entries ?? []) as Obj[]).some((entry) => String(entry.change_request_id) === changeId));
  if (!already) {
    if (funds.reduce((total, fund) => total + Number(fund.balance_vnd), 0) < delta) {
      const document = await paper(ctx, { symbol: `QD-DP-${facts.code.replace('HD-', '').split('-')[0]}/2026`, title: tx('reserve.paper', String(facts.row.project_code)), docType: 'BB', sender: tx('reserve.sender'), issuedOn: ctx.day(-30) });
      await ctx.attempt(CHECKER, 'POST', `/projects/${projectId}/reserve-funds`, { kind: 'CONTINGENCY', amount_vnd: String(delta * 2), authority_document_version_id: document.versionId, reason: tx('reserve.fund.reason') });
    }
    const asked = await ctx.attempt<CommandReply>(MAKER, 'POST', `/projects/${projectId}/reserve-drawdowns`, { kind: 'CONTINGENCY', amount_vnd: amount, change_request_id: changeId, reason: tx('reserve.request.reason', facts.code) });
    if (!asked.ok) return;
    const decided = await ctx.attempt(LEADER, 'POST', `/reserve-drawdowns/${asked.json.resource_id}/decision`, { decision: 'approve', reason: tx('reserve.decide.reason') }, { version: asked.json.resource_version });
    if (!decided.ok) return;
  }
  const detail = await ctx.get<Obj>(MAKER, `/resources/contract/${facts.id}`);
  const standing = ((detail.revisions ?? []) as Obj[]).filter((revision) => revision.status === 'EFFECTIVE' || revision.status === 'PENDING_EFFECTIVE').sort((a, b) => Number(b.revision) - Number(a.revision))[0];
  if (standing === undefined) return;
  const newValue = Number(standing.amount_vnd) + delta;
  const row = await ctx.get<Obj>(MAKER, `/resources/change_request/${changeId}`);
  const decision = await paper(ctx, { symbol: `QD-LTD-${facts.code.replace('HD-', '')}-TG/2026`, title: tx('change.decision.increase.paper', facts.code), docType: 'BB', sender: tx('investorRep'), issuedOn: ctx.today });
  const boq = [{ business_key: 'B01', description: facts.boqDescription, unit_code: 'M3', quantity: '1000', unit_price: String(newValue / 1000) }];
  const approved = await ctx.attempt(LEADER, 'POST', `/contract-changes/${changeId}/decision`, { decision: 'approve', reason: tx('change.decision.increase'), evidence_ids: [], effective_on: ctx.day(10), decision_document_version_id: decision.versionId, boq_lines: boq }, { version: Number(row.version) });
  if (approved.ok) ctx.record({ module: 'CTR', screen: 'CTR-08', kind: 'change-order', id: changeId, code: facts.code, note: 'increase of 1.85 billion approved on the reserve, takes effect in ten days' });
}

/** HD-PMDT105-XL01 has two chains (a cut and an increase, both approved to take effect later); the others stop at each tier, one is withdrawn. */
async function changeChains(ctx: SeedContext): Promise<void> {
  const xl01 = await contractFacts(ctx, 'HD-PMDT105-XL01');
  const xl02 = await contractFacts(ctx, 'HD-PMDT105-XL02');
  const xl114 = await contractFacts(ctx, 'HD-PMDT114-XL01');
  const tb164 = await contractFacts(ctx, 'HD-PMTB164-TB01');
  for (const facts of [xl01, xl114, tb164]) if (facts !== undefined) await setTiers(ctx, String(facts.row.project_id));
  if (xl01 !== undefined && (await changesOf(ctx, xl01.id, tx('change.cut.reason'))).length === 0) {
    // A cut: a shorter circulating pipe, so the order lowers the price and needs no cover from the reserve; it is approved and takes effect in three days.
    const event = await raise(ctx, xl01, { reason: tx('change.cut.reason'), kind: 'DESIGN_CHANGE', estimated: '-420000000', days: 0 });
    const pco = event === undefined ? undefined : await promote(ctx, event, tx('change.promote.pco'));
    const pcoDone = pco === undefined ? undefined : await evaluate(ctx, pco, { delta: '-420000000', days: 0 });
    const order = pcoDone === undefined ? undefined : await promote(ctx, pcoDone, tx('change.promote.co'));
    const orderDone = order === undefined ? undefined : await evaluate(ctx, order, { delta: '-420000000', days: 0 });
    if (orderDone !== undefined) {
      const decision = await paper(ctx, { symbol: 'QD-LTD-PMDT105-XL01/2026', title: tx('change.decision.paper', 'HD-PMDT105-XL01'), docType: 'BB', sender: tx('investorRep'), issuedOn: ctx.today });
      const newValue = Number(xl01.row.contract_value_vnd) - 420_000_000;
      const boq = [{ business_key: 'B01', description: String(xl01.boqDescription), unit_code: 'M3', quantity: '1000', unit_price: String(newValue / 1000) }];
      const approved = await ctx.attempt(LEADER, 'POST', `/contract-changes/${orderDone.id}/decision`, { decision: 'approve', reason: tx('change.decision.reason'), evidence_ids: [], effective_on: ctx.day(3), decision_document_version_id: decision.versionId, boq_lines: boq }, { version: orderDone.version });
      ctx.record({ module: 'CTR', screen: 'CTR-08', kind: 'change-order', id: orderDone.id, code: 'HD-PMDT105-XL01', note: approved.ok ? 'cut of 420 million approved, takes effect in three days' : 'cut evaluated' });
    }
  }
  if (xl01 !== undefined && (await changesOf(ctx, xl01.id, tx('change.event.reason.xl01'))).length === 0) {
    // An increase: it waits at the order for the cover of the reserve (tier 2), the way the board of CTR-19 shows an order that is not yet decided.
    const line = await allocationLine(ctx, xl01);
    const event = await raise(ctx, xl01, { reason: tx('change.event.reason.xl01'), kind: 'SITE_CONDITION', estimated: '1850000000', days: 12 });
    const pco = event === undefined ? undefined : await promote(ctx, event, tx('change.promote.pco'));
    const pcoDone = pco === undefined || line === undefined ? undefined : await evaluate(ctx, pco, { delta: '1850000000', days: 12, line });
    const order = pcoDone === undefined ? undefined : await promote(ctx, pcoDone, tx('change.promote.co'));
    const orderDone = order === undefined || line === undefined ? undefined : await evaluate(ctx, order, { delta: '1850000000', days: 12, line });
    if (orderDone !== undefined) ctx.record({ module: 'CTR', screen: 'CTR-27', kind: 'change-order', id: orderDone.id, code: 'HD-PMDT105-XL01', note: 'increase of 1.85 billion evaluated, tier 2' });
  }
  if (xl01 !== undefined) {
    const waiting = (await changesOf(ctx, xl01.id, tx('change.event.reason.xl01'))).find((row) => row.stage === 'CO' && row.status === 'EVALUATED');
    if (waiting !== undefined) await coverAndApprove(ctx, xl01, String(waiting.id), 1_850_000_000);
  }
  if (xl02 !== undefined && (await changesOf(ctx, xl02.id, tx('change.second.reason'))).length === 0) {
    const event = await raise(ctx, xl02, { reason: tx('change.second.reason'), kind: 'DESIGN_CHANGE', estimated: '620000000', days: 7 });
    if (event !== undefined) ctx.record({ module: 'CTR', screen: 'CTR-19', kind: 'change-event', id: event.id, code: 'CE-001', note: 'waiting for the price' });
  }
  if (xl114 !== undefined && (await changesOf(ctx, xl114.id, tx('change.third.reason'))).length === 0) {
    const line = await allocationLine(ctx, xl114);
    const event = await raise(ctx, xl114, { reason: tx('change.third.reason'), kind: 'OWNER_INSTRUCTION', estimated: '430000000', days: 5 });
    const pco = event === undefined ? undefined : await promote(ctx, event, tx('change.promote.pco'));
    const done = pco === undefined || line === undefined ? undefined : await evaluate(ctx, pco, { delta: '430000000', days: 5, line });
    if (done !== undefined) ctx.record({ module: 'CTR', screen: 'CTR-19', kind: 'change-price', id: done.id, code: 'PCO-001', note: 'evaluated, waiting for the order' });
  }
  if (tb164 !== undefined && (await changesOf(ctx, tb164.id, tx('change.tb.reason'))).length === 0) {
    const event = await raise(ctx, tb164, { reason: tx('change.tb.reason'), kind: 'DESIGN_CHANGE', estimated: '180000000', days: 0 });
    if (event !== undefined) {
      const withdrawn = await ctx.attempt(MAKER, 'POST', `/change-requests/${event.id}/withdraw`, { reason: tx('change.third.withdraw') }, { version: event.version });
      if (withdrawn.ok) ctx.record({ module: 'CTR', screen: 'CTR-19', kind: 'change-event', id: event.id, code: 'CE-001', note: 'withdrawn' });
    }
  }
}

// ---- delay damages (CTR-32, 33, 34) ---------------------------------------------------------------------------------------------------

/** The owner's claim for delay damages of the equipment contract: the term of the contract proposed by the officer and approved by the owner, then the claim with its notice and particulars. */
async function delayClaim(ctx: SeedContext): Promise<void> {
  const facts = await contractFacts(ctx, 'HD-PMTB164-TB01');
  if (facts === undefined) return;
  const terms = await ctx.call<Obj>(MAKER, 'GET', `/contracts/${facts.id}/claim-terms`);
  const listed = (terms.ok ? ((terms.json.items ?? []) as Obj[]) : []).filter((row) => row.claimant_side === 'OWNER');
  if (!listed.some((row) => row.status === 'APPROVED' || row.status === 'PROPOSED')) {
    const term = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${facts.id}/claim-terms`, {
      claimant_side: 'OWNER',
      notice_days: 14,
      particulars_days: 30,
      response_days: 21,
      settlement_days: 30,
      basis: 'CALENDAR_DAYS',
      particulars_from: 'AWARENESS',
      bar_effect: 'NONE',
      clause_reference: tx('claim.term.clause'),
    });
    if (term.ok) listed.push({ id: term.json.resource_id, status: 'PROPOSED', version: term.json.resource_version });
  }
  const waiting = listed.find((row) => row.status === 'PROPOSED');
  if (waiting !== undefined) await ctx.attempt(CHECKER, 'POST', `/claim-terms/${String(waiting.id)}/decision`, { decision: 'APPROVE', note: tx('claim.term.approve') }, { version: Number(waiting.version) });
  const claims = await ctx.list<Obj>(MAKER, '/claims', { contract_id: facts.id });
  const amount = String(Math.round(Number(facts.row.contract_value_vnd) * 0.015));
  let claimId = claims.find((row) => row.title === tx('claim.delay.title'))?.id as string | undefined;
  if (claimId === undefined) {
    const claim = await ctx.attempt<CommandReply>(MAKER, 'POST', `/contracts/${facts.id}/claims`, {
      claimant_side: 'OWNER',
      kind: 'DELAY_DAMAGES',
      title: tx('claim.delay.title'),
      event_description: tx('claim.delay.description'),
      event_on: ctx.day(-20),
      awareness_on: ctx.day(-18),
      claimed_amount_vnd: amount,
      claimed_days: 15,
    });
    if (!claim.ok) return;
    claimId = claim.json.resource_id;
  }
  // The steps of the timeline: the notice, then the particulars (each takes the version the claim has reached).
  for (const step of [
    { kind: 'NOTICE', occurred_on: ctx.day(-14), note: tx('claim.step.notice') },
    { kind: 'PARTICULARS', occurred_on: ctx.day(-7), note: tx('claim.step.particulars'), claimed_amount_vnd: amount, claimed_days: 15 },
  ]) {
    const detail = await ctx.get<Obj>(MAKER, `/claims/${claimId}`);
    if (((detail.steps ?? []) as Obj[]).some((row) => row.kind === step.kind)) continue;
    const done = await ctx.attempt(MAKER, 'POST', `/claims/${claimId}/steps`, step, { version: Number(detail.version) });
    if (!done.ok) break;
  }
  ctx.record({ module: 'CTR', screen: 'CTR-32', kind: 'claim', id: claimId, code: 'CLM', note: 'delay damages, notice and particulars served' });
}

export async function seedClipEnterpriseExecution(ctx: SeedContext): Promise<void> {
  const contracts = await payableContracts(ctx);
  if (runs('A')) await stageA(ctx, contracts);
  if (runs('B')) await stageB(ctx, contracts);
  if (runs('C')) {
    await stageC(ctx, contracts);
    await ctx.step('CTR', 'chains of changes', () => changeChains(ctx));
    await ctx.step('CTR', 'delay damages claim', () => delayClaim(ctx));
  }
}
