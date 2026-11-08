import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { vnd } from '../context.ts';
import { CHECKER, MAKER, OWNER, asString, paper, projectOf, tolerate } from './shared.ts';
import { asObj } from '../context.ts';
import TEXTS from './data/aud.json' with { type: 'json' };
import { textsOf } from '../../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * AUD: the inspections and audits of the province and what they leave behind. The story: six engagements. The provincial inspectorate's inspection of the road
 * 205 reached its conclusion; its four findings (procurement, money paid for work not done, concrete quality, procedure) became six recommendations that sit at
 * every stage: unassigned, assigned, with a plan, with the action done, a financial recovery partly recovered, one disputed, one sent for verification, one
 * verified and closed. The state audit of public investment is under way, the internal audit of land clearance waits for its conclusion, the inspection of
 * safety is planned, a supervisory check was cancelled. A second conclusion (internal report on clearance) has its own recommendations.
 */

interface EngagementSpec {
  code: string;
  type: 'ADMINISTRATIVE_INSPECTION' | 'SPECIALIZED_INSPECTION' | 'STATE_AUDIT' | 'INTERNAL_AUDIT' | 'SUPERVISORY_CHECK';
  authorityKind: 'GOVERNMENT_INSPECTORATE' | 'PROVINCIAL_INSPECTORATE' | 'MINISTRY_INSPECTORATE' | 'STATE_AUDIT_OFFICE' | 'INTERNAL';
  authority: string;
  title: string;
  decision: { symbol: string; title: string; ago: number };
  projects: string[];
  from: string;
  to: string;
  state: 'PLANNED' | 'ONGOING' | 'AWAITING' | 'FOLLOW_UP' | 'CANCELLED';
  startedAgo?: number;
  fieldworkEndedAgo?: number;
}

const ENGAGEMENTS: EngagementSpec[] = [
  { code: 'TTT-2026-014', type: 'ADMINISTRATIVE_INSPECTION', authorityKind: 'PROVINCIAL_INSPECTORATE', authority: tx('authority.001'), title: tx('title.002'), decision: { symbol: tx('symbol.003'), title: tx('title.004'), ago: 150 }, projects: ['DA-DT205'], from: '2025-01-01', to: '2025-12-31', state: 'FOLLOW_UP', startedAgo: 130, fieldworkEndedAgo: 85 },
  { code: 'KTNN-2026-03', type: 'STATE_AUDIT', authorityKind: 'STATE_AUDIT_OFFICE', authority: tx('authority.005'), title: tx('title.006'), decision: { symbol: tx('symbol.007'), title: tx('title.008'), ago: 40 }, projects: ['DA-DT205', 'DA-TH012', 'DA-YT007'], from: '2025-01-01', to: '2025-12-31', state: 'ONGOING', startedAgo: 24 },
  { code: 'KTNB-2026-02', type: 'INTERNAL_AUDIT', authorityKind: 'INTERNAL', authority: tx('authority.009'), title: tx('title.010'), decision: { symbol: tx('symbol.011'), title: tx('title.012'), ago: 75 }, projects: ['DA-TH012'], from: '2026-01-01', to: '2026-09-30', state: 'AWAITING', startedAgo: 60, fieldworkEndedAgo: 14 },
  { code: 'TTCN-2026-05', type: 'SPECIALIZED_INSPECTION', authorityKind: 'PROVINCIAL_INSPECTORATE', authority: tx('authority.013'), title: tx('title.014'), decision: { symbol: tx('symbol.015'), title: tx('title.016'), ago: 6 }, projects: ['DA-YT007'], from: '2026-01-01', to: '2026-10-31', state: 'PLANNED' },
  { code: 'KT-2026-07', type: 'SUPERVISORY_CHECK', authorityKind: 'INTERNAL', authority: tx('authority.017'), title: tx('title.018'), decision: { symbol: tx('symbol.019'), title: tx('title.020'), ago: 110 }, projects: ['DA-DT205'], from: '2026-04-01', to: '2026-06-30', state: 'CANCELLED' },
  { code: 'KTNB-2026-04', type: 'INTERNAL_AUDIT', authorityKind: 'INTERNAL', authority: tx('authority.009'), title: tx('title.021'), decision: { symbol: tx('symbol.022'), title: tx('title.023'), ago: 120 }, projects: ['DA-DT205', 'DA-YT007'], from: '2026-01-01', to: '2026-06-30', state: 'FOLLOW_UP', startedAgo: 100, fieldworkEndedAgo: 70 },
];

interface RecSpec {
  code: string;
  type: 'FINANCIAL_RECOVERY' | 'FINANCIAL_ADJUSTMENT' | 'PROCESS_CORRECTION' | 'ACCOUNTABILITY' | 'REFERRAL' | 'POLICY_CHANGE';
  finding?: string;
  description: string;
  billions?: number;
  /** How far it goes. */
  to: 'RECEIVED' | 'ASSIGNED' | 'PLANNED' | 'ACTION_DONE' | 'VERIFYING' | 'CLOSED' | 'DISPUTED';
  dueIn?: number;
  recoveredBillions?: number;
}

interface ConclusionSpec {
  engagement: string;
  kind: 'INSPECTION_CONCLUSION' | 'AUDIT_REPORT' | 'AUDIT_NOTICE' | 'INTERNAL_REPORT';
  symbol: string;
  title: string;
  issuedAgo: number;
  receivedAgo: number;
  implementIn: number;
  reportIn: number;
  summary: string;
  totalBillions: number;
  findings: Array<{ code: string; category: 'FINANCIAL' | 'PROCEDURE' | 'PROCUREMENT' | 'QUALITY' | 'LAND' | 'PLANNING' | 'OTHER'; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; description: string; billions?: number; project?: string }>;
  recs: RecSpec[];
}

const CONCLUSIONS: ConclusionSpec[] = [
  {
    engagement: 'TTT-2026-014',
    kind: 'INSPECTION_CONCLUSION',
    symbol: '08/KL-TTr',
    title: tx('title.024'),
    issuedAgo: 62,
    receivedAgo: 56,
    implementIn: 45,
    reportIn: 55,
    summary: tx('summary.025'),
    totalBillions: 2.15,
    findings: [
      { code: 'PH-01', category: 'PROCUREMENT', severity: 'HIGH', description: tx('description.026'), billions: 0.86, project: 'DA-DT205' },
      { code: 'PH-02', category: 'FINANCIAL', severity: 'CRITICAL', description: tx('description.027'), billions: 1.29, project: 'DA-DT205' },
      { code: 'PH-03', category: 'QUALITY', severity: 'MEDIUM', description: tx('description.028'), project: 'DA-DT205' },
      { code: 'PH-04', category: 'PROCEDURE', severity: 'LOW', description: tx('description.029'), project: 'DA-DT205' },
    ],
    recs: [
      { code: 'KN-01', type: 'FINANCIAL_RECOVERY', finding: 'PH-02', description: tx('description.030'), billions: 1.29, to: 'ACTION_DONE', dueIn: 30, recoveredBillions: 0.8 },
      { code: 'KN-02', type: 'FINANCIAL_ADJUSTMENT', finding: 'PH-01', description: tx('description.031'), billions: 0.86, to: 'PLANNED', dueIn: 40 },
      { code: 'KN-03', type: 'PROCESS_CORRECTION', finding: 'PH-04', description: tx('description.032'), to: 'CLOSED', dueIn: 20 },
      { code: 'KN-04', type: 'ACCOUNTABILITY', finding: 'PH-01', description: tx('description.033'), to: 'VERIFYING', dueIn: 25 },
      { code: 'KN-05', type: 'POLICY_CHANGE', finding: 'PH-03', description: tx('description.034'), to: 'DISPUTED', dueIn: 35 },
      { code: 'KN-06', type: 'PROCESS_CORRECTION', description: tx('description.035'), to: 'RECEIVED' },
    ],
  },
  {
    engagement: 'KTNB-2026-04',
    kind: 'INTERNAL_REPORT',
    symbol: '12/BC-KTNB',
    title: tx('title.036'),
    issuedAgo: 38,
    receivedAgo: 33,
    implementIn: 20,
    reportIn: 25,
    summary: tx('summary.037'),
    totalBillions: 0.34,
    findings: [
      { code: 'NB-01', category: 'PROCEDURE', severity: 'MEDIUM', description: tx('description.038'), project: 'DA-YT007' },
      { code: 'NB-02', category: 'FINANCIAL', severity: 'LOW', description: tx('description.039'), billions: 0.34, project: 'DA-DT205' },
    ],
    recs: [
      { code: 'NB-KN-01', type: 'PROCESS_CORRECTION', finding: 'NB-01', description: tx('description.040'), to: 'ASSIGNED', dueIn: 10 },
      { code: 'NB-KN-02', type: 'FINANCIAL_RECOVERY', finding: 'NB-02', description: tx('description.041'), billions: 0.34, to: 'ASSIGNED', dueIn: 18 },
    ],
  },
];

async function engagementOf(ctx: SeedContext, spec: EngagementSpec, existing: Obj[]): Promise<Obj> {
  let row = existing.find((candidate) => candidate.engagement_code === spec.code);
  if (row === undefined) {
    const decision = await paper(ctx, { symbol: spec.decision.symbol, title: spec.decision.title, type: 'QD', sender: spec.authority, issuedOn: ctx.day(-spec.decision.ago) });
    const scope = [];
    for (const code of spec.projects) scope.push({ kind: 'PROJECT', id: (await projectOf(ctx, code)).id });
    const made = await ctx.command(MAKER, '/audit-engagements', {
      engagement_code: spec.code,
      engagement_type: spec.type,
      authority_kind: spec.authorityKind,
      authority_name: spec.authority,
      decision_document_id: decision.documentId,
      title: spec.title,
      period_from: spec.from,
      period_to: spec.to,
      coordinator_user_id: ctx.person(CHECKER).membershipId,
      scope,
    });
    row = { id: made.resource_id, status: 'PLANNED', version: made.resource_version };
    ctx.record({ module: 'AUD', screen: 'AUD-02', kind: 'audit-engagement', id: made.resource_id, code: spec.code, note: spec.state });
  }
  const read = async (): Promise<Obj> => ctx.get(MAKER, `/audit-engagements/${asString(row?.id)}`);
  let detail = await read();
  if (spec.state === 'CANCELLED' && detail.status === 'PLANNED') {
    await ctx.command(MAKER, `/audit-engagements/${asString(row.id)}/cancellation`, { on_date: ctx.today, reason: tx('reason.042') }, { version: Number(detail.version) });
    return read();
  }
  if (detail.status === 'PLANNED' && spec.startedAgo !== undefined) {
    const start = (hold: boolean): Promise<Awaited<ReturnType<SeedContext['call']>>> => ctx.call(MAKER, 'POST', `/audit-engagements/${asString(row?.id)}/start`, { started_on: ctx.day(-(spec.startedAgo as number)), place_legal_hold: hold }, { version: Number(detail.version) });
    let reply = await start(true);
    if (!reply.ok) reply = await start(false);
    ctx.expectOk(reply, `start ${spec.code}`);
    detail = await read();
  }
  if (detail.status === 'ONGOING' && spec.fieldworkEndedAgo !== undefined) {
    await ctx.command(MAKER, `/audit-engagements/${asString(row.id)}/fieldwork-end`, { on_date: ctx.day(-spec.fieldworkEndedAgo), reason: tx('reason.043') }, { version: Number(detail.version) });
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
      ctx.warn(`AUD: the engagement ${spec.engagement} is ${asString(engagement.status)}, a conclusion cannot be recorded`);
      return undefined;
    }
    const doc = await paper(ctx, { symbol: spec.symbol, title: spec.title, type: 'KL', sender: tx('sender.044'), issuedOn: ctx.day(-spec.issuedAgo) });
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
  let findings = await ctx.list(MAKER, `/audit-conclusions/${conclusionId}/findings`);
  for (const finding of spec.findings) {
    if (findings.some((row) => row.finding_code === finding.code)) continue;
    const project = finding.project === undefined ? undefined : await projectOf(ctx, finding.project);
    await ctx.command(MAKER, `/audit-conclusions/${conclusionId}/findings`, {
      finding_code: finding.code,
      category: finding.category,
      ...(project === undefined ? {} : { project_id: project.id }),
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
  return conclusion;
}

const recommendationRow = async (ctx: SeedContext, code: string): Promise<Obj | undefined> => (await ctx.list(MAKER, '/audit-recommendations')).find((row) => row.rec_code === code);

/** One recommendation walked along the chain as far as the story takes it. */
async function work(ctx: SeedContext, rec: RecSpec): Promise<void> {
  let row = await recommendationRow(ctx, rec.code);
  if (row === undefined) return;
  const id = asString(row.id);
  const refresh = async (): Promise<void> => {
    row = await recommendationRow(ctx, rec.code);
  };
  const status = (): string => asString(row?.status);
  const ordinal = ['RECEIVED', 'ASSIGNED', 'PLANNED', 'ACTION_DONE', 'VERIFYING', 'CLOSED', 'DISPUTED'].indexOf(rec.to);
  if (ordinal >= 1 && ['OPEN', 'RECEIVED', 'NEW', 'PROPOSED'].includes(status())) {
    await ctx.command(CHECKER, `/audit-recommendations/${id}/assignment`, { owner_unit_id: ctx.unitId('CB-SKHDT-QLDA'), owner_user_id: ctx.person(MAKER).membershipId, due_on: ctx.day(rec.dueIn ?? 15), create_issue: false }, { version: Number(row?.version) });
    await refresh();
  }
  if (rec.to === 'DISPUTED') {
    if (status() === 'ASSIGNED') {
      const explanation = await paper(ctx, { symbol: `GT-${rec.code}`, title: tx('title.045', rec.code), type: 'CV', sender: tx('sender.046'), issuedOn: ctx.day(-3) });
      await ctx.command(MAKER, `/audit-recommendations/${id}/dispute`, { dispute_reason: tx('dispute_reason.047'), dispute_document_id: explanation.documentId }, { version: Number(row?.version) });
    }
    return;
  }
  if (ordinal >= 2 && status() === 'ASSIGNED') {
    await ctx.command(MAKER, `/audit-recommendations/${id}/actions`, { action_code: `${rec.code}-H1`, description: tx('description.048', rec.code, rec.description.slice(0, 120)), planned_on: ctx.day(Math.max((rec.dueIn ?? 15) - 5, 1)) }, { version: Number(row?.version) });
    await refresh();
  }
  if (ordinal >= 3 && status() === 'IN_PROGRESS') {
    const detail = await ctx.get(MAKER, `/audit-engagements/${asString(row?.engagement_id ?? asObj(row?.engagement).id ?? '')}`).catch(() => ({}) as Obj);
    void detail;
    const actions = ((row?.actions ?? []) as Obj[]).filter((action) => action.status === 'PLANNED');
    const proof = await paper(ctx, { symbol: `BCKP-${rec.code}`, title: tx('title.049', rec.code), type: 'BC', sender: tx('sender.046'), issuedOn: ctx.day(-2) });
    for (const action of actions) await tolerate(ctx, `complete the action of ${rec.code}`, () => ctx.command(MAKER, `/audit-remediation-actions/${asString(action.id)}/completion`, { completed_on: ctx.today, evidence_document_id: proof.documentId }, { version: Number(action.version) }));
    await refresh();
  }
  if (rec.recoveredBillions !== undefined) {
    const proof = await paper(ctx, { symbol: `NT-${rec.code}`, title: tx('title.050', rec.code), type: 'BC', sender: tx('sender.051'), issuedOn: ctx.day(-4) });
    const links = await ctx.list(MAKER, `/audit-engagements/${asString(row?.engagement_id)}/recovery-links`).catch(() => [] as Obj[]);
    if (links.length === 0) await tolerate(ctx, `recovery of ${rec.code}`, () => ctx.command(MAKER, `/audit-recommendations/${id}/recoveries`, { source_kind: 'TREASURY_REMITTANCE', amount_vnd: vnd(rec.recoveredBillions as number), recorded_on: ctx.day(-4), evidence_document_id: proof.documentId }, { version: Number(row?.version) }));
    await refresh();
  }
  if (ordinal >= 4 && ['IN_PROGRESS', 'ACTIONS_DONE', 'ACTION_DONE'].includes(status())) {
    await tolerate(ctx, `send ${rec.code} for verification`, () => ctx.command(MAKER, `/audit-recommendations/${id}/verification-request`, {}, { version: Number(row?.version) }));
    await refresh();
  }
  if (rec.to === 'CLOSED' && status() === 'PENDING_VERIFICATION') {
    const basis = await paper(ctx, { symbol: `XN-${rec.code}`, title: tx('title.052', rec.code), type: 'KL', sender: tx('sender.053'), issuedOn: ctx.day(-1) });
    await tolerate(ctx, `verify and close ${rec.code}`, () => ctx.command(CHECKER, `/audit-recommendations/${id}/verification`, { decision: 'CLOSE', closure_basis_document_id: basis.documentId, comment: tx('comment.054') }, { version: Number(row?.version) }));
  }
}

export async function seedAud(ctx: SeedContext): Promise<void> {
  const existing = await ctx.list(MAKER, '/audit-engagements');
  const done = new Map<string, Obj>();
  for (const spec of ENGAGEMENTS) {
    try {
      done.set(spec.code, await ctx.step('AUD', `engagement ${spec.code} (${spec.state})`, () => engagementOf(ctx, spec, existing)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/DECISION_DOCUMENT_NOT_EFFECTIVE/u.test(message)) throw error;
      // PRODUCT GAP: a letter received through DOC stays PENDING and no command makes it EFFECTIVE, so no engagement can name its decision.
      ctx.warn('AUD: no engagement can be registered, the decision letter of DOC is never in force (DECISION_DOCUMENT_NOT_EFFECTIVE): the AUD screens stay empty');
      return;
    }
  }
  for (const spec of CONCLUSIONS) {
    const engagement = done.get(spec.engagement);
    if (engagement === undefined) continue;
    await ctx.step('AUD', `conclusion ${spec.symbol}: findings and recommendations`, () => conclusionOf(ctx, spec, engagement));
    for (const rec of spec.recs) await ctx.step('AUD', `recommendation ${rec.code} (${rec.to})`, () => work(ctx, rec));
  }
  void OWNER;
}
