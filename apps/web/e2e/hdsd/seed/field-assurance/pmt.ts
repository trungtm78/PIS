import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { CHECKER, MAKER, OWNER, asString, paper, projectOf, tolerate } from './shared.ts';

/**
 * PMT: the permits a public investment project must hold before a milestone. The story of the department: the catalogue of the eight permit types the
 * province's projects need, a dossier for each of the three projects with the permits its kind of works requires, and the permits at every stage: issued
 * (one for good, one that ends within the month, one that ended five weeks ago), in appraisal, waiting for a supplement, rejected and filed again,
 * exempted by a second person, and the gates that hold a milestone until the permit is valid.
 */

interface TypeSpec {
  code: string;
  name: string;
  category: 'ENVIRONMENT' | 'DESIGN_APPRAISAL' | 'FIRE_SAFETY' | 'CONSTRUCTION_PERMIT' | 'LAND' | 'TRAFFIC' | 'WATER_RESOURCES' | 'OTHER';
  authority: string;
  basis: string;
  validityMonths?: number;
  processingDays?: number;
  exemptionAllowed?: boolean;
  appliesTo: Obj;
}

const TYPES: TypeSpec[] = [
  { code: 'GPXD', name: 'Giấy phép xây dựng', category: 'CONSTRUCTION_PERMIT', authority: 'Sở Xây dựng tỉnh Cao Bằng', basis: 'Luật Xây dựng số 50/2014/QH13 (sửa đổi, bổ sung năm 2020), Điều 89 và Điều 95', validityMonths: 24, processingDays: 20, exemptionAllowed: true, appliesTo: { work_types: ['EDUCATION', 'HEALTH'] } },
  { code: 'DTM', name: 'Quyết định phê duyệt báo cáo đánh giá tác động môi trường', category: 'ENVIRONMENT', authority: 'Sở Tài nguyên và Môi trường tỉnh Cao Bằng', basis: 'Luật Bảo vệ môi trường số 72/2020/QH14, Điều 34', processingDays: 45, appliesTo: { min_total_investment_vnd: '100000000000' } },
  { code: 'GPMT', name: 'Giấy phép môi trường', category: 'ENVIRONMENT', authority: 'Sở Tài nguyên và Môi trường tỉnh Cao Bằng', basis: 'Luật Bảo vệ môi trường số 72/2020/QH14, Điều 39', validityMonths: 84, processingDays: 30, appliesTo: { min_total_investment_vnd: '40000000000' } },
  { code: 'PCCC', name: 'Văn bản thẩm duyệt thiết kế phòng cháy và chữa cháy', category: 'FIRE_SAFETY', authority: 'Phòng Cảnh sát phòng cháy, chữa cháy và cứu nạn, cứu hộ - Công an tỉnh Cao Bằng', basis: 'Luật Phòng cháy, chữa cháy số 27/2001/QH10 (sửa đổi năm 2013), Nghị định số 136/2020/NĐ-CP, Điều 13', processingDays: 15, appliesTo: { work_types: ['EDUCATION', 'HEALTH'] } },
  { code: 'TKXD', name: 'Văn bản thẩm định thiết kế xây dựng', category: 'DESIGN_APPRAISAL', authority: 'Sở Xây dựng tỉnh Cao Bằng', basis: 'Nghị định số 15/2021/NĐ-CP về quản lý dự án đầu tư xây dựng, Điều 11', processingDays: 30, appliesTo: {} },
  { code: 'GPTC', name: 'Giấy phép thi công trong phạm vi bảo vệ đường bộ', category: 'TRAFFIC', authority: 'Sở Giao thông vận tải tỉnh Cao Bằng', basis: 'Luật Đường bộ số 35/2024/QH15, Điều 45', validityMonths: 12, processingDays: 10, appliesTo: { work_types: ['TRANSPORT'] } },
  { code: 'QDGD', name: 'Quyết định giao đất, cho thuê đất', category: 'LAND', authority: 'Ủy ban nhân dân tỉnh Cao Bằng', basis: 'Luật Đất đai số 31/2024/QH15, Điều 116', processingDays: 40, appliesTo: {} },
  { code: 'GPNM', name: 'Giấy phép khai thác, sử dụng nước mặt', category: 'WATER_RESOURCES', authority: 'Sở Tài nguyên và Môi trường tỉnh Cao Bằng', basis: 'Luật Tài nguyên nước số 28/2023/QH15, Điều 44', validityMonths: 60, processingDays: 30, appliesTo: { work_types: ['TRANSPORT'] } },
];

/** How far a permit goes in the story: the state it is left in, and the days (before today) of its steps. */
interface Plan {
  type: string;
  /** What the permit is left as. */
  to: 'ISSUED' | 'IN_APPRAISAL' | 'SUBMITTED' | 'SUPPLEMENT_REQUESTED' | 'REJECTED_THEN_FILED' | 'EXEMPTED' | 'PLANNED';
  /** Days before today the application went in. */
  submitted?: number;
  /** For an issued permit: its number, the day of issue (days before today) and the day it ends (days from today; null for none). */
  no?: string;
  issued?: number;
  endsIn?: number;
  note?: string;
}

const DOSSIERS: Record<string, { owner: string; plans: Plan[] }> = {
  'DA-DT205': {
    owner: 'CB-SKHDT-QLDA',
    plans: [
      { type: 'DTM', to: 'ISSUED', submitted: 210, issued: 160, no: '1843/QĐ-UBND', note: 'Hồ sơ đánh giá tác động môi trường đã được thẩm định' },
      { type: 'GPMT', to: 'ISSUED', submitted: 330, issued: 300, no: '07/GPMT-STNMT', endsIn: 24 },
      { type: 'TKXD', to: 'ISSUED', submitted: 120, issued: 90, no: '212/TĐ-SXD' },
      { type: 'GPTC', to: 'ISSUED', submitted: 430, issued: 400, no: '56/GP-SGTVT', endsIn: -35 },
      { type: 'GPNM', to: 'ISSUED', submitted: 80, issued: 60, no: '14/GP-STNMT', endsIn: 9 },
      { type: 'QDGD', to: 'IN_APPRAISAL', submitted: 38, note: 'Chờ hội đồng thẩm định quỹ đất của tỉnh' },
    ],
  },
  'DA-TH012': {
    owner: 'CB-SKHDT-QLDA',
    plans: [
      { type: 'GPXD', to: 'SUPPLEMENT_REQUESTED', submitted: 26, note: 'Cơ quan cấp phép yêu cầu bổ sung bản vẽ thoát nước mái' },
      { type: 'GPMT', to: 'SUBMITTED', submitted: 6 },
      { type: 'PCCC', to: 'REJECTED_THEN_FILED', submitted: 75, note: 'Thiết kế lối thoát nạn chưa đạt quy chuẩn' },
      { type: 'TKXD', to: 'ISSUED', submitted: 100, issued: 70, no: '188/TĐ-SXD' },
      { type: 'QDGD', to: 'ISSUED', submitted: 200, issued: 150, no: '2210/QĐ-UBND' },
    ],
  },
  'DA-YT007': {
    owner: 'CB-SKHDT-QLDA',
    plans: [
      { type: 'GPXD', to: 'EXEMPTED' },
      { type: 'PCCC', to: 'ISSUED', submitted: 90, issued: 62, no: '41/TD-PCCC' },
      { type: 'TKXD', to: 'ISSUED', submitted: 110, issued: 84, no: '176/TĐ-SXD' },
      { type: 'QDGD', to: 'IN_APPRAISAL', submitted: 21 },
    ],
  },
};

async function permitTypes(ctx: SeedContext): Promise<Map<string, Obj>> {
  const rows = await ctx.list(MAKER, '/resources/permit_type');
  return new Map(rows.map((row) => [asString(row.code), row]));
}

/** The catalogue: the types are published from the first day of the year, each with its authority, legal basis and the projects it applies to. */
async function publishTypes(ctx: SeedContext): Promise<void> {
  const known = await permitTypes(ctx);
  for (const type of TYPES) {
    if (known.has(type.code)) {
      ctx.record({ module: 'PMT', screen: 'PMT-03', kind: 'permit-type', id: asString(known.get(type.code)?.id), code: type.code, note: 'existing' });
      continue;
    }
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

async function openDossier(ctx: SeedContext, projectCode: string, ownerUnit: string): Promise<string> {
  const project = await projectOf(ctx, projectCode);
  const found = await ctx.find(MAKER, '/resources/permit_dossier', (row) => row.project_id === project.id);
  if (found !== undefined) return asString(found.id);
  const made = await ctx.command(MAKER, `/projects/${project.id}/permit-dossiers`, { owner_unit_id: ctx.unitId(ownerUnit), owner_membership_id: ctx.person(MAKER).membershipId });
  ctx.record({ module: 'PMT', screen: 'PMT-01', kind: 'permit-dossier', id: made.resource_id, code: projectCode, note: 'opened' });
  return made.resource_id;
}

const dossierDetail = (ctx: SeedContext, id: string): Promise<Obj> => ctx.get(MAKER, `/resources/permit_dossier/${id}`);
const permitDetail = (ctx: SeedContext, id: string): Promise<Obj> => ctx.get(MAKER, `/resources/permit/${id}`);

/** The permit of a type that is still to be worked (planned or on its way), or undefined. */
function openPermitOf(dossier: Obj, type: string, statuses: string[]): Obj | undefined {
  return (dossier.permits as Obj[]).find((permit) => permit.permit_type_code === type && statuses.includes(asString(permit.status)));
}

async function milestone(ctx: SeedContext, permitId: string, step: string, body: Obj): Promise<number> {
  const permit = await permitDetail(ctx, permitId);
  const done = await ctx.command(MAKER, `/permits/${permitId}/milestones`, { step_code: step, ...body }, { version: Number(permit.version) });
  return done.resource_version;
}

/** The application goes in and the authority acknowledges it: the permit is in appraisal. */
async function submitAndAcknowledge(ctx: SeedContext, permitId: string, submittedAgo: number, supplier: string): Promise<void> {
  const first = await paper(ctx, { symbol: `HS-${supplier}/${ctx.year}`, title: `Hồ sơ đề nghị cấp phép ${supplier}`, type: 'CV', sender: 'Ban Quản lý dự án', issuedOn: ctx.day(-submittedAgo) });
  await milestone(ctx, permitId, 'SUBMITTED', { actual_on: ctx.day(-submittedAgo), note: 'Nộp hồ sơ trực tiếp tại bộ phận một cửa', document_version_id: first.versionId });
  await milestone(ctx, permitId, 'ACKNOWLEDGED', { actual_on: ctx.day(-Math.max(submittedAgo - 2, 0)), note: 'Cơ quan cấp phép đã tiếp nhận và hẹn lịch thẩm định' });
}

async function issue(ctx: SeedContext, permitId: string, projectCode: string, plan: Plan): Promise<void> {
  const licence = await paper(ctx, {
    symbol: `${plan.no ?? 'GP'}/${projectCode}/${plan.type}`,
    title: `${plan.type} ${plan.no ?? ''} của dự án ${projectCode}`,
    type: 'GP',
    sender: 'Cơ quan cấp phép',
    issuedOn: ctx.day(-(plan.issued ?? 30)),
  });
  const issuedOn = ctx.day(-(plan.issued ?? 30));
  const permit = await permitDetail(ctx, permitId);
  await ctx.command(
    MAKER,
    `/permits/${permitId}/decision`,
    {
      outcome: 'ISSUED',
      permit_no: plan.no,
      issued_on: issuedOn,
      valid_from: issuedOn,
      ...(plan.endsIn === undefined ? { no_expiry: true } : { valid_until: ctx.day(plan.endsIn) }),
      document_version_id: licence.versionId,
    },
    { version: Number(permit.version) },
  );
}

async function workPermit(ctx: SeedContext, projectCode: string, dossierId: string, plan: Plan): Promise<void> {
  let dossier = await dossierDetail(ctx, dossierId);
  const planned = openPermitOf(dossier, plan.type, ['PLANNED']);
  const tag = `${projectCode}-${plan.type}`;
  const present = (statuses: string[]): Obj | undefined => openPermitOf(dossier, plan.type, statuses);
  const record = (permit: Obj | undefined, note: string): void => ctx.record({ module: 'PMT', screen: 'PMT-02', kind: 'permit', id: asString(permit?.id), code: tag, note });
  if (planned === undefined && present(['IN_APPRAISAL', 'SUBMITTED', 'SUPPLEMENT_REQUESTED', 'ISSUED', 'EXEMPTED']) === undefined) {
    if (plan.to === 'REJECTED_THEN_FILED' && present(['REJECTED']) !== undefined) {
      // the first attempt was refused: the next one is a new permit of the type
    } else {
      ctx.warn(`${tag}: the dossier plans no permit of this type for the project (types in force that apply: ${(dossier.permits as Obj[]).map((p) => p.permit_type_code).join(', ')})`);
      return;
    }
  }
  if (plan.to === 'PLANNED') return record(planned, 'planned');
  if (plan.to === 'EXEMPTED') {
    if (planned === undefined) return record(present(['EXEMPTED']), 'existing');
    const decision = await paper(ctx, { symbol: `${projectCode}/MT-GPXD`, title: `Quyết định miễn giấy phép xây dựng của dự án ${projectCode}`, type: 'QD', sender: 'Sở Xây dựng tỉnh Cao Bằng', issuedOn: ctx.day(-40) });
    // The person who declares the exemption is not the one who opened the dossier and planned the permit.
    await ctx.command(OWNER, `/permits/${asString(planned.id)}/exempt`, { exemption_basis: 'Công trình sửa chữa, cải tạo không làm thay đổi kết cấu chịu lực và công năng sử dụng (Luật Xây dựng, Điều 89, khoản 2)', exemption_decision_document_version_id: decision.versionId }, { version: Number(planned.version) });
    return record(planned, 'exempted');
  }
  if (plan.to === 'REJECTED_THEN_FILED') {
    let first = planned ?? present(['REJECTED']);
    if (planned !== undefined) {
      await submitAndAcknowledge(ctx, asString(planned.id), plan.submitted ?? 60, `${tag}-L1`);
      const current = await permitDetail(ctx, asString(planned.id));
      await ctx.command(MAKER, `/permits/${asString(planned.id)}/decision`, { outcome: 'REJECTED', reason: plan.note ?? 'Hồ sơ chưa đạt yêu cầu' }, { version: Number(current.version) });
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
  const permit = planned;
  if (permit === undefined) return record(present(['IN_APPRAISAL', 'SUBMITTED', 'SUPPLEMENT_REQUESTED', 'ISSUED']), 'existing');
  const id = asString(permit.id);
  if (plan.to === 'SUBMITTED') {
    const first = await paper(ctx, { symbol: `HS-${tag}/${ctx.year}`, title: `Hồ sơ đề nghị cấp phép ${tag}`, type: 'CV', sender: 'Ban Quản lý dự án', issuedOn: ctx.day(-(plan.submitted ?? 5)) });
    await milestone(ctx, id, 'SUBMITTED', { actual_on: ctx.day(-(plan.submitted ?? 5)), note: 'Nộp hồ sơ qua cổng dịch vụ công của tỉnh', document_version_id: first.versionId });
    return record(permit, 'submitted');
  }
  await submitAndAcknowledge(ctx, id, plan.submitted ?? 30, tag);
  if (plan.to === 'IN_APPRAISAL') {
    await milestone(ctx, id, 'APPRAISAL_MEETING', { planned_on: ctx.day(6), note: plan.note ?? 'Họp thẩm định hồ sơ' });
    return record(permit, 'in appraisal');
  }
  if (plan.to === 'SUPPLEMENT_REQUESTED') {
    await milestone(ctx, id, 'SUPPLEMENT_REQUESTED', { actual_on: ctx.day(-Math.max((plan.submitted ?? 30) - 14, 1)), note: plan.note ?? 'Yêu cầu bổ sung hồ sơ' });
    return record(permit, 'supplement requested');
  }
  await issue(ctx, id, projectCode, plan);
  record(permit, 'issued');
}

/** The gates: a milestone is held until the permit of its rule is valid (or exempted, or only submitted when the rule says so). */
async function publishGates(ctx: SeedContext): Promise<void> {
  const types = await permitTypes(ctx);
  const rules = await ctx.list(MAKER, '/resources/permit_gate_rule');
  const wanted = [
    { gate: 'START_CONSTRUCTION', type: 'GPXD', requirement: 'VALID_OR_EXEMPT', appliesTo: { work_types: ['EDUCATION', 'HEALTH'] }, basis: 'Luật Xây dựng 2014 (sửa đổi 2020), Điều 107: chỉ khởi công khi đã có giấy phép xây dựng hoặc được miễn' },
    { gate: 'ACCEPTANCE_COMPLETION', type: 'PCCC', requirement: 'VALID_PERMIT', appliesTo: { work_types: ['EDUCATION', 'HEALTH'] }, basis: 'Nghị định số 136/2020/NĐ-CP, Điều 15: nghiệm thu về phòng cháy trước khi đưa vào sử dụng' },
    { gate: 'HANDOVER', type: 'TKXD', requirement: 'VALID_PERMIT', appliesTo: {}, basis: 'Nghị định số 15/2021/NĐ-CP, Điều 31: bàn giao công trình theo thiết kế đã được thẩm định' },
  ];
  for (const rule of wanted) {
    const type = types.get(rule.type);
    if (type === undefined) throw new Error(`the permit type ${rule.type} is not published`);
    const exists = rules.some((row) => row.gate_code === rule.gate && asString(row.permit_type_code ?? row.permit_type?.code) === rule.type);
    if (exists) continue;
    const made = await ctx.command(MAKER, '/permit-gate-rules', {
      gate_code: rule.gate,
      permit_type_id: type.id,
      requirement: rule.requirement,
      applies_to_rule: rule.appliesTo,
      legal_basis: rule.basis,
      effective_from: '2026-01-01',
    });
    ctx.record({ module: 'PMT', screen: 'PMT-04', kind: 'permit-gate-rule', id: made.resource_id, code: `${rule.gate}/${rule.type}`, note: 'published' });
  }
}

/** A gate waived for a time by the owner of the tenant, who did not write the paper that backs it. */
async function grantWaiver(ctx: SeedContext): Promise<void> {
  const project = await projectOf(ctx, 'DA-TH012');
  const types = await permitTypes(ctx);
  const type = types.get('PCCC');
  const existing = await ctx.list(MAKER, '/resources/permit_gate_waiver');
  if (existing.some((row) => asString(row.project?.id) === project.id)) return;
  const decision = await paper(ctx, { symbol: '312/QĐ-UBND-MT', title: 'Quyết định cho phép nghiệm thu có điều kiện về phòng cháy chữa cháy của Trường Tiểu học phường Nùng Trí Cao', type: 'QD', issuedOn: ctx.day(-10) });
  const made = await tolerate(ctx, 'waive the gate ACCEPTANCE_COMPLETION of DA-TH012', () =>
    ctx.command(OWNER, '/permit-gate-waivers', {
      project_id: project.id,
      gate_code: 'ACCEPTANCE_COMPLETION',
      permit_type_id: asString(type?.id),
      reason: 'Cho phép nghiệm thu giai đoạn trong thời gian chờ thẩm duyệt lại thiết kế phòng cháy chữa cháy',
      decision_document_version_id: decision.versionId,
      valid_until: ctx.day(45),
    }),
  );
  if (made !== undefined) ctx.record({ module: 'PMT', screen: 'PMT-06', kind: 'permit-gate-waiver', id: made.resource_id, code: 'DA-TH012/ACCEPTANCE_COMPLETION', note: 'granted' });
}

export async function seedPmt(ctx: SeedContext): Promise<void> {
  await ctx.step('PMT', 'the catalogue of permit types', () => publishTypes(ctx));
  for (const [projectCode, spec] of Object.entries(DOSSIERS)) {
    const dossierId = await ctx.step('PMT', `dossier of ${projectCode}`, () => openDossier(ctx, projectCode, spec.owner));
    for (const plan of spec.plans) await ctx.step('PMT', `permit ${projectCode}/${plan.type} (${plan.to})`, () => workPermit(ctx, projectCode, dossierId, plan));
  }
  await ctx.step('PMT', 'gate rules', () => publishGates(ctx));
  await ctx.step('PMT', 'waiver of the gate for DA-TH012', () => grantWaiver(ctx));
  void CHECKER;
}
