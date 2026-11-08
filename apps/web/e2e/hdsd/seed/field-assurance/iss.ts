import { randomUUID } from 'node:crypto';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { CHECKER, MAKER, OWNER, asString, ensureWorkCalendar, paper, projectOf, publishMaster, tolerate } from './shared.ts';
import TEXTS from './data/iss.json' with { type: 'json' };
import { textsOf } from '../../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * ISS: the problems of the construction sites and how fast the province answers them. The story: the department defines five kinds of problem and
 * the time it gives to answer each by severity; the project board reports the problems of the three projects (land not handed over, a bridge deck that
 * failed a test, a missing permit, a safety incident, a contractor that lags); some are assigned and worked, one waits for verification, two are closed,
 * and three are escalated to a higher unit or a task force. Severities run from low to critical. The deadlines are counted by the product from the moment of
 * the report, so a problem of a two-hour SLA becomes overdue by itself once the hours pass.
 */

const CATEGORIES = [
  { key: 'GPMB', label: tx('label.001'), unit: 'CB-SKHDT-QLDA' },
  { key: 'CHAT-LUONG', label: tx('label.002'), unit: 'CB-SKHDT-QLDA' },
  { key: 'GIAY-PHEP', label: tx('label.003'), unit: 'CB-SKHDT-VP' },
  { key: 'AN-TOAN-MT', label: tx('label.004'), unit: 'CB-SKHDT-QLDA' },
  { key: 'TIEN-DO', label: tx('label.005'), unit: 'CB-SKHDT-QLDA' },
];

/** The hours of the answer and of the solution, by severity (counted on working days, 07:30 to 17:00). Safety problems are the strictest. */
const HOURS: Record<string, { response: number; resolve: number }> = {
  CRITICAL: { response: 2, resolve: 8 },
  HIGH: { response: 4, resolve: 24 },
  MEDIUM: { response: 8, resolve: 72 },
  LOW: { response: 16, resolve: 120 },
};
const SAFETY_CRITICAL = { response: 1, resolve: 2 };

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface IssueSpec {
  title: string;
  project: string;
  category: string;
  severity: Severity;
  description: string;
  unit?: string;
  /** Who works it (the keys of the guide's people). */
  worker?: 'projectManager' | 'owner';
  /** How far it goes. */
  to: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'PENDING_VERIFICATION' | 'CLOSED';
  comment?: string;
  escalate?: { level: 1 | 2 | 3; unit?: string; reason: string; accept?: boolean };
  extend?: { reason: string };
  position?: { lat: string; lng: string; accuracy: string };
}

const ISSUES: IssueSpec[] = [
  // DA-DT205 - the provincial road 205
  { title: tx('title.006'), project: 'DA-DT205', category: 'GPMB', severity: 'CRITICAL', description: tx('description.007'), to: 'IN_PROGRESS', worker: 'projectManager', comment: tx('comment.008'), escalate: { level: 2, unit: 'CB-SKHDT', reason: tx('reason.009'), accept: true }, position: { lat: '22.665400', lng: '106.257900', accuracy: '12' } },
  { title: tx('title.010'), project: 'DA-DT205', category: 'TIEN-DO', severity: 'HIGH', description: tx('description.011'), to: 'IN_PROGRESS', worker: 'owner', comment: tx('comment.012'), extend: { reason: tx('reason.013') } },
  { title: tx('title.014'), project: 'DA-DT205', category: 'CHAT-LUONG', severity: 'HIGH', description: tx('description.015'), to: 'PENDING_VERIFICATION', worker: 'projectManager', comment: tx('comment.016') },
  { title: tx('title.017'), project: 'DA-DT205', category: 'AN-TOAN-MT', severity: 'CRITICAL', description: tx('description.018'), to: 'IN_PROGRESS', worker: 'projectManager', comment: tx('comment.019'), escalate: { level: 1, reason: tx('reason.020'), accept: false }, position: { lat: '22.701200', lng: '106.301500', accuracy: '8' } },
  { title: tx('title.021'), project: 'DA-DT205', category: 'GIAY-PHEP', severity: 'MEDIUM', description: tx('description.022'), to: 'ASSIGNED', worker: 'projectManager' },
  { title: tx('title.023'), project: 'DA-DT205', category: 'TIEN-DO', severity: 'LOW', description: tx('description.024'), to: 'CLOSED', worker: 'owner', comment: tx('comment.025') },
  // DA-TH012 - the primary school
  { title: tx('title.026'), project: 'DA-TH012', category: 'GPMB', severity: 'MEDIUM', description: tx('description.027'), to: 'IN_PROGRESS', worker: 'owner', comment: tx('comment.028') },
  { title: tx('title.029'), project: 'DA-TH012', category: 'CHAT-LUONG', severity: 'HIGH', description: tx('description.030'), to: 'ASSIGNED', worker: 'projectManager' },
  { title: tx('title.031'), project: 'DA-TH012', category: 'AN-TOAN-MT', severity: 'CRITICAL', description: tx('description.032'), to: 'OPEN' },
  { title: tx('title.033'), project: 'DA-TH012', category: 'GIAY-PHEP', severity: 'MEDIUM', description: tx('description.034'), to: 'CLOSED', worker: 'owner', comment: tx('comment.035') },
  // DA-YT007 - the health station
  { title: tx('title.036'), project: 'DA-YT007', category: 'TIEN-DO', severity: 'LOW', description: tx('description.037'), to: 'OPEN' },
  { title: tx('title.038'), project: 'DA-YT007', category: 'CHAT-LUONG', severity: 'MEDIUM', description: tx('description.039'), to: 'IN_PROGRESS', worker: 'projectManager', comment: tx('comment.040') },
  { title: tx('title.041'), project: 'DA-YT007', category: 'AN-TOAN-MT', severity: 'HIGH', description: tx('description.042'), to: 'IN_PROGRESS', worker: 'owner', comment: tx('comment.043') },
  { title: tx('title.044'), project: 'DA-YT007', category: 'TIEN-DO', severity: 'MEDIUM', description: tx('description.045'), to: 'PENDING_VERIFICATION', worker: 'projectManager', comment: tx('comment.046') },
];

async function categories(ctx: SeedContext): Promise<Map<string, Obj>> {
  const decision = await paper(ctx, { symbol: tx('symbol.047'), title: tx('title.048'), type: 'QD', sender: tx('sender.049'), issuedOn: ctx.day(-45) });
  const result = new Map<string, Obj>();
  for (const category of CATEGORIES) {
    const record = await publishMaster(ctx, { type: 'ISSUE_CATEGORY', key: category.key, label: category.label, attributes: { handler_unit_key: category.unit }, reason: tx('reason.050') }, decision);
    result.set(category.key, record);
  }
  return result;
}

/** The time the department gives to answer a problem, by kind and severity. */
async function publishPolicies(ctx: SeedContext, byKey: Map<string, Obj>): Promise<void> {
  const known = new Set((await ctx.list(MAKER, '/issue-sla-policies')).map((row) => asString(row.code)));
  for (const category of CATEGORIES) {
    for (const severity of Object.keys(HOURS)) {
      const code = `SLA-${category.key}-${severity}`;
      if (known.has(code)) continue;
      const hours = category.key === 'AN-TOAN-MT' && severity === 'CRITICAL' ? SAFETY_CRITICAL : (HOURS[severity] as { response: number; resolve: number });
      const made = await ctx.command(MAKER, '/issue-sla-policies', {
        code,
        category_version_id: byKey.get(category.key)?.version_id,
        severity,
        calendar_code: 'WORKDAY_VN',
        response_hours: hours.response,
        resolve_hours: hours.resolve,
        require_independent_verifier: true,
        require_evidence: false,
        // a policy cannot begin in the past
        valid_from: ctx.today,
      });
      ctx.record({ module: 'ISS', screen: 'ISS-09', kind: 'sla-policy', id: made.resource_id, code, note: `${hours.response}h / ${hours.resolve}h` });
    }
  }
}

async function worker(ctx: SeedContext, issueId: string, workerKey: string, spec: IssueSpec): Promise<void> {
  const read = (): Promise<Obj> => ctx.get(MAKER, `/resources/issue/${issueId}`);
  let issue = await read();
  if (issue.status === 'OPEN' && spec.to !== 'OPEN') {
    await ctx.command(CHECKER, `/issues/${issueId}/assign`, { assignee_id: ctx.person(workerKey).membershipId, note: tx('note.051') }, { version: Number(issue.version) });
    issue = await read();
  }
  if (issue.status === 'ASSIGNED' && ['IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED'].includes(spec.to)) {
    await ctx.command(workerKey, `/issues/${issueId}/start`, { note: tx('note.052') }, { version: Number(issue.version) });
    issue = await read();
  }
  if (spec.comment !== undefined && ['IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED'].includes(spec.to)) {
    const detail = await ctx.get(MAKER, `/resources/issue/${issueId}`);
    const noted = ((detail.timeline ?? detail.events ?? []) as Obj[]).some((event) => event.kind === 'COMMENTED');
    if (!noted) await ctx.command(workerKey, `/issues/${issueId}/comments`, { note: spec.comment });
    issue = await read();
  }
  if (spec.extend !== undefined && issue.status === 'IN_PROGRESS' && Number(issue.reopen_count ?? 0) === 0) {
    const due = new Date(asString(issue.due_at));
    const detail = await ctx.get(MAKER, `/resources/issue/${issueId}`);
    const extended = ((detail.timeline ?? detail.events ?? []) as Obj[]).some((event) => event.kind === 'EXTENDED');
    if (!extended) {
      // one working day after the deadline is within the limit of one SLA
      await tolerate(ctx, `extend ${spec.title}`, () => ctx.command(MAKER, `/issues/${issueId}/extend`, { new_due_at: new Date(due.getTime() + 24 * 3_600_000).toISOString(), reason: spec.extend?.reason }, { version: Number(issue.version) }));
      issue = await read();
    }
  }
  if (spec.escalate !== undefined && ['IN_PROGRESS', 'ASSIGNED', 'ESCALATED'].includes(asString(issue.status)) && Number(issue.escalation_level ?? 0) < spec.escalate.level) {
    const escalated = await tolerate(ctx, `escalate ${spec.title}`, () =>
      ctx.command(MAKER, `/issues/${issueId}/escalate`, { level: spec.escalate?.level, ...(spec.escalate?.unit === undefined ? {} : { target_unit_id: ctx.unitId(spec.escalate.unit) }), reason: spec.escalate?.reason }, { version: Number(issue.version) }),
    );
    if (escalated !== undefined && spec.escalate.accept === true) {
      const detail = await ctx.get(MAKER, `/resources/issue/${issueId}`);
      const open = ((detail.escalations ?? []) as Obj[]).find((row) => row.status === 'OPEN');
      if (open !== undefined) await tolerate(ctx, `accept the escalation of ${spec.title}`, () => ctx.command(CHECKER, `/issue-escalations/${asString(open.id)}/accept`, { note: tx('note.053') }, { version: Number(open.version ?? 1) }));
    }
    issue = await read();
  }
  if (['PENDING_VERIFICATION', 'CLOSED'].includes(spec.to) && issue.status === 'IN_PROGRESS') {
    await ctx.command(workerKey, `/issues/${issueId}/request-verification`, { result_note: spec.comment ?? tx('result_note.054'), evidence_document_version_ids: [] }, { version: Number(issue.version) });
    issue = await read();
  }
  if (spec.to === 'CLOSED' && issue.status === 'PENDING_VERIFICATION') {
    const verifier = workerKey === 'owner' ? MAKER : OWNER;
    await ctx.command(verifier, `/issues/${issueId}/close`, { verification_note: tx('verification_note.055') }, { version: Number(issue.version) });
  }
}

async function reportIssue(ctx: SeedContext, spec: IssueSpec, byKey: Map<string, Obj>, existing: Map<string, Obj>): Promise<string> {
  const found = existing.get(spec.title);
  let issueId: string;
  if (found !== undefined) {
    issueId = asString(found.id);
    ctx.record({ module: 'ISS', screen: 'ISS-01', kind: 'issue', id: issueId, code: asString(found.code), note: 'existing' });
  } else {
    const project = await projectOf(ctx, spec.project);
    const category = byKey.get(spec.category);
    const made = await ctx.command(MAKER, '/issues', {
      project_id: project.id,
      category_version_id: category?.version_id,
      severity: spec.severity,
      title: spec.title,
      description: spec.description,
      owner_unit_id: ctx.unitId(spec.unit ?? 'CB-SKHDT-QLDA'),
      source_module: 'MANUAL',
      client_operation_id: randomUUID(),
      ...(spec.position === undefined ? {} : { geo_consent: true, geo_lat: spec.position.lat, geo_lng: spec.position.lng, geo_accuracy_m: spec.position.accuracy }),
    });
    issueId = made.resource_id;
    ctx.record({ module: 'ISS', screen: 'ISS-01', kind: 'issue', id: issueId, code: spec.title.slice(0, 40), note: spec.severity });
  }
  if (spec.to !== 'OPEN') await worker(ctx, issueId, spec.worker ?? 'projectManager', spec);
  return issueId;
}

/** A problem that reaches the task force of the project (level 3), when the capital group made one. */
async function escalateToTaskForce(ctx: SeedContext, issueId: string): Promise<void> {
  const issue = await ctx.get(MAKER, `/resources/issue/${issueId}`);
  if (Number(issue.escalation_level ?? 0) >= 3 || !['IN_PROGRESS', 'ASSIGNED', 'ESCALATED'].includes(asString(issue.status))) return;
  const forces = await ctx.attempt(MAKER, 'GET', '/resources/task_force');
  const force = (((forces.json.items ?? []) as Obj[]).find((row) => ['ACTIVE', 'Active'].includes(asString(row.status))) ?? undefined);
  if (force === undefined) {
    ctx.warn('no active task force exists (the capital group makes them): the problem stays at level 2');
    return;
  }
  await tolerate(ctx, 'escalate to the task force', () =>
    ctx.command(MAKER, `/issues/${issueId}/escalate`, { level: 3, task_force_id: asString(force.id), reason: tx('reason.056') }, { version: Number(issue.version) }),
  );
}

export async function seedIss(ctx: SeedContext): Promise<void> {
  await ctx.step('ISS', 'the working calendar of the SLAs', () => ensureWorkCalendar(ctx));
  const byKey = await ctx.step('ISS', 'the five kinds of problem (catalogue)', () => categories(ctx));
  await ctx.step('ISS', 'the SLA policies', () => publishPolicies(ctx, byKey));
  const existing = new Map((await ctx.list(MAKER, '/resources/issue')).map((row) => [asString(row.title), row]));
  const ids = new Map<string, string>();
  for (const spec of ISSUES) ids.set(spec.title, await ctx.step('ISS', `issue: ${spec.title.slice(0, 50)}`, () => reportIssue(ctx, spec, byKey, existing)));
  const first = ISSUES[0];
  if (first !== undefined) await ctx.step('ISS', 'escalate the land problem to the task force', () => escalateToTaskForce(ctx, ids.get(first.title) as string));
}
