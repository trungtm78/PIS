import { readFileSync } from 'node:fs';
import type { Obj, SeedContext } from '../context.ts';
import { clipPlan } from './plan.ts';

/**
 * The demo data of the leader dashboard of the province of Cà Mau (HOME-01 of that tenant): the projects of the dataset are registered under one unit, and the dashboard
 * reads the province by investor unit (the ranking of units, the heat map by month, the scorecard). This group gives each project the investor unit the dashboard names
 * for it (scripts/fixtures/clip-data/camau-dashboard.json), with the command of the product for it: the transfer of a project between units (PRJ-20), asked by the project
 * manager and decided by the leader. Only the investor unit moves: the owner unit, and with it who may work on the project, stays.
 *
 * Idempotent: a project that already has its investor is left alone, and a transfer left waiting by a run that stopped half-way is decided instead of asked again.
 */
const FIXTURE = new URL('../../../../../../scripts/fixtures/clip-data/camau-dashboard.json', import.meta.url);
const REQUESTER = 'projectManager';
const DECIDER = 'capApprover';
/** The states a project cannot be transferred in (the product refuses them): they keep the investor they have. */
const SETTLED = new Set(['COMPLETED', 'REJECTED', 'CANCELLED', 'CLOSED']);

interface DashboardFixture {
  reason: string;
  decisionReason: string;
  /** The code of the investor unit of each project, by project code. */
  investors: Record<string, string>;
  /** The unit that holds the steering meetings, the note a finished directive is closed with, and the meetings with what each one directed. */
  meetingUnit: string;
  closeNote: string;
  meetings: { ago: number; type: string; title: string; directives: { text: string; project: string; dueIn: number; close?: boolean }[] }[];
}

export async function seedClipDashboard(ctx: SeedContext): Promise<void> {
  const plan = clipPlan();
  if (plan === undefined || plan.variant !== 'camau') {
    ctx.warn('the dashboard data belongs to the dataset of Cà Mau: nothing to do for another dataset');
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as DashboardFixture;
  // The seeds read the answers of the API in the words of the guide: a unit of this dataset that stands for a unit of the guide comes back under the code of the guide
  // (plan.localize pairs a word of the guide with the word of the dataset), so a unit is looked up by its own code and by the code it stands for.
  const pairs = (plan.localize as { pairs?: [string, string][] } | undefined)?.pairs ?? [];
  const unitIds = new Map((await ctx.list<Obj>(REQUESTER, '/resources/organization_unit')).map((unit) => [String(unit.code), String(unit.id)]));
  // The word of the dataset may be the whole code (CM-BQLDAXD) or a part of it (AN-XUYEN in CM-P-AN-XUYEN): every pair that occurs in the code is tried.
  const unitByCode = {
    get: (code: string): string | undefined => {
      if (unitIds.has(code)) return unitIds.get(code);
      for (const [guide, dataset] of pairs) if (dataset !== '' && code.includes(dataset) && unitIds.has(code.replace(dataset, guide))) return unitIds.get(code.replace(dataset, guide));
      return undefined;
    },
  };
  const projects = await ctx.list<Obj>(REQUESTER, '/resources/project');
  const waiting = new Map((await ctx.list<Obj>(DECIDER, '/project-transfers', { status: 'REQUESTED' })).map((transfer) => [String((transfer.project as Obj | undefined)?.id), transfer]));
  let moved = 0;
  let kept = 0;
  for (const project of projects) {
    const code = String(project.code);
    const unitCode = fixture.investors[code];
    if (unitCode === undefined) continue;
    const target = unitByCode.get(unitCode);
    if (target === undefined) {
      ctx.warn(`the unit ${unitCode} of the project ${code} is not a unit of the tenant`);
      continue;
    }
    if (String(project.investor_unit_id) === target || SETTLED.has(String(project.status))) {
      kept += 1;
      continue;
    }
    const id = String(project.id);
    let transfer = waiting.get(id);
    // A transfer left waiting is decided here only when it is this one: the investor unit, to the unit the dashboard names. Another one is somebody's request and is left alone.
    if (transfer !== undefined && (String(transfer.transfer_scope) !== 'INVESTOR_UNIT' || String((transfer.to_unit as Obj | undefined)?.id) !== target)) {
      ctx.warn(`the project ${code} has another transfer waiting: left as it is`);
      continue;
    }
    if (transfer === undefined) {
      const asked = await ctx.attempt(REQUESTER, 'POST', `/projects/${id}/transfers`, { to_unit_id: target, transfer_scope: 'INVESTOR_UNIT', effective_date: ctx.day(0), reason: fixture.reason }, { version: Number(project.version) });
      if (!asked.ok) continue;
      transfer = { id: asked.json.resource_id, version: asked.json.resource_version };
    }
    const decided = await ctx.attempt(DECIDER, 'POST', `/project-transfers/${String(transfer.id)}/decision`, { decision: 'approve', reason: fixture.decisionReason }, { version: Number(transfer.version) });
    if (!decided.ok) continue;
    moved += 1;
    ctx.record({ module: 'PRJ', screen: 'PRJ-20', kind: 'project-transfer', id: String(transfer.id), code, note: `investor unit ${unitCode}` });
  }
  ctx.record({ module: 'PRJ', screen: 'PRJ-20', kind: 'dashboard-investors', id: 'summary', code: 'dashboard', note: `${moved} projects given their investor unit, ${kept} left as they were` });
  await seedDirectives(ctx, fixture, projects, unitByCode);
}

const PAPER_SYMBOL = 'BB-HT-CD-2026';

/** The minutes that confirm the directives reported done (a directive closes on evidence): one letter of the incoming register, received once; its version is what the closure names. */
async function closingPaper(ctx: SeedContext): Promise<string | undefined> {
  const existing = (await ctx.list<Obj>(REQUESTER, '/incoming-documents')).find((letter) => letter.original_symbol === PAPER_SYMBOL);
  if (existing !== undefined) {
    // The register lists the letter without the version of its file: the letter in full carries it. Only when that cannot be read is the letter taken in again.
    const detail = await ctx.attempt<Obj>(REQUESTER, 'GET', `/incoming-documents/${String(existing.id)}`);
    const known = String(existing.version_id ?? existing.current_version_id ?? (detail.ok ? (detail.json.version_id ?? detail.json.current_version_id ?? (detail.json.document as Obj | undefined)?.current_version_id) : undefined) ?? '');
    if (known !== '') return known;
  }
  const sent = await ctx.upload<{ file_object_key: string; file_sha256: string }>(REQUESTER, '/document-files', { filename: 'bb-ht-cd-2026.pdf', buffer: ctx.pdf('BAN CHI DAO', PAPER_SYMBOL, 'Bien ban xac nhan hoan thanh chi dao') });
  if (!sent.ok) return undefined;
  const received = await ctx.attempt<{ version_id: string }>(REQUESTER, 'POST', '/incoming-documents', {
    title: 'Biên bản xác nhận hoàn thành các chỉ đạo giao ban', doc_type_code: 'QD', channel: 'UPLOAD', file_object_key: sent.json.file_object_key, file_sha256: sent.json.file_sha256,
    original_symbol: PAPER_SYMBOL, original_issued_on: ctx.day(-1), sender_name: 'Ban chỉ đạo đầu tư công tỉnh',
    ...(existing === undefined ? {} : { duplicate_override_reason: 'Nhập lại văn bản để lấy mã tham chiếu' }),
  });
  return received.ok ? String(received.json.version_id) : undefined;
}

/**
 * The steering meetings of the year and what each one directed (DIR-01, DIR-03): the page of tasks and directives reads them. A directive is given to the investor unit of
 * its project; some are closed, the others run or have passed their day. Idempotent by the title of the meeting and the text of the directive on its project.
 */
async function seedDirectives(ctx: SeedContext, fixture: DashboardFixture, projects: Obj[], unitByCode: { get(code: string): string | undefined }): Promise<void> {
  const holder = unitByCode.get(fixture.meetingUnit);
  if (holder === undefined) {
    ctx.warn(`the unit ${fixture.meetingUnit} that holds the meetings is not a unit of the tenant`);
    return;
  }
  const projectId = new Map(projects.map((project) => [String(project.code), String(project.id)]));
  const meetings = new Map((await ctx.list<Obj>(REQUESTER, '/steering-meetings')).map((meeting) => [String(meeting.title), String(meeting.id)]));
  // A directive is the one of its meeting: the same words on the same project at another meeting are another directive.
  const directiveKey = (meeting: string, text: string, project: string): string => `${meeting}|${project}|${text}`;
  const existing = new Map((await ctx.list<Obj>(REQUESTER, '/directives')).map((row) => [directiveKey(String((row.meeting as Obj | undefined)?.id), String(row.text), String((row.project as Obj | undefined)?.code)), row]));
  let added = 0;
  let closed = 0;
  let evidence: string | undefined;
  for (const meeting of fixture.meetings) {
    let meetingId = meetings.get(meeting.title);
    if (meetingId === undefined) {
      const made = await ctx.attempt(REQUESTER, 'POST', '/steering-meetings', { meeting_date: ctx.day(-meeting.ago), meeting_type: meeting.type, title: meeting.title, unit_id: holder });
      if (!made.ok) continue;
      meetingId = String(made.json.resource_id);
    }
    for (const directive of meeting.directives) {
      const project = projectId.get(directive.project);
      const assignee = unitByCode.get(fixture.investors[directive.project] ?? '');
      if (project === undefined || assignee === undefined) {
        ctx.warn(`the directive of the project ${directive.project} names a project or a unit the tenant does not have`);
        continue;
      }
      let row = existing.get(directiveKey(meetingId, directive.text, directive.project));
      if (row === undefined) {
        const made = await ctx.attempt(REQUESTER, 'POST', `/steering-meetings/${meetingId}/directives`, { scope_kind: 'PROJECT', project_id: project, text: directive.text, assignee_unit_id: assignee, due_on: ctx.day(directive.dueIn) });
        if (!made.ok) continue;
        row = { id: made.json.resource_id, version: made.json.resource_version, stored_status: 'OPEN' };
        added += 1;
      }
      if (directive.close !== true || String(row.stored_status) === 'DONE' || String(row.status) === 'DONE') continue;
      // Only the directive this group gave: one that was since given to another unit is somebody's work and stays open.
      const given = (row.assignee_unit as Obj | undefined)?.id;
      if (given !== undefined && String(given) !== assignee) continue;
      // Whoever recorded the directive may not close it; the leader closes what the unit reported done, and where the leader does not see the project, the head of the tenant or of the unit does.
      for (const person of ['owner', DECIDER, 'unitAdmin']) {
        evidence ??= await closingPaper(ctx);
        if (evidence === undefined) break;
        const done = await ctx.attempt(person, 'POST', `/directives/${String(row.id)}/closure`, { note: fixture.closeNote, evidence_document_version_ids: [evidence] }, { version: Number(row.version) });
        if (done.ok) {
          closed += 1;
          break;
        }
      }
    }
  }
  ctx.record({ module: 'DIR', screen: 'DIR-03', kind: 'dashboard-directives', id: 'summary', code: 'dashboard', note: `${added} directives added, ${closed} closed` });
}
