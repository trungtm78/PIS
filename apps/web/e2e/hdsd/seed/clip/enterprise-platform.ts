import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Obj, SeedContext } from '../context.ts';
import { STACK_INFO_PATH } from '../../../support/stack-paths.ts';
import { grantMemberRoles } from '../platform-records/iam.ts';
import { at } from '../platform-records/shared.ts';

/**
 * Group `clip-ent-platform`: the platform modules under "All applications" that read as empty after the portfolio is built, in enterprise voice (state-owned
 * fertiliser company reporting to its parent group): NOT (templates, broadcast campaigns, consents, quiet hours, limits, inbox), OMNI (channel accounts,
 * routing, contacts, conversations from the signed webhook of the provider) and MNE (forms, filing calendar of the Group, reports through review).
 *
 * Everything goes through the commands of the product; nothing is written to a table. The group is idempotent: every record is looked up by its code or name
 * before it is made, a command the rules of the product refuse is written in the warnings and the next step goes on, and a part that fails is reported
 * and does not stop the other parts (the group runs last, after the stories it reads).
 */

const MAKER = 'projectManager';
const CHECKER = 'capApprover';
const OWNER = 'owner';

/** A part of the group: a failure inside is written down and the next part still runs. */
async function part(ctx: SeedContext, module: string, title: string, run: () => Promise<void>): Promise<void> {
  try {
    await ctx.step(module, title, run);
  } catch (error) {
    ctx.warn(`${title} stopped: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function waitFor<T>(read: () => Promise<T | undefined>, seconds = 6): Promise<T | undefined> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > end) return undefined;
    await sleep(1000);
  }
}

const versionOf = (row: Obj): number => Number(row.version ?? row.resource_version ?? 1);

// ---- NOT: templates, campaigns, consents, preferences, limits, inbox ----------------------------------------------------------------------

interface TemplateSpec {
  code: string;
  channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH_FCM';
  purpose: 'OPERATIONAL' | 'REMINDER' | 'ANNOUNCEMENT';
  subject?: string;
  body: string;
  variables: Record<string, 'string' | 'integer'>;
  end: 'APPROVE' | 'REJECT' | 'DRAFT' | 'REVIEW';
  reason: string;
}

const TEMPLATES: TemplateSpec[] = [
  {
    code: 'dn-viec-can-xu-ly', channel: 'IN_APP', purpose: 'OPERATIONAL', end: 'APPROVE',
    body: 'Có việc cần xử lý: {{doi_tuong}} thuộc {{don_vi}}. Hạn xử lý: {{han_xu_ly}}. Đề nghị xem chi tiết và xử lý đúng hạn.',
    variables: { doi_tuong: 'string', don_vi: 'string', han_xu_ly: 'string' },
    reason: 'Mẫu thông báo trong hệ thống cho việc cần xử lý của Ban Quản lý dự án',
  },
  {
    code: 'dn-nhac-han-bao-cao-tuan', channel: 'IN_APP', purpose: 'REMINDER', end: 'APPROVE',
    body: 'Báo cáo nhanh tuần {{tuan}} của {{don_vi}} đến hạn nộp lúc {{han_nop}}. Đề nghị hoàn thành đúng hạn để tổng hợp gửi Tập đoàn.',
    variables: { tuan: 'string', don_vi: 'string', han_nop: 'string' },
    reason: 'Nhắc hạn báo cáo nhanh hằng tuần của các ban quản lý dự án',
  },
  {
    code: 'dn-nhac-han-bao-cao-tuan-email', channel: 'EMAIL', purpose: 'REMINDER', end: 'APPROVE',
    subject: 'Nhắc hạn nộp báo cáo nhanh tuần {{tuan}}',
    body: 'Kính gửi {{don_vi}},\n\nBáo cáo nhanh tuần {{tuan}} đến hạn nộp vào {{han_nop}}. Đề nghị đơn vị hoàn thành và gửi trên hệ thống đúng hạn.\n\nPhòng Đầu tư - Xây dựng, Công ty Cổ phần Phân bón Dầu khí Cà Mau',
    variables: { tuan: 'string', don_vi: 'string', han_nop: 'string' },
    reason: 'Nhắc hạn báo cáo gửi qua thư điện tử cho người có đồng ý nhận tin',
  },
  {
    code: 'dn-lich-bao-tri-he-thong', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', end: 'APPROVE',
    subject: 'Thông báo lịch bảo trì hệ thống quản lý đầu tư xây dựng',
    body: 'Kính gửi các đơn vị,\n\nHệ thống quản lý đầu tư xây dựng sẽ bảo trì từ {{bat_dau}} đến {{ket_thuc}}. Trong thời gian này hệ thống chỉ cho phép xem. Đề nghị các ban quản lý dự án hoàn tất việc nhập liệu trước thời điểm bảo trì.\n\nPhòng Đầu tư - Xây dựng',
    variables: { bat_dau: 'string', ket_thuc: 'string' },
    reason: 'Thông báo chung về lịch bảo trì, dùng cho các đợt gửi diện rộng',
  },
  {
    code: 'dn-huong-dan-ho-so-thanh-toan', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', end: 'APPROVE',
    subject: 'Hướng dẫn lập hồ sơ đề nghị thanh toán hợp đồng trên hệ thống',
    body: 'Kính gửi các ban quản lý dự án và nhà thầu,\n\nTừ {{ngay_ap_dung}}, hồ sơ đề nghị thanh toán hợp đồng được lập và trình trực tiếp trên hệ thống. Tài liệu hướng dẫn kèm theo thông báo này.\n\nPhòng Tài chính - Kế toán',
    variables: { ngay_ap_dung: 'string' },
    reason: 'Hướng dẫn thủ tục lập hồ sơ thanh toán điện tử cho hợp đồng xây lắp',
  },
  {
    code: 'dn-canh-bao-cham-giai-ngan-sms', channel: 'SMS', purpose: 'OPERATIONAL', end: 'APPROVE',
    body: 'Dự án {{ma_du_an}} đang chậm giải ngân so với kế hoạch vốn. Đề nghị xem chi tiết trên hệ thống quản lý đầu tư xây dựng.',
    variables: { ma_du_an: 'string' },
    reason: 'Cảnh báo ngắn cho lãnh đạo ban quản lý dự án khi dự án chậm giải ngân',
  },
  {
    code: 'dn-viec-moi-duoc-giao-push', channel: 'PUSH_FCM', purpose: 'OPERATIONAL', end: 'APPROVE',
    body: 'Bạn có việc mới cần xử lý trên hệ thống quản lý đầu tư xây dựng.',
    variables: {},
    reason: 'Tin đẩy trung tính, an toàn khi hiện trên màn hình khóa',
  },
  {
    code: 'dn-nhac-tam-ung-sms', channel: 'SMS', purpose: 'REMINDER', end: 'REJECT',
    body: 'Hợp đồng {{ma_hop_dong}} còn khoản tạm ứng chưa thu hồi, hạn thu hồi {{han_thu_hoi}}. Đề nghị nhà thầu làm việc với ban quản lý dự án.',
    variables: { ma_hop_dong: 'string', han_thu_hoi: 'string' },
    reason: 'Mẫu nhắc tạm ứng cần ghi rõ số tiền, chưa đủ căn cứ để gửi qua tin nhắn',
  },
  {
    code: 'dn-tb-bao-tri-he-thong', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', end: 'APPROVE',
    subject: 'Thông báo bảo trì hệ thống quản lý đầu tư xây dựng đêm 14/11',
    body: 'Kính gửi các đơn vị,\n\nHệ thống quản lý đầu tư xây dựng bảo trì từ 22:00 ngày 14/11/2026 đến 06:00 ngày 15/11/2026, trong thời gian này chỉ cho phép xem. Đề nghị các ban quản lý dự án hoàn tất việc nhập liệu trước thời điểm bảo trì.\n\nPhòng Đầu tư - Xây dựng',
    variables: {},
    reason: 'Thông báo diện rộng về lịch bảo trì, không cần biến vì gửi cho cả nhóm vai trò',
  },
  {
    code: 'dn-tb-nhac-han-bao-cao-tuan', channel: 'EMAIL', purpose: 'REMINDER', end: 'APPROVE',
    subject: 'Nhắc hạn nộp báo cáo nhanh tuần gửi Tập đoàn',
    body: 'Kính gửi các ban quản lý dự án,\n\nBáo cáo nhanh tuần đến hạn nộp lúc 16:00 thứ Sáu hằng tuần để Phòng Đầu tư - Xây dựng tổng hợp gửi Tập đoàn. Đề nghị các đơn vị hoàn thành đúng hạn.\n\nPhòng Đầu tư - Xây dựng',
    variables: {},
    reason: 'Nhắc hạn báo cáo hằng tuần cho nhóm vai trò phụ trách dự án',
  },
  {
    code: 'dn-tb-huong-dan-thanh-toan', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', end: 'APPROVE',
    subject: 'Hướng dẫn lập hồ sơ đề nghị thanh toán hợp đồng điện tử',
    body: 'Kính gửi các ban quản lý dự án và bộ phận kế toán,\n\nTừ ngày 01/12/2026, hồ sơ đề nghị thanh toán hợp đồng được lập và trình trực tiếp trên hệ thống quản lý đầu tư xây dựng. Tài liệu hướng dẫn gửi kèm.\n\nPhòng Tài chính - Kế toán',
    variables: {},
    reason: 'Hướng dẫn thủ tục thanh toán điện tử trước khi áp dụng',
  },
  {
    code: 'dn-thu-moi-giao-ban-dau-tu', channel: 'EMAIL', purpose: 'ANNOUNCEMENT', end: 'DRAFT',
    subject: 'Thư mời họp giao ban đầu tư xây dựng tháng {{thang}}',
    body: 'Kính mời các đồng chí dự họp giao ban đầu tư xây dựng tháng {{thang}} tại phòng họp tầng 3, trụ sở Công ty.',
    variables: { thang: 'string' },
    reason: 'Mẫu thư mời đang soạn',
  },
];

function variableSchema(spec: TemplateSpec): Obj {
  return { properties: Object.fromEntries(Object.entries(spec.variables).map(([name, type]) => [name, { type, classification: 'INTERNAL' }])) };
}

async function writeTemplate(ctx: SeedContext, spec: TemplateSpec): Promise<void> {
  const existing = await ctx.find(MAKER, '/resources/notification_template_version', (row) => row.code === spec.code && row.channel === spec.channel);
  if (existing !== undefined) return;
  const created = await ctx.command(MAKER, '/notification-templates', {
    code: spec.code,
    channel: spec.channel,
    locale: 'vi-VN',
    purpose: spec.purpose,
    content_ast: spec.subject === undefined ? { body: spec.body } : { subject: spec.subject, body: spec.body },
    variable_schema: variableSchema(spec),
    lockscreen_safe: spec.channel === 'PUSH_FCM',
  });
  if (spec.end === 'DRAFT') return;
  const submitted = await ctx.command(MAKER, `/notification-templates/${created.resource_id}/submit`, { reason: spec.reason }, { version: created });
  if (spec.end === 'REVIEW') return;
  await ctx.command(CHECKER, `/notification-templates/${created.resource_id}/decision`, { decision: spec.end === 'APPROVE' ? 'approve' : 'reject', reason: spec.reason, evidence_ids: [] }, { version: submitted });
}

interface CampaignSpec {
  name: string;
  purpose: 'ANNOUNCEMENT' | 'REMINDER' | 'OPERATIONAL';
  template: string;
  roles: string[];
  scheduleDays?: number;
  end: 'DRAFT' | 'PENDING' | 'APPROVE' | 'REJECT' | 'CANCEL';
  reason: string;
}

const CAMPAIGNS: CampaignSpec[] = [
  { name: 'Thông báo lịch bảo trì hệ thống tháng 11', purpose: 'ANNOUNCEMENT', template: 'dn-tb-bao-tri-he-thong', roles: ['CAN_BO_BAN_QLDA', 'LANH_DAO_SO', 'KE_TOAN_THANH_TOAN'], end: 'APPROVE', reason: 'Các đơn vị cần biết lịch bảo trì để hoàn tất nhập liệu trước giờ khóa sổ tháng' },
  { name: 'Nhắc hạn nộp báo cáo nhanh tuần', purpose: 'REMINDER', template: 'dn-tb-nhac-han-bao-cao-tuan', roles: ['CAN_BO_BAN_QLDA', 'KE_TOAN_THANH_TOAN'], scheduleDays: 2, end: 'APPROVE', reason: 'Nhắc các ban quản lý dự án nộp báo cáo tuần trước hạn thứ Sáu' },
  { name: 'Hướng dẫn lập hồ sơ thanh toán hợp đồng điện tử', purpose: 'ANNOUNCEMENT', template: 'dn-tb-huong-dan-thanh-toan', roles: ['CAN_BO_BAN_QLDA', 'KE_TOAN_THANH_TOAN'], end: 'PENDING', reason: 'Phổ biến thủ tục mới cho các ban quản lý dự án trước khi áp dụng' },
  { name: 'Thông báo lịch tập huấn sử dụng hệ thống', purpose: 'ANNOUNCEMENT', template: 'dn-tb-bao-tri-he-thong', roles: ['CAN_BO_BAN_QLDA'], end: 'DRAFT', reason: 'Đang chờ chốt thời gian và địa điểm tập huấn' },
  { name: 'Thông báo khen thưởng ban quản lý dự án giải ngân tốt quý III', purpose: 'ANNOUNCEMENT', template: 'dn-tb-bao-tri-he-thong', roles: ['CAN_BO_BAN_QLDA', 'LANH_DAO_SO'], end: 'REJECT', reason: 'Chưa có quyết định khen thưởng chính thức của Tổng giám đốc nên chưa thể thông báo diện rộng' },
  { name: 'Thông báo ngừng hệ thống đột xuất để nâng cấp', purpose: 'ANNOUNCEMENT', template: 'dn-tb-bao-tri-he-thong', roles: ['CAN_BO_BAN_QLDA', 'LANH_DAO_SO', 'KE_TOAN_THANH_TOAN'], scheduleDays: 5, end: 'CANCEL', reason: 'Lịch nâng cấp thay đổi theo đề nghị của nhà cung cấp, cần hủy và gửi lại sau' },
];

async function runCampaign(ctx: SeedContext, spec: CampaignSpec): Promise<void> {
  const existing = await ctx.find(MAKER, '/notification-campaigns', (row) => row.name === spec.name);
  if (existing !== undefined) return;
  const template = await ctx.find(MAKER, '/resources/notification_template_version', (row) => row.code === spec.template && row.status === 'Active');
  if (template === undefined) {
    ctx.warn(`the template ${spec.template} is not Active: the campaign "${spec.name}" is not made`);
    return;
  }
  const created = await ctx.command(MAKER, '/notification-campaigns', {
    name: spec.name,
    purpose: spec.purpose,
    template_version_id: template.id,
    segment: { role_codes: spec.roles },
    ...(spec.scheduleDays === undefined ? {} : { scheduled_at: at(ctx, spec.scheduleDays, 8) }),
  });
  if (spec.end === 'DRAFT') return;
  const preview = await ctx.must<{ preview_hash: string; version: number }>(MAKER, 'POST', `/notification-campaigns/${created.resource_id}/preview`, { reason: 'Kiểm tra danh sách người nhận trước khi trình duyệt' }, { version: created });
  const submitted = await ctx.command(MAKER, `/notification-campaigns/${created.resource_id}/submit`, { preview_hash: preview.preview_hash, reason: spec.reason }, { version: preview.version });
  if (spec.end === 'PENDING') return;
  const decided = await ctx.command(CHECKER, `/notification-campaigns/${created.resource_id}/decision`, { decision: spec.end === 'REJECT' ? 'reject' : 'approve', reason: spec.reason, evidence_ids: [] }, { version: submitted });
  if (spec.end === 'CANCEL') await ctx.command(MAKER, `/notification-campaigns/${created.resource_id}/cancel`, { reason: spec.reason }, { version: decided });
}

const CONSENTS: Array<{ person: string; channel: 'EMAIL' | 'SMS' | 'ZALO' | 'PUSH'; purpose: 'OPERATIONAL' | 'REMINDER' | 'ANNOUNCEMENT'; withdraw?: string }> = [
  ...(['owner', 'unitAdmin', 'projectManager', 'capApprover', 'treasuryMaker', 'auditor', 'nobody'] as const).flatMap((person) => [
    { person, channel: 'EMAIL' as const, purpose: 'ANNOUNCEMENT' as const },
    { person, channel: 'EMAIL' as const, purpose: 'REMINDER' as const },
  ]),
  { person: 'projectManager', channel: 'SMS', purpose: 'OPERATIONAL' },
  { person: 'capApprover', channel: 'SMS', purpose: 'OPERATIONAL' },
  { person: 'treasuryMaker', channel: 'PUSH', purpose: 'OPERATIONAL' },
  { person: 'nobody', channel: 'SMS', purpose: 'REMINDER', withdraw: 'Tôi chỉ nhận nhắc hạn qua thư điện tử công vụ, không nhận tin nhắn điện thoại' },
  { person: 'auditor', channel: 'ZALO', purpose: 'ANNOUNCEMENT', withdraw: 'Chuyển sang nhận thông báo qua thư điện tử của công ty' },
];

async function recordConsents(ctx: SeedContext): Promise<void> {
  for (const consent of CONSENTS) {
    const known = await ctx.attempt<{ items?: Obj[] }>(consent.person, 'GET', '/me/consents');
    const rows = known.json.items ?? [];
    if (rows.some((row) => row.channel === consent.channel && row.purpose === consent.purpose)) continue;
    const given = await ctx.attempt(consent.person, 'POST', '/me/consents', { channel: consent.channel, purpose: consent.purpose, consent_text_version: 'v2026.1', capture_method: 'IN_APP' });
    if (given.ok && consent.withdraw !== undefined) {
      await ctx.attempt(consent.person, 'POST', `/me/consents/${String(given.json.resource_id)}/withdraw`, { reason: consent.withdraw }, { version: given.json as never });
    }
  }
}

async function setPreferences(ctx: SeedContext): Promise<void> {
  const choices: Array<{ person: string; items: Obj[]; start: string; end: string }> = [
    { person: 'capApprover', start: '20:00', end: '07:30', items: [{ event_category: '*', channel: 'IN_APP', enabled: true, digest_mode: 'IMMEDIATE' }, { event_category: '*', channel: 'EMAIL', enabled: true, digest_mode: 'DAILY' }] },
    { person: 'treasuryMaker', start: '21:00', end: '06:30', items: [{ event_category: '*', channel: 'IN_APP', enabled: true, digest_mode: 'IMMEDIATE' }, { event_category: '*', channel: 'EMAIL', enabled: true, digest_mode: 'HOURLY' }] },
    { person: 'projectManager', start: '22:00', end: '06:00', items: [{ event_category: '*', channel: 'IN_APP', enabled: true, digest_mode: 'IMMEDIATE' }, { event_category: '*', channel: 'SMS', enabled: false }] },
  ];
  for (const choice of choices) {
    const current = await ctx.attempt<Obj>(choice.person, 'GET', '/me/notification-preferences');
    const items = (current.json.items as Obj[] | undefined) ?? [];
    if (items.length > 0) continue;
    await ctx.attempt(choice.person, 'PUT', '/me/notification-preferences', { items: choice.items, quiet_start: choice.start, quiet_end: choice.end, time_zone: 'Asia/Ho_Chi_Minh' }, { version: Number(current.json.version ?? 0) });
  }
}

async function setChannelLimits(ctx: SeedContext): Promise<void> {
  const accounts = await ctx.list(MAKER, '/resources/channel_account');
  const caps: Record<string, { daily: number; budget: string }> = { EMAIL: { daily: 5000, budget: '3000000' }, SMS: { daily: 1000, budget: '5000000' }, ZALO_OA: { daily: 2000, budget: '2000000' } };
  for (const account of accounts.filter((row) => row.status === 'Active')) {
    const cap = caps[String(account.channel)];
    if (cap === undefined || account.daily_send_cap !== undefined && account.daily_send_cap !== null) continue;
    await ctx.attempt(MAKER, 'PUT', `/channel-accounts/${String(account.id)}/limits`, { daily_send_cap: cap.daily, monthly_budget_vnd: cap.budget, reason: 'Hạn mức theo hợp đồng dịch vụ tin nhắn và thư điện tử năm 2026 của Công ty' }, { version: versionOf(account) });
  }
}

async function testSend(ctx: SeedContext): Promise<void> {
  const template = await ctx.find(MAKER, '/resources/notification_template_version', (row) => row.code === 'dn-nhac-han-bao-cao-tuan-email' && row.status === 'Active');
  if (template === undefined) return;
  await ctx.attempt(MAKER, 'POST', `/notification-templates/${String(template.id)}/test-sends`, {
    test_recipient_ids: [ctx.person(MAKER).membershipId, ctx.person(CHECKER).membershipId],
    sample_variables: { tuan: '45', don_vi: 'Ban Quản lý dự án', han_nop: '13/11/2026' },
  });
}

/** The people open their inbox: two thirds of what has come is read, and what asks for an acknowledgement is acknowledged by some of them. */
async function readInboxes(ctx: SeedContext): Promise<void> {
  for (const person of ['projectManager', 'owner', 'capApprover', 'unitAdmin', 'treasuryMaker', 'auditor', 'nobody']) {
    const reply = await ctx.attempt<{ items?: Obj[] }>(person, 'GET', '/me/notifications', undefined, { query: { limit: 100 } });
    for (const [index, item] of (reply.json.items ?? []).entries()) {
      if (item.read_at !== null && item.read_at !== undefined) continue;
      if (index % 3 === 2) continue;
      const opened = await ctx.attempt(person, 'POST', `/notifications/${String(item.id)}/read`, { opened_via: 'IN_APP' });
      if (opened.ok && item.ack_required === true && index % 2 === 0) await ctx.attempt(person, 'POST', `/notifications/${String(item.id)}/acknowledge`, { comment: 'Đã nhận và giao cán bộ phụ trách xử lý' });
    }
  }
}

const PHONES: Record<string, string> = { owner: '+84912340001', unitAdmin: '+84912340002', projectManager: '+84912340003', capApprover: '+84912340004', treasuryMaker: '+84912340005', auditor: '+84912340006', nobody: '+84912340007' };

/** The phone of each person (the SMS consents need a number on the profile). */
async function completeProfiles(ctx: SeedContext): Promise<void> {
  for (const [person, phone] of Object.entries(PHONES)) {
    const current = await ctx.attempt<Obj>(person, 'GET', '/me/profile');
    if (!current.ok || (current.json.phone_e164 !== undefined && current.json.phone_e164 !== null && current.json.phone_e164 !== '')) continue;
    await ctx.attempt(person, 'PUT', '/me/profile', { locale: 'vi-VN', time_zone: 'Asia/Ho_Chi_Minh', phone_e164: phone }, { version: Number(current.json.version ?? 1) });
  }
}

async function seedNot(ctx: SeedContext): Promise<void> {
  await part(ctx, 'NOT', 'every person holds the role MEMBER (inbox)', () => grantMemberRoles(ctx));
  await part(ctx, 'NOT', 'profiles with a phone (IAM-05)', () => completeProfiles(ctx));
  await part(ctx, 'NOT', 'templates of the messages (NOT-07)', async () => {
    for (const spec of TEMPLATES) await writeTemplate(ctx, spec);
  });
  await part(ctx, 'NOT', 'consents of the people (NOT-17)', () => recordConsents(ctx));
  await part(ctx, 'NOT', 'preferences and quiet hours (NOT-03)', () => setPreferences(ctx));
}

async function seedNotLate(ctx: SeedContext): Promise<void> {
  await part(ctx, 'NOT', 'limits of the channels (NOT-15)', () => setChannelLimits(ctx));
  await part(ctx, 'NOT', 'test send of a template (NOT-08)', () => testSend(ctx));
  await part(ctx, 'NOT', 'broadcast campaigns (NOT-09, NOT-10, NOT-16)', async () => {
    for (const spec of CAMPAIGNS) {
      try {
        await runCampaign(ctx, spec);
      } catch (error) {
        ctx.warn(`campaign "${spec.name}" stopped: ${error instanceof Error ? error.message.slice(0, 260) : String(error)}`);
      }
    }
  });
  await part(ctx, 'NOT', 'the people read their inbox (NOT-01, NOT-02)', () => readInboxes(ctx));
}

// ---- OMNI: channel accounts, routing, replies, contacts, conversations -------------------------------------------------------------------

const MAIL = { channel: 'EMAIL', externalId: 'tiepnhan.dautu@dpm.com.vn', name: 'Hộp thư tiếp nhận của Ban Quản lý dự án đầu tư', credential: 'secret://dpm/mail-tiepnhan' } as const;
const WEBHOOK_REF = 'secret://e2e/uat-relay-webhook';
const PROVIDER = 'smtp-relay';

const ACCOUNTS: Array<{ channel: 'EMAIL' | 'SMS' | 'ZALO_OA' | 'ZALO_ZNS'; externalId: string; name: string; credential: string; webhook: string; autoReply?: string; disable?: string }> = [
  { channel: 'EMAIL', externalId: MAIL.externalId, name: MAIL.name, credential: MAIL.credential, webhook: WEBHOOK_REF, autoReply: 'Ban Quản lý dự án đã nhận được nội dung của quý đơn vị và sẽ phản hồi trong 4 giờ làm việc.' },
  { channel: 'SMS', externalId: 'brandname-dpm-dautu', name: 'Tin nhắn thương hiệu của Ban Quản lý dự án', credential: 'secret://dpm/sms-brandname', webhook: 'secret://dpm/sms-brandname-webhook' },
  { channel: 'ZALO_OA', externalId: '4417283569104700001', name: 'Zalo OA Ban Quản lý dự án đầu tư', credential: 'secret://dpm/zalo-oa', webhook: 'secret://dpm/zalo-oa-webhook', autoReply: 'Cảm ơn quý đơn vị, Ban Quản lý dự án sẽ phản hồi sớm nhất.' },
  { channel: 'EMAIL', externalId: 'phanhoi.cu@dpm.com.vn', name: 'Hộp thư phản hồi cũ (đã ngừng dùng)', credential: 'secret://dpm/mail-cu', webhook: WEBHOOK_REF, disable: 'Hộp thư được thay bằng hộp thư tiếp nhận dùng chung của Ban Quản lý dự án' },
];

async function connectAccounts(ctx: SeedContext): Promise<void> {
  let verifierAnswers = true;
  for (const spec of ACCOUNTS) {
    const existing = await ctx.find(MAKER, '/resources/channel_account', (row) => row.external_account_id === spec.externalId);
    if (existing !== undefined) continue;
    const connected = await ctx.command(MAKER, '/channel-accounts', { channel: spec.channel, external_account_id: spec.externalId, display_name: spec.name, credential_secret_ref: spec.credential, webhook_secret_ref: spec.webhook });
    await ctx.command(MAKER, `/channel-accounts/${connected.resource_id}/verify`, { reason: 'Xác minh tài khoản kênh với nhà cung cấp trước khi đưa vào sử dụng' }, { version: connected });
    const active = !verifierAnswers ? undefined : await waitFor(async () => {
      const row = await ctx.get<Obj>(MAKER, `/resources/channel_account/${connected.resource_id}`);
      return row.status === 'Active' ? row : undefined;
    });
    if (active === undefined) {
      verifierAnswers = false;
      ctx.warn(`the channel account ${spec.externalId} did not become Active (channel verification consumer missing?)`);
      continue;
    }
    if (spec.autoReply !== undefined) await ctx.attempt(MAKER, 'PUT', `/channel-accounts/${connected.resource_id}`, { auto_reply_text: spec.autoReply, reason: 'Câu trả lời tự động ngoài giờ làm việc' }, { version: versionOf(active) });
    if (spec.disable !== undefined) {
      const fresh = await ctx.get<Obj>(MAKER, `/resources/channel_account/${connected.resource_id}`);
      await ctx.command(MAKER, `/channel-accounts/${connected.resource_id}/disable`, { reason: spec.disable }, { version: versionOf(fresh) });
    }
  }
}

async function publishRouting(ctx: SeedContext): Promise<void> {
  const existing = await ctx.find(MAKER, '/conversation-routing-policies', (row) => row.status === 'Published' || row.status === 'PUBLISHED');
  if (existing !== undefined) return;
  const calendars = await ctx.attempt<{ items?: Obj[] }>(MAKER, 'GET', '/resources/work_calendar_version', undefined, { query: { limit: 50 } });
  const published = (calendars.json.items ?? []).find((row) => row.status === 'Published' || row.status === 'PUBLISHED') ?? (calendars.json.items ?? [])[0];
  const draft = await ctx.command(MAKER, '/conversation-routing-policies', {
    rules: [
      { channels: ['EMAIL', 'ZALO_OA'], keywords: ['thanh toán', 'tạm ứng', 'quyết toán', 'hóa đơn'], queue_unit_id: ctx.unitId('CB-STC'), priority: 'NORMAL' },
      { channels: ['EMAIL', 'ZALO_OA'], keywords: ['tiến độ', 'công trường', 'an toàn', 'nghiệm thu'], queue_unit_id: ctx.unitId('CB-SKHDT-QLDA'), priority: 'HIGH' },
      { queue_unit_id: ctx.unitId('CB-SKHDT-VP'), priority: 'LOW' },
    ],
    calendar_code: String(published?.calendar_code ?? 'VN-HANH-CHINH'),
    first_response_minutes: 240,
    resolution_hours: 72,
  });
  await ctx.command(MAKER, `/conversation-routing-policies/${draft.resource_id}/publish`, { reason: 'Chuyển câu hỏi về thanh toán cho phòng Tài chính, về tiến độ và an toàn công trường cho Ban Quản lý dự án' }, { version: draft });
}

const CANNED = [
  { code: 'dn-da-tiep-nhan', title: 'Đã tiếp nhận đề nghị', body: 'Ban Quản lý dự án đã tiếp nhận đề nghị của quý đơn vị và giao cán bộ phụ trách xử lý. Kết quả sẽ được phản hồi trong thời hạn quy định.', channels: ['EMAIL', 'ZALO_OA'] },
  { code: 'dn-bo-sung-ho-so', title: 'Đề nghị bổ sung hồ sơ', body: 'Đề nghị quý đơn vị bổ sung các hồ sơ còn thiếu theo danh mục đã gửi để Ban Quản lý dự án tiếp tục xử lý.', channels: ['EMAIL'] },
  { code: 'dn-tien-do-thanh-toan', title: 'Tiến độ xử lý hồ sơ thanh toán', body: 'Hồ sơ đề nghị thanh toán của quý đơn vị đang được phòng Tài chính - Kế toán kiểm tra. Dự kiến hoàn tất trong 5 ngày làm việc kể từ khi đủ hồ sơ.', channels: ['EMAIL', 'ZALO_OA', 'SMS'] },
  { code: 'dn-lien-he-dau-moi', title: 'Thông tin đầu mối liên hệ', body: 'Đầu mối liên hệ của Ban Quản lý dự án về nội dung này là cán bộ phụ trách hợp đồng. Vui lòng liên hệ qua thư điện tử công vụ để được hỗ trợ nhanh nhất.', channels: ['EMAIL', 'SMS', 'ZALO_OA'] },
];

async function cannedReplies(ctx: SeedContext): Promise<void> {
  for (const reply of CANNED) {
    const existing = await ctx.find(MAKER, '/canned-replies', (row) => row.code === reply.code);
    if (existing !== undefined) continue;
    await ctx.command(MAKER, '/canned-replies', { code: reply.code, title: reply.title, body_text: reply.body, channels: reply.channels, classification: 'PUBLIC' });
  }
}

interface ContactSpec {
  name: string;
  classification: 'CONTRACTOR_STAFF' | 'AGENCY_STAFF' | 'CITIZEN';
  identities: Array<{ channel: 'PHONE' | 'EMAIL' | 'ZALO'; value: string; verify?: string }>;
  consents?: Array<{ channel: 'EMAIL' | 'SMS' | 'ZALO'; purpose: 'OPERATIONAL' | 'REMINDER' | 'ANNOUNCEMENT' | 'SUPPORT_CONVERSATION'; withdraw?: string }>;
}

const CONTACTS: ContactSpec[] = [
  { name: 'Nguyễn Văn Thắng - Phụ trách hợp đồng, Nam Việt', classification: 'CONTRACTOR_STAFF', identities: [{ channel: 'EMAIL', value: 'thang.nv@namviet-xaydung.vn', verify: 'Giấy giới thiệu số 12/NV-2026' }, { channel: 'PHONE', value: '0912 345 118', verify: 'Giấy giới thiệu số 12/NV-2026' }], consents: [{ channel: 'EMAIL', purpose: 'OPERATIONAL' }, { channel: 'SMS', purpose: 'REMINDER' }] },
  { name: 'Trần Thị Hạnh - Kế toán trưởng nhà thầu', classification: 'CONTRACTOR_STAFF', identities: [{ channel: 'EMAIL', value: 'hanh.tt@namviet-xaydung.vn', verify: 'Giấy giới thiệu số 14/NV-2026' }, { channel: 'PHONE', value: '0912 777 305', verify: 'Giấy giới thiệu số 14/NV-2026' }], consents: [{ channel: 'EMAIL', purpose: 'SUPPORT_CONVERSATION' }, { channel: 'SMS', purpose: 'OPERATIONAL', withdraw: 'Chỉ nhận thông báo qua thư điện tử' }] },
  { name: 'Lê Minh Quân - Tư vấn giám sát', classification: 'CONTRACTOR_STAFF', identities: [{ channel: 'EMAIL', value: 'quan.lm@tuvangiamsat-hn.vn', verify: 'Hợp đồng tư vấn giám sát số 08/HĐ-TVGS' }, { channel: 'ZALO', value: 'quanlm_tvgs' }], consents: [{ channel: 'EMAIL', purpose: 'ANNOUNCEMENT' }] },
  { name: 'Phạm Quốc Bảo - Phòng Kế hoạch Tập đoàn', classification: 'AGENCY_STAFF', identities: [{ channel: 'EMAIL', value: 'bao.pq@tapdoan.example.vn', verify: 'Công văn giới thiệu đầu mối của Tập đoàn' }], consents: [{ channel: 'EMAIL', purpose: 'REMINDER' }, { channel: 'EMAIL', purpose: 'ANNOUNCEMENT', withdraw: 'Đầu mối đã chuyển công tác' }] },
  { name: 'Võ Thị Hương - Nhà cung cấp thiết bị', classification: 'CONTRACTOR_STAFF', identities: [{ channel: 'PHONE', value: '0966 120 874' }, { channel: 'EMAIL', value: 'huong.vt@thietbi-congnghiep.vn' }] },
];

async function makeContacts(ctx: SeedContext): Promise<void> {
  for (const spec of CONTACTS) {
    const existing = await ctx.find(MAKER, '/resources/contact', (row) => row.display_name === spec.name);
    if (existing !== undefined) continue;
    const created = await ctx.command(MAKER, '/contacts', { display_name: spec.name, classification: spec.classification });
    for (const identity of spec.identities) {
      const added = await ctx.command(MAKER, `/contacts/${created.resource_id}/identities`, { channel: identity.channel, external_id: identity.value });
      if (identity.verify !== undefined) await ctx.command(MAKER, `/contacts/${created.resource_id}/identities/${added.resource_id}/verify`, { method: 'ADMIN_DOCUMENT', document_ref: identity.verify }, { version: added });
    }
    for (const consent of spec.consents ?? []) {
      const given = await ctx.attempt(MAKER, 'POST', `/contacts/${created.resource_id}/consents`, { channel: consent.channel, purpose: consent.purpose, consent_text_version: 'v2026.1', capture_method: 'WEB_FORM', evidence_reference: `Biểu mẫu đồng ý nhận tin - ${spec.name}` });
      if (given.ok && consent.withdraw !== undefined) await ctx.attempt(MAKER, 'POST', `/contact-consents/${String(given.json.resource_id)}/withdraw`, { reason: consent.withdraw }, { version: given.json.resource_version as number });
    }
  }
}

interface Thread {
  key: string;
  from: string;
  name: string;
  daysAgo: number;
  hour: number;
  messages: string[];
  flow: 'NEW' | 'ASSIGNED' | 'ANSWERED' | 'RESOLVED' | 'NOTE' | 'ISSUE';
  assignee?: 'projectManager' | 'owner';
}

const THREADS: Thread[] = [
  { key: 't01', from: 'thang.nv@namviet-xaydung.vn', name: 'Nguyễn Văn Thắng', daysAgo: 9, hour: 8, flow: 'ANSWERED', assignee: 'projectManager', messages: ['Kính gửi Ban Quản lý dự án, nhà thầu Nam Việt đề nghị cho biết tiến độ xử lý hồ sơ thanh toán đợt 2 của hợp đồng HD-PMDT105-XL01 đã nộp ngày 28/10.'] },
  { key: 't02', from: 'hanh.tt@namviet-xaydung.vn', name: 'Trần Thị Hạnh', daysAgo: 8, hour: 9, flow: 'RESOLVED', assignee: 'owner', messages: ['Đề nghị hướng dẫn việc xuất hóa đơn cho khối lượng nghiệm thu giai đoạn 2, có cần ghi kèm số biên bản nghiệm thu hay không?'] },
  { key: 't03', from: 'quan.lm@tuvangiamsat-hn.vn', name: 'Lê Minh Quân', daysAgo: 7, hour: 14, flow: 'NOTE', assignee: 'projectManager', messages: ['Tư vấn giám sát báo cáo: công trường hạng mục móng bể chứa có nguy cơ chậm do thời tiết, đề nghị Ban xem xét điều chỉnh biện pháp thi công và an toàn.'] },
  { key: 't04', from: 'bao.pq@tapdoan.example.vn', name: 'Phạm Quốc Bảo', daysAgo: 6, hour: 7, flow: 'ISSUE', assignee: 'projectManager', messages: ['Phòng Kế hoạch Tập đoàn đề nghị Công ty rà soát số liệu giải ngân tháng 10 của dự án DA-PMDT105 trước khi tổng hợp báo cáo giám sát.', 'Bổ sung: đề nghị phản hồi trước ngày 12/11.'] },
  { key: 't05', from: 'huong.vt@thietbi-congnghiep.vn', name: 'Võ Thị Hương', daysAgo: 5, hour: 10, flow: 'ASSIGNED', assignee: 'projectManager', messages: ['Nhà cung cấp thiết bị đề nghị gia hạn thời gian giao hàng 15 ngày do chậm thông quan, kèm bộ chứng từ vận chuyển.'] },
  { key: 't06', from: 'thang.nv@namviet-xaydung.vn', name: 'Nguyễn Văn Thắng', daysAgo: 4, hour: 15, flow: 'NEW', messages: ['Đề nghị gia hạn bảo lãnh thực hiện hợp đồng thêm 90 ngày theo phụ lục tiến độ đã thống nhất, xin hướng dẫn thủ tục.'] },
  { key: 't07', from: 'hanh.tt@namviet-xaydung.vn', name: 'Trần Thị Hạnh', daysAgo: 3, hour: 9, flow: 'ASSIGNED', assignee: 'owner', messages: ['Kế toán nhà thầu hỏi về thời hạn thu hồi tạm ứng của hợp đồng, đề nghị cung cấp bảng đối chiếu số dư.'] },
  { key: 't08', from: 'quan.lm@tuvangiamsat-hn.vn', name: 'Lê Minh Quân', daysAgo: 2, hour: 16, flow: 'RESOLVED', assignee: 'projectManager', messages: ['Tư vấn giám sát xin xác nhận lịch nghiệm thu hoàn thành hạng mục kết cấu ngày 14/11.'] },
  { key: 't09', from: 'bao.pq@tapdoan.example.vn', name: 'Phạm Quốc Bảo', daysAgo: 1, hour: 8, flow: 'NEW', messages: ['Đề nghị Công ty gửi báo cáo nhanh tuần 45 trước 16 giờ thứ Sáu để Phòng Kế hoạch tổng hợp.'] },
  { key: 't10', from: 'huong.vt@thietbi-congnghiep.vn', name: 'Võ Thị Hương', daysAgo: 0, hour: 7, flow: 'NEW', messages: ['Xin thông tin đầu mối nhận hàng tại kho công trường để phối hợp lịch giao thiết bị tuần sau.'] },
];

function webhookSecret(): string {
  const info = JSON.parse(readFileSync(STACK_INFO_PATH, 'utf8')) as { provider?: { webhookSecret?: string } };
  const secret = info.provider?.webhookSecret;
  if (secret === undefined) throw new Error('the stack info has no provider.webhookSecret');
  return secret;
}

async function providerCall(ctx: SeedContext, body: Obj): Promise<{ status: number; json: Obj }> {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', webhookSecret()).update(`${timestamp}.${raw}`).digest('hex');
  const response = await fetch(`http://127.0.0.1:${ctx.info.apiPort}/webhooks/channels/${PROVIDER}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-timestamp': String(timestamp), 'x-signature': signature },
    body: raw,
  });
  const text = await response.text();
  let json: Obj = {};
  try {
    json = text === '' ? {} : (JSON.parse(text) as Obj);
  } catch {
    json = {};
  }
  return { status: response.status, json };
}

function instant(ctx: SeedContext, daysAgo: number, hour: number, offsetMinutes = 0): Date {
  const [y, m, d] = ctx.day(-daysAgo).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour - 7, offsetMinutes));
}

const MARK = 'ent-omni';

/** The messages are the same ids on every run (the provider id is the idempotency key), so a second run changes nothing. */
async function receiveMessages(ctx: SeedContext): Promise<void> {
  const mail = await ctx.find(MAKER, '/resources/channel_account', (row) => row.external_account_id === MAIL.externalId);
  if (mail === undefined || mail.status !== 'Active') {
    ctx.warn('the e-mail account is not Active: no conversation can be received');
    return;
  }
  for (const thread of THREADS) {
    for (const [index, text] of thread.messages.entries()) {
      const reply = await providerCall(ctx, {
        id: `${MARK}-${thread.key}-in-${index}`,
        account: MAIL.externalId,
        type: 'message.inbound',
        at: instant(ctx, thread.daysAgo, thread.hour, index * 190).toISOString(),
        inbound: { message: `${MARK}-${thread.key}-m${index}`, thread: `${MARK}-thread-${thread.key}`, from: thread.from, name: thread.name, text },
      });
      if (reply.status !== 200) ctx.warn(`webhook answered HTTP ${reply.status} for ${thread.key}`);
    }
  }
  await providerCall(ctx, { id: `${MARK}-receipt-orphan-1`, account: MAIL.externalId, message: 'smtp-relay-msg-unknown-7781', status: 'DELIVERED', type: 'delivery.status', at: instant(ctx, 1, 9).toISOString() });
}

async function conversationOf(ctx: SeedContext, thread: Thread): Promise<Obj | undefined> {
  const all = await ctx.list(MAKER, '/resources/conversation');
  for (const conversation of all) {
    const messages = await ctx.list(MAKER, '/resources/channel_message', { conversation_id: String(conversation.id) });
    if (messages.some((message) => String(message.text ?? '').startsWith(thread.messages[0]!.slice(0, 40)))) return conversation;
  }
  return undefined;
}

const freshVersion = async (ctx: SeedContext, id: string): Promise<number> => versionOf(await ctx.get<Obj>(MAKER, `/resources/conversation/${id}`));

async function agentsWork(ctx: SeedContext): Promise<void> {
  const mail = await ctx.find(MAKER, '/resources/channel_account', (row) => row.external_account_id === MAIL.externalId);
  if (mail === undefined || mail.status !== 'Active') return;
  const projects = await ctx.list(MAKER, '/resources/project');
  const project = projects.find((row) => String(row.code ?? '') === 'DA-PMDT105') ?? projects[0];
  for (const thread of THREADS) {
    if (thread.flow === 'NEW') continue;
    const conversation = await conversationOf(ctx, thread);
    if (conversation === undefined) continue;
    const id = String(conversation.id);
    if (conversation.assignee_membership_id === null || conversation.assignee_membership_id === undefined) {
      if (thread.assignee !== undefined) await ctx.attempt(MAKER, 'POST', `/conversations/${id}/assign`, { assignee_membership_id: ctx.person(thread.assignee).membershipId, reason: 'Phân công theo phạm vi phụ trách hợp đồng' }, { version: await freshVersion(ctx, id) });
    } else continue;
    if (thread.flow === 'ASSIGNED') continue;
    if (thread.flow === 'NOTE' || thread.flow === 'ISSUE') {
      await ctx.attempt(MAKER, 'POST', `/conversations/${id}/messages`, { kind: 'INTERNAL_NOTE', channel_account_id: String(mail.id), text: thread.flow === 'NOTE' ? 'Đã trao đổi với chỉ huy trưởng công trường, sẽ cập nhật biện pháp thi công trong buổi giao ban thứ Sáu.' : 'Đối chiếu số liệu giải ngân tháng 10 với bảng kê Kho bạc và phòng Tài chính trước khi phản hồi Tập đoàn.' }, { version: await freshVersion(ctx, id) });
    }
    if (thread.flow === 'ISSUE' && project !== undefined) {
      await ctx.attempt(MAKER, 'POST', `/conversations/${id}/links`, { resource_type: 'project', resource_id: String(project.id) }, { version: await freshVersion(ctx, id) });
      const options = await ctx.attempt<{ issue_types?: string[] }>(MAKER, 'GET', '/conversation-conversion-options');
      await ctx.attempt(MAKER, 'POST', `/conversations/${id}/issues`, { project_id: String(project.id), issue_type: String((options.json.issue_types ?? [])[0] ?? 'SCHEDULE'), summary: 'Rà soát số liệu giải ngân tháng 10 theo đề nghị của Phòng Kế hoạch Tập đoàn', due_date: ctx.day(2) }, { version: await freshVersion(ctx, id) });
    }
    if (thread.flow === 'ANSWERED' || thread.flow === 'RESOLVED') {
      const contactId = String(conversation.contact_id);
      const contact = await ctx.get<Obj>(MAKER, `/resources/contact/${contactId}`);
      const email = ((contact.identities as Obj[] | undefined) ?? []).find((identity) => identity.channel === 'EMAIL');
      if (email !== undefined && email.status !== 'Verified') await ctx.attempt(MAKER, 'POST', `/contacts/${contactId}/identities/${String(email.id)}/verify`, { method: 'ADMIN_DOCUMENT', document_ref: `Xác minh qua hợp đồng ${thread.key}` }, { version: versionOf(email) });
      await ctx.attempt(MAKER, 'POST', `/contacts/${contactId}/consents`, { channel: 'EMAIL', purpose: 'SUPPORT_CONVERSATION', consent_text_version: 'v2026.1', capture_method: 'CHANNEL_OPT_IN', evidence_reference: `Thư điện tử của ${thread.name} ngày ${ctx.day(-thread.daysAgo)}` });
      await ctx.attempt(MAKER, 'POST', `/conversations/${id}/messages`, { kind: 'EXTERNAL', channel_account_id: String(mail.id), purpose: 'SUPPORT_CONVERSATION', text: 'Ban Quản lý dự án đã tiếp nhận nội dung và đang xử lý, phòng Tài chính - Kế toán sẽ phản hồi chi tiết trong 5 ngày làm việc.' }, { version: await freshVersion(ctx, id) });
    }
    if (thread.flow === 'RESOLVED') await ctx.attempt(MAKER, 'POST', `/conversations/${id}/resolve`, { reason: 'Đã trả lời và nhà thầu xác nhận không cần hỗ trợ thêm' }, { version: await freshVersion(ctx, id) });
  }
}

async function seedOmni(ctx: SeedContext): Promise<void> {
  await part(ctx, 'OMNI', 'channel accounts (OMNI-05, OMNI-06)', () => connectAccounts(ctx));
  await part(ctx, 'OMNI', 'routing policy and SLA (OMNI-07)', () => publishRouting(ctx));
  await part(ctx, 'OMNI', 'canned replies (OMNI-08)', () => cannedReplies(ctx));
  await part(ctx, 'OMNI', 'contacts, identities, consents (OMNI-03, OMNI-04)', () => makeContacts(ctx));
  await part(ctx, 'OMNI', 'messages from the provider webhook (OMNI-01, OMNI-11)', () => receiveMessages(ctx));
  await part(ctx, 'OMNI', 'agents assign, answer, link, convert, resolve (OMNI-02, OMNI-09)', () => agentsWork(ctx));
}

// ---- MNE: forms, filing calendar of the Group, reports -----------------------------------------------------------------------------------

const MNE_BASIS = 'Quy chế quản lý đầu tư xây dựng của Tập đoàn Dầu khí Việt Nam (PVN) và Quy chế giám sát đầu tư của Công ty';
const SNAPSHOT_FIELDS = [
  { key: 'plan_total_vnd', label: 'Tổng kế hoạch vốn (đồng)', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
  { key: 'project_count', label: 'Số dự án đang theo dõi', kind: 'INTEGER', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'project_count' } },
];

interface FormSpec {
  code: string;
  title: string;
  kind: string;
  template: string;
  fields: Obj[];
}

const FORMS: FormSpec[] = [
  {
    code: 'DN-BC-06T', title: 'Báo cáo giám sát đầu tư xây dựng tổng thể 6 tháng gửi Tập đoàn', kind: 'OVERALL_SEMIANNUAL', template: 'MNE-TT44-M02',
    fields: [...SNAPSHOT_FIELDS, { key: 'danh_gia', label: 'Đánh giá chung tình hình thực hiện kế hoạch đầu tư', kind: 'TEXT', required: true }, { key: 'kien_nghi', label: 'Kiến nghị với Tập đoàn', kind: 'TEXT', required: false }],
  },
  {
    code: 'DN-BC-NAM', title: 'Báo cáo giám sát đầu tư xây dựng tổng thể năm gửi Tập đoàn', kind: 'OVERALL_ANNUAL', template: 'MNE-TT44-M03',
    fields: [...SNAPSHOT_FIELDS, { key: 'danh_gia', label: 'Đánh giá chung kết quả thực hiện kế hoạch đầu tư năm', kind: 'TEXT', required: true }, { key: 'kien_nghi', label: 'Kiến nghị với Tập đoàn', kind: 'TEXT', required: false }],
  },
  {
    code: 'DN-BC-DA', title: 'Báo cáo giám sát dự án định kỳ', kind: 'PROJECT_PERIODIC', template: 'MNE-TT44-M06',
    fields: [...SNAPSHOT_FIELDS, { key: 'tien_do', label: 'Tình hình thực hiện tiến độ dự án', kind: 'TEXT', required: true }, { key: 'vuong_mac', label: 'Khó khăn, vướng mắc và đề xuất', kind: 'TEXT', required: false }],
  },
  {
    code: 'CV3665-WEEKLY', title: 'Báo cáo nhanh tuần về giải ngân vốn đầu tư gửi Tập đoàn', kind: 'WEEKLY_QUICK', template: 'MNE-CV3665-WEEKLY',
    fields: [
      { key: 'rate_pm_pct', label: 'Tỷ lệ giải ngân so với vốn đã giao cho ban quản lý dự án (%)', kind: 'PERCENT', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_pm_pct' } },
      { key: 'rate_total_pct', label: 'Tỷ lệ giải ngân so với tổng kế hoạch vốn (%)', kind: 'PERCENT', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'rate_total_pct' } },
      { key: 'plan_total_vnd', label: 'Tổng kế hoạch vốn (đồng)', kind: 'MONEY', required: true, source: { kind: 'SNAPSHOT_METRIC', metric: 'plan_total_vnd' } },
      { key: 'disbursed_treasury_vnd', label: 'Giải ngân lũy kế (đồng)', kind: 'MONEY', required: false, source: { kind: 'SNAPSHOT_METRIC', metric: 'disbursed_treasury_vnd' } },
      { key: 'slow_projects', label: 'Dự án chậm giải ngân và lãnh đạo phụ trách', kind: 'TEXT', required: true, source: { kind: 'SLOW_PROJECTS', limit: 5 } },
      { key: 'proposals', label: 'Kiến nghị', kind: 'TEXT', required: false },
    ],
  },
];

/** `from` is how the rule starts: a day count back from the seed day (negative) or a month and day of the year. The weekly rule starts a few weeks back so the calendar does not open on a year of empty past weeks. */
const RULES: Array<{ code: string; form: string; frequency: 'WEEKLY' | 'SEMIANNUAL' | 'ANNUAL'; due: Obj; basis: string; from: { daysBack: number } | { month: number; day: number } }> = [
  { code: 'DN_BC_6T', from: { month: 7, day: 1 }, form: 'DN-BC-06T', frequency: 'SEMIANNUAL', due: { period: 'H1', month: 7, day: 10 }, basis: `${MNE_BASIS}: báo cáo 6 tháng trước ngày 10 tháng 7` },
  { code: 'DN_BC_NAM', from: { month: 1, day: 1 }, form: 'DN-BC-NAM', frequency: 'ANNUAL', due: { period: 'YEAR', month: 2, day: 10, year_offset: 1 }, basis: `${MNE_BASIS}: báo cáo năm trước ngày 10 tháng 2 năm sau` },
  { code: 'DN_BC_NHANH_TUAN', from: { daysBack: 28 }, form: 'CV3665-WEEKLY', frequency: 'WEEKLY', due: { weekly: 'FRI', time: '16:00' }, basis: `${MNE_BASIS}: báo cáo nhanh hằng tuần vào thứ Sáu` },
];

async function formByCode(ctx: SeedContext, code: string): Promise<Obj | undefined> {
  const forms = await ctx.list<Obj>(OWNER, '/mne-forms');
  return forms.filter((row) => row.form_code === code).sort((a, b) => Number(b.revision) - Number(a.revision))[0];
}

/** Tries each person in turn: the first that the rules of the product allow. */
async function asAny(ctx: SeedContext, people: string[], path: string, body: unknown, version?: Obj | number): Promise<{ ok: boolean; json: Obj }> {
  for (const person of people) {
    const reply = await ctx.call<Obj>(person, 'POST', path, body, version === undefined ? {} : { version: version as never });
    if (reply.ok) return { ok: true, json: reply.json };
    if (reply.status >= 500) ctx.expectOk(reply);
    if (person === people[people.length - 1]) ctx.warn(`POST ${path} -> HTTP ${reply.status} ${reply.text.slice(0, 260)}`);
  }
  return { ok: false, json: {} };
}

async function mneForms(ctx: SeedContext): Promise<void> {
  for (const spec of FORMS) {
    let form = await formByCode(ctx, spec.code);
    if (form === undefined) {
      const made = await asAny(ctx, [OWNER, MAKER], '/mne-forms', {
        form_code: spec.code,
        title: spec.title,
        report_kind: spec.kind,
        legal_basis: MNE_BASIS,
        legal_confirmation_ref: 'QĐ-ĐTXD-2026-118 của Tổng giám đốc',
        effective_from: `${ctx.day(0).slice(0, 4)}-01-01`,
        schema_json: { fields: spec.fields },
        doc_template_code: spec.template,
        export_formats: ['XLSX', 'PDF'],
      });
      if (!made.ok) continue;
      form = await formByCode(ctx, spec.code);
    }
    if (form !== undefined && String(form.status ?? '') !== 'PUBLISHED' && String(form.status ?? '') !== 'Published' && form.published_at === undefined) {
      await asAny(ctx, [CHECKER, OWNER], `/mne-forms/${String(form.id)}/publish`, {}, versionOf(form));
    }
  }
}

async function mneRules(ctx: SeedContext): Promise<void> {
  const existing = await ctx.list<Obj>(OWNER, '/mne-obligation-rules');
  for (const spec of RULES) {
    if (existing.some((row) => row.rule_code === spec.code)) continue;
    const form = await formByCode(ctx, spec.form);
    if (form === undefined) continue;
    const made = await asAny(ctx, [OWNER, MAKER], '/mne-obligation-rules', {
      rule_code: spec.code,
      form_id: String(form.id),
      reporting_role: 'INVESTOR',
      recipient: 'Phòng Kế hoạch - Đầu tư, Tập đoàn Dầu khí Việt Nam (PVN)',
      frequency: spec.frequency,
      due_rule_json: spec.due,
      legal_basis: spec.basis,
      legal_confirmation_ref: 'QĐ-ĐTXD-2026-118 của Tổng giám đốc',
      effective_from: 'daysBack' in spec.from ? ctx.day(-spec.from.daysBack) : `${ctx.day(0).slice(0, 4)}-${String(spec.from.month).padStart(2, '0')}-${String(spec.from.day).padStart(2, '0')}`,
    });
    if (!made.ok) continue;
  }
  const rules = await ctx.list<Obj>(OWNER, '/mne-obligation-rules');
  for (const rule of rules.filter((row) => RULES.some((spec) => spec.code === row.rule_code))) {
    if (String(rule.status ?? '').toUpperCase() === 'PUBLISHED' || rule.published_at !== undefined && rule.published_at !== null) continue;
    await asAny(ctx, [CHECKER, OWNER], `/mne-obligation-rules/${String(rule.id)}/publish`, {}, versionOf(rule));
  }
}

async function mneObligations(ctx: SeedContext): Promise<void> {
  const year = Number(ctx.day(0).slice(0, 4));
  const have = await ctx.list<Obj>(OWNER, '/mne-obligations', { report_year: year });
  const rules = (await ctx.list<Obj>(OWNER, '/mne-obligation-rules')).filter((row) => RULES.some((spec) => spec.code === row.rule_code));
  if (have.some((row) => rules.some((rule) => String(rule.id) === String(row.obligation_rule_id)))) return;
  await asAny(ctx, [OWNER, MAKER], '/mne-obligations/generate', { report_year: year });
}

/** The frozen snapshot that a report of the period can be built on: the latest PERIOD_CLOSE one of a day not after the end of the period. */
async function snapshotFor(ctx: SeedContext, periodEnd: string): Promise<string | undefined> {
  const snapshots = await ctx.list<Obj>(OWNER, '/period-snapshots');
  const usable = snapshots.filter((row) => row.status === 'FROZEN' && (row.snapshot_kind === 'PERIOD_CLOSE' || row.snapshot_kind === 'MNE') && String(row.as_of_date) <= periodEnd);
  usable.sort((a, b) => String(b.as_of_date).localeCompare(String(a.as_of_date)));
  return usable[0] === undefined ? undefined : String(usable[0].id);
}

async function reportRow(ctx: SeedContext, id: string): Promise<Obj> {
  return ctx.get<Obj>(OWNER, `/mne-reports/${id}`);
}

/** One report through preparation, hand-in and approval; stops quietly where the rules of the product stop it. Returns the status it reached. */
async function carryReport(ctx: SeedContext, id: string, snapshotId: string | undefined, narrative: Obj, until: 'DRAFT' | 'IN_REVIEW' | 'APPROVED'): Promise<string> {
  let row = await reportRow(ctx, id);
  if (String(row.status) !== 'DRAFT') return String(row.status);
  if (snapshotId !== undefined) {
    const edited = await asAny(ctx, [MAKER, OWNER], `/mne-reports/${id}/revisions`, { snapshot_id: snapshotId, narrative }, versionOf(row));
    if (!edited.ok) return 'DRAFT';
    row = await reportRow(ctx, id);
  }
  if (until === 'DRAFT') return String(row.status);
  const submitted = await asAny(ctx, [MAKER, OWNER], `/mne-reports/${id}/submit`, {}, versionOf(row));
  if (!submitted.ok) return String(row.status);
  row = await reportRow(ctx, id);
  if (until === 'IN_REVIEW') return String(row.status);
  await asAny(ctx, [CHECKER], `/mne-reports/${id}/decision`, { decision: 'approve', reason: 'Số liệu khớp với kỳ chốt, đủ điều kiện phát hành gửi Tập đoàn' }, versionOf(row));
  return String((await reportRow(ctx, id)).status);
}

async function mneReports(ctx: SeedContext): Promise<void> {
  const year = Number(ctx.day(0).slice(0, 4));
  const obligations = await ctx.list<Obj>(OWNER, '/mne-obligations', { report_year: year });
  const forms = await ctx.list<Obj>(OWNER, '/mne-forms');
  const codeOfForm = (formId: string): string => String(forms.find((row) => String(row.id) === formId)?.form_code ?? '');
  const today = ctx.day(0);
  const dated = obligations.filter((row) => row.mne_report_id !== null && row.mne_report_id !== undefined);
  const weekly = dated.filter((row) => String(row.form_code) === 'CV3665-WEEKLY' && String(row.due_date) <= today).sort((a, b) => String(b.due_date).localeCompare(String(a.due_date)));
  const annual = dated.filter((row) => String(row.form_code) === 'DN-BC-NAM');
  const semi = dated.filter((row) => String(row.form_code) === 'DN-BC-06T');
  void codeOfForm;
  // The latest due weekly flash is approved, the one before it waits for review, the one before that stays a draft.
  const plan: Array<{ row: Obj; until: 'DRAFT' | 'IN_REVIEW' | 'APPROVED'; narrative: Obj }> = [
    { row: weekly[0]!, until: 'APPROVED', narrative: { proposals: 'Đề nghị Tập đoàn thống nhất lịch chốt số liệu giải ngân tháng 11 vào ngày 28/11.' } },
    { row: weekly[1]!, until: 'IN_REVIEW', narrative: { proposals: 'Không có kiến nghị.' } },
    ...weekly.slice(2, 8).map((row) => ({ row, until: 'APPROVED' as const, narrative: { proposals: 'Không có kiến nghị.' } })),
    { row: annual[0]!, until: 'IN_REVIEW', narrative: { danh_gia: 'Kế hoạch đầu tư xây dựng năm 2026 đạt tiến độ giải ngân theo kế hoạch, các dự án trọng điểm thực hiện đúng cam kết hợp đồng; một số hạng mục thiết bị chậm do thông quan.', kien_nghi: 'Đề nghị Tập đoàn xem xét điều chuyển vốn giữa các dự án trong cùng nhóm khi có hạng mục chậm.' } },
    { row: semi[0]!, until: 'DRAFT', narrative: { danh_gia: 'Báo cáo 6 tháng đầu năm đang được tổng hợp từ các báo cáo của ban quản lý dự án.' } },
  ];
  for (const item of plan) {
    if (item.row === undefined) continue;
    const id = String(item.row.mne_report_id);
    const period = String(item.row.period_end ?? item.row.due_date ?? today);
    const snapshot = await snapshotFor(ctx, period.length === 10 ? period : today);
    const status = await carryReport(ctx, id, snapshot, item.narrative, item.until);
    ctx.record({ module: 'MNE', screen: 'MNE-03', kind: 'mne-report', id, code: String(item.row.form_code), note: `${String(item.row.due_date)} ${status}` });
  }
}

async function mneProjectReports(ctx: SeedContext): Promise<void> {
  const year = Number(ctx.day(0).slice(0, 4));
  const form = await formByCode(ctx, 'DN-BC-DA');
  if (form === undefined) return;
  const projects = (await ctx.list<Obj>(OWNER, '/resources/project')).filter((row) => /^DA-/u.test(String(row.code))).slice(0, 4);
  const existing = await ctx.list<Obj>(OWNER, '/mne-reports', { report_year: year }).catch(() => [] as Obj[]);
  const snapshot = await snapshotFor(ctx, `${year}-12-31`);
  const stages: Array<'DRAFT' | 'IN_REVIEW' | 'APPROVED'> = ['APPROVED', 'IN_REVIEW', 'IN_REVIEW', 'DRAFT'];
  for (const [index, project] of projects.entries()) {
    if (existing.some((row) => row.project_id === project.id && String(row.form_code) === 'DN-BC-DA')) continue;
    const owner = String(project.owner_unit_id ?? project.unit_id ?? ctx.unitId('CB-SKHDT-QLDA'));
    const made = await asAny(ctx, [MAKER, OWNER], '/mne-reports', { form_id: String(form.id), report_year: year, period_label: `YEAR-${year}`, scope_unit_id: owner, project_id: String(project.id), ...(snapshot === undefined ? {} : { snapshot_id: snapshot }) });
    if (!made.ok) continue;
    const id = String(made.json.resource_id);
    const status = await carryReport(ctx, id, snapshot, { tien_do: `Dự án ${String(project.code)} thực hiện theo tiến độ đã duyệt; khối lượng nghiệm thu lũy kế đạt kế hoạch quý IV, không phát sinh điều chỉnh tổng mức đầu tư.`, vuong_mac: index === 1 ? 'Đề nghị phòng Tài chính rút ngắn thời gian xử lý hồ sơ thanh toán đợt cuối năm.' : 'Không có vướng mắc.' }, stages[index] ?? 'DRAFT');
    ctx.record({ module: 'MNE', screen: 'MNE-04', kind: 'mne-report', id, code: String(project.code), note: status });
  }
}

async function seedMne(ctx: SeedContext): Promise<void> {
  await part(ctx, 'MNE', 'monitoring forms (MNE-02)', () => mneForms(ctx));
  await part(ctx, 'MNE', 'obligation rules and filing calendar (MNE-01)', async () => {
    await mneRules(ctx);
    await mneObligations(ctx);
  });
  await part(ctx, 'MNE', 'overall and weekly reports through review (MNE-03, MNE-05, MNE-07)', () => mneReports(ctx));
  await part(ctx, 'MNE', 'project reports (MNE-04)', () => mneProjectReports(ctx));
}


// ---- INT: source systems and the mapping of project codes ----------------------------------------------------------------------------------

const SOURCE_SYSTEMS: Array<{ code: string; name: string; kind: string; prefix: string }> = [
  { code: 'SAP_ERP', name: 'Hệ thống ERP SAP của Công ty (phân hệ dự án và tài sản)', kind: 'ERP', prefix: 'WBS-DPM-' },
  { code: 'PMIS_PVN', name: 'Hệ thống quản lý đầu tư xây dựng của Tập đoàn', kind: 'PMIS', prefix: 'PVN-DT-' },
  { code: 'MISA_KT', name: 'Phần mềm kế toán tài chính của Công ty', kind: 'FINANCE', prefix: 'KT-DA-' },
];

async function seedInt(ctx: SeedContext): Promise<void> {
  const known = await ctx.attempt<{ items?: Obj[] }>(OWNER, 'GET', '/int/source-systems');
  const have = new Set((known.json.items ?? []).map((row) => String(row.code)));
  for (const system of SOURCE_SYSTEMS) {
    if (have.has(system.code)) continue;
    await ctx.attempt(OWNER, 'POST', '/int/source-systems', { code: system.code, name: system.name, kind: system.kind });
  }
  const projects = (await ctx.list<Obj>(OWNER, '/resources/project')).filter((row) => /^DA-/u.test(String(row.code))).sort((a, b) => String(a.code).localeCompare(String(b.code))).slice(0, 6);
  const mapped = await ctx.attempt<{ items?: Obj[] }>(OWNER, 'GET', '/int/project-codes', undefined, { query: { limit: 200 } });
  const rows = mapped.json.items ?? [];
  for (const [index, project] of projects.entries()) {
    for (const system of SOURCE_SYSTEMS) {
      if (system.code === 'MISA_KT' && index % 2 === 1) continue;
      const externalCode = `${system.prefix}${String(project.code).replace(/^DA-/u, '')}`;
      if (rows.some((row) => row.source_system === system.code && row.external_code === externalCode)) continue;
      const proposed = await asAny(ctx, [MAKER, OWNER], '/int/project-codes', { source_system: system.code, our_code: String(project.code), external_code: externalCode, valid_from: `${ctx.day(0).slice(0, 4)}-01-01`, reason: 'Đối chiếu mã dự án giữa hệ thống quản lý đầu tư và hệ thống nguồn để hợp nhất báo cáo' });
      // The last of each system waits for the decision; the others are approved by the leader.
      if (!proposed.ok || index === projects.length - 1) continue;
      const id = String(proposed.json.id ?? proposed.json.resource_id ?? '');
      if (id !== '') await asAny(ctx, [CHECKER, OWNER], `/int/project-codes/${id}/decision`, { decision: 'APPROVE', reason: 'Mã nguồn khớp hồ sơ dự án và quyết định đầu tư' }, versionOf(proposed.json));
    }
  }
}


// ---- HUB: integration incidents ------------------------------------------------------------------------------------------------------------

async function seedHub(ctx: SeedContext): Promise<void> {
  const existing = await ctx.attempt<{ items?: Obj[] }>(OWNER, 'GET', '/integration-hub/incidents', undefined, { query: { limit: 100 } });
  if ((existing.json.items ?? []).length > 0) return;
  const connectors = await ctx.attempt<{ items?: Obj[] }>(OWNER, 'GET', '/integration-hub/connectors');
  const live = (connectors.json.items ?? []).filter((row) => row.enabled === true && String(row.status) !== 'PENDING_EXTERNAL');
  const list = live.length > 0 ? live : (connectors.json.items ?? []);
  const texts: Array<{ summary: string; severity: 'URGENT' | 'ACTION' | 'WATCH'; end: 'OPEN' | 'ACKNOWLEDGE' | 'RESOLVE' }> = [
    { summary: 'Tệp sao kê ngày làm việc gần nhất đến chậm hơn 3 giờ so với lịch, đã báo đơn vị cung cấp dữ liệu', severity: 'ACTION', end: 'ACKNOWLEDGE' },
    { summary: 'Số dòng của lần nạp tuần trước lệch 12 dòng so với tệp gốc, đã nạp lại và đối chiếu khớp', severity: 'WATCH', end: 'RESOLVE' },
    { summary: 'Hai mã dự án trong tệp nguồn chưa có ánh xạ sang mã dự án của Công ty, các dòng bị giữ lại chờ duyệt', severity: 'URGENT', end: 'OPEN' },
  ];
  for (const [index, text] of texts.entries()) {
    const connector = list[index % Math.max(1, list.length)];
    if (connector === undefined) return;
    const opened = await asAny(ctx, [OWNER, MAKER], '/integration-hub/incidents', { connector_code: String(connector.code), summary: text.summary, severity: text.severity });
    if (!opened.ok || text.end === 'OPEN') continue;
    const id = String(opened.json.resource_id);
    let version = versionOf(opened.json);
    const ack = await asAny(ctx, [OWNER, CHECKER], `/integration-hub/incidents/${id}/decision`, { decision: 'ACKNOWLEDGE', reason: 'Đã tiếp nhận và giao cán bộ phụ trách tích hợp kiểm tra' }, version);
    if (text.end === 'RESOLVE' && ack.ok) {
      version = versionOf(ack.json);
      await asAny(ctx, [OWNER, CHECKER], `/integration-hub/incidents/${id}/decision`, { decision: 'RESOLVE', reason: 'Đã nạp lại tệp và đối chiếu khớp số dòng' }, version);
    }
  }
}

// ---- the group ---------------------------------------------------------------------------------------------------------------------------

export async function seedClipEnterprisePlatform(ctx: SeedContext): Promise<void> {
  await seedNot(ctx);
  await seedOmni(ctx);
  await seedMne(ctx);
  await part(ctx, 'INT', 'source systems and project code mapping (INT-03)', () => seedInt(ctx));
  await part(ctx, 'HUB', 'integration incidents (HUB-03)', () => seedHub(ctx));
  await seedNotLate(ctx);
}
