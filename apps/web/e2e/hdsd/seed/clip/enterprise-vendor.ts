import { asVersion } from '../context.ts';
import type { CommandReply, Obj, SeedContext } from '../context.ts';

/**
 * Group `clip-ent-vendor`: the contractor management screens (VND-*, BID-21) made with the product's own commands.
 *
 * Contractors are the 16 of the procurement group (found by legal name). Everything is entered by `projectManager` and checked by a second person (`owner` / `capApprover`), as the product requires (maker is not checker).
 * Every section is guarded by a read of what already exists, so the group can be applied again; a refused command is written as a warning and the rest goes on.
 */

const MAKER = 'projectManager';
const CHECKER = 'owner';
const LEADER = 'capApprover';

const NAME = {
  phuHung: 'Phú Hưng',
  minhPhat: 'Minh Phát',
  namViet: 'Nam Việt',
  vietHung: 'Việt Hưng',
  baoAn: 'Bảo An',
  dongA: 'Đông Á',
  tanPhat: 'Tân Phát',
  hongPhuc: 'Hồng Phúc',
  caiMep: 'Cái Mép',
  phuMy: 'Cảng Phú Mỹ',
  hoangLong: 'Hoàng Long',
  thangLong: 'Thăng Long',
  daiPhong: 'Đại Phong',
  quangVinh: 'Quang Vinh',
  phuongNam: 'Phương Nam',
  vietDong: 'Việt Đông',
} as const;
type Key = keyof typeof NAME;

interface Ctx {
  ctx: SeedContext;
  byKey: Map<Key, Obj>;
  idOf: (key: Key) => string;
}


/** Runs a command that may be refused; returns the answer or undefined (the refusal is a warning). */
async function tryCommand(ctx: SeedContext, person: string, path: string, body?: unknown, version?: number): Promise<CommandReply | undefined> {
  const reply = await ctx.attempt<CommandReply>(person, 'POST', path, body ?? {}, version === undefined ? {} : { version });
  return reply.ok ? reply.json : undefined;
}

/** A letter that stands for a paper (certificate scan, decision, notice). */
async function paper(ctx: SeedContext, symbol: string, title: string, sender: string, issuedOn: string): Promise<string> {
  return (await ctx.letter({ symbol, title, sender, issuedOn, person: MAKER })).documentId;
}

async function loadContractors(ctx: SeedContext): Promise<Ctx> {
  const register = await ctx.list<Obj>(MAKER, '/vendor/register');
  const byKey = new Map<Key, Obj>();
  for (const key of Object.keys(NAME) as Key[]) {
    const row = register.find((one) => String(one.legal_name).includes(NAME[key]));
    if (row !== undefined) byKey.set(key, row);
  }
  return {
    ctx,
    byKey,
    idOf: (key) => {
      const row = byKey.get(key);
      if (row === undefined) throw new Error(`contractor ${NAME[key]} is not in the register`);
      return String(row.contractor_id);
    },
  };
}

// ---- VND-02: profiles (representative, address, contact, ownership) ---------------------------------------------------------------------

const PROFILES: Array<{ key: Key; rep: string; position: string; address: string; phone: string; email: string; reg: string }> = [
  { key: 'phuHung', rep: 'Nguyễn Văn Thịnh', position: 'Tổng giám đốc', address: 'Số 12 Đường số 3, KCN Phú Mỹ 1, thị xã Phú Mỹ, tỉnh Bà Rịa - Vũng Tàu', phone: '0254 3921 101', email: 'info@phuhung-xaylap.vn', reg: '3500123401' },
  { key: 'minhPhat', rep: 'Trần Quốc Bảo', position: 'Giám đốc', address: 'Số 45 Đường 30/4, phường Phước Trung, thành phố Bà Rịa', phone: '0254 3856 202', email: 'lienhe@minhphat-cokhi.vn', reg: '3500123402' },
  { key: 'namViet', rep: 'Lê Hoàng Nam', position: 'Chủ tịch HĐQT kiêm Tổng giám đốc', address: 'Tầng 8, Tòa nhà Petro Plaza, số 18 Lê Duẩn, quận 1, TP. Hồ Chí Minh', phone: '028 3822 303', email: 'contact@namviet-ic.vn', reg: '0310123403' },
  { key: 'vietHung', rep: 'Phạm Đức Hưng', position: 'Giám đốc', address: 'Số 27 Nguyễn Thị Minh Khai, phường 1, thành phố Vũng Tàu', phone: '0254 3510 404', email: 'vietHung@vh-kythuat.vn', reg: '3500123404' },
  { key: 'baoAn', rep: 'Đỗ Thị Thanh Mai', position: 'Tổng giám đốc', address: 'Số 90 Pasteur, quận 3, TP. Hồ Chí Minh', phone: '028 3930 505', email: 'office@baoan-tvtk.vn', reg: '0310123405' },
  { key: 'tanPhat', rep: 'Võ Minh Tâm', position: 'Giám đốc', address: 'Lô C5 KCN Biên Hòa 2, thành phố Biên Hòa, tỉnh Đồng Nai', phone: '0251 3836 707', email: 'sales@tanphat-pressure.vn', reg: '3600123407' },
  { key: 'hongPhuc', rep: 'Hoàng Gia Huy', position: 'Giám đốc', address: 'Số 6 Đường D2, KCN Long Thành, tỉnh Đồng Nai', phone: '0251 3514 808', email: 'hongphuc@bom-hongphuc.vn', reg: '3600123408' },
  { key: 'phuongNam', rep: 'Bùi Thanh Sơn', position: 'Giám đốc', address: 'Số 3 Trần Phú, phường 5, thành phố Vũng Tàu', phone: '0254 3589 915', email: 'tuvan@phuongnam-dk.vn', reg: '3500123415' },
];

async function seedProfiles(c: Ctx): Promise<void> {
  const { ctx } = c;
  for (const spec of PROFILES) {
    const id = c.idOf(spec.key);
    const detail = await ctx.get<Obj>(MAKER, `/vendor/contractors/${id}`);
    const profile = (detail.profile ?? {}) as Obj;
    if (profile.legal_rep_name !== null && profile.legal_rep_name !== undefined) continue;
    const saved = await tryCommand(ctx, MAKER, `/vendor/contractors/${id}/profile`, { legal_rep_name: spec.rep, legal_rep_position: spec.position, registered_address: spec.address, phone: spec.phone, email: spec.email, business_registration_no: spec.reg }, asVersion(profile.version));
    if (saved !== undefined) await tryCommand(ctx, MAKER, `/vendor/contractors/${id}/ownership-declaration`, { note: 'Không có cổ đông hoặc thành viên góp vốn nào nắm trên 25% vốn điều lệ ngoài những người đã khai trong hồ sơ năng lực.' }, saved.resource_version);
  }
}

// ---- VND-05: certificates and key staff ---------------------------------------------------------------------------------------------------

type QKind = 'CONSTRUCTION_ACTIVITY' | 'DESIGN_CONSULTING' | 'SUPERVISION_CONSULTING' | 'SAFETY_CERTIFICATE' | 'QUALITY_MANAGEMENT_ISO9001' | 'EQUIPMENT_OWNERSHIP';
const QUALIFICATIONS: Array<{ key: Key; kind: QKind; no: string; grade?: 'I' | 'II' | 'III'; scope: string; issuer: string; issuedAgo: number; expiresIn: number; verify: boolean }> = [
  { key: 'phuHung', kind: 'CONSTRUCTION_ACTIVITY', no: 'BRV-00123456', grade: 'I', scope: 'Thi công xây dựng công trình công nghiệp nhẹ và công nghiệp hóa chất', issuer: 'Sở Xây dựng tỉnh Bà Rịa - Vũng Tàu', issuedAgo: 700, expiresIn: 1100, verify: true },
  { key: 'minhPhat', kind: 'CONSTRUCTION_ACTIVITY', no: 'BRV-00234567', grade: 'II', scope: 'Lắp đặt thiết bị công nghệ và đường ống áp lực công trình hóa chất, dầu khí', issuer: 'Sở Xây dựng tỉnh Bà Rịa - Vũng Tàu', issuedAgo: 1000, expiresIn: 38, verify: true },
  { key: 'minhPhat', kind: 'QUALITY_MANAGEMENT_ISO9001', no: 'VN-QMS-2023-0412', scope: 'Gia công, chế tạo và lắp đặt cơ khí công nghiệp', issuer: 'Tổ chức chứng nhận Quacert', issuedAgo: 900, expiresIn: 160, verify: true },
  { key: 'namViet', kind: 'CONSTRUCTION_ACTIVITY', no: 'HCM-00345678', grade: 'I', scope: 'Thi công xây dựng công trình công nghiệp, hạ tầng kỹ thuật và san nền', issuer: 'Sở Xây dựng TP. Hồ Chí Minh', issuedAgo: 500, expiresIn: 1300, verify: true },
  { key: 'namViet', kind: 'SAFETY_CERTIFICATE', no: 'ATLD-2025-1188', scope: 'Đánh giá hệ thống quản lý an toàn, sức khỏe nghề nghiệp ISO 45001', issuer: 'Tổ chức chứng nhận BSI Việt Nam', issuedAgo: 300, expiresIn: 760, verify: true },
  { key: 'namViet', kind: 'QUALITY_MANAGEMENT_ISO9001', no: 'VN-QMS-2024-0877', scope: 'Xây dựng và quản lý dự án công nghiệp', issuer: 'Tổ chức chứng nhận Quacert', issuedAgo: 410, expiresIn: 620, verify: true },
  { key: 'vietHung', kind: 'CONSTRUCTION_ACTIVITY', no: 'BRV-00456789', grade: 'II', scope: 'Thi công lắp đặt hệ thống điện, đo lường và điều khiển công trình công nghiệp', issuer: 'Sở Xây dựng tỉnh Bà Rịa - Vũng Tàu', issuedAgo: 650, expiresIn: 900, verify: true },
  { key: 'baoAn', kind: 'SUPERVISION_CONSULTING', no: 'HCM-TVGS-0567', grade: 'I', scope: 'Giám sát thi công xây dựng và lắp đặt thiết bị công trình công nghiệp', issuer: 'Sở Xây dựng TP. Hồ Chí Minh', issuedAgo: 800, expiresIn: 1000, verify: true },
  { key: 'baoAn', kind: 'DESIGN_CONSULTING', no: 'HCM-TVTK-0568', grade: 'II', scope: 'Thiết kế cơ sở và thiết kế kỹ thuật công trình công nghiệp', issuer: 'Sở Xây dựng TP. Hồ Chí Minh', issuedAgo: 800, expiresIn: 21, verify: true },
  { key: 'tanPhat', kind: 'EQUIPMENT_OWNERSHIP', no: 'TP-TB-2025-031', scope: 'Quyền sở hữu xưởng gia công và hệ thống thử áp lực 250 bar', issuer: 'Phòng Đăng ký kinh doanh tỉnh Đồng Nai', issuedAgo: 380, expiresIn: 1400, verify: true },
  { key: 'tanPhat', kind: 'QUALITY_MANAGEMENT_ISO9001', no: 'VN-QMS-2022-0301', scope: 'Chế tạo máy nén và thiết bị áp lực', issuer: 'Tổ chức chứng nhận Quacert', issuedAgo: 1200, expiresIn: -12, verify: true },
  { key: 'hongPhuc', kind: 'QUALITY_MANAGEMENT_ISO9001', no: 'VN-QMS-2025-0654', scope: 'Chế tạo và cung cấp bơm công nghiệp', issuer: 'Tổ chức chứng nhận Quacert', issuedAgo: 200, expiresIn: 900, verify: false },
  { key: 'phuongNam', kind: 'DESIGN_CONSULTING', no: 'BRV-TVKS-0678', grade: 'II', scope: 'Khảo sát địa chất công trình và đo đạc bản đồ', issuer: 'Sở Xây dựng tỉnh Bà Rịa - Vũng Tàu', issuedAgo: 450, expiresIn: 700, verify: true },
];

const KEY_STAFF: Array<{ key: Key; role: 'PROJECT_MANAGER' | 'SITE_ENGINEER' | 'DESIGN_LEAD' | 'SUPERVISOR' | 'SAFETY_OFFICER' | 'QUALITY_OFFICER' | 'SURVEYOR'; person: string; title: string; no: string; issuedAgo: number; expiresIn?: number; verify: boolean }> = [
  { key: 'namViet', role: 'PROJECT_MANAGER', person: 'Nguyễn Hữu Phước', title: 'Kỹ sư xây dựng, chỉ huy trưởng công trường hạng I', no: 'CHT-I-HCM-2021-0345', issuedAgo: 900, expiresIn: 600, verify: true },
  { key: 'namViet', role: 'SAFETY_OFFICER', person: 'Trần Văn Hải', title: 'Cán bộ an toàn lao động', no: 'ATLD-2024-5521', issuedAgo: 400, expiresIn: 30, verify: true },
  { key: 'minhPhat', role: 'SITE_ENGINEER', person: 'Lê Quang Vinh', title: 'Kỹ sư cơ khí, giám sát lắp đặt thiết bị', no: 'KSCK-BRV-2020-218', issuedAgo: 1100, verify: true },
  { key: 'baoAn', role: 'SUPERVISOR', person: 'Phạm Thị Hồng Nhung', title: 'Giám sát trưởng công trình công nghiệp hạng I', no: 'GSCT-I-HCM-2022-0912', issuedAgo: 700, expiresIn: 900, verify: true },
  { key: 'baoAn', role: 'DESIGN_LEAD', person: 'Vũ Minh Khôi', title: 'Chủ trì thiết kế công nghệ hóa chất', no: 'CTTK-II-HCM-2023-0156', issuedAgo: 500, expiresIn: 800, verify: false },
  { key: 'tanPhat', role: 'QUALITY_OFFICER', person: 'Đặng Quốc Thắng', title: 'Kỹ sư kiểm định thiết bị áp lực', no: 'KDAL-DNA-2023-077', issuedAgo: 600, expiresIn: 500, verify: true },
  { key: 'phuongNam', role: 'SURVEYOR', person: 'Ngô Văn Bình', title: 'Kỹ sư khảo sát địa chất công trình', no: 'KSDC-BRV-2022-044', issuedAgo: 650, expiresIn: 450, verify: true },
];

async function seedCertificates(c: Ctx): Promise<void> {
  const { ctx } = c;
  let counter = 0;
  for (const spec of QUALIFICATIONS) {
    const id = c.idOf(spec.key);
    const detail = await ctx.get<Obj>(MAKER, `/vendor/contractors/${id}`);
    const have = (detail.qualifications as Obj[]).some((row) => row.certificate_no === spec.no);
    if (have) continue;
    counter += 1;
    const documentId = await paper(ctx, `CC-${spec.no}`, `Bản sao chứng chỉ ${spec.no}`, `Công ty ${NAME[spec.key]}`, ctx.day(-30));
    const made = await tryCommand(ctx, MAKER, `/vendor/contractors/${id}/qualifications`, {
      kind: spec.kind,
      certificate_no: spec.no,
      ...(spec.grade === undefined ? {} : { grade: spec.grade }),
      scope: spec.scope,
      issuer: spec.issuer,
      issued_on: ctx.day(-spec.issuedAgo),
      expires_on: ctx.day(spec.expiresIn),
      document_id: documentId,
    });
    if (made !== undefined && spec.verify) await tryCommand(ctx, CHECKER, `/vendor/qualifications/${made.resource_id}/verification`, {}, made.resource_version);
  }
  for (const spec of KEY_STAFF) {
    const id = c.idOf(spec.key);
    const detail = await ctx.get<Obj>(MAKER, `/vendor/contractors/${id}`);
    if ((detail.key_staff as Obj[]).some((row) => row.certificate_no === spec.no)) continue;
    counter += 1;
    const documentId = await paper(ctx, `NS-${spec.no}`, `Bản sao chứng chỉ hành nghề của ${spec.person}`, `Công ty ${NAME[spec.key]}`, ctx.day(-20));
    const made = await tryCommand(ctx, MAKER, `/vendor/contractors/${id}/key-staff`, {
      staff_role: spec.role,
      person_name: spec.person,
      qualification_title: spec.title,
      certificate_no: spec.no,
      issued_on: ctx.day(-spec.issuedAgo),
      ...(spec.expiresIn === undefined ? {} : { expires_on: ctx.day(spec.expiresIn) }),
      document_id: documentId,
    });
    if (made !== undefined && spec.verify) await tryCommand(ctx, CHECKER, `/vendor/key-staff/${made.resource_id}/verification`, {}, made.resource_version);
  }
  ctx.record({ module: 'VND', screen: 'VND-05', kind: 'certificates', id: 'vnd-05', code: 'VND-05', note: `${counter} certificates and key staff entered` });
}

// ---- VND-03: debarment cases (and BID-21 restrictions) -------------------------------------------------------------------------------------

/** A letter that is entered in the incoming register: that is what puts its document in force (a decision paper must be in force before a ban is put into effect). */
async function inForce(ctx: SeedContext, symbol: string, title: string, sender: string, ago: number): Promise<string> {
  const letter = await ctx.letter({ symbol, title, sender, issuedOn: ctx.day(-ago), person: MAKER });
  const row = await ctx.find<Obj>(MAKER, '/incoming-documents', (one) => one.id === letter.incomingId);
  if (row !== undefined && row.status === 'RECEIVED') {
    const register = await ctx.find<Obj>(MAKER, '/document-number-registers', (one) => one.register_code === 'DEN' && Number(one.year) === ctx.year);
    if (register === undefined) ctx.warn('the incoming register DEN does not exist: the decision paper stays received only');
    else await tryCommand(ctx, MAKER, `/incoming-documents/${String(row.id)}/registration`, { register_id: String(register.id) }, asVersion(row.version));
  }
  return letter.documentId;
}

interface CaseSpec {
  key: Key;
  open: Record<string, unknown>;
  proposalSymbol?: string;
  proposalTitle?: string;
  notice?: { symbol: string; title: string; ago: number };
  response?: { summary: string; symbol: string; title: string; ago: number };
  decision?: { kind: 'BAN' | 'DISMISS'; reason: string; months?: number; fromAgo?: number; symbol?: string; title?: string; ago?: number };
}

async function seedCases(c: Ctx): Promise<void> {
  const { ctx } = c;
  const sender = 'Ban Quản lý dự án Đạm Phú Mỹ';
  const specs: CaseSpec[] = [
    {
      key: 'quangVinh',
      proposalSymbol: '312/TTr-BQLDA',
      proposalTitle: 'Tờ trình đề nghị xử lý vi phạm của Công ty TNHH Thương mại Thiết bị Quang Vinh',
      open: { trigger_kind: 'INVESTOR_PROPOSAL', trigger_ref: '312/TTr-BQLDA', violation_groups: ['GROUP_2'], violation_summary: 'Hồ sơ năng lực kê khai hợp đồng tương tự đã hoàn thành cho công trình nhà máy phân bón, nhưng chủ đầu tư các hợp đồng đó xác nhận nhà thầu chưa từng ký hợp đồng.', violation_on: ctx.day(-75) },
      notice: { symbol: '318/TB-BQLDA', title: 'Thông báo về việc xem xét xử lý vi phạm đối với Công ty TNHH Thương mại Thiết bị Quang Vinh', ago: 55 },
      response: { summary: 'Nhà thầu có văn bản giải trình, thừa nhận kê khai chưa chính xác do sai sót của bộ phận hồ sơ; không cung cấp được hợp đồng chứng minh.', symbol: '45/CV-QV', title: 'Công văn giải trình của Công ty TNHH Thương mại Thiết bị Quang Vinh', ago: 45 },
      decision: { kind: 'BAN', reason: 'Hành vi gian lận trong hồ sơ năng lực, đã được giải trình nhưng không có chứng cứ khắc phục.', months: 12, fromAgo: 28, symbol: '176/QĐ-ĐPM', title: 'Quyết định cấm tham gia đấu thầu đối với Công ty TNHH Thương mại Thiết bị Quang Vinh', ago: 30 },
    },
    {
      key: 'daiPhong',
      proposalSymbol: '327/TTr-BQLDA',
      proposalTitle: 'Tờ trình đề nghị xử lý vi phạm của Công ty Cổ phần Cơ điện Lạnh Đại Phong',
      open: { trigger_kind: 'AUDIT_CONCLUSION', trigger_ref: 'KL-KTNB-14/2026', violation_groups: ['GROUP_1'], violation_summary: 'Kết luận kiểm toán nội bộ phát hiện hồ sơ dự thầu gói mua sắm của Đại Phong và một nhà thầu khác có cùng lỗi đánh máy và cùng địa chỉ IP nộp hồ sơ.', violation_on: ctx.day(-40) },
      notice: { symbol: '331/TB-BQLDA', title: 'Thông báo xem xét xử lý vi phạm đối với Công ty Cổ phần Cơ điện Lạnh Đại Phong', ago: 8 },
    },
    {
      key: 'thangLong',
      open: { trigger_kind: 'OWN_INITIATIVE', violation_groups: ['GROUP_3'], violation_summary: 'Nhà thầu rút hồ sơ dự thầu sau thời điểm đóng thầu gói cung cấp vật liệu chịu lửa và không nộp bảo đảm dự thầu theo yêu cầu.', violation_on: ctx.day(-6) },
    },
    {
      key: 'hoangLong',
      open: { trigger_kind: 'PETITION_RESOLUTION', trigger_ref: 'KN-02/2026', violation_groups: ['GROUP_3'], violation_summary: 'Kiến nghị của nhà thầu cạnh tranh cho rằng Hoàng Long dùng chung nhân sự chủ chốt với nhà thầu khác trong cùng gói thầu.', violation_on: ctx.day(-50) },
      notice: { symbol: '305/TB-BQLDA', title: 'Thông báo xem xét kiến nghị đối với Công ty TNHH Điện và Tự động hóa Hoàng Long', ago: 40 },
      response: { summary: 'Nhà thầu cung cấp hợp đồng lao động và bảng đóng bảo hiểm xã hội chứng minh không dùng chung nhân sự.', symbol: '12/CV-HL', title: 'Công văn giải trình của Công ty TNHH Điện và Tự động hóa Hoàng Long', ago: 35 },
      decision: { kind: 'DISMISS', reason: 'Đã đối chiếu hợp đồng lao động và bảo hiểm xã hội: hai nhà thầu không dùng chung nhân sự, kiến nghị không có cơ sở.' },
    },
  ];
  const readCase = async (id: string): Promise<Obj | undefined> => ctx.find<Obj>(MAKER, '/vendor/restriction-cases', (one) => one.id === id);
  for (const spec of specs) {
    const contractorId = c.idOf(spec.key);
    const all = await ctx.list<Obj>(MAKER, '/vendor/restriction-cases');
    let row = all.find((one) => one.contractor_id === contractorId);
    if (row === undefined) {
      const proposal = spec.proposalSymbol === undefined ? undefined : await paper(ctx, spec.proposalSymbol, spec.proposalTitle ?? spec.proposalSymbol, sender, ctx.day(-20));
      const made = await tryCommand(ctx, MAKER, '/vendor/restriction-cases', { subject_kind: 'CONTRACTOR', contractor_id: contractorId, ...spec.open, ...(proposal === undefined ? {} : { proposal_document_id: proposal }) });
      if (made === undefined) continue;
      row = await readCase(made.resource_id);
    }
    // Walk the case forward from the state it is in.
    for (let step = 0; step < 5 && row !== undefined; step += 1) {
      const id = String(row.id);
      const version = asVersion(row.version);
      let moved: CommandReply | undefined;
      if (row.status === 'PROPOSED' && spec.notice !== undefined) {
        moved = await tryCommand(ctx, MAKER, `/vendor/restriction-cases/${id}/moves`, { move: 'SEND_NOTICE', notice_document_id: await paper(ctx, spec.notice.symbol, spec.notice.title, sender, ctx.day(-spec.notice.ago)) }, version);
      } else if (row.status === 'NOTICE_SENT' && spec.response !== undefined) {
        moved = await tryCommand(ctx, MAKER, `/vendor/restriction-cases/${id}/moves`, { move: 'RECORD_RESPONSE', summary: spec.response.summary, response_document_id: await paper(ctx, spec.response.symbol, spec.response.title, `Công ty ${NAME[spec.key]}`, ctx.day(-spec.response.ago)) }, version);
      } else if (row.status === 'RESPONSE_RECEIVED' && spec.decision !== undefined) {
        const d = spec.decision;
        const body: Record<string, unknown> = { decision: d.kind, reason: d.reason };
        if (d.kind === 'BAN') {
          body.scope = 'TENANT';
          body.ban_months = d.months;
          body.effective_from = ctx.day(-(d.fromAgo ?? 0));
          body.decision_document_id = await inForce(ctx, d.symbol ?? 'QD-CAM-THAU', d.title ?? 'Quyết định cấm tham gia đấu thầu', 'Công ty Đạm Phú Mỹ', d.ago ?? 30);
        }
        moved = await tryCommand(ctx, LEADER, `/vendor/restriction-cases/${id}/decision`, body, version);
      } else if (row.status === 'DECIDED' && spec.decision?.kind === 'BAN') {
        const d = spec.decision;
        await inForce(ctx, d.symbol ?? 'QD-CAM-THAU', d.title ?? 'Quyết định cấm tham gia đấu thầu', 'Công ty Đạm Phú Mỹ', d.ago ?? 30);
        moved = await tryCommand(ctx, LEADER, `/vendor/restriction-cases/${id}/effect`, {}, version);
      }
      if (moved === undefined) break;
      row = await readCase(id);
    }
  }
  ctx.record({ module: 'VND', screen: 'VND-03', kind: 'restriction-cases', id: 'vnd-03', code: 'VND-03', note: '4 debarment cases, 1 ban in effect' });
}

// ---- VND-06: reputation events and joint ventures ----------------------------------------------------------------------------------------

async function seedReputation(c: Ctx, packages: Map<string, Obj>): Promise<void> {
  const { ctx } = c;
  const existing = await ctx.list<Obj>(MAKER, '/vendor/reputation-events');
  const receipts: Record<string, string> = { NO_BID_SECURITY: 'MSC-UT-2026-001184', WITHDRAWING_AFTER_CLOSING: 'MSC-UT-2026-001236' };
  for (const row of existing) {
    // Events recorded but not posted yet: a second person posts them (the recorder cannot).
    const receipt = receipts[String(row.behaviour_code)];
    if (receipt !== undefined && row.status === 'RECORDED') await tryCommand(ctx, CHECKER, `/vendor/reputation-events/${String(row.id)}/posting`, { receipt }, asVersion(row.version));
  }
  if (existing.length === 0) {
    const pack = (code: string): string | undefined => (packages.get(code) === undefined ? undefined : String(packages.get(code)?.id));
    const record = async (key: Key, behaviour: string, daysAgo: number, description: string, packageCode?: string): Promise<CommandReply | undefined> =>
      tryCommand(ctx, MAKER, '/vendor/reputation-events', { contractor_id: c.idOf(key), behaviour_code: behaviour, event_on: ctx.day(-daysAgo), description, ...(packageCode !== undefined && pack(packageCode) !== undefined ? { package_id: pack(packageCode) } : {}) });
    const first = await record('hoangLong', 'NO_BID_SECURITY', 42, 'Nhà thầu nộp hồ sơ dự thầu gói cung cấp thiết bị nhưng không nộp bảo đảm dự thầu theo yêu cầu của hồ sơ mời thầu, hồ sơ bị loại ở bước kiểm tra tính hợp lệ.', 'PMTB164-TB02');
    if (first !== undefined) await tryCommand(ctx, CHECKER, `/vendor/reputation-events/${first.resource_id}/posting`, { receipt: 'MSC-UT-2026-001184' }, first.resource_version);
    const second = await record('caiMep', 'WITHDRAWING_AFTER_CLOSING', 33, 'Nhà thầu có văn bản rút hồ sơ dự thầu gói lắp đặt thiết bị công nghệ sau thời điểm đóng thầu 4 ngày.', 'PMDT105-XL02');
    if (second !== undefined) await tryCommand(ctx, CHECKER, `/vendor/reputation-events/${second.resource_id}/posting`, { receipt: 'MSC-UT-2026-001236' }, second.resource_version);
    await record('thangLong', 'WINNING_WITHOUT_SIGNING', 9, 'Nhà thầu được thông báo trúng thầu gói cung cấp vật liệu chịu lửa nhưng từ chối đến hoàn thiện hợp đồng, không nêu lý do chính đáng.');
    const retracted = await record('dongA', 'NOT_COMPARING_DOCUMENTS', 25, 'Ghi nhận nhầm đối tượng: văn bản đối chiếu tài liệu gửi nhầm cho nhà thầu cùng tên viết tắt.');
    if (retracted !== undefined) await tryCommand(ctx, LEADER, `/vendor/reputation-events/${retracted.resource_id}/retraction`, { reason: 'Ghi nhầm nhà thầu, đã xác minh lại với biên bản mở thầu.' }, retracted.resource_version);
  }
  const ventures = await ctx.list<Obj>(MAKER, '/vendor/joint-ventures');
  if (ventures.length === 0) {
    const agreement = await paper(ctx, 'TTLD-01/2026', 'Thỏa thuận liên danh Nam Việt - Việt Hưng', 'Công ty Cổ phần Xây dựng Công nghiệp Nam Việt', ctx.day(-90));
    await tryCommand(ctx, MAKER, '/vendor/joint-ventures', {
      name: 'Liên danh Nam Việt - Việt Hưng (xây lắp và hệ thống điện đo lường)',
      members: [
        { contractor_id: c.idOf('namViet'), share_pct: '65', lead: true },
        { contractor_id: c.idOf('vietHung'), share_pct: '35', lead: false },
      ],
      agreement_document_id: agreement,
      starts_on: ctx.day(-90),
    });
    const agreement2 = await paper(ctx, 'TTLD-02/2026', 'Thỏa thuận liên danh Minh Phát - Cái Mép', 'Công ty Cổ phần Cơ khí và Xây lắp Dầu khí Minh Phát', ctx.day(-60));
    await tryCommand(ctx, MAKER, '/vendor/joint-ventures', {
      name: 'Liên danh Minh Phát - Cái Mép (lắp đặt thiết bị và đường ống công nghệ)',
      members: [
        { contractor_id: c.idOf('minhPhat'), share_pct: '70', lead: true },
        { contractor_id: c.idOf('caiMep'), share_pct: '30', lead: false },
      ],
      agreement_document_id: agreement2,
      starts_on: ctx.day(-60),
    });
  }
  ctx.record({ module: 'VND', screen: 'VND-06', kind: 'reputation', id: 'vnd-06', code: 'VND-06', note: 'reputation events and joint ventures' });
}

// ---- VND-09: bid security register --------------------------------------------------------------------------------------------------------

async function seedSecurities(c: Ctx, packages: Map<string, Obj>): Promise<void> {
  const { ctx } = c;
  const existing = await ctx.list<Obj>(MAKER, '/vendor/bid-securities');
  if (existing.length > 0) return;
  const bank = 'Ngân hàng TMCP Hải Âu - Chi nhánh Bà Rịa - Vũng Tàu';
  const plan: Array<{ pack: string; key: Key; kind: 'BANK_GUARANTEE' | 'INSURANCE_BOND' | 'CASH_DEPOSIT'; pct: number; flow: 'CONFIRMED' | 'PENDING' | 'REJECTED' | 'FORFEIT_PROPOSED' | 'RELEASED' }> = [
    { pack: 'PMDT105-TB01', key: 'hongPhuc', kind: 'BANK_GUARANTEE', pct: 1.5, flow: 'CONFIRMED' },
    { pack: 'PMDT105-TB01', key: 'vietHung', kind: 'BANK_GUARANTEE', pct: 1.5, flow: 'CONFIRMED' },
    { pack: 'PMDT105-TB01', key: 'hoangLong', kind: 'INSURANCE_BOND', pct: 1.5, flow: 'PENDING' },
    { pack: 'PMDT114-TB01', key: 'hongPhuc', kind: 'BANK_GUARANTEE', pct: 1.5, flow: 'CONFIRMED' },
    { pack: 'PMTB164-TB02', key: 'hoangLong', kind: 'CASH_DEPOSIT', pct: 2, flow: 'FORFEIT_PROPOSED' },
    { pack: 'PMTB164-TB02', key: 'caiMep', kind: 'BANK_GUARANTEE', pct: 2, flow: 'REJECTED' },
    { pack: 'PMDT105-XL01', key: 'namViet', kind: 'BANK_GUARANTEE', pct: 1.5, flow: 'RELEASED' },
    { pack: 'PMDT105-XL01', key: 'minhPhat', kind: 'BANK_GUARANTEE', pct: 1.5, flow: 'RELEASED' },
  ];
  const prepared = new Set<string>();
  let n = 0;
  for (const spec of plan) {
    const pack = packages.get(spec.pack);
    if (pack === undefined) continue;
    const budget = BigInt(String(pack.budget_vnd).split('.')[0] ?? '0');
    const amount = (budget * BigInt(Math.round(spec.pct * 100))) / 10000n;
    if (!prepared.has(spec.pack)) {
      prepared.add(spec.pack);
      const controls = await ctx.get<Obj>(MAKER, `/vendor/packages/${String(pack.id)}/controls`);
      await tryCommand(ctx, MAKER, `/vendor/packages/${String(pack.id)}/controls`, { security_base_amount: Number(budget), bid_valid_until: ctx.day(60), estimated_value: Number(budget), duration_months: 18 }, asVersion(controls.version));
    }
    n += 1;
    const doc = await paper(ctx, `BL-${spec.pack}-${n}`, `Thư bảo lãnh dự thầu gói ${spec.pack} của Công ty ${NAME[spec.key]}`, bank, ctx.day(-35));
    const made = await tryCommand(ctx, MAKER, '/vendor/bid-securities', {
      package_id: String(pack.id),
      contractor_id: c.idOf(spec.key),
      kind: spec.kind,
      issuer: spec.kind === 'INSURANCE_BOND' ? 'Công ty Bảo hiểm Bảo Minh Vũng Tàu' : bank,
      security_no: `BL/2026/${spec.pack.replace('PM', '')}/${n.toString().padStart(3, '0')}`,
      amount: Number(amount),
      issued_on: ctx.day(-35),
      valid_until: ctx.day(spec.flow === 'RELEASED' ? 20 : 90),
      document_id: doc,
    });
    if (made === undefined || spec.flow === 'PENDING') continue;
    if (spec.flow === 'REJECTED') {
      await tryCommand(ctx, CHECKER, `/vendor/bid-securities/${made.resource_id}/reject`, { reason: 'Thư bảo lãnh không ghi rõ tên gói thầu và không có điều khoản thanh toán ngay khi nhận yêu cầu đầu tiên.' }, made.resource_version);
      continue;
    }
    const confirmed = await tryCommand(ctx, CHECKER, `/vendor/bid-securities/${made.resource_id}/confirm`, { issuer_reference: `Xác nhận qua điện thoại và công văn số ${100 + n}/NH-HA ngày ${ctx.day(-33)}` }, made.resource_version);
    if (confirmed === undefined) continue;
    if (spec.flow === 'FORFEIT_PROPOSED') await tryCommand(ctx, MAKER, `/vendor/bid-securities/${made.resource_id}/propose-forfeiture`, { reason_code: 'WITHDREW_AFTER_CLOSING', reason: 'Nhà thầu rút hồ sơ dự thầu sau thời điểm đóng thầu theo công văn số 77/CV-HL.' }, confirmed.resource_version);
    if (spec.flow === 'RELEASED') await tryCommand(ctx, CHECKER, `/vendor/bid-securities/${made.resource_id}/release`, { reason: 'Hoàn trả bảo đảm dự thầu sau khi ký hợp đồng và nhà thầu trúng thầu nộp bảo đảm thực hiện hợp đồng.' }, confirmed.resource_version);
  }
  ctx.record({ module: 'VND', screen: 'VND-09', kind: 'bid-securities', id: 'vnd-09', code: 'VND-09', note: 'bid security register' });
}

// ---- CTR-23 / CTR-37 / VND-12: evaluation of contract performance, violations, rating proposals -------------------------------------------

async function seedPerformance(c: Ctx, contracts: Map<string, Obj>): Promise<void> {
  const { ctx } = c;
  const specs: Array<{ contract: string; period: string; scores: [number, number, number, number, number]; remarks: string; approve: boolean; rating: boolean }> = [
    { contract: 'HD-PMDT105-XL01', period: 'Quý 3/2026', scores: [88, 82, 90, 85, 95], remarks: 'Nhà thầu bám sát tiến độ phần móng và kết cấu, chất lượng bê tông đạt yêu cầu, an toàn công trường tốt.', approve: true, rating: true },
    { contract: 'HD-PMDT105-XL02', period: 'Quý 3/2026', scores: [78, 70, 80, 75, 85], remarks: 'Lắp đặt thiết bị chậm so với kế hoạch do vật tư về muộn, đã có biện pháp bù tiến độ.', approve: true, rating: true },
    { contract: 'HD-PMDT105-TV01', period: 'Quý 3/2026', scores: [92, 90, 94, 88, 96], remarks: 'Tư vấn giám sát có mặt đầy đủ, báo cáo hằng tuần đúng hạn.', approve: true, rating: false },
    { contract: 'HD-PMTB164-TB01', period: 'Quý 3/2026', scores: [60, 55, 70, 65, 80], remarks: 'Thiết bị giao chậm 3 tuần so với hợp đồng, một số hạng mục chưa đạt thử áp lực lần đầu.', approve: false, rating: false },
    { contract: 'HD-PMDT114-XL01', period: 'Quý 3/2026', scores: [85, 80, 88, 82, 90], remarks: 'Chất lượng thi công ổn định, phối hợp tốt với tư vấn giám sát.', approve: true, rating: false },
  ];
  for (const spec of specs) {
    const contract = contracts.get(spec.contract);
    if (contract === undefined) continue;
    const id = String(contract.id);
    const existing = await ctx.list<Obj>(MAKER, '/performance-evaluations', { contract_id: id }).catch(() => [] as Obj[]);
    if (existing.length === 0) {
      const made = await tryCommand(ctx, MAKER, `/contracts/${id}/performance-evaluations`, { evaluation_kind: 'PERIODIC', period_label: spec.period, score_quality: spec.scores[0], score_schedule: spec.scores[1], score_safety_env: spec.scores[2], score_cooperation: spec.scores[3], score_financial: spec.scores[4], remarks: spec.remarks });
      if (made !== undefined && spec.approve) await tryCommand(ctx, CHECKER, `/performance-evaluations/${made.resource_id}/approve`, { note: 'Đã đối chiếu với báo cáo giám sát và biên bản nghiệm thu giai đoạn.' }, made.resource_version);
    }
  }
  // Violations: recorded by one person, confirmed by another; a sanction needs the decision paper.
  const violationOf = contracts.get('HD-PMDT105-XL02');
  const tbOf = contracts.get('HD-PMTB164-TB01');
  if (violationOf !== undefined) {
    const id = String(violationOf.id);
    const have = await ctx.get<Obj>(MAKER, `/contractors/${String(violationOf.contractor_id)}/scorecard`).catch(() => ({}) as Obj);
    for (const row of (have.violations ?? []) as Obj[]) {
      if (row.status === 'RECORDED' && row.violation_kind === 'DELAY') await tryCommand(ctx, CHECKER, `/violations/${String(row.id)}/confirm`, { penalty_kind: 'WARNING', decision_document_version_id: await decisionVersion(ctx, 'CB-NT-07/2026', 'Công văn nhắc nhở nhà thầu chậm tiến độ gói lắp đặt thiết bị công nghệ') }, asVersion(row.version));
    }
    if (((have.violations ?? []) as Obj[]).length === 0) {
      const v1 = await tryCommand(ctx, MAKER, `/contracts/${id}/violations`, { violation_kind: 'DELAY', severity: 'MAJOR', occurred_on: ctx.day(-20), description: 'Nhà thầu chậm bàn giao mặt bằng lắp đặt cụm máy nén 22 ngày so với tiến độ trong hợp đồng, không có văn bản đề nghị gia hạn trước hạn.' });
      if (v1 !== undefined) await tryCommand(ctx, CHECKER, `/violations/${v1.resource_id}/confirm`, { penalty_kind: 'WARNING', decision_document_version_id: await decisionVersion(ctx, 'CB-NT-07/2026', 'Công văn nhắc nhở nhà thầu chậm tiến độ gói lắp đặt thiết bị công nghệ') }, v1.resource_version);
      const v2 = await tryCommand(ctx, MAKER, `/contracts/${id}/violations`, { violation_kind: 'SAFETY', severity: 'MINOR', occurred_on: ctx.day(-9), description: 'Công nhân không đeo dây an toàn khi làm việc trên cao tại khu vực giàn đường ống, đã được nhắc nhở tại chỗ.' });
      void v2;
    }
  }
  if (tbOf !== undefined) {
    const have = await ctx.get<Obj>(MAKER, `/contractors/${String(tbOf.contractor_id)}/scorecard`).catch(() => ({}) as Obj);
    if (((have.violations ?? []) as Obj[]).length === 0) {
      await tryCommand(ctx, MAKER, `/contracts/${String(tbOf.id)}/violations`, { violation_kind: 'QUALITY', severity: 'MAJOR', occurred_on: ctx.day(-14), description: 'Bình chứa áp lực lô 1 không đạt thử áp lực lần đầu, phải gia công lại mối hàn.' });
    }
  }
  // Rating proposals: the investor proposes, another person notifies and records the answer of the contractor, the leader adopts, and the result is published (VND-12).
  for (const spec of specs.filter((one) => one.rating)) {
    const contract = contracts.get(spec.contract);
    if (contract === undefined) continue;
    const id = String(contract.id);
    const readProposal = async (): Promise<Obj | undefined> => (await ctx.list<Obj>(MAKER, '/contract-rating-proposals', { contract_id: id })).find((one) => one.period_label === spec.period);
    let proposal = await readProposal();
    if (proposal === undefined) {
      const made = await tryCommand(ctx, MAKER, `/contracts/${id}/rating-proposals`, { evaluation_kind: 'PERIODIC', period_label: spec.period, note: 'Đề xuất xếp hạng thực hiện hợp đồng theo kết quả đánh giá định kỳ.' });
      if (made === undefined) continue;
      proposal = await readProposal();
    }
    for (let step = 0; step < 4 && proposal !== undefined; step += 1) {
      const pid = String(proposal.id);
      const version = asVersion(proposal.version);
      const state = String(proposal.state);
      let moved: CommandReply | undefined;
      if (state === 'PROPOSED') moved = await tryCommand(ctx, CHECKER, `/contract-rating-proposals/${pid}/notify`, { note: 'Đã gửi thông báo đề xuất xếp hạng cho nhà thầu.' }, version);
      else if (state === 'NOTIFIED') moved = await tryCommand(ctx, CHECKER, `/contract-rating-proposals/${pid}/response`, { response_kind: 'ACCEPT', response_text: 'Nhà thầu thống nhất với đề xuất xếp hạng của chủ đầu tư.', received_on: ctx.day(0) }, version);
      else if (state === 'RESPONDED' || state === 'RESPONSE_RECEIVED') {
        const criteria = (proposal.criteria ?? {}) as Record<string, Obj>;
        const keys = ['quality', 'schedule', 'safety_env', 'cooperation', 'financial'];
        const overrides: Record<string, { score: number; reason: string }> = {};
        keys.forEach((key, index) => {
          if (criteria[key]?.score === null || criteria[key]?.score === undefined) overrides[key] = { score: spec.scores[index] ?? 80, reason: 'Chưa đủ thời gian quan sát tự động; cán bộ hợp đồng đánh giá trực tiếp theo biên bản kiểm tra hiện trường quý 3/2026.' };
        });
        moved = await tryCommand(ctx, LEADER, `/contract-rating-proposals/${pid}/adopt`, { note: 'Chấp thuận xếp hạng theo đề xuất.', overrides }, version);
        if (moved !== undefined) await tryCommand(ctx, LEADER, `/vendor/rating-proposals/${pid}/publication`, { kind: 'INITIAL', receipt: `MSC-DG-2026-00${spec.contract.endsWith('XL01') ? '412' : '413'}` });
      } else {
        ctx.warn(`rating proposal ${spec.contract} is in state ${state}`);
      }
      if (moved === undefined) break;
      proposal = await readProposal();
    }
  }
  ctx.record({ module: 'CTR', screen: 'CTR-23', kind: 'performance', id: 'ctr-23', code: 'CTR-23', note: 'evaluations, violations, rating proposals' });
}

/** The version id of a clean file of a document, as the evaluation commands name it. */
async function decisionVersion(ctx: SeedContext, symbol: string, title: string): Promise<string | undefined> {
  const documentId = await inForce(ctx, symbol, title, 'Ban Quản lý dự án Đạm Phú Mỹ', 15);
  const versions = await ctx.list<Obj>(MAKER, '/resources/document_version');
  return versions.find((row) => row.document_id === documentId)?.id as string | undefined;
}

// ---- VND-15 / VND-13: screening of banned parties and investigation ------------------------------------------------------------------------

async function seedScreening(c: Ctx): Promise<void> {
  const { ctx } = c;
  const screening = await ctx.get<Obj>(MAKER, '/vendor/screening');
  if (((screening.runs ?? []) as Obj[]).length === 0) {
    const imports = [
      { source: 'WORLD_BANK', as_of: ctx.day(-3), reference: 'Danh sách các bên bị loại của Ngân hàng Thế giới, bản cập nhật tháng 11/2026', entries: [{ ref: 'WB-2026-0192', name: 'Công ty Cổ phần Cơ điện Lạnh Đại Phong', tax_code: c.byKey.get('daiPhong')?.tax_identifier, valid_from: ctx.day(-200), valid_until: ctx.day(500) }, { ref: 'WB-2026-0233', name: 'Phu Hung Industrial Construction Co', valid_from: ctx.day(-100) }] },
      { source: 'ADB', as_of: ctx.day(-3), reference: 'Danh sách các bên bị cấm của Ngân hàng Phát triển Châu Á, bản tháng 11/2026', entries: [{ ref: 'ADB-2026-044', name: 'Cong ty TNHH Thuong mai Thiet bi Quang Vinh', valid_from: ctx.day(-300) }] },
    ];
    for (const one of imports) await tryCommand(ctx, CHECKER, '/vendor/screening/list-imports', one);
    await tryCommand(ctx, CHECKER, '/vendor/screening/runs', {});
  }
  const hits = ((await ctx.get<Obj>(MAKER, '/vendor/screening')).hits ?? []) as Obj[];
  for (const hit of hits) {
    const text = JSON.stringify(hit);
    if (String(hit.status) !== 'PENDING' && String(hit.status) !== 'HOLD' && String(hit.state) !== 'PENDING') continue;
    if (text.includes('Đại Phong')) await tryCommand(ctx, LEADER, `/vendor/screening/hits/${String(hit.id)}/confirm`, { violation_groups: ['GROUP_1'], violation_summary: 'Tên và mã số thuế trùng với danh sách các bên bị loại của Ngân hàng Thế giới.', note: 'Đã đối chiếu mã số thuế với hồ sơ năng lực.' }, asVersion(hit.version));
    else if (text.includes('Phú Hưng') || text.includes('Phu Hung')) await tryCommand(ctx, LEADER, `/vendor/screening/hits/${String(hit.id)}/dismiss`, { reason: 'Trùng tên gần đúng nhưng khác mã số thuế và địa chỉ; là một pháp nhân khác.' }, asVersion(hit.version));
  }
  ctx.record({ module: 'VND', screen: 'VND-15', kind: 'screening', id: 'vnd-15', code: 'VND-15', note: 'list imports, one screening run and hits' });
}

async function seedInvestigation(c: Ctx): Promise<void> {
  const { ctx } = c;
  const leads = ((await ctx.get<Obj>(MAKER, '/vendor/leads')).items ?? []) as Obj[];
  if (leads.length === 0) {
    // Three firms (one of them banned) give the same office address and telephone number: the link scan finds the cluster and opens a lead of suspected re-incorporation.
    const office = { registered_address: 'Số 15 Đường số 7, KCN Long Thành, huyện Long Thành, tỉnh Đồng Nai', phone: '0251 3999 111' };
    const people: Array<{ key: Key; rep: string; position: string; email: string }> = [
      { key: 'quangVinh', rep: 'Lương Văn Quang', position: 'Giám đốc', email: 'quangvinh@qv-thietbi.vn' },
      { key: 'thangLong', rep: 'Lương Thị Thăng', position: 'Giám đốc', email: 'thanglong@tl-chiuhua.vn' },
      { key: 'daiPhong', rep: 'Lương Đại Phong', position: 'Tổng giám đốc', email: 'daiphong@dp-codienlanh.vn' },
    ];
    for (const one of people) {
      const detail = await ctx.get<Obj>(MAKER, `/vendor/contractors/${c.idOf(one.key)}`);
      const profile = (detail.profile ?? {}) as Obj;
      if (profile.phone === office.phone) continue;
      await tryCommand(ctx, MAKER, `/vendor/contractors/${c.idOf(one.key)}/profile`, { legal_rep_name: one.rep, legal_rep_position: one.position, email: one.email, ...office }, asVersion(profile.version));
    }
    await tryCommand(ctx, 'auditor', '/vendor/link-scans', { note: 'Quét liên hệ định kỳ cuối quý' });
  }
  const after = ((await ctx.get<Obj>(MAKER, '/vendor/leads')).items ?? []) as Obj[];
  const first = after.every((one) => one.status === 'NEW') ? after.find((one) => one.kind === 'RESTRICTED_AFFILIATE') : undefined;
  if (first !== undefined) await tryCommand(ctx, 'auditor', `/vendor/leads/${String(first.id)}/take`, {}, asVersion(first.version));
  ctx.record({ module: 'VND', screen: 'VND-13', kind: 'investigation', id: 'vnd-13', code: 'VND-13', note: `link scan, ${after.length} leads` });
}

// ---- VND-20 / VND-21 / VND-23: contractor portal (staff side) and remediation ------------------------------------------------------------

async function seedPortal(c: Ctx, contracts: Map<string, Obj>): Promise<void> {
  const { ctx } = c;
  const invitations = ((await ctx.get<Obj>(MAKER, '/vendor/portal/invitations')).items ?? []) as Obj[];
  if (invitations.length === 0) {
    const specs: Array<{ key: Key; name: string; email: string; basis: 'REGISTRY_EMAIL' | 'REPRESENTATIVE_LETTER' | 'TAX_AUTHORITY_RECORD'; approve: boolean }> = [
      { key: 'namViet', name: 'Lê Hoàng Nam', email: 'contact@namviet-ic.example.test', basis: 'REGISTRY_EMAIL', approve: false },
      { key: 'minhPhat', name: 'Trần Quốc Bảo', email: 'lienhe@minhphat-cokhi.example.test', basis: 'REPRESENTATIVE_LETTER', approve: false },
      { key: 'baoAn', name: 'Đỗ Thị Thanh Mai', email: 'office@baoan-tvtk.example.test', basis: 'REGISTRY_EMAIL', approve: false },
      { key: 'tanPhat', name: 'Võ Minh Tâm', email: 'sales@tanphat-pressure.example.test', basis: 'TAX_AUTHORITY_RECORD', approve: false },
    ];
    for (const spec of specs) {
      const made = await tryCommand(ctx, MAKER, '/vendor/portal/invitations', { contractor_id: c.idOf(spec.key), contact_email: spec.email, contact_name: spec.name, contact_basis: spec.basis, basis_reference: `Hồ sơ năng lực HSNL/2026 của ${NAME[spec.key]}` });
      if (made !== undefined && spec.approve) await tryCommand(ctx, CHECKER, `/vendor/portal/invitations/${made.resource_id}/approval`, { note: 'Đã gọi điện xác nhận người nhận lời mời với người đại diện theo pháp luật.' }, made.resource_version);
    }
  }
  const requests = ((await ctx.get<Obj>(MAKER, '/vendor/portal/requests')).items ?? []) as Obj[];
  if (requests.length === 0) {
    const xl02 = contracts.get('HD-PMDT105-XL02');
    await tryCommand(ctx, MAKER, `/vendor/contractors/${c.idOf('minhPhat')}/portal-requests`, { kind: 'EVALUATION_RESPONSE', title: 'Phản hồi kết quả đánh giá thực hiện hợp đồng quý 3/2026', body: 'Đề nghị nhà thầu có ý kiến về kết quả đánh giá thực hiện hợp đồng HD-PMDT105-XL02 trong 20 ngày.', ...(xl02 === undefined ? {} : { subject_type: 'CONTRACT', subject_id: String(xl02.id) }), due_on: ctx.day(12) });
    await tryCommand(ctx, MAKER, `/vendor/contractors/${c.idOf('namViet')}/portal-requests`, { kind: 'CERTIFICATE_UPLOAD', title: 'Bổ sung chứng chỉ an toàn lao động đã gia hạn', body: 'Chứng chỉ ATLD của cán bộ an toàn sắp hết hạn trong 30 ngày, đề nghị nhà thầu tải lên bản gia hạn.', due_on: ctx.day(20) });
    await tryCommand(ctx, MAKER, `/vendor/contractors/${c.idOf('tanPhat')}/portal-requests`, { kind: 'PROFILE_UPDATE', title: 'Cập nhật hồ sơ năng lực: chứng nhận ISO 9001 đã hết hạn', body: 'Đề nghị nhà thầu cập nhật chứng nhận hệ thống quản lý chất lượng còn hiệu lực.', due_on: ctx.day(-2) });
  }
  const plans = ((await ctx.get<Obj>(MAKER, '/vendor/remediation-plans')).items ?? []) as Obj[];
  if (plans.length === 0) {
    const xl02 = contracts.get('HD-PMDT105-XL02');
    const tb = contracts.get('HD-PMTB164-TB01');
    const make = async (key: Key, contract: Obj | undefined, body: Record<string, unknown>, start: boolean): Promise<void> => {
      const made = await tryCommand(ctx, MAKER, `/vendor/contractors/${c.idOf(key)}/remediation-plans`, { ...body, ...(contract === undefined ? {} : { contract_id: String(contract.id) }) });
      if (made !== undefined && start) await tryCommand(ctx, CHECKER, `/vendor/remediation-plans/${made.resource_id}/start`, {}, made.resource_version);
    };
    await make('minhPhat', xl02, { title: 'Kế hoạch khắc phục chậm tiến độ lắp đặt thiết bị', objective: 'Đưa tiến độ lắp đặt cụm máy nén trở lại đúng tiến độ hợp đồng và không phát sinh thêm vi phạm an toàn.', trigger_kind: 'POOR_EVALUATION', actions: [{ description: 'Nộp tiến độ bù cho các hạng mục chậm, có xác nhận của tư vấn giám sát', due_on: ctx.day(7) }, { description: 'Bổ sung thêm một tổ lắp đặt và cán bộ an toàn chuyên trách tại công trường', due_on: ctx.day(14) }, { description: 'Tổ chức huấn luyện an toàn làm việc trên cao cho toàn bộ công nhân', due_on: ctx.day(10) }] }, true);
    await make('tanPhat', tb, { title: 'Kế hoạch khắc phục chất lượng bình chứa áp lực', objective: 'Hoàn thành gia công lại mối hàn và thử áp lực đạt yêu cầu trước khi giao lô 2.', trigger_kind: 'NON_CONFORMANCE', actions: [{ description: 'Gia công lại mối hàn lô 1 và nộp hồ sơ kiểm tra không phá hủy', due_on: ctx.day(10) }, { description: 'Thử áp lực lại có sự chứng kiến của chủ đầu tư', due_on: ctx.day(18) }] }, true);
    await make('hongPhuc', undefined, { title: 'Kế hoạch bổ sung hồ sơ chất lượng bơm công nghiệp', objective: 'Hoàn thiện hồ sơ chứng nhận chất lượng trước khi tham gia các gói thầu tiếp theo.', trigger_kind: 'MANUAL', actions: [{ description: 'Nộp chứng nhận ISO 9001 bản gốc có xác nhận của tổ chức chứng nhận', due_on: ctx.day(21) }] }, false);
  }
  ctx.record({ module: 'VND', screen: 'VND-20', kind: 'portal-staff', id: 'vnd-20', code: 'VND-20/21/23', note: 'invitations, requests, remediation plans' });
}

// ---- BID-20: petitions of bidders -----------------------------------------------------------------------------------------------------------

async function seedPetitions(c: Ctx, packages: Map<string, Obj>): Promise<void> {
  const { ctx } = c;
  const known = await ctx.list<Obj>(MAKER, '/procurement-petitions').catch(() => [] as Obj[]);
  const specs: Array<{ pack: string; key: Key; kind: 'PROCESS' | 'RESULT'; symbol: string; title: string; ago: number; resolve: boolean; outcome?: 'UPHELD' | 'REJECTED' | 'WITHDRAWN' }> = [
    { pack: 'PMDT105-XL01', key: 'vietHung', kind: 'RESULT', symbol: '21/KN-VH', title: 'Văn bản kiến nghị về kết quả lựa chọn nhà thầu gói PMDT105-XL01 của Công ty TNHH Kỹ thuật Công nghiệp Việt Hưng', ago: 0, resolve: true, outcome: 'REJECTED' },
    { pack: 'PMDT105-TB01', key: 'hoangLong', kind: 'PROCESS', symbol: '09/KN-HL', title: 'Văn bản kiến nghị về hồ sơ mời thầu gói PMDT105-TB01 của Công ty TNHH Điện và Tự động hóa Hoàng Long', ago: 11, resolve: false },
    { pack: 'PMTB164-TB02', key: 'caiMep', kind: 'PROCESS', symbol: '05/KN-CM', title: 'Văn bản kiến nghị về tiêu chí đánh giá gói PMTB164-TB02 của Công ty TNHH Một thành viên Lắp đặt Đường ống Công nghệ Cái Mép', ago: 20, resolve: true },
  ];
  for (const spec of specs) {
    const pack = packages.get(spec.pack);
    if (pack === undefined) continue;
    if (known.some((row) => ((row.package ?? {}) as Obj).code === spec.pack && ((row.contractor ?? {}) as Obj).id === c.idOf(spec.key))) continue;
    const doc = await paper(ctx, spec.symbol, spec.title, `Công ty ${NAME[spec.key]}`, ctx.day(-spec.ago));
    const made = await tryCommand(ctx, MAKER, '/procurement-petitions', { package_id: String(pack.id), contractor_id: c.idOf(spec.key), petition_kind: spec.kind, received_on: ctx.day(-spec.ago), petition_document_id: doc });
    if (made === undefined || !spec.resolve) continue;
    const resolved = await tryCommand(ctx, CHECKER, `/procurement-petitions/${made.resource_id}/resolution`, { outcome: 'RESOLVED', resolution_document_id: await paper(ctx, `${spec.symbol}-TL`, `Văn bản trả lời kiến nghị của Công ty ${NAME[spec.key]}`, 'Ban Quản lý dự án Đạm Phú Mỹ', ctx.day(-Math.max(0, spec.ago - 7))) }, made.resource_version);
    if (resolved !== undefined && spec.outcome !== undefined) await tryCommand(ctx, LEADER, `/procurement-petitions/${made.resource_id}/outcome`, { outcome: spec.outcome, decision_ref: `QĐ-GQKN-${spec.symbol}`, decision_on: ctx.day(-Math.max(0, spec.ago - 12)), note: 'Kết quả giải quyết kiến nghị theo ý kiến của tổ chuyên gia.' }, resolved.resource_version);
  }
  ctx.record({ module: 'BID', screen: 'BID-20', kind: 'petitions', id: 'bid-20', code: 'BID-20', note: 'bidder petitions' });
}

// ---- CTR-24: export of contractor records for the national database --------------------------------------------------------------------

async function seedExports(c: Ctx): Promise<void> {
  const { ctx } = c;
  const known = await ctx.list<Obj>(CHECKER, '/contractor-exports').catch(() => [] as Obj[]);
  if (known.length > 0) return;
  const first = await tryCommand(ctx, CHECKER, '/contractor-exports', { scope: 'PERFORMANCE', period_from: ctx.day(-365), period_to: ctx.day(0), format: 'CSV' });
  if (first !== undefined) await tryCommand(ctx, CHECKER, `/contractor-exports/${first.resource_id}/mark-submitted`, { submitted_ref: 'Công văn số 214/ĐPM-QLDA gửi Hệ thống mạng đấu thầu quốc gia', submitted_on: ctx.day(0) }, first.resource_version);
  await tryCommand(ctx, CHECKER, '/contractor-exports', { scope: 'VIOLATION', period_from: ctx.day(-365), period_to: ctx.day(0), format: 'JSON' });
  ctx.record({ module: 'CTR', screen: 'CTR-24', kind: 'exports', id: 'ctr-24', code: 'CTR-24', note: 'two export batches' });
}

// ---- entry ----------------------------------------------------------------------------------------------------------------------------------

export async function seedClipEnterpriseVendor(ctx: SeedContext): Promise<void> {
  const register = await ctx.list<Obj>(MAKER, '/vendor/register');
  if (register.length < 16) {
    ctx.warn('the contractor register has fewer than 16 contractors: the group has nothing to do');
    return;
  }
  const packages = new Map((await ctx.list<Obj>(MAKER, '/resources/procurement_package')).map((row) => [String(row.code), row]));
  const contracts = new Map((await ctx.list<Obj>(MAKER, '/resources/contract')).map((row) => [String(row.code), row]));
  const c = await loadContractors(ctx);
  await ctx.step('VND', 'profiles', () => seedProfiles(c));
  await ctx.step('VND', 'certificates and key staff (VND-05)', () => seedCertificates(c));
  await ctx.step('VND', 'debarment cases (VND-03, BID-21)', () => seedCases(c));
  await ctx.step('VND', 'reputation events and joint ventures (VND-06)', () => seedReputation(c, packages));
  await ctx.step('VND', 'bid securities (VND-09)', () => seedSecurities(c, packages));
  await ctx.step('CTR', 'evaluations, violations, rating proposals (CTR-23, CTR-37, VND-12)', () => seedPerformance(c, contracts));
  await ctx.step('VND', 'screening of banned parties (VND-15)', () => seedScreening(c));
  await ctx.step('VND', 'investigation leads (VND-13)', () => seedInvestigation(c));
  await ctx.step('VND', 'contractor portal and remediation (VND-20, VND-21, VND-23)', () => seedPortal(c, contracts));
  await ctx.step('BID', 'petitions of bidders (BID-20)', () => seedPetitions(c, packages));
  await ctx.step('CTR', 'export batches (CTR-24)', () => seedExports(c));
}
