import { randomUUID } from 'node:crypto';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { CHECKER, MAKER, OWNER, activeContracts, asString, paper, tolerate } from './shared.ts';

/**
 * QMS: the quality of what is built. The story, for the contract of the road 205 (the busiest) and one of the health station: the site diaries of the last
 * two weeks are written (a diary of the contractor's day is a draft until the contractor signs it, which only the contractor's own guest account can do, so
 * the days stay drafts; today and a day before are missing, so the alert of missing diaries has something to show); the supervisor asks for inspections of
 * concealed work, materials, stages and safety, some are scheduled, some recorded as passed, failed or conditional, one is cancelled; the minutes of an
 * accepted inspection are drawn up and signed by the supervisor and the owner; materials go to the laboratory; and non-conformities are raised, given corrective
 * actions, answered with evidence, verified and closed, or left open as critical.
 */

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

const ROAD_INSPECTIONS: InspectionSpec[] = [
  { title: 'Nghiệm thu cốt thép móng cống hộp Km7+120', type: 'CONCEALED_WORK', location: 'Cống hộp Km7+120', requestedAgo: 21, to: 'PASS', note: 'Cốt thép đúng bản vẽ thi công, khoảng cách và chiều dày lớp bảo vệ đạt' },
  { title: 'Nghiệm thu nền đường lớp đất đắp K98 đoạn Km5 - Km6', type: 'CONSTRUCTION_STAGE', location: 'Km5 - Km6', requestedAgo: 16, to: 'PASS', note: 'Độ chặt đạt K98 theo kết quả thí nghiệm rót cát' },
  { title: 'Nghiệm thu nhập vật liệu: đá dăm loại 1 lô 14', type: 'MATERIAL_ENTRY', location: 'Bãi tập kết Km4', requestedAgo: 12, to: 'FAIL', note: 'Hàm lượng thoi dẹt vượt giới hạn, yêu cầu đưa vật liệu ra khỏi công trường' },
  { title: 'Kiểm tra an toàn lao động khu vực thi công taluy Km9', type: 'SAFETY', location: 'Taluy dương Km9+600', requestedAgo: 9, to: 'CONDITIONAL', note: 'Cần bổ sung rào chắn và lưới an toàn trước khi thi công tiếp' },
  { title: 'Nghiệm thu giai đoạn lớp móng cấp phối đá dăm Km0 - Km3', type: 'PART_ACCEPTANCE', location: 'Km0 - Km3', requestedAgo: 6, to: 'SCHEDULED' },
  { title: 'Nghiệm thu cốt thép dầm cầu nhỏ Km10+300', type: 'CONCEALED_WORK', location: 'Cầu nhỏ Km10+300', requestedAgo: 3, to: 'REQUESTED' },
  { title: 'Nghiệm thu nhập vật liệu: thép D20 lô 03', type: 'MATERIAL_ENTRY', location: 'Kho vật tư công trường', requestedAgo: 25, to: 'CANCELLED', note: 'Nhà thầu đổi lô thép nên hủy đề nghị cũ' },
];

const STATION_INSPECTIONS: InspectionSpec[] = [
  { title: 'Nghiệm thu chống thấm mái khu khám bệnh', type: 'CONCEALED_WORK', location: 'Mái khu khám bệnh', requestedAgo: 10, to: 'PASS', note: 'Lớp chống thấm đạt, thử ngập nước 24 giờ không thấm' },
  { title: 'Kiểm tra an toàn thi công trên cao tại trạm y tế', type: 'SAFETY', location: 'Khu vực giàn giáo phía Đông', requestedAgo: 4, to: 'SCHEDULED' },
];

const MATERIALS = [
  { sample: 'MAU-BT-0712', kind: 'Bê tông M30 cống hộp Km7+120', lab: 'Trung tâm kiểm định chất lượng xây dựng Cao Bằng', standard: 'TCVN 3118:2022', ago: 33, result: 'FAIL' as const },
  { sample: 'MAU-BT-0725', kind: 'Bê tông M30 (khoan lấy lõi) cống hộp Km7+120', lab: 'Trung tâm kiểm định chất lượng xây dựng Cao Bằng', standard: 'TCVN 12252:2020', ago: 12, result: 'PASS' as const },
  { sample: 'MAU-DA-0409', kind: 'Đá dăm loại 1 lô 14', lab: 'Phòng thí nghiệm LAS-XD 112 - Công ty Kiểm định Việt Bắc', standard: 'TCVN 7570:2006', ago: 14, result: 'FAIL' as const },
  { sample: 'MAU-TH-0318', kind: 'Thép D20 lô 03', lab: 'Phòng thí nghiệm LAS-XD 112 - Công ty Kiểm định Việt Bắc', standard: 'TCVN 1651-2:2018', ago: 8, result: 'PASS' as const },
  { sample: 'MAU-DT-0221', kind: 'Đất đắp nền K98 đoạn Km5 - Km6', lab: 'Phòng thí nghiệm LAS-XD 112 - Công ty Kiểm định Việt Bắc', standard: 'TCVN 4201:2012', ago: 18, result: undefined },
];

interface NcrSpec {
  title: string;
  description: string;
  severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
  source: 'INSPECTION' | 'MATERIAL_TEST' | 'SUPERVISOR_REMARK' | 'SELF_REPORT' | 'AUDIT';
  owner: 'projectManager' | 'owner';
  dueIn: number;
  to: 'OPEN' | 'ACTION' | 'EVIDENCE' | 'CLOSED';
  action: string;
}

const NCRS: NcrSpec[] = [
  { title: 'Cường độ bê tông cống hộp Km7+120 không đạt mác thiết kế', description: 'Mẫu nén 28 ngày đạt 24,1 MPa so với 30 MPa yêu cầu. Cần khoan lấy lõi kiểm tra và xử lý nếu không đạt.', severity: 'MAJOR', source: 'MATERIAL_TEST', owner: 'projectManager', dueIn: -2, to: 'CLOSED', action: 'Khoan lấy lõi ba vị trí và thí nghiệm lại tại phòng thí nghiệm độc lập' },
  { title: 'Lớp bê tông bảo vệ cốt thép dầm cầu nhỏ Km10+300 mỏng hơn thiết kế', description: 'Đo kiểm tra tại sáu vị trí, lớp bảo vệ 15 - 18 mm so với 30 mm.', severity: 'MAJOR', source: 'SUPERVISOR_REMARK', owner: 'owner', dueIn: 6, to: 'EVIDENCE', action: 'Đục sửa, phun vữa polyme và nộp biên bản đo lại' },
  { title: 'Đá dăm lô 14 không đạt tiêu chuẩn hàm lượng thoi dẹt', description: 'Kết quả thí nghiệm 21,4% thoi dẹt, vượt giới hạn 15%.', severity: 'MINOR', source: 'MATERIAL_TEST', owner: 'projectManager', dueIn: 4, to: 'ACTION', action: 'Đưa lô đá ra khỏi công trường và nhập lô thay thế có chứng nhận' },
  { title: 'Thiếu rào chắn và biển báo tại vị trí sạt taluy Km9+600', description: 'Khu vực sạt chưa có rào chắn, người dân và xe thô sơ vẫn qua lại sát mép sạt.', severity: 'CRITICAL', source: 'INSPECTION', owner: 'owner', dueIn: 1, to: 'OPEN', action: 'Lắp rào chắn, biển báo và bố trí người điều tiết giao thông' },
];

// ---- diaries ------------------------------------------------------------------------------------------------------------------------

const WEATHER = ['NANG', 'NANG', 'MAY', 'MUA_NHO', 'NANG', 'MUA_LON', 'MAY'];
const WORK = [
  'Đào và đắp nền đường đoạn Km5+200 - Km5+450; lu lèn lớp K98 đến chiều dày 30 cm.',
  'Thi công cống hộp Km7+120: lắp ván khuôn thành, buộc thép lớp trên.',
  'Vận chuyển và rải cấp phối đá dăm lớp dưới móng đoạn Km1 - Km2.',
  'Đổ bê tông bản đáy cống hộp Km7+120 và bảo dưỡng.',
  'Gia cố mái taluy Km9+300 bằng lưới thép và phun vữa.',
  'Mưa nhỏ buổi sáng, thi công buổi chiều: đắp đất đoạn Km4 - Km4+200.',
  'Thi công rãnh dọc bê tông M20 bên trái tuyến Km3 - Km3+300.',
];

async function diaries(ctx: SeedContext, contract: Obj, label: string, spec: { daysBack: number; skipRecent: number; keepEvery: number }): Promise<void> {
  const contractId = asString(contract.id);
  const have = new Set((await ctx.list(MAKER, '/resources/site_diary', { contract_id: contractId })).map((row) => asString(row.record_date)));
  let made = 0;
  for (let ago = spec.daysBack; ago >= spec.skipRecent; ago -= 1) {
    const date = ctx.day(-ago);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || have.has(date) || (ago % spec.keepEvery !== 0 && spec.keepEvery > 1)) continue;
    const index = Math.abs(ago);
    const saved = await tolerate(ctx, `diary ${label} ${date}`, () =>
      ctx.command(MAKER, '/site-diaries', {
        contract_id: contractId,
        record_date: date,
        client_operation_id: randomUUID(),
        content: {
          weather_code: WEATHER[index % WEATHER.length],
          workforce_count: 38 + (index % 6) * 4,
          work_done: WORK[index % WORK.length],
          equipment: 'Máy xúc 2 chiếc, máy lu 2 chiếc, ô tô tự đổ 6 chiếc',
          issues: index % 5 === 0 ? 'Mưa làm gián đoạn thi công hai giờ buổi chiều' : 'Không có',
        },
      }),
    );
    if (saved !== undefined) made += 1;
  }
  ctx.record({ module: 'QMS', screen: 'QMS-01', kind: 'site-diaries', id: contractId, code: asString(contract.code), note: `${made} drafts` });
}

// ---- inspections -------------------------------------------------------------------------------------------------------------------

async function inspections(ctx: SeedContext, contract: Obj, list: InspectionSpec[]): Promise<Obj[]> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/inspections', { contract_id: contractId });
  const results: Obj[] = [];
  for (const spec of list) {
    let row = existing.find((candidate) => candidate.title === spec.title);
    if (row === undefined) {
      const made = await tolerate(ctx, `inspection ${spec.title}`, () => ctx.command(MAKER, '/inspections', { contract_id: contractId, inspection_type: spec.type, title: spec.title, location_text: spec.location, requested_for: ctx.day(-(spec.requestedAgo - 2)) }));
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'REQUESTED', version: made.resource_version, title: spec.title };
      ctx.record({ module: 'QMS', screen: 'QMS-04', kind: 'inspection', id: made.resource_id, code: spec.title.slice(0, 40), note: spec.to });
    }
    const id = asString(row.id);
    const read = (): Promise<Obj> => ctx.get(MAKER, `/inspections/${id}`);
    let detail = await read();
    if (detail.status === 'REQUESTED' && ['SCHEDULED', 'PASS', 'FAIL', 'CONDITIONAL'].includes(spec.to)) {
      await tolerate(ctx, `schedule ${spec.title}`, () =>
        ctx.command(MAKER, `/inspections/${id}/schedule`, { scheduled_at: new Date(Date.now() + (spec.to === 'SCHEDULED' ? 2 : -(spec.requestedAgo - 3)) * 86_400_000).toISOString(), participant_membership_ids: [ctx.person(CHECKER).membershipId, ctx.person(OWNER).membershipId] }, { version: Number(detail.version) }),
      );
      detail = await read();
    }
    if (detail.status === 'SCHEDULED' && ['PASS', 'FAIL', 'CONDITIONAL'].includes(spec.to)) {
      const outcome = spec.to === 'PASS' ? 'PASS' : 'FAIL';
      await tolerate(ctx, `record the result of ${spec.title}`, () =>
        ctx.command(
          MAKER,
          `/inspections/${id}/result`,
          { result: spec.to, result_note: spec.note ?? 'Đã kiểm tra', checklist: CHECKLIST_CODES[spec.type].map((code, index) => ({ code, outcome: spec.to === 'PASS' || index > 0 ? 'PASS' : outcome, note: spec.to === 'PASS' ? 'Đạt yêu cầu' : index === 0 ? spec.note : 'Đạt yêu cầu' })) },
          { version: Number(detail.version) },
        ),
      );
      detail = await read();
    }
    if (spec.to === 'CANCELLED' && !['CANCELLED'].includes(asString(detail.status))) {
      await tolerate(ctx, `cancel ${spec.title}`, () => ctx.command(MAKER, `/inspections/${id}/cancel`, { reason: spec.note ?? 'Nhà thầu rút đề nghị' }, { version: Number(detail.version) }));
      detail = await read();
    }
    results.push(detail);
  }
  return results;
}

/** The minutes of an accepted inspection, signed by the supervisor and the owner; the contractor's signature and the leader's approval are still to come. */
async function acceptances(ctx: SeedContext, passed: Obj[]): Promise<void> {
  const existing = await ctx.list(MAKER, '/quality-acceptances');
  let n = existing.length;
  for (const [index, inspection] of passed.entries()) {
    if (index >= 2) break;
    const id = asString(inspection.id);
    if (existing.some((row) => asString(row.inspection_id ?? row.inspection?.id) === id)) continue;
    n += 1;
    const minutes = await paper(ctx, { symbol: `BB-NTCL-${String(n).padStart(3, '0')}`, title: `Biên bản nghiệm thu chất lượng: ${asString(inspection.title)}`, type: 'BB', sender: 'Ban Quản lý dự án', issuedOn: ctx.day(-5) });
    const made = await tolerate(ctx, `acceptance minutes for ${asString(inspection.title)}`, () =>
      ctx.command(MAKER, `/inspections/${id}/quality-acceptances`, { acceptance_scope: asString(inspection.inspection_type) === 'CONSTRUCTION_STAGE' ? 'STAGE' : 'WORK_ITEM', record_no: `BB-NTCL-${ctx.year}-${String(n).padStart(3, '0')}`, document_version_id: minutes.versionId }),
    );
    if (made === undefined) continue;
    ctx.record({ module: 'QMS', screen: 'QMS-05', kind: 'quality-acceptance', id: made.resource_id, code: `BB-NTCL-${n}`, note: 'minutes drawn up' });
    if (index === 0) {
      const signers: Array<[string, string]> = [
        [CHECKER, 'SUPERVISOR'],
        [OWNER, 'OWNER'],
      ];
      for (const [person, role] of signers) {
        await tolerate(ctx, `sign the minutes as ${role}`, () => ctx.command(person, `/quality-acceptances/${made.resource_id}/sign`, { signer_role: role, signature_method: 'IN_APP_OTP', client_operation_id: randomUUID() }));
      }
    }
  }
}

async function materials(ctx: SeedContext, contract: Obj): Promise<void> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/material-tests', { contract_id: contractId });
  for (const material of MATERIALS) {
    let row = existing.find((candidate) => candidate.sample_code === material.sample);
    if (row === undefined) {
      const made = await tolerate(ctx, `material test ${material.sample}`, () => ctx.command(MAKER, '/material-tests', { contract_id: contractId, sample_code: material.sample, material_kind: material.kind, lab_name: material.lab, standard_ref: material.standard, sampled_on: ctx.day(-material.ago) }));
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'REGISTERED' };
      ctx.record({ module: 'QMS', screen: 'QMS-06', kind: 'material-test', id: made.resource_id, code: material.sample, note: material.result ?? 'waiting for the laboratory' });
    }
    if (material.result !== undefined && !['PASS', 'FAIL'].includes(asString(row.result ?? row.status))) {
      const report = await paper(ctx, { symbol: `KQTN-${material.sample}`, title: `Kết quả thí nghiệm mẫu ${material.sample}`, type: 'BC', sender: material.lab, issuedOn: ctx.day(-(material.ago - 5)) });
      await tolerate(ctx, `result of ${material.sample}`, () =>
        ctx.command(MAKER, `/material-tests/${asString(row?.id)}/result`, {
          result: material.result,
          tested_on: ctx.day(-(material.ago - 5)),
          result_values: material.result === 'PASS' ? { ket_qua: 'Đạt yêu cầu theo tiêu chuẩn áp dụng' } : { ket_qua: 'Không đạt yêu cầu theo tiêu chuẩn áp dụng' },
          report_document_version_id: report.versionId,
        }),
      );
    }
  }
}

async function nonconformances(ctx: SeedContext, contract: Obj): Promise<void> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/resources/quality_nonconformance', { contract_id: contractId });
  for (const spec of NCRS) {
    let row = existing.find((candidate) => candidate.title === spec.title);
    if (row === undefined) {
      const made = await tolerate(ctx, `non-conformity ${spec.title}`, () =>
        ctx.command(MAKER, '/nonconformances', {
          contract_id: contractId,
          severity: spec.severity,
          title: spec.title,
          description: spec.description,
          source_kind: spec.source,
          action_owner_id: ctx.person(spec.owner).membershipId,
          due_at: new Date(Date.now() + spec.dueIn * 86_400_000).toISOString(),
        }),
      );
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'OPEN' };
      ctx.record({ module: 'QMS', screen: 'QMS-07', kind: 'nonconformance', id: made.resource_id, code: spec.title.slice(0, 40), note: spec.severity });
    }
    const id = asString(row.id);
    const read = (): Promise<Obj> => ctx.get(MAKER, `/resources/quality_nonconformance/${id}`);
    let detail = await read();
    const actions = (): Obj[] => ((detail.corrective_actions ?? detail.actions ?? []) as Obj[]);
    if (spec.to !== 'OPEN' && actions().length === 0) {
      await tolerate(ctx, `corrective action of ${spec.title}`, () => ctx.command(MAKER, `/nonconformances/${id}/corrective-actions`, { description: spec.action, owner_membership_id: ctx.person(spec.owner).membershipId, due_at: new Date(Date.now() + Math.max(spec.dueIn, 1) * 86_400_000).toISOString() }));
      detail = await read();
    }
    const action = actions()[0];
    if (['EVIDENCE', 'CLOSED'].includes(spec.to) && action !== undefined && ['OPEN', 'ASSIGNED', 'PENDING'].includes(asString(action.status))) {
      const proof = await paper(ctx, { symbol: `KP-${id.slice(0, 8)}`, title: `Biên bản khắc phục: ${spec.title}`, type: 'BB', sender: 'Nhà thầu thi công', issuedOn: ctx.day(-2) });
      await tolerate(ctx, `evidence of ${spec.title}`, () => ctx.command(spec.owner, `/corrective-actions/${asString(action.id)}/evidence`, { evidence_document_version_id: proof.versionId, note: 'Đã khắc phục theo yêu cầu, gửi biên bản và kết quả kiểm tra' }));
      detail = await read();
    }
    const after = actions()[0];
    if (spec.to === 'CLOSED' && after !== undefined && asString(after.status) !== 'VERIFIED') {
      await tolerate(ctx, `verify ${spec.title}`, () => ctx.command(CHECKER, `/corrective-actions/${asString(after.id)}/verify`, { outcome: 'VERIFIED', verification_note: 'Đã kiểm tra thực tế, kết quả đạt yêu cầu' }));
      detail = await read();
    }
    if (spec.to === 'CLOSED' && asString(detail.status) !== 'CLOSED') {
      await tolerate(ctx, `close ${spec.title}`, () => ctx.command(MAKER, `/nonconformances/${id}/close`, { closure_note: 'Đã khắc phục và được xác minh, đóng hồ sơ không phù hợp' }));
    }
  }
}

export async function seedQms(ctx: SeedContext): Promise<void> {
  const contracts = await activeContracts(ctx);
  if (contracts.length === 0) {
    ctx.warn('QMS: no contract is being performed (the delivery group makes them): the screens of the quality module stay empty');
    return;
  }
  const projects = new Map((await ctx.list(MAKER, '/resources/project')).map((row) => [asString(row.id), asString(row.code)]));
  const byProject = (code: string): Obj | undefined => contracts.find((row) => projects.get(asString(row.project_id)) === code);
  const road = byProject('DA-DT205') ?? contracts[0];
  const station = byProject('DA-YT007') ?? contracts.find((row) => row !== road);
  if (road === undefined) return;
  await ctx.step('QMS', `site diaries of ${asString(road.code)}`, () => diaries(ctx, road, 'road', { daysBack: 16, skipRecent: 2, keepEvery: 1 }));
  if (station !== undefined) await ctx.step('QMS', `site diaries of ${asString(station.code)}`, () => diaries(ctx, station, 'station', { daysBack: 14, skipRecent: 9, keepEvery: 2 }));
  const roadResults = await ctx.step('QMS', 'inspections of the road', () => inspections(ctx, road, ROAD_INSPECTIONS));
  if (station !== undefined) await ctx.step('QMS', 'inspections of the station', () => inspections(ctx, station, STATION_INSPECTIONS));
  const passed = roadResults.filter((row) => asString(row.result) === 'PASS' || asString(row.status) === 'PASSED');
  await ctx.step('QMS', 'minutes of acceptance', () => acceptances(ctx, passed));
  await ctx.step('QMS', 'material tests', () => materials(ctx, road));
  await ctx.step('QMS', 'non-conformities', () => nonconformances(ctx, road));
}
