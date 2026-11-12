import type { CommandReply, Obj, SeedContext } from '../context.ts';
import TEXTS from '../data/enterprise-legal.json' with { type: 'json' };

/**
 * Group `clip-ent-legal`: the legal dossier of each project (PRJ-04), made with the commands of the product only.
 *
 * The product draws the dossier from the decision documents of the revisions of a project (ST-PRJ-008): every document that grounds the project is recorded as an approved revision of its scope
 * (`ADJUST_SCOPE`, which moves no figure of the project), proposed by the project manager and decided by the leader with the document and the day it takes effect. The documents are the ones the other
 * groups already registered (the submission `NNN/TTr-BQLDA`, the appraisal result `NNN/TB-HĐTĐ`, the decision `NNN/QĐ-HĐTV`, the permits of PMT, the signed contracts and their guarantees of CTR);
 * only the investment policy and the feasibility report, which nothing else registers, are received here as letters. Each document is one revision, in the order of the day it was issued, so the
 * newest stands as approved and the ones before it as replaced.
 *
 * Idempotent: a document that already grounds a revision of the project is not recorded again. A project that has a revision waiting for a decision is left alone (the product allows one at a time).
 */

const MAKER = 'projectManager';
const LEADER = 'capApprover';
const T = TEXTS as unknown as Record<string, string>;

/** The text of a key with its `{name}` markers replaced. */
function text(key: string, values: Record<string, string> = {}): string {
  const found = T[key];
  if (typeof found !== 'string') throw new Error(`the text ${key} is not in enterprise-legal.json`);
  return found.replace(/\{(\w+)\}/gu, (_marker, name: string) => values[name] ?? '');
}

type Kind = 'policy' | 'feasibility' | 'design' | 'env' | 'build' | 'water' | 'fire' | 'proposal' | 'appraisal' | 'decision' | 'contract' | 'guarantee';

interface Item {
  kind: Kind;
  documentId: string;
  /** The day the document was issued: the day the revision takes effect. */
  day: string;
  values: Record<string, string>;
  note: string;
}

/** The Vietnam calendar day of an instant the API writes in UTC (the register keeps midnight of Vietnam as 17:00 UTC of the day before). */
function vietnamDay(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (!value.includes('T')) return value.slice(0, 10);
  return new Date(Date.parse(value) + 7 * 3_600_000).toISOString().slice(0, 10);
}

/** `2026-08-01` as `01/08/2026`, the way the dossier names a day. */
const dayText = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** Billions of dong as the text of a figure, with the decimal comma. */
function billions(total: unknown): string {
  const whole = BigInt(String(total ?? '0').split('.')[0] ?? '0');
  const value = Number(whole / 1_000_000n) / 1000;
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}

/** Whole dong with the dots of a thousand: 3516450000 as 3.516.450.000. */
const dongText = (amount: unknown): string => String(amount ?? '0').split('.')[0]!.replace(/\B(?=(\d{3})+(?!\d))/gu, '.');

const PERMIT_KINDS: Record<string, Kind> = { GPXD: 'build', TKXD: 'design', DTM: 'env', GPNM: 'water', PCCC: 'fire' };

export async function seedClipEnterpriseLegal(ctx: SeedContext): Promise<void> {
  await ctx.step('PRJ', 'legal dossier of the projects', async () => {
    const projects = (await ctx.list<Obj>(MAKER, '/resources/project')).sort((a, b) => String(a.code).localeCompare(String(b.code)));
    const incoming = await ctx.list<Obj>(MAKER, '/incoming-documents');
    const bySymbol = new Map<string, Obj>();
    for (const row of incoming) if (typeof row.original_symbol === 'string' && !bySymbol.has(row.original_symbol)) bySymbol.set(row.original_symbol, row);
    const contracts = await ctx.list<Obj>(MAKER, '/resources/contract');
    const versions = await ctx.list<Obj>(MAKER, '/resources/document_version');
    const documentOfVersion = new Map<string, string>();
    for (const row of versions) documentOfVersion.set(String(row.id), String(row.document_id));
    const guarantees = (await ctx.list<Obj>(MAKER, '/resources/guarantee')).filter((row) => row.kind === 'PERFORMANCE');
    const dossiers = await ctx.list<Obj>(MAKER, '/resources/permit_dossier');
    let made = 0;
    for (const project of projects) {
      const code = String(project.code);
      const id = String(project.id);
      const number = code.replace(/\D/gu, '');
      const base: Record<string, string> = {
        code,
        name: String(project.name ?? code),
        total: billions(project.total_investment_vnd),
        from: String(project.start_year ?? ''),
        to: String(project.end_year ?? ''),
      };

      // The documents of this project, each with the day it was issued.
      const items: Item[] = [];
      const received = async (kind: Kind, symbol: string, title: string, docType: string, sender: string, day: string): Promise<void> => {
        const letter = await ctx.letter({ symbol, title, issuedOn: day, sender, docType });
        items.push({ kind, documentId: letter.documentId, day, values: { ...base, proposal: symbol }, note: symbol });
      };
      const existing = (symbol: string, kind: Kind): void => {
        const row = bySymbol.get(symbol);
        const day = vietnamDay(row?.original_issued_on);
        if (row === undefined || day === undefined) return;
        items.push({ kind, documentId: String(row.document_id), day, values: { ...base, proposal: symbol }, note: symbol });
      };

      const reachable = ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'].includes(String(project.status));
      if (!reachable) continue;
      await received('policy', `${number}/NQ-HĐTV`, text('policy.title', base), 'QD', text('sender.board'), ctx.day(-215));
      await received('feasibility', `${number}/BC-NCKT`, text('feasibility.title', base), 'BC', text('sender.pmb'), ctx.day(-200));
      existing(`${number}/TTr-BQLDA`, 'proposal');
      existing(`${number}/TB-HĐTĐ`, 'appraisal');
      existing(`${number}/QĐ-HĐTV`, 'decision');

      const permitByNo = new Map<string, Obj>();
      for (const dossier of dossiers.filter((row) => String(row.project_id ?? ((row.project ?? {}) as Obj).id) === id)) {
        const detail = await ctx.get<Obj>(MAKER, `/resources/permit_dossier/${String(dossier.id)}`);
        for (const row of (detail.permits ?? []) as Obj[]) if (typeof row.permit_no === 'string') permitByNo.set(row.permit_no, row);
      }
      // The permits of PMT whose papers are registered: the number of the permit tells which, and the permit holds its validity.
      for (const [symbol, row] of bySymbol) {
        const match = new RegExp(`^(.+)/${code}/([A-Z]+)$`, 'u').exec(symbol);
        const kind = match === null ? undefined : PERMIT_KINDS[match[2] ?? ''];
        const day = vietnamDay(row.original_issued_on);
        if (match === null || kind === undefined || day === undefined) continue;
        const permit = permitByNo.get(match[1] ?? '');
        const until = permit?.no_expiry === true || permit === undefined ? undefined : vietnamDay(permit.valid_until);
        items.push({ kind, documentId: String(row.document_id), day, values: { ...base, no: match[1] ?? '', date: dayText(day), valid: until === undefined ? text('valid.open') : text('valid.until', { date: dayText(until) }) }, note: symbol });
      }

      // The main contract of the project and the guarantee of its performance.
      for (const listed of contracts.filter((row) => String(row.project_id) === id && /-(XL|TB)01$/u.test(String(row.code)))) {
        const contract = await ctx.get<Obj>(MAKER, `/resources/contract/${String(listed.id)}`);
        const day = vietnamDay(contract.signed_on);
        if (day === undefined) continue;
        const values = { ...base, contract: String(contract.code), title: String(contract.title ?? ''), date: dayText(day) };
        const base1 = ((contract.revisions ?? []) as Obj[]).find((revision) => revision.kind === 'BASE');
        const signed = base1 === undefined ? undefined : documentOfVersion.get(String(base1.document_version_id));
        if (signed !== undefined) items.push({ kind: 'contract', documentId: signed, day, values, note: String(contract.code) });
        for (const guarantee of guarantees.filter((row) => String(row.contract_id) === String(contract.id))) {
          const document = documentOfVersion.get(String(guarantee.document_version_id));
          const from = vietnamDay(guarantee.valid_from);
          const until = vietnamDay(guarantee.expires_at);
          if (document === undefined || from === undefined || until === undefined) continue;
          const given = { ...values, no: String(guarantee.guarantee_no), issuer: String(guarantee.issuer), amount: dongText(guarantee.amount_vnd), date: dayText(from), until: dayText(until) };
          items.push({ kind: 'guarantee', documentId: document, day: from, values: given, note: String(guarantee.guarantee_no) });
        }
      }

      const history = await ctx.list<Obj>(MAKER, `/projects/${id}/revisions`);
      if (history.some((row) => row.status === 'IN_REVIEW')) {
        ctx.warn(`${code} has a revision waiting for its decision: its legal dossier is left as it is`);
        continue;
      }
      const recorded = new Set(history.map((row) => String(((row.decision_document ?? {}) as Obj).id ?? '')));
      // The oldest paper goes first, so the newest ends as the one in force.
      const todo = items.filter((item) => !recorded.has(item.documentId)).sort((a, b) => a.day.localeCompare(b.day));
      for (const item of todo) {
        const current = await ctx.get<Obj>(MAKER, `/resources/project/${id}`);
        const proposed = await ctx.attempt<CommandReply>(MAKER, 'POST', `/projects/${id}/revisions`, { change_kind: 'ADJUST_SCOPE', after: { scope_summary: text(`${item.kind}.scope`, item.values) }, reason: text(`${item.kind}.reason`, item.values) }, { version: Number(current.version) });
        if (!proposed.ok) break;
        const decided = await ctx.attempt(LEADER, 'POST', `/project-revisions/${proposed.json.resource_id}/decision`, { decision: 'approve', reason: text(`${item.kind}.approve`, item.values), decision_document_id: item.documentId, effective_from: item.day }, { version: proposed.json.resource_version });
        if (!decided.ok) break;
        made += 1;
        ctx.record({ module: 'PRJ', screen: 'PRJ-04', kind: 'legal-document', id: String(proposed.json.resource_id), code, note: `${item.kind} ${item.note}` });
      }
    }
    ctx.log(`  [prj] ${made} legal documents recorded in the dossiers`);
  });
  await ctx.step('PRJ', 'baseline and look-ahead plans', () => workingRecords(ctx));
  await ctx.step('PRJ', 'investment appraisals', () => appraisals(ctx));
  await ctx.step('PRJ', 'expected value of the open risks', () => riskExposure(ctx));
}

interface AppraisalText {
  project: string;
  title: string;
  /** Billions of dong spent in the first periods. */
  capex: number[];
  /** Billions of dong earned in the periods after the spending. */
  benefit: number[];
  stage: 'APPROVED' | 'SUBMITTED' | 'COMPUTED';
}

const billionsToDong = (value: number): string => `${value}000000000`;

/** The appraisals of the efficiency of an investment (PRJ-23, PRJ-24): one approved, one waiting for approval, one computed and still a draft. */
async function appraisals(ctx: SeedContext): Promise<void> {
  const wanted = TEXTS['appraisal.list'] as unknown as AppraisalText[];
  const projects = new Map((await ctx.list<Obj>(MAKER, '/resources/project')).map((row) => [String(row.code), row]));
  const known = await ctx.list<Obj>(MAKER, '/investment-appraisals', { limit: 50 });
  for (const spec of wanted) {
    const project = projects.get(spec.project);
    if (project === undefined || known.some((row) => row.title === spec.title)) continue;
    const opened = await ctx.attempt<CommandReply>(MAKER, 'POST', '/investment-appraisals', { title: spec.title, kind: 'FINANCIAL', project_id: String(project.id) });
    if (!opened.ok) continue;
    const owner = ctx.person(MAKER).membershipId;
    const lines = [...spec.capex.map((capex, index) => ({ period: index, capex: billionsToDong(capex) })), ...spec.benefit.map((benefit, index) => ({ period: spec.capex.length + index, benefit: billionsToDong(benefit) }))];
    const answered = ['HORIZON', 'DISCOUNT_RATE', 'BENEFIT', 'CAPEX'].map((key) => ({ key, value: 'Theo hồ sơ', unit: 'VND', source_kind: 'DOCUMENT', source: T['appraisal.source'], owner_id: owner }));
    const edited = await ctx.attempt<CommandReply>(MAKER, 'POST', `/investment-appraisals/${opened.json.resource_id}/inputs`, { title: spec.title, period_unit: 'YEAR', discount_rate_pct: '10', convention: 'END', lines, assumptions: answered, scenarios: [], scores: [] }, { version: opened.json.resource_version });
    if (!edited.ok) continue;
    const computed = await ctx.attempt<CommandReply>(MAKER, 'POST', `/investment-appraisals/${opened.json.resource_id}/runs`, {}, { version: edited.json.resource_version });
    if (!computed.ok || spec.stage === 'COMPUTED') continue;
    const submitted = await ctx.attempt<CommandReply>(MAKER, 'POST', `/investment-appraisals/${opened.json.resource_id}/submission`, {}, { version: computed.json.resource_version });
    if (!submitted.ok || spec.stage === 'SUBMITTED') continue;
    await ctx.attempt(LEADER, 'POST', `/investment-appraisals/${opened.json.resource_id}/approval`, { reason: T['appraisal.approve'] }, { version: submitted.json.resource_version });
    ctx.record({ module: 'PRJ', screen: 'PRJ-23', kind: 'investment-appraisal', id: String(opened.json.resource_id), code: spec.project, note: spec.stage });
  }
}

/** The Monday of the week of a day, as YYYY-MM-DD. */
function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The baseline v0 of the projects under way (PRJ-26, PRJ-27) and the look-ahead plan of the site of three of them (PRJ-30). */
async function workingRecords(ctx: SeedContext): Promise<void> {
  const projects = await ctx.list<Obj>(MAKER, '/resources/project');
  const byCode = new Map(projects.map((row) => [String(row.code), row]));
  let baselines = 0;
  for (const row of projects) {
    if (!['IMPLEMENTATION', 'BUDGETED'].includes(String(row.status))) continue;
    const id = String(row.id);
    const held = await ctx.call<Obj>(MAKER, 'GET', `/projects/${id}/baseline`);
    const versions = held.ok ? ((held.json.versions ?? []) as unknown[]) : [];
    if (versions.length > 0) continue;
    const made = await ctx.call(MAKER, 'POST', `/projects/${id}/baseline`, {});
    if (made.ok) baselines += 1;
    else ctx.warn(`the baseline of ${String(row.code)} was refused: HTTP ${made.status}`);
  }
  ctx.log(`  [prj] ${baselines} baselines captured`);

  const week = mondayOf(ctx.day(0));
  const plans = TEXTS['lookahead.items'] as unknown as Record<string, Array<[string, number, number, string]>>;
  for (const [code, items] of Object.entries(plans)) {
    const project = byCode.get(code);
    if (project === undefined) continue;
    const id = String(project.id);
    const created = await ctx.call<CommandReply>(MAKER, 'POST', `/projects/${id}/look-ahead-plans`, {
      week_start: week,
      horizon_weeks: 3,
      items: items.map(([description, from, to, responsible]) => ({ description, planned_start: addDays(week, from), planned_finish: addDays(week, to), responsible })),
    });
    if (!created.ok) {
      if (created.status !== 409) ctx.warn(`the look-ahead plan of ${code} was refused: HTTP ${created.status} ${created.text.slice(0, 200)}`);
      continue;
    }
    await ctx.attempt(MAKER, 'POST', `/look-ahead-plans/${created.json.resource_id}/publish`, {}, { version: created.json.resource_version });
    ctx.record({ module: 'PRJ', screen: 'PRJ-30', kind: 'look-ahead-plan', id: String(created.json.resource_id), code, note: `${items.length} items` });
  }
  // Two items wait for something that is not ready yet: a permit and a delivery of material.
  const waiting: Array<[string, number, string[]]> = [
    ['DA-PMDT120', 2, TEXTS['lookahead.constraint'] as string[]],
    ['DA-PMDT105', 1, TEXTS['lookahead.constraint2'] as string[]],
  ];
  for (const [code, index, [kind, description]] of waiting) {
    const project = byCode.get(code);
    const wanted = plans[code]?.[index]?.[0];
    if (project === undefined || wanted === undefined) continue;
    const view = await ctx.get<Obj>(MAKER, `/projects/${String(project.id)}/look-ahead`);
    const item = (((view.plan ?? {}) as Obj).items as Obj[] | undefined)?.find((candidate) => candidate.description === wanted);
    if (item === undefined || ((item.constraints ?? []) as unknown[]).length > 0) continue;
    await ctx.attempt(MAKER, 'POST', `/look-ahead-items/${String(item.id)}/constraints`, { kind, description, owner_membership_id: ctx.person(MAKER).membershipId, due_on: ctx.day(5) });
  }
}

/** The chance and the cost of the open risks of the projects under way (PRJ-22 sets the balance of the reserve against their expected value). Taken from the scoring of the risk, so a second run writes the same figures. */
async function riskExposure(ctx: SeedContext): Promise<void> {
  const projects = (await ctx.list<Obj>(MAKER, '/resources/project')).filter((row) => row.status === 'IMPLEMENTATION');
  let set = 0;
  for (const project of projects) {
    const risks = await ctx.list<Obj>(MAKER, `/projects/${String(project.id)}/risks`);
    for (const risk of risks.filter((row) => !['CLOSED', 'RESOLVED'].includes(String(row.status)) && String(row.project_id ?? project.id) === String(project.id))) {
      const likelihood = Number(risk.likelihood);
      const impact = Number(risk.impact);
      if (!Number.isFinite(likelihood) || !Number.isFinite(impact)) continue;
      const done = await ctx.call(MAKER, 'POST', `/project-risks/${String(risk.id)}/exposure`, { probability_pct: String(Math.min(90, likelihood * 10)), cost_impact_vnd: `${impact * 300}000000` });
      if (done.ok) set += 1;
      else if (done.status !== 409) ctx.warn(`the exposure of the risk ${String(risk.code ?? risk.id)} was refused: HTTP ${done.status} ${done.text.slice(0, 160)}`);
    }
  }
  ctx.log(`  [prj] ${set} risk exposures set`);
}
