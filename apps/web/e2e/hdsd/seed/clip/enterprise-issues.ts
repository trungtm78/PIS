import { randomUUID } from 'node:crypto';
import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import TEXTS from '../data/enterprise-issues.json' with { type: 'json' };
import { CHECKER, MAKER, OWNER, asString, ensureWorkCalendar, paper, projectOf, publishMaster, tolerate } from '../field-assurance/shared.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-ent-issues`: the operational trouble of the enterprise projects, made with the commands of the product only.
 *
 *  - ISS: the catalogue of kinds of issue (published by a decision of the board), the SLA policies, and eleven issues of the projects and contracts of the plan. The issues are worked at the moment the story says
 *    (the clock of the stack is moved back to the day each one was reported, and put back at the end, always), so the weekly progress (ISS-06) and the weekly matrix (ISS-08) have a trail over several weeks
 *    and the SLA deadlines are overdue or not by themselves. The officer reports and works them, the leader assigns, decides the escalations and confirms the closing, the owner is the second person.
 *  - QMS: the site diaries, inspections, laboratory tests, acceptance minutes and non-conformities of two contracts (a cooling-water plant and a product warehouse).
 *  - PMT: the permits of an industrial plant (construction, design appraisal, environment, fire safety, water, hot work), kept as dossiers of four projects.
 *  Land clearance (LND) is left out on purpose: compensation of households is a public-road story and does not belong to a plant inside an industrial zone.
 *
 * Idempotent: an issue is found by its title, a catalogue entry by its key, a permit by its project and type; a step already taken is read from the state and not taken again. A refusal of a rule
 * of the product is written in the warnings and the story goes on.
 */

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type Stage = 'ASSIGNED' | 'IN_PROGRESS' | 'PENDING_VERIFICATION' | 'CLOSED';

interface StepSpec {
  ago: number;
  to?: Stage;
  comment?: string;
  result?: string;
  closeNote?: string;
  extend?: string;
  escalate?: { level: 1 | 2 | 3; unit?: string; reason: string; accept: boolean };
}
interface IssueSpec {
  key: string;
  title: string;
  description: string;
  project: string;
  contract?: string;
  category: string;
  severity: Severity;
  openedAgo: number;
  claimOf?: string;
  worker?: 'projectManager' | 'owner';
  position?: { lat: string; lng: string; accuracy: string };
  steps: StepSpec[];
}

/** Only for trying the group again on a stack that already holds an earlier try: a suffix on the keys and titles it makes. Empty in the real seed. */
const VARIANT = process.env.CLIP_ISSUES_VARIANT ?? '';

const ISSUES = (TEXTS['iss.issues'] as unknown as IssueSpec[]).map((spec) => ({ ...spec, title: `${spec.title}${VARIANT}`, category: `${spec.category}${VARIANT}` }));
const CATEGORIES = (TEXTS['iss.categories'] as Array<{ key: string; label: string }>).map((category) => ({ ...category, key: `${category.key}${VARIANT}` }));
const HANDLER_UNIT = 'CB-SKHDT-QLDA';

/** The hours of the answer and of the solution, by severity (counted on working days; a plant project takes weeks, not hours). Safety problems are the strictest. */
const HOURS: Record<Severity, { response: number; resolve: number }> = {
  CRITICAL: { response: 2, resolve: 40 },
  HIGH: { response: 4, resolve: 160 },
  MEDIUM: { response: 8, resolve: 240 },
  LOW: { response: 16, resolve: 400 },
};
const SAFETY_CRITICAL = { response: 1, resolve: 24 };

const DAY_MS = 86_400_000;
const text = (key: string, ...values: string[]): string => values.reduce((line, value, index) => line.replace(`{${index}}`, value), String((TEXTS as Record<string, unknown>)[key]));

// ---- the clock of the stack ----------------------------------------------------------------------------------------------------------

const apiBase = (ctx: SeedContext): string => ((process.env.CLIP_API_URL ?? '') === '' ? `http://127.0.0.1:${ctx.info.apiPort}` : String(process.env.CLIP_API_URL).replace(/\/+$/u, ''));

/** The offset (in days) the clock of the stack has from the real day now, or undefined when the stack has no clock route. */
async function clockOffset(ctx: SeedContext): Promise<number | undefined> {
  try {
    const response = await fetch(`${apiBase(ctx)}/__e2e/clock`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { now?: string };
    return typeof body.now === 'string' ? Math.round((Date.parse(body.now) - Date.now()) / DAY_MS) : undefined;
  } catch {
    return undefined;
  }
}

async function setClockOffset(ctx: SeedContext, days: number): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase(ctx)}/__e2e/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offset_days: days }) });
    if (!response.ok) return false;
    await ctx.syncClock();
    return true;
  } catch {
    return false;
  }
}

/** A command that the first person who holds the right can give (the rules keep the actor apart from the assignee, which depends on who works the issue). */
async function commandByAny(ctx: SeedContext, people: string[], path: string, body: Obj, version: number): Promise<boolean> {
  for (const person of people) {
    const reply = await ctx.attempt(person, 'POST', path, body, { version });
    if (reply.ok) return true;
  }
  return false;
}

/** The first reply that is accepted when the command is given by each person in turn (the rules of the product decide who holds the right; the refused tries are not written as warnings). */
async function postByAny(ctx: SeedContext, people: string[], path: string, body: Obj, version?: number): Promise<{ resource_id: string; resource_version: number } | undefined> {
  for (const person of people) {
    const reply = await ctx.call<{ resource_id: string; resource_version: number }>(person, 'POST', path, body, version === undefined ? {} : { version });
    if (reply.ok) return reply.json;
    if (reply.status >= 500) throw new Error(`POST ${path} -> HTTP ${reply.status}`);
  }
  ctx.warn(`${path} was refused for every person tried (${people.join(', ')})`);
  return undefined;
}

// ---- who may confirm and extend ------------------------------------------------------------------------------------------------------------

/**
 * The leader confirms the closing of an issue and grants its extension, but the system roles hold neither right (only the owner of the tenant does). A role of the enterprise gives them to the leader, made and
 * granted by the owner as the BI roles are (IAM commands; the development token of the seed carries the second factor). Idempotent: the role is found by its code, the grant by its holder. The grant is dated by the real
 * day, so while the clock of the stack is back in the past the leader cannot use it yet: the seed lets the second person (or the officer) close and extend, and the leader confirms the pending ones on the day of the demo.
 */
async function grantIssueDecider(ctx: SeedContext): Promise<void> {
  const code = 'XAC_NHAN_VUONG_MAC';
  const existing = await ctx.find(OWNER, '/resources/role_definition', (row) => row.code === code);
  const roleId = existing !== undefined ? asString(existing.id) : (await ctx.command(OWNER, '/roles', { code, name: text('iss.role.name'), permissions: ['issue.read', 'issue.close', 'issue.reopen', 'issue.extend'], rank: 65 })).resource_id;
  const membershipId = ctx.person(CHECKER).membershipId;
  const granted = await ctx.find(OWNER, '/resources/role_grant', (row: Obj) => row.membership_id === membershipId && row.role_id === roleId && asString(row.status).toUpperCase() === 'ACTIVE');
  if (granted === undefined) await ctx.command(OWNER, '/role-grants', { membership_id: membershipId, role_id: roleId, scope_kind: 'TENANT', reason: text('iss.role.reason') });
}

// ---- the catalogue and the policies ----------------------------------------------------------------------------------------------------

async function categories(ctx: SeedContext): Promise<Map<string, Obj>> {
  const decision = await paper(ctx, { symbol: text('iss.decision.symbol'), title: text('iss.decision.title'), type: 'QD', sender: text('iss.decision.sender'), issuedOn: ctx.day(-45) });
  const result = new Map<string, Obj>();
  for (const category of CATEGORIES) {
    const record = await publishMaster(ctx, { type: 'ISSUE_CATEGORY', key: category.key, label: category.label, attributes: { handler_unit_key: HANDLER_UNIT }, reason: text('iss.decision.reason') }, decision);
    result.set(category.key, record);
  }
  return result;
}

async function publishPolicies(ctx: SeedContext, byKey: Map<string, Obj>): Promise<void> {
  const known = new Set((await ctx.list(MAKER, '/issue-sla-policies')).map((row) => asString(row.code)));
  for (const category of CATEGORIES) {
    for (const severity of Object.keys(HOURS) as Severity[]) {
      const code = `SLA-${category.key}-${severity}`;
      if (known.has(code)) continue;
      const hours = category.key === `DN-AN-TOAN-MT${VARIANT}` && severity === 'CRITICAL' ? SAFETY_CRITICAL : HOURS[severity];
      const made = await ctx.command(MAKER, '/issue-sla-policies', {
        code,
        category_version_id: byKey.get(category.key)?.version_id,
        severity,
        calendar_code: 'WORKDAY_VN',
        response_hours: hours.response,
        resolve_hours: hours.resolve,
        require_independent_verifier: true,
        require_evidence: false,
        // a policy cannot begin in the past (of the clock of the stack)
        valid_from: ctx.today,
      });
      ctx.record({ module: 'ISS', screen: 'ISS-09', kind: 'sla-policy', id: made.resource_id, code, note: `${hours.response}h / ${hours.resolve}h` });
    }
  }
}

// ---- the issues ------------------------------------------------------------------------------------------------------------------------------

const eventsOf = (detail: Obj): Obj[] => (detail.timeline ?? detail.events ?? []) as Obj[];

async function claimIdOf(ctx: SeedContext, contractCode: string): Promise<string | undefined> {
  const contract = await ctx.find(MAKER, '/resources/contract', (row) => row.code === contractCode);
  if (contract === undefined) return undefined;
  const claims = await tolerate(ctx, `claims of ${contractCode}`, () => ctx.list(MAKER, '/claims', { contract_id: asString(contract.id) }));
  return claims?.find((row) => row.kind === 'EXTENSION_OF_TIME' || row.kind === undefined)?.id as string | undefined;
}

async function reportIssue(ctx: SeedContext, spec: IssueSpec, byKey: Map<string, Obj>, existing: Map<string, Obj>): Promise<string> {
  const found = existing.get(spec.title);
  if (found !== undefined) {
    ctx.record({ module: 'ISS', screen: 'ISS-01', kind: 'issue', id: asString(found.id), code: asString(found.code), note: 'existing' });
    return asString(found.id);
  }
  const project = await projectOf(ctx, spec.project);
  const contract = spec.contract === undefined ? undefined : await ctx.find(MAKER, '/resources/contract', (row) => row.code === spec.contract);
  const claimId = spec.claimOf === undefined ? undefined : await claimIdOf(ctx, spec.claimOf);
  const body: Obj = {
    project_id: project.id,
    category_version_id: byKey.get(spec.category)?.version_id,
    severity: spec.severity,
    title: spec.title,
    description: spec.description,
    ...(contract === undefined ? {} : { contract_id: asString(contract.id) }),
    owner_unit_id: ctx.unitId(HANDLER_UNIT),
    source_module: 'MANUAL',
    client_operation_id: randomUUID(),
    ...(spec.position === undefined ? {} : { geo_consent: true, geo_lat: spec.position.lat, geo_lng: spec.position.lng, geo_accuracy_m: spec.position.accuracy }),
  };
  let made = claimId === undefined ? undefined : await tolerate(ctx, `issue ${spec.key} with its claim`, () => ctx.command(MAKER, '/issues', { ...body, source_module: 'CTR', source_ref_id: claimId, client_operation_id: randomUUID() }));
  made ??= await ctx.command(MAKER, '/issues', body);
  ctx.record({ module: 'ISS', screen: 'ISS-01', kind: 'issue', id: made.resource_id, code: spec.key, note: `${spec.severity} ${spec.project}` });
  return made.resource_id;
}

/** One step of the story of an issue, taken at the day the clock is on. It is state driven: whatever is already done is read from the issue and left alone. */
async function takeStep(ctx: SeedContext, issueId: string, spec: IssueSpec, step: StepSpec): Promise<void> {
  const workerKey = spec.worker ?? 'projectManager';
  const read = (): Promise<Obj> => ctx.get(MAKER, `/resources/issue/${issueId}`);
  let issue = await read();
  const to = step.to;
  if (to !== undefined && issue.status === 'OPEN') {
    await ctx.command(CHECKER, `/issues/${issueId}/assign`, { assignee_id: ctx.person(workerKey).membershipId, note: text('iss.note.assign') }, { version: Number(issue.version) });
    issue = await read();
  }
  if (to !== undefined && to !== 'ASSIGNED' && issue.status === 'ASSIGNED') {
    await ctx.command(workerKey, `/issues/${issueId}/start`, { note: text('iss.note.start') }, { version: Number(issue.version) });
    issue = await read();
  }
  if (step.comment !== undefined && ['IN_PROGRESS', 'ESCALATED', 'PENDING_VERIFICATION', 'CLOSED'].includes(asString(issue.status))) {
    const wanted = spec.steps.filter((candidate) => candidate.comment !== undefined && spec.steps.indexOf(candidate) <= spec.steps.indexOf(step)).length;
    const have = eventsOf(await ctx.get(MAKER, `/resources/issue/${issueId}`)).filter((event) => event.kind === 'COMMENTED').length;
    if (have < wanted) await ctx.command(workerKey, `/issues/${issueId}/comments`, { note: step.comment });
    issue = await read();
  }
  if (step.extend !== undefined && issue.status === 'IN_PROGRESS' && !eventsOf(await ctx.get(MAKER, `/resources/issue/${issueId}`)).some((event) => event.kind === 'EXTENDED')) {
    // one more working day after the later of the deadline and now is within the limit of one SLA; the assignee never extends their own deadline
    const from = Math.max(Date.parse(asString(issue.due_at)), ctx.asOf.getTime());
    const done = await commandByAny(ctx, [workerKey === 'owner' ? MAKER : OWNER, CHECKER], `/issues/${issueId}/extend`, { new_due_at: new Date(from + DAY_MS).toISOString(), reason: step.extend }, Number(issue.version));
    if (!done) ctx.warn(`extension of ${spec.key} was refused`);
    issue = await read();
  }
  const escalate = step.escalate;
  if (escalate !== undefined && ['IN_PROGRESS', 'ASSIGNED', 'ESCALATED'].includes(asString(issue.status)) && Number(issue.escalation_level ?? 0) < escalate.level) {
    const escalated = await tolerate(ctx, `escalate ${spec.key}`, () =>
      ctx.command(MAKER, `/issues/${issueId}/escalate`, { level: escalate.level, ...(escalate.unit === undefined ? {} : { target_unit_id: ctx.unitId(escalate.unit) }), reason: escalate.reason }, { version: Number(issue.version) }),
    );
    if (escalated !== undefined && escalate.accept) {
      const detail = await ctx.get(MAKER, `/resources/issue/${issueId}`);
      const open = ((detail.escalations ?? []) as Obj[]).find((row) => row.status === 'OPEN');
      if (open !== undefined) await tolerate(ctx, `accept the escalation of ${spec.key}`, () => ctx.command(CHECKER, `/issue-escalations/${asString(open.id)}/accept`, { note: text('iss.note.accept') }, { version: Number(open.version ?? 1) }));
    }
    issue = await read();
  }
  if ((to === 'PENDING_VERIFICATION' || to === 'CLOSED') && issue.status === 'IN_PROGRESS') {
    await ctx.command(workerKey, `/issues/${issueId}/request-verification`, { result_note: step.result ?? text('iss.note.resultDefault'), evidence_document_version_ids: [] }, { version: Number(issue.version) });
    issue = await read();
  }
  if (to === 'CLOSED' && issue.status === 'PENDING_VERIFICATION') {
    const closed = await commandByAny(ctx, [workerKey === 'owner' ? MAKER : OWNER, CHECKER], `/issues/${issueId}/close`, { verification_note: step.closeNote ?? text('iss.note.closeDefault') }, Number(issue.version));
    if (!closed) ctx.warn(`closing of ${spec.key} was refused`);
  }
}

async function seedIssues(ctx: SeedContext): Promise<void> {
  const phases = [...new Set(ISSUES.flatMap((spec) => [spec.openedAgo, ...spec.steps.map((step) => step.ago)]))].sort((a, b) => b - a);
  const base = await clockOffset(ctx);
  const canMove = base !== undefined;
  if (!canMove) ctx.warn('the stack has no clock: every issue is reported today and the weekly trail has one week');
  const ids = new Map<string, string>();
  let byKey: Map<string, Obj> | undefined;
  try {
    for (const ago of phases) {
      if (canMove && !(await setClockOffset(ctx, base - ago))) ctx.warn(`the clock of the stack could not be moved to day -${ago}`);
      if (byKey === undefined) {
        await ensureWorkCalendar(ctx);
        await ctx.step('IAM', 'role of the leader to confirm and extend issues', () => grantIssueDecider(ctx));
        const catalogue = await ctx.step('ISS', 'kinds of issue (catalogue)', () => categories(ctx));
        byKey = catalogue;
        await ctx.step('ISS', 'SLA policies', () => publishPolicies(ctx, catalogue));
      }
      const existing = new Map((await ctx.list(MAKER, '/resources/issue')).map((row) => [asString(row.title), row]));
      for (const spec of ISSUES) {
        if (spec.openedAgo === ago) ids.set(spec.key, await ctx.step('ISS', `issue ${spec.key}: ${spec.title.slice(0, 50)}`, () => reportIssue(ctx, spec, byKey as Map<string, Obj>, existing)));
        const issueId = ids.get(spec.key);
        if (issueId === undefined) continue;
        for (const step of spec.steps) if (step.ago === ago) await ctx.step('ISS', `${spec.key} at day -${ago}`, () => takeStep(ctx, issueId, spec, step));
      }
    }
  } finally {
    if (canMove && !(await setClockOffset(ctx, base))) ctx.warn('THE CLOCK OF THE STACK COULD NOT BE PUT BACK: set it with POST /__e2e/clock {"offset_days":0}');
  }
}

// ---- QMS: diaries, inspections, laboratory, non-conformities -----------------------------------------------------------------------------

type Inspection = 'MATERIAL_ENTRY' | 'CONCEALED_WORK' | 'CONSTRUCTION_STAGE' | 'PART_ACCEPTANCE' | 'COMPLETION' | 'SAFETY' | 'OTHER';
const CHECKLIST_CODES: Record<Inspection, string[]> = {
  MATERIAL_ENTRY: ['ORIGIN', 'SAMPLE'],
  CONCEALED_WORK: ['DRAWING', 'QUALITY', 'RECORD'],
  CONSTRUCTION_STAGE: ['DRAWING', 'QUALITY'],
  PART_ACCEPTANCE: ['DRAWING', 'QUALITY'],
  COMPLETION: ['DRAWING', 'QUALITY', 'DOSSIER'],
  SAFETY: ['MEASURES', 'EQUIPMENT'],
  OTHER: ['CONTENT'],
};
interface InspectionSpec {
  title: string;
  type: Inspection;
  location: string;
  requestedAgo: number;
  to: 'REQUESTED' | 'SCHEDULED' | 'PASS' | 'FAIL' | 'CONDITIONAL' | 'CANCELLED';
  note?: string;
}
interface MaterialSpec {
  sample: string;
  kind: string;
  lab: string;
  standard: string;
  ago: number;
  result?: 'PASS' | 'FAIL';
}
interface NcrSpec {
  contract: 'pump' | 'store';
  materialSample?: string;
  inspectionTitle?: string;
  title: string;
  description: string;
  severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
  source: 'INSPECTION' | 'MATERIAL_TEST' | 'SUPERVISOR_REMARK' | 'SELF_REPORT' | 'AUDIT';
  owner: 'projectManager' | 'owner';
  dueIn: number;
  to: 'OPEN' | 'ACTION' | 'EVIDENCE' | 'CLOSED';
  action: string;
}

const WEATHER = ['SUNNY', 'SUNNY', 'CLOUDY', 'RAIN', 'SUNNY', 'HEAVY_RAIN', 'CLOUDY'];

async function diaries(ctx: SeedContext, contract: Obj, work: string[], equipment: string, spec: { daysBack: number; skipRecent: number; keepEvery: number }): Promise<void> {
  const contractId = asString(contract.id);
  const have = new Set((await ctx.list(MAKER, '/resources/site_diary', { contract_id: contractId })).map((row) => asString(row.record_date)));
  let made = 0;
  for (let ago = spec.daysBack; ago >= spec.skipRecent; ago -= 1) {
    const date = ctx.day(-ago);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || have.has(date) || (ago % spec.keepEvery !== 0 && spec.keepEvery > 1)) continue;
    const saved = await tolerate(ctx, `diary ${asString(contract.code)} ${date}`, () =>
      ctx.command(MAKER, '/site-diaries', {
        contract_id: contractId,
        record_date: date,
        client_operation_id: randomUUID(),
        content: {
          summary: work[ago % work.length],
          weather_code: WEATHER[ago % WEATHER.length],
          workforce_count: 42 + (ago % 6) * 5,
          notes: ago % 5 === 0 ? text('qms.issues.rain') : text('qms.issues.none'),
          equipment,
        },
      }),
    );
    if (saved !== undefined) made += 1;
  }
  ctx.record({ module: 'QMS', screen: 'QMS-01', kind: 'site-diaries', id: contractId, code: asString(contract.code), note: `${made} drafts` });
}

/** Runs `run` with the clock of the stack on the day `ago` days back (when the stack has a clock), and always puts it back. */
async function atDay<T>(ctx: SeedContext, base: number | undefined, ago: number, run: () => Promise<T>): Promise<T> {
  if (base === undefined || ago <= 0) return run();
  const moved = await setClockOffset(ctx, base - ago);
  try {
    return await run();
  } finally {
    if (moved && !(await setClockOffset(ctx, base))) ctx.warn('THE CLOCK OF THE STACK COULD NOT BE PUT BACK: set it with POST /__e2e/clock {"offset_days":0}');
  }
}

async function inspections(ctx: SeedContext, contract: Obj, list: InspectionSpec[], base: number | undefined): Promise<Obj[]> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/inspections', { contract_id: contractId });
  const results: Obj[] = [];
  for (const spec of list) {
    // An inspection that was held (or cancelled) is made on the day it was requested: the product refuses to schedule a moment that has passed.
    const past = ['PASS', 'FAIL', 'CONDITIONAL', 'CANCELLED'].includes(spec.to);
    const detail = await atDay(ctx, base, past ? spec.requestedAgo : 0, () => oneInspection(ctx, contractId, existing, spec));
    if (detail !== undefined) results.push(detail);
  }
  return results;
}

async function oneInspection(ctx: SeedContext, contractId: string, existing: Obj[], spec: InspectionSpec): Promise<Obj | undefined> {
  let row = existing.find((candidate) => candidate.title === spec.title);
  if (row === undefined) {
    const made = await tolerate(ctx, `inspection ${spec.title}`, () => ctx.command(MAKER, '/inspections', { contract_id: contractId, inspection_type: spec.type, title: spec.title, location_text: spec.location, requested_for: ctx.day(spec.to === 'SCHEDULED' || spec.to === 'REQUESTED' ? 2 : 1) }));
    if (made === undefined) return undefined;
    row = { id: made.resource_id, status: 'REQUESTED', version: made.resource_version, title: spec.title };
    ctx.record({ module: 'QMS', screen: 'QMS-04', kind: 'inspection', id: made.resource_id, code: spec.title.slice(0, 40), note: spec.to });
  }
  const id = asString(row.id);
  const read = (): Promise<Obj> => ctx.get(MAKER, `/inspections/${id}`);
  let detail = await read();
  if (detail.status === 'REQUESTED' && ['SCHEDULED', 'PASS', 'FAIL', 'CONDITIONAL'].includes(spec.to)) {
    await tolerate(ctx, `schedule ${spec.title}`, () =>
      ctx.command(MAKER, `/inspections/${id}/schedule`, { scheduled_at: new Date(ctx.asOf.getTime() + (spec.to === 'SCHEDULED' ? 2 * DAY_MS : 3_600_000)).toISOString(), participant_membership_ids: [ctx.person(CHECKER).membershipId, ctx.person(OWNER).membershipId] }, { version: Number(detail.version) }),
    );
    detail = await read();
  }
  if (detail.status === 'SCHEDULED' && ['PASS', 'FAIL', 'CONDITIONAL'].includes(spec.to)) {
    const outcome = spec.to === 'PASS' ? 'PASS' : 'FAIL';
    await tolerate(ctx, `record the result of ${spec.title}`, () =>
      ctx.command(
        MAKER,
        `/inspections/${id}/result`,
        { result: spec.to, result_note: spec.note ?? text('qms.note.sampleResultDefault'), checklist: CHECKLIST_CODES[spec.type].map((code, index) => ({ code, outcome: spec.to === 'PASS' || index > 0 ? 'PASS' : outcome, note: spec.to === 'PASS' ? text('qms.note.itemPass') : index === 0 ? spec.note : text('qms.note.itemPass') })) },
        { version: Number(detail.version) },
      ),
    );
    detail = await read();
  }
  if (spec.to === 'CANCELLED' && asString(detail.status) !== 'CANCELLED') {
    await tolerate(ctx, `cancel ${spec.title}`, () => ctx.command(MAKER, `/inspections/${id}/cancel`, { reason: spec.note ?? text('qms.reason.cancel') }, { version: Number(detail.version) }));
    detail = await read();
  }
  return detail;
}

/** The minutes of an accepted inspection, signed by the supervisor and the owner; the contractor's signature and the leader's approval are still to come. */
async function acceptances(ctx: SeedContext, passed: Obj[]): Promise<void> {
  const existing = (await tolerate(ctx, 'list the acceptance minutes', () => ctx.list(CHECKER, '/quality-acceptances'))) ?? [];
  let n = existing.length;
  for (const [index, inspection] of passed.entries()) {
    if (index >= 2) break;
    const id = asString(inspection.id);
    if (existing.some((row) => asString(row.inspection_id ?? asObj(row.inspection).id) === id)) continue;
    n += 1;
    const minutes = await paper(ctx, { symbol: `BB-NTCL-${String(n).padStart(3, '0')}`, title: text('qms.minutes.title', asString(inspection.title)), type: 'BB', sender: text('qms.sender.project'), issuedOn: ctx.day(-5) });
    const made = await postByAny(ctx, [CHECKER, OWNER, MAKER], `/inspections/${id}/quality-acceptances`, { acceptance_scope: asString(inspection.inspection_type) === 'CONSTRUCTION_STAGE' ? 'STAGE' : 'WORK_ITEM', record_no: `BB-NTCL-${ctx.year}-${String(n).padStart(3, '0')}`, document_version_id: minutes.versionId });
    if (made === undefined) continue;
    ctx.record({ module: 'QMS', screen: 'QMS-05', kind: 'quality-acceptance', id: made.resource_id, code: `BB-NTCL-${n}`, note: 'minutes drawn up' });
    if (index === 0) {
      const signers: Array<[string, string]> = [
        [CHECKER, 'SUPERVISOR'],
        [OWNER, 'OWNER'],
      ];
      for (const [person, role] of signers) {
        const current = await tolerate(ctx, 'read the acceptance minutes', () => ctx.get(person, `/quality-acceptances/${made.resource_id}`));
        await postByAny(ctx, [person], `/quality-acceptances/${made.resource_id}/sign`, { signer_role: role, signature_method: 'IN_APP_OTP', client_operation_id: randomUUID() }, Number(current?.version ?? made.resource_version));
      }
    }
  }
}

async function materials(ctx: SeedContext, contract: Obj, list: MaterialSpec[]): Promise<void> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/material-tests', { contract_id: contractId });
  for (const material of list) {
    let row = existing.find((candidate) => candidate.sample_code === material.sample);
    if (row === undefined) {
      const made = await tolerate(ctx, `material test ${material.sample}`, () => ctx.command(MAKER, '/material-tests', { contract_id: contractId, sample_code: material.sample, material_kind: material.kind, lab_name: material.lab, standard_ref: material.standard, sampled_on: ctx.day(-material.ago) }));
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'REGISTERED', version: made.resource_version };
      ctx.record({ module: 'QMS', screen: 'QMS-06', kind: 'material-test', id: made.resource_id, code: material.sample, note: material.result ?? 'waiting for the laboratory' });
    }
    if (material.result !== undefined && !['PASS', 'FAIL'].includes(asString(row.result ?? row.status))) {
      const report = await paper(ctx, { symbol: `KQTN-${material.sample}`, title: text('qms.lab.report', material.sample), type: 'BC', sender: material.lab, issuedOn: ctx.day(-(material.ago - 5)) });
      await tolerate(ctx, `result of ${material.sample}`, () =>
        ctx.command(MAKER, `/material-tests/${asString(row?.id)}/result`, {
          result: material.result,
          tested_on: ctx.day(-(material.ago - 5)),
          result_values: material.result === 'PASS' ? { ket_qua: text('qms.lab.pass') } : { ket_qua: text('qms.lab.fail') },
          report_document_version_id: report.versionId,
        }, { version: Number(row?.version ?? 1) }),
      );
    }
  }
}

async function nonconformances(ctx: SeedContext, contracts: Record<'pump' | 'store', Obj>): Promise<void> {
  for (const spec of TEXTS['qms.ncrs'] as unknown as NcrSpec[]) {
    const contractId = asString(contracts[spec.contract].id);
    const existing = await ctx.list(MAKER, '/resources/quality_nonconformance', { contract_id: contractId });
    let row = existing.find((candidate) => candidate.title === spec.title);
    if (row === undefined) {
      const sample = spec.materialSample === undefined ? undefined : (await ctx.list(MAKER, '/material-tests', { contract_id: contractId })).find((candidate) => candidate.sample_code === spec.materialSample);
      const inspection = spec.inspectionTitle === undefined ? undefined : (await ctx.list(MAKER, '/inspections', { contract_id: contractId })).find((candidate) => candidate.title === spec.inspectionTitle);
      const made = await tolerate(ctx, `non-conformity ${spec.title}`, () =>
        ctx.command(MAKER, '/nonconformances', {
          contract_id: contractId,
          ...(sample === undefined ? {} : { material_test_id: asString(sample.id) }),
          ...(inspection === undefined ? {} : { inspection_id: asString(inspection.id) }),
          severity: spec.severity,
          title: spec.title,
          description: spec.description,
          source_kind: spec.source,
          action_owner_id: ctx.person(spec.owner).membershipId,
          due_at: new Date(Date.now() + Math.max(spec.dueIn, 1) * DAY_MS).toISOString(),
        }),
      );
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'OPEN' };
      ctx.record({ module: 'QMS', screen: 'QMS-07', kind: 'nonconformance', id: made.resource_id, code: spec.title.slice(0, 40), note: spec.severity });
    }
    const id = asString(row.id);
    const read = (): Promise<Obj> => ctx.get(MAKER, `/resources/quality_nonconformance/${id}`);
    let detail = await read();
    const actions = (): Obj[] => (detail.corrective_actions ?? detail.actions ?? []) as Obj[];
    if (spec.to !== 'OPEN' && actions().length === 0) {
      await postByAny(ctx, [MAKER, CHECKER, OWNER], `/nonconformances/${id}/corrective-actions`, { description: spec.action, owner_membership_id: ctx.person(spec.owner).membershipId, due_at: new Date(Date.now() + Math.max(spec.dueIn, 1) * DAY_MS).toISOString() }, Number(detail.version));
      detail = await read();
    }
    const action = actions()[0];
    if (['EVIDENCE', 'CLOSED'].includes(spec.to) && action !== undefined && ['OPEN', 'ASSIGNED', 'PENDING'].includes(asString(action.status))) {
      const proof = await paper(ctx, { symbol: `KP-${id.slice(0, 8)}`, title: text('qms.remedy.title', spec.title), type: 'BB', sender: text('qms.sender.contractor'), issuedOn: ctx.day(-2) });
      await tolerate(ctx, `evidence of ${spec.title}`, () => ctx.command(spec.owner, `/corrective-actions/${asString(action.id)}/evidence`, { evidence_document_version_id: proof.versionId, note: text('qms.remedy.note') }));
      detail = await read();
    }
    const after = actions()[0];
    if (spec.to === 'CLOSED' && after !== undefined && asString(after.status) !== 'VERIFIED') {
      await postByAny(ctx, [spec.owner === 'owner' ? MAKER : OWNER, CHECKER], `/corrective-actions/${asString(after.id)}/verify`, { outcome: 'VERIFIED', verification_note: text('qms.verify.note') });
      detail = await read();
    }
    if (spec.to === 'CLOSED' && asString(detail.status) !== 'CLOSED') {
      await postByAny(ctx, [MAKER, CHECKER, OWNER], `/nonconformances/${id}/close`, { closure_note: text('qms.close.note') }, Number(detail.version));
    }
  }
}

async function seedQuality(ctx: SeedContext): Promise<void> {
  const pump = await ctx.find(MAKER, '/resources/contract', (row) => row.code === 'HD-PMDT105-XL01');
  const store = await ctx.find(MAKER, '/resources/contract', (row) => row.code === 'HD-PMDT114-XL01');
  if (pump === undefined || store === undefined) {
    ctx.warn('QMS: the contracts HD-PMDT105-XL01 and HD-PMDT114-XL01 do not exist (the contracts group makes them): the quality screens stay empty');
    return;
  }
  const base = await clockOffset(ctx);
  await ctx.step('QMS', 'site diaries of HD-PMDT105-XL01', () => diaries(ctx, pump, TEXTS['qms.work.pump'], text('qms.equipment.pump'), { daysBack: 18, skipRecent: 2, keepEvery: 1 }));
  await ctx.step('QMS', 'site diaries of HD-PMDT114-XL01', () => diaries(ctx, store, TEXTS['qms.work.store'], text('qms.equipment.store'), { daysBack: 14, skipRecent: 7, keepEvery: 2 }));
  const pumpResults = await ctx.step('QMS', 'inspections of HD-PMDT105-XL01', () => inspections(ctx, pump, TEXTS['qms.inspections.pump'] as unknown as InspectionSpec[], base));
  const storeResults = await ctx.step('QMS', 'inspections of HD-PMDT114-XL01', () => inspections(ctx, store, TEXTS['qms.inspections.store'] as unknown as InspectionSpec[], base));
  const passed = [...pumpResults, ...storeResults].filter((row) => asString(row.result) === 'PASS' || asString(row.status) === 'PASSED');
  await ctx.step('QMS', 'minutes of acceptance', () => acceptances(ctx, passed));
  await ctx.step('QMS', 'material tests of HD-PMDT114-XL01', () => materials(ctx, store, TEXTS['qms.materials'] as unknown as MaterialSpec[]));
  await ctx.step('QMS', 'non-conformities', () => nonconformances(ctx, { pump, store }));
}

// ---- PMT: the permits of an industrial plant ------------------------------------------------------------------------------------------------

interface TypeSpec {
  code: string;
  name: string;
  category: string;
  authority: string;
  basis: string;
  validityMonths?: number;
  processingDays?: number;
  exemptionAllowed?: boolean;
  appliesTo: Obj;
}
interface PlanSpec {
  type: string;
  to: 'ISSUED' | 'IN_APPRAISAL' | 'SUBMITTED' | 'SUPPLEMENT_REQUESTED' | 'REJECTED_THEN_FILED' | 'EXEMPTED' | 'PLANNED';
  submitted?: number;
  no?: string;
  issued?: number;
  endsIn?: number;
  note?: string;
}

const permitTypes = async (ctx: SeedContext): Promise<Map<string, Obj>> => new Map((await ctx.list(MAKER, '/resources/permit_type')).map((row) => [asString(row.code), row]));
const dossierDetail = (ctx: SeedContext, id: string): Promise<Obj> => ctx.get(MAKER, `/resources/permit_dossier/${id}`);
const permitDetail = (ctx: SeedContext, id: string): Promise<Obj> => ctx.get(MAKER, `/resources/permit/${id}`);
const openPermitOf = (dossier: Obj, type: string, statuses: string[]): Obj | undefined => (dossier.permits as Obj[]).find((permit) => permit.permit_type_code === type && statuses.includes(asString(permit.status)));

async function publishTypes(ctx: SeedContext): Promise<void> {
  const known = await permitTypes(ctx);
  for (const type of TEXTS['pmt.types'] as unknown as TypeSpec[]) {
    if (known.has(type.code)) continue;
    const made = await ctx.command(MAKER, '/permit-types', {
      code: type.code,
      name: type.name,
      category: type.category,
      authority_text: type.authority,
      legal_basis: type.basis,
      effective_from: '2026-01-01',
      applies_to_rule: type.appliesTo,
      ...(type.validityMonths === undefined ? {} : { default_validity_months: type.validityMonths }),
      ...(type.processingDays === undefined ? {} : { default_processing_days: type.processingDays }),
      exemption_allowed: type.exemptionAllowed === true,
    });
    ctx.record({ module: 'PMT', screen: 'PMT-03', kind: 'permit-type', id: made.resource_id, code: type.code, note: 'published' });
  }
}

async function openDossier(ctx: SeedContext, projectCode: string): Promise<string> {
  const project = await projectOf(ctx, projectCode);
  const found = await ctx.find(MAKER, '/resources/permit_dossier', (row) => row.project_id === project.id);
  if (found !== undefined) return asString(found.id);
  const made = await ctx.command(MAKER, `/projects/${project.id}/permit-dossiers`, { owner_unit_id: ctx.unitId(HANDLER_UNIT), owner_membership_id: ctx.person(MAKER).membershipId });
  ctx.record({ module: 'PMT', screen: 'PMT-01', kind: 'permit-dossier', id: made.resource_id, code: projectCode, note: 'opened' });
  return made.resource_id;
}

async function milestone(ctx: SeedContext, permitId: string, step: string, body: Obj): Promise<void> {
  const permit = await permitDetail(ctx, permitId);
  await ctx.command(MAKER, `/permits/${permitId}/milestones`, { step_code: step, ...body }, { version: Number(permit.version) });
}

async function submitAndAcknowledge(ctx: SeedContext, permitId: string, submittedAgo: number, tag: string): Promise<void> {
  const first = await paper(ctx, { symbol: `HS-${tag}/${ctx.year}`, title: text('pmt.title.dossier', tag), type: 'CV', sender: text('pmt.sender.office'), issuedOn: ctx.day(-submittedAgo) });
  await milestone(ctx, permitId, 'SUBMITTED', { actual_on: ctx.day(-submittedAgo), note: text('pmt.note.submit'), document_version_id: first.versionId });
  await milestone(ctx, permitId, 'ACKNOWLEDGED', { actual_on: ctx.day(-Math.max(submittedAgo - 2, 0)), note: text('pmt.note.ack') });
}

async function issuePermit(ctx: SeedContext, permitId: string, projectCode: string, plan: PlanSpec): Promise<void> {
  const licence = await paper(ctx, { symbol: `${plan.no ?? 'GP'}/${projectCode}/${plan.type}`, title: text('pmt.title.permit', plan.type, plan.no ?? '', projectCode), type: 'GP', sender: text('pmt.sender.authority'), issuedOn: ctx.day(-(plan.issued ?? 30)) });
  const issuedOn = ctx.day(-(plan.issued ?? 30));
  const permit = await permitDetail(ctx, permitId);
  await ctx.command(
    MAKER,
    `/permits/${permitId}/decision`,
    { outcome: 'ISSUED', permit_no: plan.no, issued_on: issuedOn, valid_from: issuedOn, ...(plan.endsIn === undefined ? { no_expiry: true } : { valid_until: ctx.day(plan.endsIn) }), document_version_id: licence.versionId },
    { version: Number(permit.version) },
  );
}

async function workPermit(ctx: SeedContext, projectCode: string, dossierId: string, plan: PlanSpec): Promise<void> {
  let dossier = await dossierDetail(ctx, dossierId);
  const planned = openPermitOf(dossier, plan.type, ['PLANNED']);
  const tag = `${projectCode}-${plan.type}`;
  const present = (statuses: string[]): Obj | undefined => openPermitOf(dossier, plan.type, statuses);
  const record = (permit: Obj | undefined, note: string): void => ctx.record({ module: 'PMT', screen: 'PMT-02', kind: 'permit', id: asString(permit?.id), code: tag, note });
  if (planned === undefined && present(['IN_APPRAISAL', 'SUBMITTED', 'SUPPLEMENT_REQUESTED', 'ISSUED', 'EXEMPTED']) === undefined) {
    if (!(plan.to === 'REJECTED_THEN_FILED' && present(['REJECTED']) !== undefined)) {
      ctx.warn(`${tag}: the dossier plans no permit of this type for the project (types planned: ${(dossier.permits as Obj[]).map((p) => p.permit_type_code).join(', ')})`);
      return;
    }
  }
  if (plan.to === 'PLANNED') return record(planned, 'planned');
  if (plan.to === 'EXEMPTED') {
    if (planned === undefined) return record(present(['EXEMPTED']), 'existing');
    const decision = await paper(ctx, { symbol: `${projectCode}/MT-GPXD`, title: text('pmt.decision.title', projectCode), type: 'QD', sender: text('pmt.decision.sender'), issuedOn: ctx.day(-40) });
    // The person who declares the exemption is not the one who opened the dossier and planned the permit.
    await ctx.command(OWNER, `/permits/${asString(planned.id)}/exempt`, { exemption_basis: text('pmt.exemption.basis'), exemption_decision_document_version_id: decision.versionId }, { version: Number(planned.version) });
    return record(planned, 'exempted');
  }
  if (plan.to === 'REJECTED_THEN_FILED') {
    let first = planned ?? present(['REJECTED']);
    if (planned !== undefined) {
      await submitAndAcknowledge(ctx, asString(planned.id), plan.submitted ?? 60, `${tag}-L1`);
      const current = await permitDetail(ctx, asString(planned.id));
      await ctx.command(MAKER, `/permits/${asString(planned.id)}/decision`, { outcome: 'REJECTED', reason: plan.note ?? text('pmt.reason.rejected') }, { version: Number(current.version) });
      first = planned;
    }
    dossier = await dossierDetail(ctx, dossierId);
    if (present(['SUBMITTED', 'IN_APPRAISAL']) === undefined) {
      const typeRow = (await permitTypes(ctx)).get(plan.type);
      const next = await ctx.command(MAKER, `/permit-dossiers/${dossierId}/permits`, { permit_type_id: asString(typeRow?.id), expected_decision_on: ctx.day(12), responsible_membership_id: ctx.person(MAKER).membershipId });
      await submitAndAcknowledge(ctx, next.resource_id, 9, `${tag}-L2`);
      return record(first, 'rejected, filed again and in appraisal');
    }
    return record(first, 'existing');
  }
  if (planned === undefined) return record(present(['IN_APPRAISAL', 'SUBMITTED', 'SUPPLEMENT_REQUESTED', 'ISSUED']), 'existing');
  const id = asString(planned.id);
  if (plan.to === 'SUBMITTED') {
    const first = await paper(ctx, { symbol: `HS-${tag}/${ctx.year}`, title: text('pmt.title.dossier', tag), type: 'CV', sender: text('pmt.sender.office'), issuedOn: ctx.day(-(plan.submitted ?? 5)) });
    await milestone(ctx, id, 'SUBMITTED', { actual_on: ctx.day(-(plan.submitted ?? 5)), note: text('pmt.note.submitOnline'), document_version_id: first.versionId });
    return record(planned, 'submitted');
  }
  await submitAndAcknowledge(ctx, id, plan.submitted ?? 30, tag);
  if (plan.to === 'IN_APPRAISAL') {
    await milestone(ctx, id, 'APPRAISAL_MEETING', { planned_on: ctx.day(6), note: plan.note ?? text('pmt.note.meeting') });
    return record(planned, 'in appraisal');
  }
  if (plan.to === 'SUPPLEMENT_REQUESTED') {
    await milestone(ctx, id, 'SUPPLEMENT_REQUESTED', { actual_on: ctx.day(-Math.max((plan.submitted ?? 30) - 14, 1)), note: plan.note ?? text('pmt.note.supplement') });
    return record(planned, 'supplement requested');
  }
  await issuePermit(ctx, id, projectCode, plan);
  record(planned, 'issued');
}

async function seedPermits(ctx: SeedContext): Promise<void> {
  await ctx.step('PMT', 'the catalogue of permit types', () => publishTypes(ctx));
  for (const [projectCode, plans] of Object.entries(TEXTS['pmt.dossiers'] as unknown as Record<string, PlanSpec[]>)) {
    const dossierId = await ctx.step('PMT', `dossier of ${projectCode}`, () => openDossier(ctx, projectCode));
    for (const plan of plans) await ctx.step('PMT', `permit ${projectCode}/${plan.type} (${plan.to})`, () => workPermit(ctx, projectCode, dossierId, plan));
  }
}

// ---- the group -------------------------------------------------------------------------------------------------------------------------------------

export async function seedClipEnterpriseIssues(ctx: SeedContext): Promise<void> {
  if (clipPlan()?.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  await seedIssues(ctx);
  await seedQuality(ctx);
  await seedPermits(ctx);
}
