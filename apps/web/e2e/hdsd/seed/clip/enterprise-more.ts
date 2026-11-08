import type { Obj, SeedContext } from '../context.ts';
import { seedCapital } from '../capital.ts';
import { seedDoc } from '../platform-records/doc.ts';
import { ensureDoaMatrix } from './doa.ts';
import { seedClipBi } from './public-bi.ts';
import { clipPlan } from './plan.ts';

/**
 * The groups of the enterprise dataset that reuse the groups of the guide on the enterprise plan (`applyClipPlan` swaps the tables of the guide for the ones of the plan):
 * the capital of the year (assignments of equity and loan, the plan of the year, the projects it funds), the documents of the office in the words of the enterprise, and BI.
 * Procurement, tenders, contracts and the process tree are the groups of the public dataset run on the same plan.
 */

function enterprisePlanOnly(ctx: SeedContext): boolean {
  if (clipPlan()?.dataset === 'enterprise') return true;
  ctx.warn('no enterprise clip plan (CLIP_PLAN_FILE): the group has nothing to do');
  return false;
}

/** Capital: the projects of the plan go through the appraisal to the pipeline, the assignments and the plan of the year are published, then the funded ones are budgeted and started. */
export async function seedClipEnterpriseCapital(ctx: SeedContext): Promise<void> {
  if (!enterprisePlanOnly(ctx)) return;
  await seedCapital(ctx);
}

/** Documents: the delegation matrix, then the outgoing decisions and letters, the register of incoming letters and the dossiers (platform-records/doc.ts, enterprise texts). */
export async function seedClipEnterpriseDocuments(ctx: SeedContext): Promise<void> {
  if (!enterprisePlanOnly(ctx)) return;
  await ctx.step('ADM', 'delegation of authority matrix', () => ensureDoaMatrix(ctx));
  try {
    await seedDoc(ctx);
  } catch (error) {
    ctx.warn(`the document seed stopped: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
}

/** The people of the BI board hold their permissions through roles the owner of the tenant makes and grants (IAM commands), as the AI board does in the guide seed. */
const BI_ROLES = [
  { person: 'projectManager', code: 'LAP_BI', name: 'Lập bảng điều hành', rank: 45, permissions: ['bi.dashboard.manage', 'bi.publish.request', 'bi.query', 'bi.dataset.build', 'bi.admin.read', 'bi.lineage.read'] },
  { person: 'capApprover', code: 'DUYET_BI', name: 'Duyệt và công bố bảng điều hành', rank: 65, permissions: ['bi.publish', 'bi.query', 'bi.dashboard.share', 'bi.admin.read', 'bi.lineage.read', 'bi.dashboard.manage'] },
];

async function setUpBiBoard(ctx: SeedContext): Promise<void> {
  for (const role of BI_ROLES) {
    let roleId: string;
    const existing = await ctx.find('owner', '/resources/role_definition', (row) => row.code === role.code);
    if (existing !== undefined) roleId = String(existing.id);
    else roleId = (await ctx.command('owner', '/roles', { code: role.code, name: role.name, permissions: role.permissions, rank: role.rank })).resource_id;
    const membershipId = ctx.person(role.person).membershipId;
    const granted = await ctx.find('owner', '/resources/role_grant', (row: Obj) => row.membership_id === membershipId && row.role_id === roleId && String(row.status).toUpperCase() === 'ACTIVE');
    if (granted === undefined) await ctx.command('owner', '/role-grants', { membership_id: membershipId, role_id: roleId, scope_kind: 'TENANT', reason: 'Bảng điều hành lãnh đạo của Tổng công ty' });
  }
}

/** BI: the metrics of the platform and the dashboards of the leader (the bundle of the repository, the dashboards of the plan). */
export async function seedClipEnterpriseBi(ctx: SeedContext): Promise<void> {
  if (!enterprisePlanOnly(ctx)) return;
  // Granting a role asks for a second factor: the development token of the seed carries a fresh aal2 claim (context.ts).
  await ctx.step('IAM', 'roles of the BI board', () => setUpBiBoard(ctx));
  await seedClipBi(ctx);
}
