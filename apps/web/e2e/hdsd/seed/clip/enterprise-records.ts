import type { CommandReply, Obj, SeedContext } from '../context.ts';
import { projectByCode } from '../capital-projects.ts';
import { CHECKER, LEADER, MAKER } from '../procurement-finance/shared.ts';
import { appraisalPack } from './enterprise-appraisal.ts';
import type { AppraisalPack } from './enterprise-appraisal.ts';
import { clipText } from './plan.ts';

/**
 * Groups of the enterprise dataset that fill two repositories, with the commands of the product and the people of the clip stack:
 *  - `clip-ent-project-docs`: the project document repository (DOC-24): documents of several classes with a text PDF each (so the text is extracted and can be searched), a second and third
 *    version with their change note, and a comment on a version, one of them resolved. (The review round of a document needs an approval workflow of the business type, which the dataset does not configure.)
 *  - `clip-ent-narrative`: report drafts with the structured narrative of eight fields (DIS-35, ENT-3b): a report of the previous period, a draft of the next period that inherits the previous
 *    words and adds its own, and a draft whose eight fields and standard causes are all written.
 */

// ---- project documents (DOC-24) ---------------------------------------------------------------------------------------------------------

interface FileUpload {
  file_object_key: string;
  file_sha256: string;
}

async function uploaded(ctx: SeedContext, name: string, lines: string[]): Promise<FileUpload> {
  const sent = await ctx.upload<FileUpload>(MAKER, '/project-documents/files', { filename: name, mime: 'application/pdf', buffer: ctx.pdf(...lines) });
  return ctx.expectOk(sent, `upload ${name}`).json;
}

async function projectDocuments(ctx: SeedContext, pack: AppraisalPack): Promise<void> {
  const known = await ctx.list<Obj>(MAKER, '/project-documents');
  const byTitle = new Map(known.map((row) => [String(row.title), row] as const));
  const idsByClass = new Map<string, { documentId: string; versionId: string }>();
  for (const spec of pack.documents) {
    const project = await projectByCode(ctx, spec.project);
    if (project === undefined) {
      ctx.warn(`the project ${spec.project} does not exist: its document is left out`);
      continue;
    }
    let documentId: string;
    const existing = byTitle.get(spec.title);
    if (existing !== undefined) documentId = String(existing.id);
    else {
      const contract = spec.contract === undefined ? undefined : await ctx.find(MAKER, '/resources/contract', (row) => row.code === spec.contract);
      const file = await uploaded(ctx, `${spec.reference.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-v1.pdf`, spec.lines);
      const created = await ctx.command(MAKER, '/project-documents', {
        project_id: String(project.id),
        doc_class: spec.docClass,
        title: spec.title,
        reference: spec.reference,
        security_class: 'INTERNAL',
        effective_from: ctx.day(-60),
        ...(contract === undefined ? {} : { contract_id: String(contract.id) }),
        note: clipText('doc.versionNote'),
        file_object_key: file.file_object_key,
        file_sha256: file.file_sha256,
        change_note: clipText('doc.versionNote'),
      });
      documentId = created.resource_id;
      for (const [index, note] of spec.changes.entries()) {
        const next = await uploaded(ctx, `${spec.reference.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-v${index + 2}.pdf`, [...spec.lines, `Chinh sua lan ${index + 1}`]);
        await ctx.command(MAKER, `/project-documents/${documentId}/versions`, { file_object_key: next.file_object_key, file_sha256: next.file_sha256, change_note: note });
      }
      ctx.record({ module: 'DOC', screen: 'DOC-24', kind: 'project-document', id: documentId, code: spec.reference, note: `${spec.docClass}, ${spec.changes.length + 1} versions` });
    }
    const detail = await ctx.get<Obj>(MAKER, `/project-documents/${documentId}`);
    const versions = (detail.versions ?? []) as Obj[];
    const latest = [...versions].sort((a, b) => Number(b.version_no) - Number(a.version_no))[0];
    if (latest !== undefined) idsByClass.set(spec.docClass, { documentId, versionId: String(latest.id) });
  }
  await ctx.step('DOC', 'comments on the versions', async () => {
    for (const comment of pack.comments) {
      const target = idsByClass.get(comment.document);
      if (target === undefined) continue;
      const listed = await ctx.get<Obj>(CHECKER, `/project-document-versions/${target.versionId}/comments`);
      const rows = (Array.isArray(listed) ? listed : (listed.items ?? [])) as Obj[];
      if (rows.some((row) => row.body === comment.body)) continue;
      const made = await ctx.command(CHECKER, `/project-document-versions/${target.versionId}/comments`, { body: comment.body });
      if (comment.resolved) await ctx.attempt(MAKER, 'POST', `/document-comments/${made.resource_id}/resolve`, {}, { version: made.resource_version });
    }
  });
}

export async function seedClipEnterpriseProjectDocs(ctx: SeedContext): Promise<void> {
  const pack = appraisalPack(ctx);
  if (pack === undefined) return;
  await projectDocuments(ctx, pack);
}

// ---- structured narrative (DIS-35) -------------------------------------------------------------------------------------------------------

interface ReportBody {
  project_id: string;
  period_id: string;
  measurement_basis: 'YTD';
  report_type: 'MONTHLY';
  funding_lines: never[];
  narrative: Obj;
}

/** The narrative a report needs to be sent: the four sections of the weekly report written from the eight fields, and the structured block of the enterprise pack. */
function narrativeOf(fields: Record<string, string>): Obj {
  return { results: fields.status, causes: fields.causes, solutions: fields.solutions, proposals: fields.proposals, enterprise: { ...fields } };
}

async function periodByCode(ctx: SeedContext, code: string): Promise<Obj | undefined> {
  return ctx.find(MAKER, '/resources/reporting_period', (row) => row.code === code);
}

async function draftFor(ctx: SeedContext, projectId: string, periodId: string): Promise<Obj | undefined> {
  const rows = await ctx.list<Obj>(MAKER, '/resources/report_revision', { project_id: projectId, period_id: periodId });
  return rows.find((row) => String((row.project as Obj | undefined)?.id ?? row.project_id) === projectId && String((row.period as Obj | undefined)?.id ?? row.period_id) === periodId);
}

/** The volumes a report needs before it can be sent (the narrative is not enough). */
const PROGRESS = { construction_vnd: '120000000000', acceptance_vnd: '95000000000', treasury_submitted_vnd: '80000000000', preparing_dossier_vnd: '15000000000', physical_progress_pct: '72.00' };

async function sendAndAccept(ctx: SeedContext, id: string, version: number, rewrite: Obj | undefined): Promise<void> {
  let current = version;
  if (rewrite !== undefined) {
    const saved = await ctx.attempt<CommandReply>(MAKER, 'POST', `/reports/${id}/revisions`, rewrite, { version: current });
    if (!saved.ok) return;
    current = saved.json.resource_version;
  }
  const sent = await ctx.attempt<CommandReply>(MAKER, 'POST', `/reports/${id}/submit`, {}, { version: current });
  if (sent.ok) await ctx.attempt(LEADER, 'POST', `/reports/${id}/decision`, { decision: 'approve', reason: clipText('doc.reviewNote'), evidence_ids: [] }, { version: sent.json.resource_version });
}

async function narratives(ctx: SeedContext, pack: AppraisalPack): Promise<void> {
  for (const spec of pack.narratives) {
    const project = await projectByCode(ctx, spec.project);
    const period = await periodByCode(ctx, spec.period);
    if (project === undefined || period === undefined) {
      ctx.warn(`the project ${spec.project} or the period ${spec.period} does not exist: no narrative`);
      continue;
    }
    const projectId = String(project.id);
    const periodId = String(period.id);
    const known = await draftFor(ctx, projectId, periodId);
    const base = { project_id: projectId, period_id: periodId, measurement_basis: 'YTD' as const, report_type: 'MONTHLY' as const, funding_lines: [] as never[], ...(spec.kind === 'previous' ? PROGRESS : {}) };
    if (known !== undefined) {
      // A report of the previous period an earlier run left as a draft is taken up where it stopped: its volumes written, sent and accepted.
      if (spec.kind === 'inherited' && known.status === 'DRAFT' && ((known.narrative as Obj | undefined)?.enterprise as Obj | undefined)?.inheritance === undefined) await ctx.call(MAKER, 'POST', `/reports/${String(known.id)}/narrative-inheritance`, {}, { version: Number(known.version) });
      if (spec.kind === 'previous' && known.status === 'DRAFT') await sendAndAccept(ctx, String(known.id), Number(known.version), { ...base, narrative: narrativeOf(spec.fields ?? {}) });
      continue;
    }
    const fields = spec.kind === 'inherited' ? (spec.own ?? {}) : (spec.fields ?? {});
    const body: ReportBody = { ...base, narrative: spec.kind === 'previous' ? narrativeOf(fields) : { enterprise: { ...fields } } };
    const made = await ctx.attempt<CommandReply>(MAKER, 'POST', '/reports', body);
    if (!made.ok) continue;
    let version = made.json.resource_version;
    const id = made.json.resource_id;
    if (spec.kind === 'inherited') {
      const copied = await ctx.attempt<CommandReply>(MAKER, 'POST', `/reports/${id}/narrative-inheritance`, {}, { version });
      if (copied.ok) version = copied.json.resource_version;
    }
    if (spec.kind === 'filled') {
      // The standard causes come from the list of the platform (MDM-17); the first two are ticked.
      const context = await ctx.get<Obj>(MAKER, `/reports/${id}/narrative-context`);
      const codes = ((context.causes ?? []) as Obj[]).slice(0, 2).map((cause) => String(cause.code));
      if (codes.length > 0) {
        const saved = await ctx.attempt<CommandReply>(MAKER, 'POST', `/reports/${id}/revisions`, { ...base, narrative: { enterprise: { ...fields, cause_codes: codes } } }, { version });
        if (saved.ok) version = saved.json.resource_version;
      }
    }
    // The report of the previous period is sent and accepted, so the next period has words to inherit.
    if (spec.kind === 'previous') await sendAndAccept(ctx, id, version, undefined);
    ctx.record({ module: 'DIS', screen: 'DIS-35', kind: 'report-narrative', id, code: `${spec.project}:${spec.period}`, note: spec.kind });
  }
}

export async function seedClipEnterpriseNarrative(ctx: SeedContext): Promise<void> {
  const pack = appraisalPack(ctx);
  if (pack === undefined) return;
  await ctx.step('DIS', 'structured narratives of the period', () => narratives(ctx, pack));
}
