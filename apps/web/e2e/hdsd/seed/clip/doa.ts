import type { Obj, SeedContext } from '../context.ts';

/**
 * The delegation of authority matrix the signing of outgoing decisions needs (ADM-04): the leader role signs every kind of document of the
 * whole organisation, whatever the amount. Drafted by the project manager, decided by the leader (maker is not checker). Asked first and skipped when a
 * matrix is already in force, so a second run does nothing.
 */
const DOCUMENT_TYPES = ['QD', 'CV', 'BC', 'GM', 'KH', 'TB', 'TTR', 'HD', 'BB', 'BL', 'HSNL', 'CTR_CONTRACT'];

export async function ensureDoaMatrix(ctx: SeedContext): Promise<void> {
  const versions = await ctx.list<Obj>('owner', '/resources/doa_matrix_version');
  // The persisted statuses are Draft, PendingApproval, Rejected, Published and Superseded: a published matrix is the one in force, the skip.
  if (versions.some((row) => String(row.status).toUpperCase() === 'PUBLISHED')) return;
  const role = await ctx.find('owner', '/resources/role_definition', (row) => row.code === 'LANH_DAO_SO');
  if (role === undefined) throw new Error('the leader role LANH_DAO_SO does not exist on this stack');
  let draft = versions.find((row) => ['DRAFT', 'PENDINGAPPROVAL'].includes(String(row.status).toUpperCase()));
  let id: string;
  let version: number;
  if (draft === undefined) {
    const created = await ctx.command('projectManager', '/doa-matrices', {
      effective_from: ctx.day(-200),
      legal_basis_ref: 'QD-UBND-QUY-CHE-UY-QUYEN-2026',
      rules: DOCUMENT_TYPES.map((type) => ({ document_type: type, unit_id: ctx.unitId('CB-HQ'), include_subtree: true, amount_min_vnd: '0', approver_role_id: String(role.id), approval_levels: 1, requires_distinct_approvers: false })),
    });
    id = created.resource_id;
    version = created.resource_version;
    draft = { id, status: 'DRAFT', version };
  } else {
    id = String(draft.id);
    version = Number(draft.version);
  }
  if (String(draft.status).toUpperCase() === 'DRAFT') {
    const sent = await ctx.command('projectManager', `/doa-matrices/${id}/submit`, { reason: 'Submitted for the decision of the leader' }, { version });
    version = sent.resource_version;
  }
  const basis = await ctx.letter({ symbol: '41/QD-UBND', title: 'Decision on the delegation of authority', issuedOn: ctx.day(-210) });
  await ctx.command('capApprover', `/doa-matrices/${id}/decision`, { decision: 'approve', reason: 'The matrix of the clip province', evidence_ids: [basis.documentId] }, { version });
  ctx.record({ module: 'ADM', screen: 'ADM-04', kind: 'doa-matrix', id, code: 'DOA', note: 'approved' });
}
