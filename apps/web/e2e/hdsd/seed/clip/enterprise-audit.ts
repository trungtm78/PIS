import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asObj, vnd, vndMillions } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import { CHECKER, MAKER, OWNER, asString, plain, projects, tolerate } from '../field-assurance/shared.ts';
import { seedNotificationSetup } from '../platform-records/notifications.ts';
import { once } from '../platform-records/shared.ts';
import TEXTS from '../data/enterprise-audit.json' with { type: 'json' };

/**
 * Group `clip-ent-audit`: governance and administration of the enterprise edition, made with the commands of the product only.
 *
 *  - NOT: the notification workflows are published FIRST, so the events of everything below (an engagement started, a recommendation assigned, an asset handed over...) reach the inbox of the owner, the leader and the project board.
 *  - AUD: four engagements (two in follow-up with conclusion, findings, recommendations at every stage, a partial financial recovery and a follow-up report; one ongoing; one planned).
 *  - AST: the handover of the equipment of two supply contracts (an accepted one with assets, warranty and claims; one with open punch items; one draft).
 *  - ADM: members invited into the five units (ADM-02).
 *
 * A letter that stands for a decision, a conclusion or a minute is received and REGISTERED (an incoming letter becomes a document in force only when it is entered in the register), so AUD and AST accept it.
 * Idempotent: everything is looked up by its natural key first; a step the rules refuse is written in the warnings and the rest go on.
 */

// ---- the story, as data -----------------------------------------------------------------------------------------------------------------

interface FindingSpec {
  code: string;
  category: 'FINANCIAL' | 'PROCEDURE' | 'PROCUREMENT' | 'QUALITY' | 'LAND' | 'PLANNING' | 'OTHER';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  project?: string;
  contract?: string;
  billions?: number;
  description: string;
}
interface RecSpec {
  code: string;
  type: 'FINANCIAL_RECOVERY' | 'FINANCIAL_ADJUSTMENT' | 'PROCESS_CORRECTION' | 'ACCOUNTABILITY' | 'REFERRAL' | 'POLICY_CHANGE';
  finding?: string;
  description: string;
  billions?: number;
  to: 'RECEIVED' | 'ASSIGNED' | 'PLANNED' | 'ACTION_DONE' | 'VERIFYING' | 'CLOSED' | 'DISPUTED';
  dueIn?: number;
  unit?: string;
  recoveredBillions?: number;
  disputeReason?: string;
}
interface ConclusionSpec {
  kind: 'INSPECTION_CONCLUSION' | 'AUDIT_REPORT' | 'AUDIT_NOTICE' | 'INTERNAL_REPORT';
  symbol: string;
  title: string;
  sender: string;
  docType?: string;
  issuedAgo: number;
  receivedAgo: number;
  implementIn: number;
  reportIn: number;
  summary: string;
  totalBillions: number;
  findings: FindingSpec[];
  recs: RecSpec[];
}
interface EngagementSpec {
  code: string;
  type: 'ADMINISTRATIVE_INSPECTION' | 'SPECIALIZED_INSPECTION' | 'STATE_AUDIT' | 'INTERNAL_AUDIT' | 'SUPERVISORY_CHECK';
  authorityKind: 'GOVERNMENT_INSPECTORATE' | 'PROVINCIAL_INSPECTORATE' | 'MINISTRY_INSPECTORATE' | 'STATE_AUDIT_OFFICE' | 'INTERNAL';
  authority: string;
  title: string;
  decision: { symbol: string; title: string; sender: string; ago: number };
  projects: string[];
  contracts: string[];
  from: string;
  to: string;
  state: 'PLANNED' | 'ONGOING' | 'FOLLOW_UP';
  startedAgo?: number;
  fieldworkEndedAgo?: number;
  fieldworkNote?: string;
  workingPaper?: { symbol: string; title: string; ago: number };
  conclusion?: ConclusionSpec;
}
interface PunchSpec {
  description: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  location: string;
  dueIn: number;
  state: 'OPEN' | 'FIXED' | 'VERIFIED' | 'WAIVED';
}
interface HandoverSpec {
  no: string;
  project: string;
  contract: string;
  kind: 'PARTIAL' | 'COMPLETION' | 'ASSET_TRANSFER';
  unit: string;
  plannedIn: number;
  to: 'DRAFT' | 'PUNCH' | 'ACCEPTED';
  title: string;
  punch: PunchSpec[];
  assets?: Array<{ code: string; name: string; billions: number; basis: 'CONTRACT_VALUE' | 'SETTLED_VALUE' | 'APPRAISED_VALUE'; warrantyMonths: number }>;
  warranty?: { scope: string; months: number; retentionMillions: number };
}
interface ClaimSpec {
  project: string;
  no: string;
  defect: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  location: string;
  ago: number;
  to: 'FILED' | 'ACKNOWLEDGED' | 'FIXED' | 'VERIFIED';
}
interface MemberSpec {
  name: string;
  email: string;
  unit: string;
  role?: string;
}

const ENGAGEMENTS = TEXTS.engagements as unknown as EngagementSpec[];
const HANDOVERS = TEXTS.handovers as unknown as HandoverSpec[];
const CLAIMS = TEXTS.claims as unknown as ClaimSpec[];
const MEMBERS = TEXTS.members as unknown as MemberSpec[];
const T = TEXTS.texts;

const say = (template: string, ...args: readonly unknown[]): string => template.replace(/\{(\d+)\}/gu, (_match, index: string) => String(args[Number(index)]));

// ---- letters in force ----------------------------------------------------------------------------------------------------------------------

interface Paper {
  documentId: string;
  versionId: string;
}
interface PaperSpec {
  symbol: string;
  title: string;
  type?: string;
  sender: string;
  ago: number;
}

const papers = new Map<string, Paper>();
let registerId: string | undefined;

function cacheFile(ctx: SeedContext): string {
  return join(ctx.stackDir, 'seed-papers-ent-audit.json');
}
function readCache(ctx: SeedContext): Record<string, Paper> {
  try {
    return JSON.parse(readFileSync(cacheFile(ctx), 'utf8')) as Record<string, Paper>;
  } catch {
    return {};
  }
}
function writeCache(ctx: SeedContext, symbol: string, found: Paper): void {
  const all = readCache(ctx);
  all[symbol] = found;
  mkdirSync(ctx.stackDir, { recursive: true });
  writeFileSync(cacheFile(ctx), JSON.stringify(all, null, 1), 'utf8');
}

async function incomingRegister(ctx: SeedContext): Promise<string> {
  if (registerId !== undefined) return registerId;
  const register = await ctx.find(MAKER, '/document-number-registers', (row) => row.register_code === 'DEN' && Number(row.year) === ctx.year);
  if (register === undefined) throw new Error('the incoming register DEN of the year does not exist: the group clip-ent-documents must run first');
  registerId = asString(register.id);
  return registerId;
}

/**
 * A letter received through DOC (an uploaded PDF) and entered in the incoming register, which is what puts its document in force (EFFECTIVE): AUD and AST refuse a letter that is only received.
 * The symbol is the natural key; the ids are kept next to the stack so that a second run finds them.
 */
async function paper(ctx: SeedContext, spec: PaperSpec): Promise<Paper> {
  const key = `${ctx.info.apiPort}:${spec.symbol}`;
  const memo = papers.get(key);
  if (memo !== undefined) return memo;
  const letters = await ctx.list(MAKER, '/incoming-documents');
  const existing = letters.find((letter) => letter.original_symbol === spec.symbol);
  const stored = readCache(ctx)[spec.symbol];
  let found: Paper;
  let incomingId: string;
  let version: number;
  let status: string;
  if (existing !== undefined && stored !== undefined) {
    found = stored;
    incomingId = asString(existing.id);
    version = Number(existing.version);
    status = asString(existing.status);
  } else {
    const bytes = ctx.pdf(...[spec.sender, spec.symbol, spec.title].map(plain));
    const uploaded = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>(MAKER, '/document-files', { filename: `${plain(spec.symbol).replace(/[^A-Za-z0-9]+/gu, '-')}.pdf`, buffer: bytes }), `upload the file of ${spec.symbol}`).json;
    const received = await ctx.must<{ resource_id: string; resource_version: number; document_id: string; version_id: string }>(MAKER, 'POST', '/incoming-documents', {
      title: spec.title,
      doc_type_code: spec.type ?? 'QD',
      channel: 'UPLOAD',
      file_object_key: uploaded.file_object_key,
      file_sha256: uploaded.file_sha256,
      original_symbol: spec.symbol,
      original_issued_on: ctx.day(-spec.ago),
      sender_name: spec.sender,
      ...(existing === undefined ? {} : { duplicate_override_reason: 'Nhập lại văn bản để lấy mã tham chiếu' }),
    });
    found = { documentId: received.document_id, versionId: received.version_id };
    incomingId = received.resource_id;
    version = received.resource_version;
    status = 'RECEIVED';
  }
  if (status === 'RECEIVED') await ctx.command(MAKER, `/incoming-documents/${incomingId}/registration`, { register_id: await incomingRegister(ctx) }, { version });
  papers.set(key, found);
  writeCache(ctx, spec.symbol, found);
  return found;
}

// ---- AUD ---------------------------------------------------------------------------------------------------------------------------------

async function contractIds(ctx: SeedContext): Promise<Map<string, string>> {
  const rows = await ctx.list(MAKER, '/resources/contract');
  return new Map(rows.map((row) => [asString(row.code), asString(row.id)]));
}

async function engagementOf(ctx: SeedContext, spec: EngagementSpec, existing: Obj[]): Promise<Obj> {
  let row = existing.find((candidate) => candidate.engagement_code === spec.code);
  if (row === undefined) {
    const decision = await paper(ctx, { symbol: spec.decision.symbol, title: spec.decision.title, type: 'QD', sender: spec.decision.sender, ago: spec.decision.ago });
    const projectRows = await projects(ctx);
    const contractRows = await contractIds(ctx);
    const scope: Array<{ kind: string; id: string }> = [];
    for (const code of spec.projects) {
      const project = projectRows[code];
      if (project === undefined) throw new Error(`the project ${code} does not exist`);
      scope.push({ kind: 'PROJECT', id: project.id });
    }
    const withContracts = [...scope];
    for (const code of spec.contracts) {
      const id = contractRows.get(code);
      if (id !== undefined) withContracts.push({ kind: 'CONTRACT', id });
    }
    const body = (items: typeof scope): Obj => ({
      engagement_code: spec.code,
      engagement_type: spec.type,
      authority_kind: spec.authorityKind,
      authority_name: spec.authority,
      decision_document_id: decision.documentId,
      title: spec.title,
      period_from: spec.from,
      period_to: spec.to,
      coordinator_user_id: ctx.person(CHECKER).membershipId,
      scope: items,
    });
    let reply = await ctx.call<{ resource_id: string; resource_version: number }>(MAKER, 'POST', '/audit-engagements', body(withContracts));
    if (!reply.ok && withContracts.length > scope.length) {
      ctx.warn(`AUD: engagement ${spec.code} with contracts in scope refused (HTTP ${reply.status} ${reply.text.slice(0, 200)}): registered with its projects only`);
      reply = await ctx.call(MAKER, 'POST', '/audit-engagements', body(scope));
    }
    const made = ctx.expectOk(reply, `register the engagement ${spec.code}`).json;
    row = { id: made.resource_id, status: 'PLANNED', version: made.resource_version };
    ctx.record({ module: 'AUD', screen: 'AUD-02', kind: 'audit-engagement', id: made.resource_id, code: spec.code, note: spec.state });
  }
  const read = async (): Promise<Obj> => ctx.get(MAKER, `/audit-engagements/${asString(row?.id)}`);
  let detail = await read();
  if (detail.status === 'PLANNED' && spec.startedAgo !== undefined) {
    const start = (hold: boolean): Promise<Awaited<ReturnType<SeedContext['call']>>> => ctx.call(MAKER, 'POST', `/audit-engagements/${asString(row?.id)}/start`, { started_on: ctx.day(-(spec.startedAgo as number)), place_legal_hold: hold }, { version: Number(detail.version) });
    let reply = await start(true);
    if (!reply.ok) reply = await start(false);
    ctx.expectOk(reply, `start ${spec.code}`);
    detail = await read();
  }
  if (detail.status === 'ONGOING' && spec.fieldworkEndedAgo !== undefined) {
    await ctx.command(MAKER, `/audit-engagements/${asString(row.id)}/fieldwork-end`, { on_date: ctx.day(-spec.fieldworkEndedAgo), reason: spec.fieldworkNote ?? 'Hoàn thành kiểm tra tại đơn vị' }, { version: Number(detail.version) });
    detail = await read();
  }
  return detail;
}

async function conclusionOf(ctx: SeedContext, spec: ConclusionSpec, engagement: Obj): Promise<Obj | undefined> {
  const engagementId = asString(engagement.id);
  const existing = await ctx.list(MAKER, `/audit-engagements/${engagementId}/conclusions`);
  let conclusion = existing[0];
  if (conclusion === undefined) {
    if (engagement.status !== 'AWAITING_CONCLUSION') {
      ctx.warn(`AUD: the engagement ${asString(engagement.engagement_code)} is ${asString(engagement.status)}, a conclusion cannot be recorded`);
      return undefined;
    }
    const doc = await paper(ctx, { symbol: spec.symbol, title: spec.title, type: spec.docType ?? 'BC', sender: spec.sender, ago: spec.issuedAgo });
    const made = await ctx.command(
      MAKER,
      `/audit-engagements/${engagementId}/conclusions`,
      {
        conclusion_kind: spec.kind,
        conclusion_document_id: doc.documentId,
        issued_on: ctx.day(-spec.issuedAgo),
        received_on: ctx.day(-spec.receivedAgo),
        implementation_due_on: ctx.day(spec.implementIn),
        report_due_on: ctx.day(spec.reportIn),
        summary: spec.summary,
        total_financial_vnd: vnd(spec.totalBillions),
      },
      { version: Number(engagement.version) },
    );
    conclusion = { id: made.resource_id };
    ctx.record({ module: 'AUD', screen: 'AUD-04', kind: 'audit-conclusion', id: made.resource_id, code: spec.symbol, note: spec.kind });
  }
  const conclusionId = asString(conclusion.id);
  const projectRows = await projects(ctx);
  const contractRows = await contractIds(ctx);
  let findings = await ctx.list(MAKER, `/audit-conclusions/${conclusionId}/findings`);
  for (const finding of spec.findings) {
    if (findings.some((row) => row.finding_code === finding.code)) continue;
    const project = finding.project === undefined ? undefined : projectRows[finding.project];
    const contract = finding.contract === undefined ? undefined : contractRows.get(finding.contract);
    await ctx.command(MAKER, `/audit-conclusions/${conclusionId}/findings`, {
      finding_code: finding.code,
      category: finding.category,
      ...(project === undefined ? {} : { project_id: project.id }),
      ...(contract === undefined ? {} : { contract_id: contract }),
      description: finding.description,
      ...(finding.billions === undefined ? {} : { amount_vnd: vnd(finding.billions) }),
      severity: finding.severity,
    });
  }
  findings = await ctx.list(MAKER, `/audit-conclusions/${conclusionId}/findings`);
  const have = await ctx.list(MAKER, '/audit-recommendations', { conclusion_id: conclusionId });
  for (const rec of spec.recs) {
    if (have.some((row) => row.rec_code === rec.code)) continue;
    const finding = findings.find((row) => row.finding_code === rec.finding);
    await ctx.command(MAKER, `/audit-conclusions/${conclusionId}/recommendations`, {
      ...(finding === undefined ? {} : { finding_id: asString(finding.id) }),
      rec_code: rec.code,
      rec_type: rec.type,
      description: rec.description,
      ...(rec.billions === undefined ? {} : { amount_vnd: vnd(rec.billions) }),
    });
  }
  return { id: conclusionId };
}

const recommendationRow = async (ctx: SeedContext, code: string): Promise<Obj | undefined> => (await ctx.list(MAKER, '/audit-recommendations')).find((row) => row.rec_code === code);

/** One recommendation walked along the chain as far as the story takes it: assigned, planned, action done, sent for verification, closed or disputed. */
async function work(ctx: SeedContext, rec: RecSpec): Promise<void> {
  let row = await recommendationRow(ctx, rec.code);
  if (row === undefined) return;
  const id = asString(row.id);
  const refresh = async (): Promise<void> => {
    row = await recommendationRow(ctx, rec.code);
  };
  const status = (): string => asString(row?.status);
  const ordinal = ['RECEIVED', 'ASSIGNED', 'PLANNED', 'ACTION_DONE', 'VERIFYING', 'CLOSED', 'DISPUTED'].indexOf(rec.to);
  if (ordinal >= 1 && ['OPEN', 'RECEIVED'].includes(status())) {
    await ctx.command(CHECKER, `/audit-recommendations/${id}/assignment`, { owner_unit_id: ctx.unitId(rec.unit ?? 'CB-SKHDT-QLDA'), owner_user_id: ctx.person(MAKER).membershipId, due_on: ctx.day(rec.dueIn ?? 15), create_issue: false }, { version: Number(row?.version) });
    await refresh();
  }
  if (rec.to === 'DISPUTED') {
    if (status() === 'ASSIGNED') {
      const explanation = await paper(ctx, { symbol: `GT-${rec.code}/2026`, title: say(T.disputeProof, rec.code), type: 'CV', sender: T.senderUnit, ago: 3 });
      await ctx.command(MAKER, `/audit-recommendations/${id}/dispute`, { dispute_reason: rec.disputeReason, dispute_document_id: explanation.documentId }, { version: Number(row?.version) });
    }
    return;
  }
  let actionId: string | undefined;
  if (ordinal >= 2 && status() === 'ASSIGNED') {
    const planned = await ctx.command(MAKER, `/audit-recommendations/${id}/actions`, { action_code: `${rec.code}-H1`, description: say(T.assignAction, rec.code, rec.description.slice(0, 120)), planned_on: ctx.day(Math.max((rec.dueIn ?? 15) - 5, 1)) }, { version: Number(row?.version) });
    actionId = planned.resource_id;
    await refresh();
  }
  if (ordinal >= 3 && status() === 'IN_PROGRESS') {
    const actions = ((row?.actions ?? []) as Obj[]).filter((action) => action.status === 'PLANNED');
    const proof = await paper(ctx, { symbol: `BCKP-${rec.code}/2026`, title: say(T.actionProof, rec.code), type: 'BC', sender: T.senderUnit, ago: 2 });
    for (const action of actions) await tolerate(ctx, `complete the action of ${rec.code}`, () => ctx.command(MAKER, `/audit-remediation-actions/${asString(action.id)}/completion`, { completed_on: ctx.today, evidence_document_id: proof.documentId }, { version: Number(action.version ?? 1) }));
    void actionId;
    await refresh();
  }
  if (rec.recoveredBillions !== undefined && Number(row?.recovered_vnd ?? 0) === 0) {
    const proof = await paper(ctx, { symbol: `NT-${rec.code}/2026`, title: say(T.recoveryProof, rec.code), type: 'BC', sender: T.senderFinance, ago: 4 });
    await tolerate(ctx, `recovery of ${rec.code}`, () => ctx.command(MAKER, `/audit-recommendations/${id}/recoveries`, { source_kind: 'MANUAL_EVIDENCE', amount_vnd: vnd(rec.recoveredBillions as number), recorded_on: ctx.day(-4), evidence_document_id: proof.documentId }, { version: Number(row?.version) }));
    await refresh();
  }
  if (ordinal >= 4 && status() === 'IN_PROGRESS') {
    await tolerate(ctx, `send ${rec.code} for verification`, () => ctx.command(MAKER, `/audit-recommendations/${id}/verification-request`, {}, { version: Number(row?.version) }));
    await refresh();
  }
  if (rec.to === 'CLOSED' && status() === 'PENDING_VERIFICATION') {
    const basis = await paper(ctx, { symbol: `XN-${rec.code}/2026`, title: say(T.closureBasis, rec.code), type: 'TB', sender: T.senderAuthority, ago: 1 });
    await tolerate(ctx, `verify and close ${rec.code}`, () => ctx.command(OWNER, `/audit-recommendations/${id}/verification`, { decision: 'CLOSE', closure_basis_document_id: basis.documentId, comment: T.closureComment }, { version: Number(row?.version) }));
  }
}

/** AUD-10: the report of the results of the recommendations of a conclusion, asked of DOC as of today. */
async function followUpReport(ctx: SeedContext, spec: EngagementSpec): Promise<void> {
  const row = (await ctx.list(MAKER, '/audit-engagements')).find((candidate) => candidate.engagement_code === spec.code);
  if (row === undefined || row.status !== 'FOLLOW_UP') return;
  const reports = await ctx.list(MAKER, `/audit-engagements/${asString(row.id)}/follow-up-reports`).catch(() => [] as Obj[]);
  if (reports.length > 0) return;
  const conclusion = (await ctx.list(MAKER, `/audit-engagements/${asString(row.id)}/conclusions`))[0];
  if (conclusion === undefined) return;
  await tolerate(ctx, `follow-up report of ${spec.code}`, () => ctx.command(MAKER, `/audit-engagements/${asString(row.id)}/follow-up-reports`, { conclusion_id: asString(conclusion.id), as_of_date: ctx.today, drafting_unit_id: ctx.unitId('CB-SKHDT-QLDA'), place: T.followUpPlace }, { version: Number(row.version) }));
}

/** AUD-09: working papers of the engagement and the proof of a recommendation, attached as evidence. */
async function evidence(ctx: SeedContext, spec: EngagementSpec): Promise<void> {
  if (spec.workingPaper === undefined) return;
  const row = (await ctx.list(MAKER, '/audit-engagements')).find((candidate) => candidate.engagement_code === spec.code);
  if (row === undefined) return;
  const doc = await paper(ctx, { symbol: spec.workingPaper.symbol, title: spec.workingPaper.title, type: 'BB', sender: spec.decision.sender, ago: spec.workingPaper.ago });
  await tolerate(ctx, `evidence of ${spec.code}`, () => ctx.command(MAKER, '/audit-evidence', { owner_kind: 'ENGAGEMENT', owner_id: asString(row.id), document_id: doc.documentId, note: T.evidenceNote }));
}

async function seedAudit(ctx: SeedContext): Promise<void> {
  const existing = await ctx.list(MAKER, '/audit-engagements');
  const done = new Map<string, Obj>();
  for (const spec of ENGAGEMENTS) {
    done.set(spec.code, await ctx.step('AUD', `engagement ${spec.code} (${spec.state})`, () => engagementOf(ctx, spec, existing)));
  }
  for (const spec of ENGAGEMENTS) {
    const engagement = done.get(spec.code);
    if (engagement === undefined || spec.conclusion === undefined) continue;
    const conclusion = spec.conclusion;
    await ctx.step('AUD', `conclusion ${conclusion.symbol}: findings and recommendations`, () => conclusionOf(ctx, conclusion, engagement));
    for (const rec of conclusion.recs) await ctx.step('AUD', `recommendation ${rec.code} (${rec.to})`, () => work(ctx, rec));
    await ctx.step('AUD', `evidence of ${spec.code}`, () => evidence(ctx, spec));
    await ctx.step('AUD', `follow-up report of ${spec.code}`, () => followUpReport(ctx, spec));
  }
}

// ---- AST ---------------------------------------------------------------------------------------------------------------------------------

async function handoverOf(ctx: SeedContext, spec: HandoverSpec, contract: Obj | undefined): Promise<Obj | undefined> {
  if (contract === undefined) {
    ctx.warn(`AST: the contract ${spec.contract} is not there: the handover ${spec.no} is not made`);
    return undefined;
  }
  const existing = await ctx.find(MAKER, '/resources/handover', (row) => row.handover_no === spec.no);
  let handoverId = asString(existing?.id);
  if (existing === undefined) {
    const minutes = await paper(ctx, { symbol: `BB-${spec.no}/2026`, title: spec.title, type: 'BB', sender: T.handoverSender, ago: spec.plannedIn < 0 ? -spec.plannedIn + 3 : 2 });
    const made = await ctx.command(MAKER, '/handovers', {
      project_id: asString(contract.project_id),
      contract_id: asString(contract.id),
      recipient_unit_id: ctx.unitId(spec.unit),
      handover_kind: spec.kind,
      handover_no: spec.no,
      planned_on: ctx.day(spec.plannedIn),
      document_version_id: minutes.versionId,
    });
    handoverId = made.resource_id;
    ctx.record({ module: 'AST', screen: 'AST-01', kind: 'handover', id: handoverId, code: spec.no, note: spec.to });
  }
  if (spec.to === 'DRAFT') return { id: handoverId, contract, spec, status: 'DRAFT' };
  const read = (): Promise<Obj> => ctx.get(MAKER, `/resources/handover/${handoverId}`);
  let detail = await read();
  const items = (): Obj[] => (detail.punch_items ?? detail.items ?? []) as Obj[];
  if (items().length === 0) {
    for (const item of spec.punch) {
      await ctx.command(MAKER, `/handovers/${handoverId}/punch-items`, { description: item.description, severity: item.severity, location_text: item.location, responsible_contractor_id: asString(contract.contractor_id), due_on: ctx.day(item.dueIn) }, { version: Number(detail.version) });
      detail = await read();
    }
  }
  for (const [index, item] of items().entries()) {
    const wanted = spec.punch[index];
    if (wanted === undefined) continue;
    const proof = (): Promise<Paper> => paper(ctx, { symbol: `KP-${spec.no}-${index + 1}/2026`, title: say(T.punchProof, index + 1, spec.no), type: 'BB', sender: T.contractorSender, ago: 1 });
    if (asString(item.status) === 'OPEN' && ['FIXED', 'VERIFIED'].includes(wanted.state)) {
      const doc = await proof();
      await tolerate(ctx, `fix punch item ${index + 1} of ${spec.no}`, () => ctx.command(MAKER, `/punch-items/${asString(item.id)}/fixed`, { evidence_document_version_id: doc.versionId, note: T.punchFixed }));
    }
    if (wanted.state === 'VERIFIED') await tolerate(ctx, `verify punch item ${index + 1} of ${spec.no}`, () => ctx.command(OWNER, `/punch-items/${asString(item.id)}/verify`, { outcome: 'VERIFIED', note: T.punchVerified }));
    if (wanted.state === 'WAIVED' && asString(item.status) === 'OPEN') await tolerate(ctx, `waive punch item ${index + 1} of ${spec.no}`, () => ctx.command(OWNER, `/punch-items/${asString(item.id)}/waive`, { waiver_reason: T.punchWaived }));
  }
  detail = await read();
  if (spec.to === 'ACCEPTED' && asString(detail.status) !== 'ACCEPTED') {
    const asBuilt = await paper(ctx, { symbol: `HSHC-${spec.no}/2026`, title: say(T.asBuilt, spec.no), type: 'BC', sender: T.contractorSender, ago: 4 });
    const manual = await paper(ctx, { symbol: `HDVH-${spec.no}/2026`, title: say(T.manual, spec.no), type: 'BC', sender: T.contractorSender, ago: 4 });
    await tolerate(ctx, `accept ${spec.no}`, () =>
      ctx.command(CHECKER, `/handovers/${handoverId}/decision`, { decision: 'approve', reason: T.acceptReason, evidence_ids: [], as_built_document_version_id: asBuilt.versionId, om_manual_document_version_id: manual.versionId }, { version: Number(detail.version) }),
    );
    detail = await read();
  }
  return { id: handoverId, contract, spec, status: asString(detail.status) };
}

async function assetsAndWarranty(ctx: SeedContext, handover: Obj): Promise<void> {
  const spec = handover.spec as HandoverSpec;
  if (handover.status !== 'ACCEPTED') return;
  const handoverId = asString(handover.id);
  const contract = handover.contract as Obj;
  const known = await ctx.list(MAKER, '/resources/asset_record');
  const made: string[] = [];
  for (const asset of spec.assets ?? []) {
    let row = known.find((candidate) => candidate.asset_code === asset.code);
    if (row === undefined) {
      const created = await tolerate(ctx, `asset ${asset.code}`, () =>
        ctx.command(MAKER, '/asset-records', {
          project_id: asString(contract.project_id),
          handover_id: handoverId,
          asset_code: asset.code,
          name: asset.name,
          source_contract_id: asString(contract.id),
          recipient_unit_id: ctx.unitId(spec.unit),
          value_vnd: vnd(asset.billions),
          value_basis: asset.basis,
          funding_origin: T.fundingOrigin,
          warranty_until: ctx.day(asset.warrantyMonths * 30),
        }),
      );
      if (created === undefined) continue;
      row = { id: created.resource_id, version: created.resource_version };
      ctx.record({ module: 'AST', screen: 'AST-03', kind: 'asset', id: created.resource_id, code: asset.code, note: asset.name });
    }
    made.push(asString(row.id));
  }
  // The first asset (the compressor) is put into service and linked to a maintenance plan.
  const first = made[0];
  if (first !== undefined) {
    const detail = await ctx.get(MAKER, `/resources/asset_record/${first}`);
    if (!detail.transferred_on && !detail.commissioning_document_version_id) {
      const commissioning = await paper(ctx, { symbol: `BBDVSD-${spec.no}/2026`, title: say(T.commissioning, spec.no), type: 'BB', sender: T.handoverSender, ago: 1 });
      await tolerate(ctx, `transfer the asset of ${spec.no}`, () => ctx.command(MAKER, `/asset-records/${first}/transfer`, { transferred_on: ctx.today, commissioning_document_version_id: commissioning.versionId }, { version: Number(detail.version) }));
    }
    const link = await ctx.get(MAKER, `/resources/asset_record/${first}`);
    if (link.om === undefined || link.om === null) {
      const plan = await paper(ctx, { symbol: `KHBT-${spec.no}/2026`, title: say(T.maintenance, spec.no), type: 'KH', sender: T.handoverSender, ago: 1 });
      await tolerate(ctx, `maintenance plan of ${spec.no}`, () => ctx.command(MAKER, `/asset-records/${first}/om-link`, { operator_unit_id: ctx.unitId(spec.unit), om_plan_document_version_id: plan.versionId, maintenance_cycle_months: 6, next_maintenance_due: ctx.day(120) }));
    }
  }
  if (spec.warranty !== undefined) {
    const existing = await ctx.list(MAKER, '/warranty-obligations');
    if (!existing.some((row) => asString(row.handover_id ?? asObj(row.handover).id) === handoverId)) {
      const obligation = await tolerate(ctx, `warranty of ${spec.no}`, () =>
        ctx.command(MAKER, '/warranty-obligations', {
          contract_id: asString(contract.id),
          handover_id: handoverId,
          ...(first === undefined ? {} : { asset_id: first }),
          scope_description: spec.warranty?.scope,
          starts_on: ctx.today,
          period_months: spec.warranty?.months,
          retention_amount_vnd: vndMillions(spec.warranty?.retentionMillions ?? 0),
          construction_grade: 'III',
        }),
      );
      if (obligation !== undefined) ctx.record({ module: 'AST', screen: 'AST-04', kind: 'warranty-obligation', id: obligation.resource_id, code: spec.no, note: `${spec.warranty.months} months` });
    }
  }
}

async function claims(ctx: SeedContext, contractOf: (project: string) => Obj | undefined): Promise<void> {
  const obligations = await ctx.list(MAKER, '/warranty-obligations');
  const existing = await ctx.list(MAKER, '/warranty-claims');
  for (const claim of CLAIMS) {
    const contract = contractOf(claim.project);
    const obligation = obligations.find((row) => asString(row.contract_id ?? asObj(row.contract).id) === asString(contract?.id) && asString(row.status) !== 'CLOSED');
    if (contract === undefined || obligation === undefined) continue;
    let row = existing.find((candidate) => candidate.claim_no === claim.no);
    if (row === undefined) {
      const proof = await paper(ctx, { symbol: `BBKT-${claim.no}/2026`, title: say(T.claimProof, claim.no), type: 'BB', sender: T.handoverSender, ago: claim.ago });
      const filed = await tolerate(ctx, `claim ${claim.no}`, () =>
        ctx.command(MAKER, `/warranty-obligations/${asString(obligation.id)}/claims`, { claim_no: claim.no, reported_on: ctx.day(-claim.ago), defect_description: claim.defect, severity: claim.severity, location_text: claim.location, evidence_document_version_id: proof.versionId, responder_contractor_id: asString(contract.contractor_id) }),
      );
      if (filed === undefined) continue;
      row = { id: filed.resource_id, version: filed.resource_version, status: 'FILED' };
      ctx.record({ module: 'AST', screen: 'AST-05', kind: 'warranty-claim', id: filed.resource_id, code: claim.no, note: claim.to });
    }
    const id = asString(row.id);
    const status = async (): Promise<Obj> => (await ctx.list(MAKER, '/warranty-claims')).find((candidate) => candidate.id === id) ?? row;
    let current = await status();
    if (asObj(current.allowed).acknowledge === true && ['ACKNOWLEDGED', 'FIXED', 'VERIFIED'].includes(claim.to)) {
      await tolerate(ctx, `acknowledge ${claim.no}`, () => ctx.command(MAKER, `/warranty-claims/${id}/acknowledge`, { committed_fix_on: ctx.day(claim.to === 'ACKNOWLEDGED' ? 6 : 0), note: T.claimAck }, { version: Number(current.version) }));
      current = await status();
    }
    if (asObj(current.allowed).fix === true && ['FIXED', 'VERIFIED'].includes(claim.to)) {
      const proof = await paper(ctx, { symbol: `BBSC-${claim.no}/2026`, title: say(T.claimProof, claim.no), type: 'BB', sender: T.contractorSender, ago: 1 });
      await tolerate(ctx, `fix ${claim.no}`, () => ctx.command(MAKER, `/warranty-claims/${id}/fixed`, { fixed_on: ctx.today, evidence_document_version_id: proof.versionId, note: T.claimFixed }, { version: Number(current.version) }));
      current = await status();
    }
    if (asString(current.status) === 'FIXED' && claim.to === 'VERIFIED') {
      await tolerate(ctx, `verify ${claim.no}`, () => ctx.command(OWNER, `/warranty-claims/${id}/verify`, { outcome: 'VERIFIED', cost_borne_by: 'CONTRACTOR', note: T.claimVerified }, { version: Number(current.version) }));
    }
  }
}

async function evaluation(ctx: SeedContext, handovers: Obj[]): Promise<void> {
  const accepted = handovers.find((row) => row.status === 'ACCEPTED');
  if (accepted === undefined) return;
  const projectId = asString((accepted.contract as Obj).project_id);
  const existing = await ctx.list(MAKER, '/evaluation-triggers');
  if (existing.some((row) => asString(row.project_id ?? asObj(row.project).id) === projectId)) return;
  await tolerate(ctx, 'evaluation trigger after the handover', () => ctx.command(MAKER, `/projects/${projectId}/evaluation-triggers`, { trigger_kind: 'POST_HANDOVER_12M', source_handover_id: asString(accepted.id), due_on: ctx.day(365) }));
}

async function seedAsset(ctx: SeedContext): Promise<void> {
  const contracts = await ctx.list(MAKER, '/resources/contract');
  const byCode = new Map(contracts.map((row) => [asString(row.code), row]));
  const done: Obj[] = [];
  for (const spec of HANDOVERS) {
    const result = await ctx.step('AST', `handover ${spec.no} (${spec.to})`, () => handoverOf(ctx, spec, byCode.get(spec.contract)));
    if (result !== undefined) done.push(result);
  }
  for (const handover of done) await ctx.step('AST', `assets and warranty of ${(handover.spec as HandoverSpec).no}`, () => assetsAndWarranty(ctx, handover));
  const contractOf = (project: string): Obj | undefined => contracts.find((row) => asString(row.project_code) === project && asString(row.status) === 'ACTIVE' && /-TB01$/u.test(asString(row.code)));
  await ctx.step('AST', 'warranty claims', () => claims(ctx, contractOf));
  await ctx.step('AST', 'evaluation after handover', () => evaluation(ctx, done));
}

// ---- ADM-02 ------------------------------------------------------------------------------------------------------------------------------

async function seedMembers(ctx: SeedContext): Promise<void> {
  const members = await ctx.list(OWNER, '/resources/membership');
  const roles = await ctx.list(OWNER, '/resources/role_definition');
  for (const member of MEMBERS) {
    const known = members.some((row) => asString(row.email).toLowerCase() === member.email.toLowerCase() || asString(row.display_name) === member.name);
    if (known) continue;
    const role = member.role === undefined ? undefined : roles.find((candidate) => candidate.code === member.role);
    const unitId = ctx.unitId(member.unit);
    const body = { email: member.email, display_name: member.name, organization_unit_id: unitId };
    if (role !== undefined) {
      const withRole = await ctx.call(OWNER, 'POST', '/memberships/invitations', { ...body, initial_grants: [{ role_id: asString(role.id), scope_kind: 'UNIT_ONLY', scope_ref_ids: [unitId] }] });
      if (withRole.ok) continue;
      ctx.warn(`ADM: invitation of ${member.name} with the role ${member.role} refused (HTTP ${withRole.status} ${withRole.text.slice(0, 160)}): invited with the default role`);
    }
    await tolerate(ctx, `invite ${member.name}`, async () => ctx.expectOk(await ctx.call(OWNER, 'POST', '/memberships/invitations', body), `invite ${member.name}`));
  }
}

/**
 * Every person of the guide holds the role MEMBER (inbox, profile): the owner grants it to the others. The shared helper of NOT also grants it to the owner himself, which the product refuses (SELF_GRANT_DENIED; the
 * owner has the inbox through TENANT_OWNER), so the step is done here under the same memory key and the helper finds it done.
 */
async function grantMembers(ctx: SeedContext): Promise<void> {
  await once(ctx, 'iam.member-role', async () => {
    const roles = await ctx.list(OWNER, '/resources/role_definition');
    const member = roles.find((role) => role.code === 'MEMBER');
    if (member === undefined) throw new Error('the system role MEMBER does not exist in the tenant');
    const grants = await ctx.list(OWNER, '/resources/role_grant');
    let granted = 0;
    for (const person of ctx.members) {
      if (person.key === OWNER) continue;
      const holds = grants.some((grant) => grant.membership_id === person.membershipId && grant.role_id === member.id && (grant.status === undefined || grant.status === 'Active'));
      if (holds) continue;
      await ctx.command(OWNER, '/role-grants', { membership_id: person.membershipId, role_id: member.id, scope_kind: 'TENANT', reason: T.memberGrant });
      granted += 1;
    }
    return { granted };
  });
}

// ---- the group ---------------------------------------------------------------------------------------------------------------------------

export async function seedClipEnterpriseAudit(ctx: SeedContext): Promise<void> {
  // First: the workflows of the events, so that the commands below raise notifications for the bell.
  await ctx.step('NOT', 'every person holds the role MEMBER', () => grantMembers(ctx));
  await ctx.step('NOT', 'notification templates and workflows (NOT-05..07)', () => seedNotificationSetup(ctx));
  await ctx.step('ADM', 'members invited into the units (ADM-02)', () => seedMembers(ctx));
  await seedAudit(ctx);
  await seedAsset(ctx);
}
