import { shiftDate, vnd } from './context.ts';
import type { Obj , SeedContext} from './context.ts';
import type { PortfolioProject } from './capital-projects.ts';

/**
 * The working records around the projects of the portfolio (PRJ): who answers for each project, its work breakdown, milestones and risks, the task
 * force that urges disbursement, the explanations the leader asked for, and the changes proposed to a project. All of it through the commands of PRJ,
 * as the project manager (who proposes) and the leader (who decides).
 */

const RISK_CATEGORIES = [
  { key: 'GPMB', label: 'Giải phóng mặt bằng' },
  { key: 'TIEN-DO', label: 'Tiến độ thi công' },
  { key: 'KY-THUAT', label: 'Kỹ thuật và chất lượng' },
  { key: 'VON', label: 'Cân đối nguồn vốn' },
  { key: 'PHAP-LY', label: 'Thủ tục pháp lý' },
];

/** The groups of risk the register uses: proposed by the project manager, approved and published by the leader, like any catalogue of the tenant. */
async function riskCategories(ctx: SeedContext): Promise<Map<string, string>> {
  const decision = await ctx.letter({ symbol: '130/QĐ-UBND', title: 'Quyết định về việc ban hành danh mục nhóm rủi ro dự án đầu tư công', issuedOn: '2026-10-22' });
  for (const category of RISK_CATEGORIES) {
    let record = await ctx.find('projectManager', '/master-records', (row) => row.business_key === category.key, { master_type: 'RISK_CATEGORY' });
    if (record === undefined) {
      await ctx.command('projectManager', '/master-records', { namespace: 'TENANT', master_type: 'RISK_CATEGORY', business_key: category.key, label: category.label, attributes: {}, valid_from: '2026-01-01', reason: 'Nhóm rủi ro dùng trong sổ rủi ro của dự án' });
      record = await ctx.find('projectManager', '/master-records', (row) => row.business_key === category.key, { master_type: 'RISK_CATEGORY' });
    }
    if (record === undefined) throw new Error(`the risk group ${category.key} cannot be found after it was proposed`);
    const changeId = String(record.open_change_request_id);
    if (record.status === 'DRAFT') {
      const change = await ctx.get('projectManager', `/master-change-requests/${changeId}`);
      await ctx.command('projectManager', `/master-change-requests/${changeId}/submit`, {}, { version: change.version });
    }
    if (record.status === 'DRAFT' || record.status === 'IN_REVIEW') {
      const change = await ctx.get('capApprover', `/master-change-requests/${changeId}`);
      await ctx.command('capApprover', `/master-change-requests/${changeId}/decision`, { decision: 'approve', reason: 'Phù hợp danh mục nhóm rủi ro của tỉnh' }, { version: change.version });
      record = await ctx.find('projectManager', '/master-records', (row) => row.business_key === category.key, { master_type: 'RISK_CATEGORY' });
    }
    if (record?.status === 'APPROVED') await ctx.command('capApprover', `/master-records/${String(record.id)}/publish`, { decision_document_id: decision.documentId }, { version: Number(record.version) });
  }
  const published = await ctx.list('projectManager', '/master-records', { master_type: 'RISK_CATEGORY' });
  return new Map(published.map((row) => [String(row.business_key), String(row.version_id)]));
}

/** The person in charge of a project answers for it before the leader (PRJ-17). */
async function assignLeader(ctx: SeedContext, project: PortfolioProject): Promise<void> {
  if (project.leader === undefined) return;
  const existing = await ctx.list('projectManager', '/resources/project_accountability', { project_id: project.id });
  if (existing.length > 0) return;
  const decision = await ctx.letter({ symbol: `${project.code.replace(/\D/gu, '')}/QĐ-SKHĐT`, title: `Quyết định phân công lãnh đạo phụ trách dự án ${project.name}`, issuedOn: ctx.day(-80), sender: 'Sở Kế hoạch và Đầu tư Cao Bằng' });
  await ctx.command('projectManager', `/projects/${project.id}/accountability-assignments`, {
    leader_membership_id: ctx.person(project.leader).membershipId,
    accountability_role: 'LEADER_IN_CHARGE',
    valid_from: ctx.day(-80),
    assignment_document_id: decision.documentId,
  });
  if (project.leader !== 'projectManager') {
    await ctx.attempt('projectManager', 'POST', `/projects/${project.id}/accountability-assignments`, { leader_membership_id: ctx.person('projectManager').membershipId, accountability_role: 'FOCAL_OFFICER', valid_from: ctx.day(-80) });
  }
}

/** The work breakdown of a project: the main components of the construction and their planned values (PRJ-05). */
async function components(ctx: SeedContext, project: PortfolioProject): Promise<Map<string, string>> {
  const existing = await ctx.get<Obj>('projectManager', `/projects/${project.id}/components`);
  const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.components ?? [])) as Obj[];
  const ids = new Map<string, string>(rows.map((row) => [String(row.code), String(row.id)]));
  const parts = [
    { code: 'CP1', name: 'Xây lắp công trình chính', share: 0.68 },
    { code: 'CP2', name: 'Thiết bị và hạng mục phụ trợ', share: 0.14 },
    { code: 'CP3', name: 'Chi phí tư vấn và quản lý dự án', share: 0.08 },
    { code: 'CP4', name: 'Bồi thường, hỗ trợ và tái định cư', share: 0.1 },
  ];
  for (const part of parts) {
    if (ids.has(part.code)) continue;
    const made = await ctx.command('projectManager', `/projects/${project.id}/components`, { code: part.code, name: part.name, planned_value_vnd: vnd(project.totalBillions * part.share), valid_from: `${project.startYear}-01-01`, sort_order: parts.indexOf(part) + 1 });
    ids.set(part.code, made.resource_id);
  }
  return ids;
}

/** Milestones: one done, one late with its reason, the rest planned ahead (PRJ-07, and the milestones of the phone). */
async function milestones(ctx: SeedContext, project: PortfolioProject, componentIds: Map<string, string>): Promise<void> {
  const existing = await ctx.get<Obj>('projectManager', `/projects/${project.id}/milestones`);
  const rows = (Array.isArray(existing) ? existing : (existing.items ?? existing.milestones ?? [])) as Obj[];
  if (rows.length > 0) return;
  const spec = [
    { code: 'GD1', name: 'Hoàn thành thiết kế bản vẽ thi công và dự toán', component: 'CP3', planned: ctx.day(-120), progress: 'DONE' as const },
    { code: 'GD2', name: 'Bàn giao mặt bằng và khởi công công trình', component: 'CP4', planned: ctx.day(-60), progress: 'DELAYED' as const },
    { code: 'GD3', name: 'Hoàn thành 50% khối lượng xây lắp', component: 'CP1', planned: ctx.day(45), progress: undefined },
    { code: 'GD4', name: 'Nghiệm thu, bàn giao đưa vào sử dụng', component: 'CP1', planned: ctx.day(240), progress: undefined },
  ];
  for (const item of spec) {
    const made = await ctx.command('projectManager', `/projects/${project.id}/milestones`, { code: item.code, name: item.name, component_id: componentIds.get(item.component), baseline_date: item.planned, planned_date: item.planned });
    if (item.progress === 'DONE') await ctx.command('projectManager', `/project-milestones/${made.resource_id}/progress`, { status: 'DONE', actual_date: shiftDate(item.planned, 6) }, { version: made.resource_version });
    if (item.progress === 'DELAYED') await ctx.command('projectManager', `/project-milestones/${made.resource_id}/progress`, { status: 'DELAYED', planned_date: ctx.day(25), reason: 'Chậm bàn giao mặt bằng do 7 hộ dân chưa nhận tiền bồi thường' }, { version: made.resource_version });
  }
}

/** Risks: one critical, one past its due date, one watched (PRJ-16). */
async function risks(ctx: SeedContext, project: PortfolioProject, categories: Map<string, string>): Promise<void> {
  const existing = await ctx.list('projectManager', `/projects/${project.id}/risks`);
  if (existing.length > 0) return;
  const owner = ctx.person(project.leader ?? 'projectManager').membershipId;
  const spec = [
    { code: 'R01', category: 'GPMB', title: 'Một số hộ dân chưa nhất trí phương án bồi thường', description: 'Còn hộ dân khiếu nại đơn giá bồi thường cây trồng và nhà phụ, chưa bàn giao toàn bộ mặt bằng', likelihood: 5, impact: 5, mitigation: 'Tổ chức đối thoại với hộ dân, rà soát lại đơn giá theo quyết định của tỉnh', due: ctx.day(21), status: 'ESCALATED' as const },
    { code: 'R02', category: 'TIEN-DO', title: 'Mùa mưa kéo dài làm chậm thi công', description: 'Lượng mưa tháng 9 và tháng 10 cao hơn trung bình nhiều năm, đã mất 14 ngày thi công', likelihood: 4, impact: 3, mitigation: 'Bố trí thêm nhân lực, thi công cuốn chiếu, bù tiến độ vào mùa khô', due: ctx.day(-12), status: 'MITIGATING' as const },
    { code: 'R03', category: 'VON', title: 'Chậm giải ngân vốn năm 2026', description: 'Tỷ lệ giải ngân hiện thấp hơn bình quân chung của tỉnh', likelihood: 3, impact: 4, mitigation: 'Thúc đẩy nghiệm thu khối lượng, hoàn thiện hồ sơ thanh toán theo từng giai đoạn', due: ctx.day(40), status: 'OPEN' as const },
  ];
  for (const item of spec) {
    await ctx.command('projectManager', `/projects/${project.id}/risks`, {
      code: item.code,
      category_master_version_id: categories.get(item.category),
      title: item.title,
      description: item.description,
      likelihood: item.likelihood,
      impact: item.impact,
      owner_membership_id: owner,
      mitigation: item.mitigation,
      due_date: item.due,
      status: item.status,
    });
  }
}

async function taskForce(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const existing = await ctx.list('projectManager', '/resources/task_force');
  if (existing.length > 0) return;
  const decision = await ctx.letter({ symbol: '88/QĐ-UBND', title: 'Quyết định về việc thành lập Tổ công tác đôn đốc giải ngân vốn đầu tư công năm 2026', issuedOn: '2026-02-03' });
  const created = await ctx.command('projectManager', '/task-forces', {
    code: 'TCT-2026-01',
    name: 'Tổ công tác đôn đốc giải ngân vốn đầu tư công năm 2026',
    purpose: 'Đôn đốc, tháo gỡ vướng mắc để giải ngân đạt kế hoạch được giao, ưu tiên các dự án chuyển tiếp và dự án vốn chương trình mục tiêu quốc gia',
    lead_membership_id: ctx.person('capApprover').membershipId,
    scope_unit_id: ctx.unitId('CB-SKHDT'),
    valid_from: '2026-02-03',
    establishment_document_id: decision.documentId,
  });
  const members = [
    { who: 'projectManager', role: 'MEMBER', project: 'DA-DT205' },
    { who: 'projectManager', role: 'MEMBER', project: 'DA-NN031' },
    { who: 'treasuryMaker', role: 'SECRETARY', project: undefined },
    { who: 'unitAdmin', role: 'MEMBER', project: 'DA-MT019' },
  ];
  for (const member of members) {
    const project = member.project === undefined ? undefined : portfolio.find((candidate) => candidate.code === member.project);
    await ctx.command('projectManager', `/task-forces/${created.resource_id}/members`, { membership_id: ctx.person(member.who).membershipId, member_role: member.role, ...(project === undefined ? {} : { project_id: project.id }), valid_from: '2026-02-03' });
  }
}

/** The leader asks, the unit answers, the leader accepts or returns (PRJ-19). */
async function explanations(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const existing = await ctx.list('capApprover', '/explanation-requests');
  if (existing.length > 0) return;
  const byCode = (code: string): PortfolioProject => {
    const found = portfolio.find((project) => project.code === code);
    if (found === undefined) throw new Error(`project ${code} is not in the portfolio`);
    return found;
  };
  const asks = [
    { code: 'DA-MT019', trigger: 'SUSPENDED_PROJECT', question: 'Đề nghị giải trình nguyên nhân tạm dừng công trình kè sông Hiến và phương án xử lý để đảm bảo giải ngân vốn năm 2026', due: ctx.day(10), response: 'Mái taluy đoạn Km1+200 sạt trượt, Ban đã thuê đơn vị khảo sát địa chất bổ sung, dự kiến có kết quả trong 15 ngày để điều chỉnh thiết kế.', decision: 'ACCEPTED' as const },
    { code: 'DA-DT205', trigger: 'LOW_DISBURSEMENT', question: 'Tỷ lệ giải ngân dự án đường tỉnh 205 thấp hơn bình quân của tỉnh, đề nghị báo cáo nguyên nhân và cam kết tiến độ', due: ctx.day(5), response: 'Do mặt bằng đoạn Km4 - Km6 chưa bàn giao đủ. Ban cam kết hoàn thành nghiệm thu giai đoạn 2 trước cuối tháng và hoàn thiện hồ sơ thanh toán.', decision: 'RETURNED' as const },
    { code: 'DA-NN031', trigger: 'MILESTONE_DELAYED', question: 'Đề nghị giải trình việc chậm mốc bàn giao mặt bằng công trình thủy lợi Nà Rạc', due: ctx.day(-4), response: undefined, decision: undefined },
  ];
  for (const ask of asks) {
    const project = byCode(ask.code);
    const made = await ctx.command('capApprover', '/explanation-requests', {
      subject_kind: 'PROJECT',
      project_id: project.id,
      trigger_code: ask.trigger,
      question: ask.question,
      requested_from_membership_id: ctx.person('projectManager').membershipId,
      due_at: `${ask.due}T10:00:00.000Z`,
    });
    if (ask.response === undefined) continue;
    const answered = await ctx.command('projectManager', `/explanation-requests/${made.resource_id}/response`, { response_text: ask.response }, { version: made.resource_version });
    if (ask.decision === 'ACCEPTED') await ctx.command('capApprover', `/explanation-requests/${made.resource_id}/decision`, { decision: 'ACCEPTED', review_note: 'Đã rõ nguyên nhân, theo dõi kết quả khảo sát' }, { version: answered.resource_version });
    if (ask.decision === 'RETURNED') await ctx.command('capApprover', `/explanation-requests/${made.resource_id}/decision`, { decision: 'RETURNED', review_note: 'Chưa nêu mốc thời gian cụ thể, đề nghị bổ sung', new_due_at: `${ctx.day(7)}T10:00:00.000Z` }, { version: answered.resource_version });
  }
}

/** Changes proposed to a project after its decision: one waits for the leader, one is approved (PRJ-06). */
async function revisions(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const dt = portfolio.find((project) => project.code === 'DA-DT205');
  const th = portfolio.find((project) => project.code === 'DA-TH012');
  if (dt === undefined || th === undefined) return;
  if ((await ctx.list('projectManager', `/projects/${dt.id}/revisions`)).length === 0) {
    await ctx.attempt('projectManager', 'POST', `/projects/${dt.id}/revisions`, { change_kind: 'ADJUST_INVESTMENT', after: { note: 'Bổ sung chi phí bồi thường theo đơn giá mới' }, total_investment_vnd: vnd(158), reason: 'Điều chỉnh đơn giá bồi thường, hỗ trợ theo quyết định mới của tỉnh làm tăng tổng mức đầu tư' });
  }
  if ((await ctx.list('projectManager', `/projects/${th.id}/revisions`)).length === 0) {
    const proposed = await ctx.attempt<{ resource_id: string; resource_version: number }>('projectManager', 'POST', `/projects/${th.id}/revisions`, { change_kind: 'ADJUST_SCHEDULE', after: { end_year: 2028 }, reason: 'Kéo dài thời gian thực hiện thêm một năm do điều chỉnh vị trí khu đất xây dựng' });
    if (proposed.ok) {
      const decision = await ctx.letter({ symbol: '2105/QĐ-UBND', title: 'Quyết định điều chỉnh tiến độ dự án Trường Tiểu học phường Nùng Trí Cao', issuedOn: ctx.day(-15) });
      await ctx.attempt('capApprover', 'POST', `/project-revisions/${proposed.json.resource_id}/decision`, { decision: 'approve', reason: 'Phù hợp điều kiện thực tế của địa phương', decision_document_id: decision.documentId, effective_from: ctx.day(-15) }, { version: proposed.json.resource_version });
    }
  }
}

export async function seedProjectExtras(ctx: SeedContext, portfolio: PortfolioProject[]): Promise<void> {
  const categories = await ctx.step('PRJ', 'risk groups of the register', () => riskCategories(ctx));
  const working = portfolio.filter((project) => ['BUDGETED', 'IMPLEMENTATION', 'SUSPENDED', 'COMPLETED'].includes(project.target));
  for (const project of working) {
    await ctx.step('PRJ', `leader of ${project.code}`, () => assignLeader(ctx, project));
    const parts = await ctx.step('PRJ', `work breakdown of ${project.code}`, () => components(ctx, project));
    await ctx.step('PRJ', `milestones of ${project.code}`, () => milestones(ctx, project, parts));
    await ctx.step('PRJ', `risks of ${project.code}`, () => risks(ctx, project, categories));
  }
  await ctx.step('PRJ', 'task force for the disbursement', () => taskForce(ctx, portfolio));
  await ctx.step('PRJ', 'explanations asked by the leader', () => explanations(ctx, portfolio));
  await ctx.step('PRJ', 'changes proposed to projects', () => revisions(ctx, portfolio));
}
