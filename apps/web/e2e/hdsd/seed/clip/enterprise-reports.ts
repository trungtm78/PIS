import type { Obj, SeedContext } from '../context.ts';
import { asObj } from '../context.ts';
import { clipPlan } from './plan.ts';

/**
 * Group `clip-ent-reports`: the PVN and HPM forms of the enterprise edition, issued through the report engine (RPT-1) and pushed through the HPM port.
 * The forms are DEMO forms (stamped, never counted as an official acceptance): their copies are real issued copies with a hash, made by three different people:
 * the officer prepares, the owner checks, the head of the committee approves and issues (the system role COMMITTEE_HEAD holds the approval and the issue; the docs
 * stack grants it to the account `docHead`). The HPM push writes the package through the file writer that stands in for HPM; the receipt is recorded by a
 * second person (the owner) and, because a demo copy can never be accepted, as a rejection with its reason, so the log shows both a written push and an answered one.
 * The stack must have been started with MACHVON_EDITION=enterprise and DEMO_FORMS=true.
 */

const PREPARER = 'projectManager';
const CHECKER = 'owner';
const APPROVER = 'docHead';

interface ReportSpec {
  layout: string;
  kind: 'MONTH' | 'QUARTER';
  index: number;
  push: 'NONE' | 'WRITTEN' | 'ANSWERED';
}

interface ReportsBlock {
  year: number;
  reports: ReportSpec[];
  rejectionNote: string;
}

function periodCode(spec: ReportSpec, year: number): string {
  return spec.kind === 'MONTH' ? `${year}-M${spec.index}` : `${year}-Q${spec.index}`;
}

async function issueCopy(ctx: SeedContext, spec: ReportSpec, year: number): Promise<{ issueId: string; revision: number; sha256: string } | undefined> {
  const code = periodCode(spec, year);
  const known = (await ctx.list<Obj>(PREPARER, '/report-engine/issues')).find((row) => row.layout_code === spec.layout && row.period === code && row.is_current === true);
  if (known !== undefined) return { issueId: String(known.id), revision: Number(known.revision), sha256: String(known.sha256) };
  const generated = await ctx.attempt<Obj>(PREPARER, 'POST', '/report-engine/drafts', { layout_code: spec.layout, period: { kind: spec.kind, year, index: spec.index } });
  if (!generated.ok) return undefined;
  const draftId = String(generated.json.draft_id ?? generated.json.resource_id);
  const step = async (person: string, action: string): Promise<boolean> => {
    const draft = await ctx.get<Obj>(person, `/report-engine/drafts/${draftId}`);
    const reply = await ctx.attempt(person, 'POST', `/report-engine/drafts/${draftId}/${action}`, {}, { version: Number(draft.version) });
    return reply.ok;
  };
  if (!(await step(CHECKER, 'check'))) return undefined;
  if (!(await step(APPROVER, 'approve'))) return undefined;
  if (!(await step(APPROVER, 'issue'))) return undefined;
  const issued = (await ctx.list<Obj>(PREPARER, '/report-engine/issues')).find((row) => row.layout_code === spec.layout && row.period === code && row.is_current === true);
  return issued === undefined ? undefined : { issueId: String(issued.id), revision: Number(issued.revision), sha256: String(issued.sha256) };
}

export async function seedClipEnterpriseReports(ctx: SeedContext): Promise<void> {
  const block = clipPlan()?.reports as ReportsBlock | undefined;
  if (block === undefined) {
    ctx.warn('no enterprise clip plan with reports: nothing to do');
    return;
  }
  for (const spec of block.reports) {
    const copy = await ctx.step('RPT', `${spec.layout} ${periodCode(spec, block.year)}`, () => issueCopy(ctx, spec, block.year));
    if (copy === undefined) {
      ctx.warn(`the form ${spec.layout} could not be issued (is the stack serving the enterprise edition with DEMO_FORMS=true?)`);
      continue;
    }
    ctx.record({ module: 'RPT', screen: 'RPT-01', kind: 'report-issue', id: copy.issueId, code: `${spec.layout} ${periodCode(spec, block.year)}`, note: `revision ${copy.revision}` });
    if (spec.push === 'NONE' || !spec.layout.startsWith('HPM')) continue;
    const pushes = await ctx.list<Obj>(PREPARER, '/hpm/pushes', { layout_code: spec.layout, period: periodCode(spec, block.year) });
    let push = pushes[0];
    if (push === undefined) {
      const sent = await ctx.attempt<Obj>(PREPARER, 'POST', '/hpm/pushes', { layout_code: spec.layout, period: periodCode(spec, block.year), revision: copy.revision, sha256: copy.sha256, issue_id: copy.issueId });
      if (!sent.ok) continue;
      push = asObj(sent.json.push);
    }
    if (spec.push === 'ANSWERED' && String(push.status) === 'WRITTEN') {
      await ctx.attempt(CHECKER, 'POST', `/hpm/pushes/${String(push.id)}/receipt`, { outcome: 'REJECTED', reference: `HPM-${periodCode(spec, block.year)}`, note: block.rejectionNote }, { version: Number(push.version) });
    }
  }
}
