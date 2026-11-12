import { vnd } from '../context.ts';
import type { Obj, SeedContext } from '../context.ts';
import TEXTS from '../data/enterprise-mobile.json' with { type: 'json' };
import { clipPlan } from './plan.ts';

/**
 * Group `clip-ent-mobile`: real work for the leaders on the phone (the installed application at /m and the Flutter application).
 *
 * The phone's approval queue (`get_resources_approval_task?mine=true&status=Pending`) lists the tasks of the ADM approval engine. The engine runs a workflow only for
 * the business types that have a PUBLISHED definition, so the group first publishes the definition of `document.review` (the maker is the owner, the publisher the
 * leader: the author never publishes), then the project officer sends project documents (design file, estimate, contract addendum, tender file, acceptance minutes,
 * submission, technical note) into review. Every send STARTS a real workflow instance and leaves its tasks pending for both leaders (owner and capApprover); this group
 * never decides a task. The bid result approvals of the procurement module (RESULT_PENDING) are a separate module flow (`bid.workflow.approve`), they are not engine tasks.
 *
 * Notifications: the inbox of the application (and of the phone application) is fed by the notification engine from the events of the other modules, and it needs a
 * published notification workflow per event type. This group publishes the one that matters for the queue (`adm.approval_task.reminded.v1`, explicit recipient: the assignee
 * of the task) and gives the leaders the role MEMBER (the inbox permission). The reminder is raised by the job `approval-sla` once a task passes its reminder point or deadline.
 *
 * Everything is made on the real day (no clock phase): a grant or a published definition is stamped by the database with the real time, so a command run at a clock in the past
 * by a person who got the grant in the same run is refused (SCOPE_DENIED). The tasks are due one working day after they are made. Idempotent: documents are found by title,
 * a review is sent only when the document has none open, and the roles and workflows by their state.
 */

const MAKER = 'projectManager';
const AUTHOR = 'owner';
const PUBLISHER = 'capApprover';
const LEADERS = ['owner', 'capApprover'] as const;
const REVIEW_BUSINESS_TYPE = 'document.review';
const REMINDER_EVENT = 'adm.approval_task.reminded.v1';

interface ReviewSpec {
  key: string;
  project: string;
  contract: string;
  docClass: string;
  title: string;
  reference: string;
  changeNote: string;
  reviewNote: string;
  pdf: string[];
}

interface ReportSpec {
  project: string;
  progressPct: string;
  constructionBn: number;
  acceptanceBn: number;
  submittedBn: number;
  disbursedBn: number;
}

const T = TEXTS as unknown as Record<string, string> & { reviews: ReviewSpec[]; reports: ReportSpec[] };

/** Publishes the definition of `document.review` (one step, both leaders hold a task, the first approval closes it) unless one is already in force. */
async function ensureReviewWorkflow(ctx: SeedContext): Promise<void> {
  const versions = await ctx.list<Obj>(AUTHOR, '/resources/workflow_version');
  if (versions.some((row) => row.business_type === REVIEW_BUSINESS_TYPE && row.status === 'Published')) return;
  const definition = {
    steps: [
      {
        id: 'review',
        name: T['workflow.step.name'],
        assignee_rule: { type: 'SPECIFIC', membership_ids: LEADERS.map((key) => ctx.person(key).membershipId) },
        min_approvals: 1,
        sla_working_hours: 8,
        on_timeout: 'REMIND',
      },
    ],
    terminal: { approved: 'approveDocumentReview', returned: 'requestDocumentSupplement', rejected: 'rejectDocumentReview' },
  };
  let draft = versions.find((row) => row.business_type === REVIEW_BUSINESS_TYPE && row.status === 'Draft');
  if (draft === undefined) {
    const made = await ctx.command(AUTHOR, '/workflow-definitions', { business_type: REVIEW_BUSINESS_TYPE, definition });
    draft = { id: made.resource_id, version: made.resource_version };
  }
  await ctx.command(PUBLISHER, `/workflow-definitions/${String(draft.id)}/publish`, { reason: T['workflow.publish.reason'] }, { version: Number(draft.version) });
}

/** The project officer may send a document into review only through a role the owner makes (no system role holds the permission to send a document into review). */
async function ensureSubmitterRole(ctx: SeedContext): Promise<void> {
  const code = 'TRINH_HO_SO';
  let roleId: string;
  const existing = await ctx.find<Obj>(AUTHOR, '/resources/role_definition', (row) => row.code === code);
  if (existing !== undefined) roleId = String(existing.id);
  else roleId = (await ctx.command(AUTHOR, '/roles', { code, name: T['role.submit.name'], permissions: ['doc.repo.read', 'doc.repo.upload', 'doc.repo.review.submit'], rank: 45 })).resource_id;
  const membershipId = ctx.person(MAKER).membershipId;
  const granted = await ctx.find<Obj>(AUTHOR, '/resources/role_grant', (row) => row.membership_id === membershipId && row.role_id === roleId && String(row.status).toUpperCase() === 'ACTIVE');
  if (granted === undefined) await ctx.command(AUTHOR, '/role-grants', { membership_id: membershipId, role_id: roleId, scope_kind: 'TENANT', reason: T['role.submit.reason'] });
}

/** The inbox permission of the leaders (the system role MEMBER on the whole tenant), unless they hold it. */
async function ensureLeaderInbox(ctx: SeedContext): Promise<void> {
  const member = (await ctx.list<Obj>(AUTHOR, '/resources/role_definition')).find((role) => role.code === 'MEMBER');
  if (member === undefined) {
    ctx.warn('the system role MEMBER does not exist: the leaders get no inbox');
    return;
  }
  const grants = await ctx.list<Obj>(AUTHOR, '/resources/role_grant');
  for (const key of LEADERS) {
    // The owner cannot grant a role to themselves (SELF_GRANT_DENIED) and already holds the inbox through the role of the owner of the tenant.
    if (key === AUTHOR) continue;
    const membershipId = ctx.person(key).membershipId;
    const holds = grants.some((grant) => grant.membership_id === membershipId && grant.role_id === member.id && (grant.status === undefined || grant.status === 'Active'));
    if (holds) continue;
    const reply = await ctx.attempt(AUTHOR, 'POST', '/role-grants', { membership_id: membershipId, role_id: member.id, scope_kind: 'TENANT', reason: T['member.grant.reason'] });
    if (!reply.ok) ctx.warn(`the role MEMBER was not granted to ${key}`);
  }
}

/** The notification workflow of the reminder of an approval task: the assignee named in the event gets it in the inbox. Skipped when the event type already has a published workflow. */
async function ensureReminderNotification(ctx: SeedContext): Promise<void> {
  const published = await ctx.find<Obj>(PUBLISHER, '/notification-workflows', (row) => row.event_type === REMINDER_EVENT && row.status === 'Published');
  if (published !== undefined) {
    ctx.log(`  [${ctx.group}/NOT] ${REMINDER_EVENT} already has a published workflow`);
    return;
  }
  const catalogue = await ctx.get<{ items: Obj[] }>(PUBLISHER, '/notification-event-types');
  const entry = catalogue.items.find((row) => row.event_type === REMINDER_EVENT && row.status === 'Active');
  if (entry === undefined) {
    ctx.warn(`${REMINDER_EVENT} is not in the catalogue of the notification engine`);
    return;
  }
  const definition = { channels: [{ channel: 'IN_APP' }], resolver: { kind: 'explicit' }, priority: 'HIGH', ackRequired: false, expiresAfterMinutes: 14 * 24 * 60, purpose: 'REMINDER' };
  const draft = await ctx.command(PUBLISHER, '/notification-workflows', { event_type: REMINDER_EVENT, definition });
  await ctx.command(AUTHOR, `/notification-workflows/${draft.resource_id}/publish`, { decision: 'approve', reason: T['notification.publish.reason'], evidence_ids: [] }, { version: draft });
}

/** One project document, found by title or made (a small PDF, the project officer uploads it). */
async function ensureDocument(ctx: SeedContext, spec: ReviewSpec, projects: Obj[], contracts: Obj[]): Promise<{ id: string; versionId: string; open: boolean } | undefined> {
  const project = projects.find((row) => row.code === spec.project);
  if (project === undefined) {
    ctx.warn(`the project ${spec.project} does not exist: ${spec.key} skipped`);
    return undefined;
  }
  const known = (await ctx.list<Obj>(MAKER, '/project-documents', { project_id: String(project.id) })).find((row) => row.title === spec.title);
  let documentId = known === undefined ? undefined : String(known.id);
  if (documentId === undefined) {
    const file = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>(MAKER, '/project-documents/files', { filename: `${spec.key}.pdf`, buffer: ctx.pdf(...spec.pdf) }), `upload ${spec.key}`).json;
    const contract = spec.contract === '' ? undefined : contracts.find((row) => row.code === spec.contract);
    const made = await ctx.command(MAKER, '/project-documents', {
      project_id: project.id,
      doc_class: spec.docClass,
      title: spec.title,
      reference: spec.reference,
      security_class: 'INTERNAL',
      ...(contract === undefined ? {} : { contract_id: contract.id }),
      file_object_key: file.file_object_key,
      file_sha256: file.file_sha256,
      change_note: spec.changeNote,
    });
    documentId = made.resource_id;
  }
  const detail = await ctx.get<{ document: Obj; versions: Obj[] }>(MAKER, `/project-documents/${documentId}`);
  const latest = detail.document.latest_review as Obj | null | undefined;
  const version = detail.versions.find((row) => row.status === 'DRAFT') ?? detail.versions[0];
  if (version === undefined) return undefined;
  return { id: documentId, versionId: String(version.id), open: latest !== null && latest !== undefined };
}

async function sendReviews(ctx: SeedContext): Promise<number> {
  const projects = await ctx.list<Obj>(MAKER, '/resources/project');
  const contracts = await ctx.list<Obj>(MAKER, '/resources/contract');
  let sent = 0;
  for (const spec of T.reviews) {
    const document = await ensureDocument(ctx, spec, projects, contracts);
    if (document === undefined || document.open) continue;
    const reply = await ctx.attempt(MAKER, 'POST', `/project-documents/${document.id}/reviews`, { version_id: document.versionId, note: spec.reviewNote });
    if (!reply.ok) continue;
    sent += 1;
    ctx.record({ module: 'ADM', screen: 'PWA-04', kind: 'document-review', id: document.id, code: spec.reference, note: `${spec.docClass} ${spec.project}` });
  }
  return sent;
}

/** The steps the tenant runs for the weekly report, as a governance rule (the owner writes and submits it, the leader approves it): one step, both leaders hold a task. Without it the report keeps the single decision and the engine never runs. */
async function ensureStagedReportRule(ctx: SeedContext): Promise<boolean> {
  const rules = await ctx.list<Obj>(AUTHOR, '/governance-rules', { rule_type: 'APPROVAL_WORKFLOW_DEFINITION' });
  const inForce = rules.find((row) => row.code === 'REPORT_ACCEPT' && row.status === 'APPROVED' && row.effective_to === null);
  if (inForce !== undefined) {
    const staged = (inForce.params as Obj | undefined)?.mode === 'STAGED';
    if (!staged) ctx.warn('the rule REPORT_ACCEPT in force is the single decision: the weekly reports will not start a workflow');
    return staged;
  }
  const params = {
    mode: 'STAGED',
    steps: [{ id: 'unit-approver', kind: 'UNIT_APPROVER', name: T['report.rule.step'], assignee_type: 'SPECIFIC', membership_ids: LEADERS.map((key) => ctx.person(key).membershipId), min_approvals: 1, sla_working_hours: 8, on_timeout: 'REMIND' }],
  };
  // The rule governs from its first day and cannot be approved once that day is past, so it starts today.
  const draft = await ctx.command(AUTHOR, '/governance-rules', { rule_type: 'APPROVAL_WORKFLOW_DEFINITION', code: 'REPORT_ACCEPT', params, effective_from: ctx.day(0), reason: T['report.rule.reason'] });
  const submitted = await ctx.command(AUTHOR, `/governance-rules/${draft.resource_id}/submit`, { reason: T['report.rule.submit'] }, { version: draft });
  await ctx.command(PUBLISHER, `/governance-rules/${draft.resource_id}/approve`, { reason: T['report.rule.approve'] }, { version: submitted });
  return true;
}

/** The weekly reports of the projects in implementation for the week that is open now: each is handed in by the project officer and starts the approval, which nobody decides here. */
async function submitWeeklyReports(ctx: SeedContext): Promise<number> {
  const period = (await ctx.list<Obj>(MAKER, '/resources/reporting_period')).find((row) => row.period_type === 'WEEK' && row.status === 'OPEN' && String(row.start_date) <= ctx.today && ctx.today <= String(row.end_date));
  if (period === undefined) {
    ctx.warn('no weekly period is open today: the weekly reports are left out');
    return 0;
  }
  const projects = await ctx.list<Obj>(MAKER, '/resources/project');
  let sent = 0;
  for (const spec of T.reports) {
    const project = projects.find((row) => row.code === spec.project);
    if (project === undefined) {
      ctx.warn(`the project ${spec.project} does not exist: its weekly report is left out`);
      continue;
    }
    const known = (await ctx.list<Obj>(MAKER, '/resources/report_revision', { project_id: String(project.id), period_id: String(period.id) })).find((row) => row.status !== 'WITHDRAWN');
    let reportId = known === undefined ? undefined : String(known.id);
    if (known !== undefined && known.status !== 'DRAFT') continue;
    if (reportId === undefined) {
      const made = await ctx.attempt(MAKER, 'POST', '/reports', {
        project_id: project.id,
        period_id: period.id,
        report_type: 'WEEKLY',
        measurement_basis: 'PROJECT_TO_DATE',
        funding_lines: [{ bucket: 'CURRENT_YEAR', budget_level: 'CENTRAL', cumulative_vnd: vnd(spec.disbursedBn) }],
        construction_vnd: vnd(spec.constructionBn),
        acceptance_vnd: vnd(spec.acceptanceBn),
        treasury_submitted_vnd: vnd(spec.submittedBn),
        preparing_dossier_vnd: vnd(0),
        physical_progress_pct: spec.progressPct,
      });
      if (!made.ok) continue;
      reportId = String(made.json.resource_id);
    }
    const draft = await ctx.get<Obj>(MAKER, `/reports/${reportId}`);
    const reply = await ctx.attempt(MAKER, 'POST', `/reports/${reportId}/submit`, {}, { version: Number(draft.version) });
    if (!reply.ok) continue;
    sent += 1;
    ctx.record({ module: 'DIS', screen: 'PWA-03', kind: 'weekly-report', id: reportId, code: `${spec.project} ${String(period.code)}`, note: `${spec.disbursedBn} billion to date, waits for the leaders` });
  }
  return sent;
}

export async function seedClipEnterpriseMobile(ctx: SeedContext): Promise<void> {
  if (clipPlan()?.dataset !== 'enterprise') {
    ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
    return;
  }
  const staged = await ctx.step('ADM', 'staged approval of the weekly report', () => ensureStagedReportRule(ctx));
  const reports = staged ? await ctx.step('DIS', 'weekly reports handed in (they wait for the leaders)', () => submitWeeklyReports(ctx)) : 0;
  // The review of project documents is opt-in: the phone shows the business type and the record of such a task as raw codes until its labels exist (CLIP_MOBILE_DOCS=1).
  const documents = process.env.CLIP_MOBILE_DOCS === '1';
  if (documents) await ctx.step('ADM', 'workflow of the review of project documents', () => ensureReviewWorkflow(ctx));
  await ctx.step('NOT', 'inbox of the leaders and the reminder workflow', async () => {
    await ensureLeaderInbox(ctx);
    await ensureReminderNotification(ctx);
  });
  if (documents) await ctx.step('IAM', 'role that lets the project officer send documents into review', () => ensureSubmitterRole(ctx));
  const sent = documents ? await ctx.step('ADM', 'project documents sent into review', () => sendReviews(ctx)) : 0;
  for (const leader of LEADERS) {
    const mine = await ctx.list<Obj>(leader, '/resources/approval_task', { mine: 'true', status: 'Pending' });
    ctx.log(`  [${ctx.group}] ${reports} weekly reports and ${sent} document reviews sent now; ${leader} has ${mine.length} pending approval tasks`);
  }
}
