import { randomUUID } from 'node:crypto';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { CHECKER, MAKER, OWNER, asString, ensureWorkCalendar, paper, projectOf, publishMaster, tolerate } from './shared.ts';

/**
 * ISS: the problems of the construction sites and how fast the province answers them. The story: the department defines five kinds of problem and
 * the time it gives to answer each by severity; the project board reports the problems of the three projects (land not handed over, a bridge deck that
 * failed a test, a missing permit, a safety incident, a contractor that lags); some are assigned and worked, one waits for verification, two are closed,
 * and three are escalated to a higher unit or a task force. Severities run from low to critical. The deadlines are counted by the product from the moment of
 * the report, so a problem of a two-hour SLA becomes overdue by itself once the hours pass.
 */

const CATEGORIES = [
  { key: 'GPMB', label: 'Giải phóng mặt bằng', unit: 'CB-SKHDT-QLDA' },
  { key: 'CHAT-LUONG', label: 'Chất lượng công trình', unit: 'CB-SKHDT-QLDA' },
  { key: 'GIAY-PHEP', label: 'Giấy phép và thủ tục', unit: 'CB-SKHDT-VP' },
  { key: 'AN-TOAN-MT', label: 'An toàn lao động và môi trường', unit: 'CB-SKHDT-QLDA' },
  { key: 'TIEN-DO', label: 'Tiến độ và năng lực nhà thầu', unit: 'CB-SKHDT-QLDA' },
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
  { title: 'Hộ ông Hoàng Văn Sính chưa nhận tiền bồi thường, chưa bàn giao mặt bằng đoạn Km3+200', project: 'DA-DT205', category: 'GPMB', severity: 'CRITICAL', description: 'Hộ gia đình có 480 m2 đất nông nghiệp trong chỉ giới thu hồi, đã kiểm đếm xong nhưng chưa nhận tiền bồi thường nên không cho nhà thầu vào thi công đoạn Km3+200 - Km3+450.', to: 'IN_PROGRESS', worker: 'projectManager', comment: 'Đã làm việc với hộ dân và Hội đồng bồi thường xã, hẹn chi trả đợt đầu trong tuần.', escalate: { level: 2, unit: 'CB-SKHDT', reason: 'Quá hạn bàn giao mặt bằng, cần Sở Kế hoạch và Đầu tư chỉ đạo Hội đồng bồi thường huyện.', accept: true }, position: { lat: '22.665400', lng: '106.257900', accuracy: '12' } },
  { title: 'Nhà thầu thi công đoạn Km5 - Km8 chậm tiến độ hơn 20 ngày so với kế hoạch', project: 'DA-DT205', category: 'TIEN-DO', severity: 'HIGH', description: 'Khối lượng nền đường đạt 62% so với kế hoạch tháng. Nhà thầu báo thiếu máy lu và nhân lực do mưa kéo dài.', to: 'IN_PROGRESS', worker: 'owner', comment: 'Đã yêu cầu nhà thầu bổ sung hai máy lu và nộp tiến độ điều chỉnh.', extend: { reason: 'Mưa kéo dài, chủ đầu tư đồng ý gia hạn thêm một ngày làm việc để nhà thầu bổ sung thiết bị.' } },
  { title: 'Mẫu bê tông cống hộp Km7+120 không đạt cường độ 28 ngày', project: 'DA-DT205', category: 'CHAT-LUONG', severity: 'HIGH', description: 'Kết quả nén mẫu của phòng thí nghiệm đạt 24,1 MPa, thấp hơn mác thiết kế M30. Cần xử lý và thí nghiệm lại bằng khoan lấy lõi.', to: 'PENDING_VERIFICATION', worker: 'projectManager', comment: 'Đã khoan lấy lõi tại ba vị trí, kết quả đạt 31,2 MPa.' },
  { title: 'Sự cố sạt taluy dương tại Km9+600 làm gián đoạn giao thông', project: 'DA-DT205', category: 'AN-TOAN-MT', severity: 'CRITICAL', description: 'Mưa lớn làm sạt khoảng 300 m3 đất đá xuống mặt đường, phải phân luồng. Chưa có người bị thương.', to: 'IN_PROGRESS', worker: 'projectManager', comment: 'Đã cắm biển cảnh báo và huy động máy xúc dọn đất.', escalate: { level: 1, reason: 'Cần Ban quản lý dự án điều thêm lực lượng và máy móc ứng cứu.', accept: false }, position: { lat: '22.701200', lng: '106.301500', accuracy: '8' } },
  { title: 'Chưa có giấy phép thi công trong phạm vi bảo vệ đường bộ tại nút giao Km11', project: 'DA-DT205', category: 'GIAY-PHEP', severity: 'MEDIUM', description: 'Giấy phép thi công của gói thầu số 2 đã hết hạn, nhà thầu cần gia hạn trước khi làm tiếp phần nút giao.', to: 'ASSIGNED', worker: 'projectManager' },
  { title: 'Đơn vị tư vấn giám sát chậm nộp báo cáo tháng 10', project: 'DA-DT205', category: 'TIEN-DO', severity: 'LOW', description: 'Báo cáo giám sát tháng 10 quá hạn nộp 5 ngày làm việc.', to: 'CLOSED', worker: 'owner', comment: 'Đã nhận báo cáo và nhắc nhở đơn vị tư vấn.' },
  // DA-TH012 - the primary school
  { title: 'Chưa thống nhất đơn giá cây trồng với hộ ông Đàm Văn Tiến trong khu vực xây trường', project: 'DA-TH012', category: 'GPMB', severity: 'MEDIUM', description: 'Hộ dân đề nghị tính lại giá cây ăn quả theo thời điểm hiện tại.', to: 'IN_PROGRESS', worker: 'owner', comment: 'Đã mời Hội đồng thẩm định giá của huyện làm việc với hộ dân.' },
  { title: 'Cốt thép dầm tầng 2 khối lớp học để lệch lớp bê tông bảo vệ', project: 'DA-TH012', category: 'CHAT-LUONG', severity: 'HIGH', description: 'Giám sát phát hiện lớp bê tông bảo vệ chỉ đạt 15 mm so với 25 mm thiết kế tại sáu vị trí.', to: 'ASSIGNED', worker: 'projectManager' },
  { title: 'Thiếu biển báo và lưới che chắn khu vực đào móng khối nhà hiệu bộ', project: 'DA-TH012', category: 'AN-TOAN-MT', severity: 'CRITICAL', description: 'Hố móng sâu 2,4 m sát lối đi của học sinh chưa có rào chắn.', to: 'OPEN' },
  { title: 'Hồ sơ phòng cháy chữa cháy bị trả lại lần thứ nhất', project: 'DA-TH012', category: 'GIAY-PHEP', severity: 'MEDIUM', description: 'Phòng Cảnh sát phòng cháy yêu cầu sửa lối thoát nạn tầng hai theo quy chuẩn.', to: 'CLOSED', worker: 'owner', comment: 'Đã nộp lại hồ sơ đã chỉnh sửa theo ý kiến của cơ quan thẩm duyệt.' },
  // DA-YT007 - the health station
  { title: 'Nhà thầu chưa nộp biện pháp thi công phần cải tạo mái', project: 'DA-YT007', category: 'TIEN-DO', severity: 'LOW', description: 'Biện pháp thi công và an toàn lao động làm việc trên cao chưa được trình duyệt.', to: 'OPEN' },
  { title: 'Thiết bị y tế bàn giao thiếu hồ sơ xuất xứ', project: 'DA-YT007', category: 'CHAT-LUONG', severity: 'MEDIUM', description: 'Ba thiết bị chưa có chứng nhận xuất xứ và phiếu kiểm định.', to: 'IN_PROGRESS', worker: 'projectManager', comment: 'Đã liên hệ nhà cung cấp, hẹn bổ sung hồ sơ trong tuần.' },
  { title: 'Bụi và tiếng ồn từ công trình ảnh hưởng đến bệnh nhân đang điều trị', project: 'DA-YT007', category: 'AN-TOAN-MT', severity: 'HIGH', description: 'Trạm y tế vẫn hoạt động trong thời gian cải tạo, cần che chắn và điều chỉnh giờ thi công.', to: 'IN_PROGRESS', worker: 'owner', comment: 'Đã thống nhất giờ thi công với trạm trưởng và lắp thêm vách che bụi.' },
  { title: 'Chậm giải ngân tạm ứng nên nhà thầu tạm dừng mua vật tư', project: 'DA-YT007', category: 'TIEN-DO', severity: 'MEDIUM', description: 'Nhà thầu đề nghị tạm ứng đợt hai từ đầu tháng, chưa được giải ngân.', to: 'PENDING_VERIFICATION', worker: 'projectManager', comment: 'Đã hoàn tất thủ tục, tiền tạm ứng đã chuyển.' },
];

async function categories(ctx: SeedContext): Promise<Map<string, Obj>> {
  const decision = await paper(ctx, { symbol: '131/QĐ-SKHĐT', title: 'Quyết định về việc ban hành danh mục loại vướng mắc trong đầu tư công', type: 'QD', sender: 'Sở Kế hoạch và Đầu tư tỉnh Cao Bằng', issuedOn: ctx.day(-45) });
  const result = new Map<string, Obj>();
  for (const category of CATEGORIES) {
    const record = await publishMaster(ctx, { type: 'ISSUE_CATEGORY', key: category.key, label: category.label, attributes: { handler_unit_key: category.unit }, reason: 'Ban hành danh mục loại vướng mắc theo Quyết định số 131/QĐ-SKHĐT' }, decision);
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
    await ctx.command(CHECKER, `/issues/${issueId}/assign`, { assignee_id: ctx.person(workerKey).membershipId, note: 'Giao xử lý theo phạm vi phụ trách' }, { version: Number(issue.version) });
    issue = await read();
  }
  if (issue.status === 'ASSIGNED' && ['IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED'].includes(spec.to)) {
    await ctx.command(workerKey, `/issues/${issueId}/start`, { note: 'Bắt đầu xử lý' }, { version: Number(issue.version) });
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
      if (open !== undefined) await tolerate(ctx, `accept the escalation of ${spec.title}`, () => ctx.command(CHECKER, `/issue-escalations/${asString(open.id)}/accept`, { note: 'Tiếp nhận và sẽ chủ trì cuộc họp giải quyết trong tuần' }, { version: Number(open.version ?? 1) }));
    }
    issue = await read();
  }
  if (['PENDING_VERIFICATION', 'CLOSED'].includes(spec.to) && issue.status === 'IN_PROGRESS') {
    await ctx.command(workerKey, `/issues/${issueId}/request-verification`, { result_note: spec.comment ?? 'Đã xử lý xong', evidence_document_version_ids: [] }, { version: Number(issue.version) });
    issue = await read();
  }
  if (spec.to === 'CLOSED' && issue.status === 'PENDING_VERIFICATION') {
    const verifier = workerKey === 'owner' ? MAKER : OWNER;
    await ctx.command(verifier, `/issues/${issueId}/close`, { verification_note: 'Đã kiểm tra thực tế tại hiện trường, vướng mắc đã được xử lý' }, { version: Number(issue.version) });
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
    ctx.command(MAKER, `/issues/${issueId}/escalate`, { level: 3, task_force_id: asString(force.id), reason: 'Vướng mắc kéo dài quá hạn, đề nghị Tổ công tác của dự án trực tiếp chỉ đạo tháo gỡ.' }, { version: Number(issue.version) }),
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
