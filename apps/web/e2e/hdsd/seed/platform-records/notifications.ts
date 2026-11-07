import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { grantMemberRoles } from './iam.ts';
import { at, made, once } from './shared.ts';

/**
 * NOT for the guide. The story: the provincial Department of Planning and Investment tells its people what needs their hand. Two phases:
 *
 *  - `seedNotificationSetup` runs FIRST of the groups: the templates of the messages (written by the project board, approved by the leader), and a
 *    published workflow for every event type of the catalogue, so that the events the other groups' commands and the jobs raise (an issue
 *    escalated, a guarantee about to expire, a letter overdue...) become notifications in the inbox of the right people, with no help from the seed.
 *  - `seedNotificationActivity` runs LATE: the people give their consent and choose how they are reached, the leader approves the broadcasts of the
 *    project board (a campaign sent, one waiting, one scheduled, one refused, one cancelled), the devices are on NOT-14, and what has arrived in the
 *    inboxes is read and acknowledged the way people do, a part of it only.
 */

const MAKER = 'projectManager';
const CHECKER = 'capApprover';
const OWNER = 'owner';

interface TemplateSpec {
  code: string;
  channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH_FCM' | 'ZALO_ZNS';
  purpose: 'OPERATIONAL' | 'REMINDER' | 'ANNOUNCEMENT';
  subject?: string;
  body: string;
  variables: Record<string, 'string' | 'integer'>;
  lockscreenSafe?: boolean;
  /** What becomes of it: approved (Active), left in review, refused, or left as a draft. */
  end: 'APPROVE' | 'REJECT' | 'DRAFT' | 'REVIEW';
  reason: string;
}

const TEMPLATES: TemplateSpec[] = [
  {
    code: 'thong-bao-viec-can-xu-ly',
    channel: 'IN_APP',
    purpose: 'OPERATIONAL',
    body: 'Có việc cần xử lý: {{doi_tuong}} thuộc {{don_vi}}. Hạn xử lý: {{han_xu_ly}}. Đề nghị xem chi tiết và xử lý đúng hạn.',
    variables: { doi_tuong: 'string', don_vi: 'string', han_xu_ly: 'string' },
    end: 'APPROVE',
    reason: 'Mẫu thông báo trong hệ thống cho việc cần xử lý, đúng ngôn ngữ hành chính của Sở',
  },
  {
    code: 'nhac-han-bao-cao-tuan',
    channel: 'IN_APP',
    purpose: 'REMINDER',
    body: 'Báo cáo giải ngân tuần {{tuan}} của {{don_vi}} đến hạn nộp vào {{han_nop}}. Đề nghị hoàn thành đúng hạn theo Công văn 3665.',
    variables: { tuan: 'string', don_vi: 'string', han_nop: 'string' },
    end: 'APPROVE',
    reason: 'Nhắc hạn báo cáo giải ngân hằng tuần cho chủ đầu tư',
  },
  {
    code: 'nhac-han-bao-cao-tuan-email',
    channel: 'EMAIL',
    purpose: 'REMINDER',
    subject: 'Nhắc hạn nộp báo cáo giải ngân tuần {{tuan}}',
    body: 'Kính gửi {{don_vi}},\n\nBáo cáo giải ngân tuần {{tuan}} đến hạn nộp vào {{han_nop}}. Đề nghị đơn vị hoàn thành và gửi trên hệ thống đúng hạn.\n\nSở Kế hoạch và Đầu tư tỉnh Cao Bằng',
    variables: { tuan: 'string', don_vi: 'string', han_nop: 'string' },
    end: 'APPROVE',
    reason: 'Nhắc hạn báo cáo gửi qua thư điện tử cho người có đồng ý nhận tin',
  },
  {
    code: 'thong-bao-lich-bao-tri',
    channel: 'EMAIL',
    purpose: 'ANNOUNCEMENT',
    subject: 'Thông báo lịch bảo trì hệ thống quản lý đầu tư công',
    body: 'Kính gửi các đơn vị,\n\nHệ thống quản lý đầu tư công sẽ bảo trì từ {{bat_dau}} đến {{ket_thuc}}. Trong thời gian này hệ thống chỉ cho phép xem. Đề nghị các đơn vị hoàn tất việc nhập liệu trước thời điểm bảo trì.\n\nSở Kế hoạch và Đầu tư tỉnh Cao Bằng',
    variables: { bat_dau: 'string', ket_thuc: 'string' },
    end: 'APPROVE',
    reason: 'Thông báo chung về lịch bảo trì, dùng cho các đợt gửi diện rộng',
  },
  {
    code: 'huong-dan-nop-ho-so-thanh-toan',
    channel: 'EMAIL',
    purpose: 'ANNOUNCEMENT',
    subject: 'Hướng dẫn nộp hồ sơ đề nghị thanh toán trên hệ thống',
    body: 'Kính gửi các chủ đầu tư và ban quản lý dự án,\n\nTừ {{ngay_ap_dung}}, hồ sơ đề nghị thanh toán được lập và trình trực tiếp trên hệ thống. Tài liệu hướng dẫn kèm theo thông báo này.\n\nSở Kế hoạch và Đầu tư tỉnh Cao Bằng',
    variables: { ngay_ap_dung: 'string' },
    end: 'APPROVE',
    reason: 'Hướng dẫn thủ tục nộp hồ sơ thanh toán điện tử',
  },
  {
    code: 'canh-bao-cham-giai-ngan-sms',
    channel: 'SMS',
    purpose: 'OPERATIONAL',
    body: 'Dự án {{ma_du_an}} đang chậm giải ngân so với kế hoạch vốn. Đề nghị xem chi tiết trên hệ thống quản lý đầu tư công.',
    variables: { ma_du_an: 'string' },
    end: 'APPROVE',
    reason: 'Cảnh báo ngắn cho lãnh đạo ban quản lý dự án khi dự án chậm giải ngân',
  },
  {
    code: 'viec-moi-duoc-giao-push',
    channel: 'PUSH_FCM',
    purpose: 'OPERATIONAL',
    body: 'Bạn có việc mới cần xử lý trên hệ thống quản lý đầu tư công.',
    variables: {},
    lockscreenSafe: true,
    end: 'APPROVE',
    reason: 'Tin đẩy trung tính, an toàn khi hiện trên màn hình khóa',
  },
  {
    code: 'thong-bao-tiep-nhan-ho-so-zns',
    channel: 'ZALO_ZNS',
    purpose: 'OPERATIONAL',
    body: 'Hồ sơ {{ma_ho_so}} đã được Sở Kế hoạch và Đầu tư tiếp nhận. Cán bộ phụ trách sẽ liên hệ khi cần bổ sung.',
    variables: { ma_ho_so: 'string' },
    end: 'REVIEW',
    reason: 'Mẫu tin Zalo cho người dân và nhà thầu, chờ nhà cung cấp phê duyệt',
  },
  {
    code: 'nhac-no-tam-ung-sms',
    channel: 'SMS',
    purpose: 'REMINDER',
    body: 'Hợp đồng {{ma_hop_dong}} còn khoản tạm ứng chưa thu hồi, hạn thu hồi {{han_thu_hoi}}. Đề nghị nhà thầu làm việc với chủ đầu tư.',
    variables: { ma_hop_dong: 'string', han_thu_hoi: 'string' },
    end: 'REJECT',
    reason: 'Mẫu nhắc tạm ứng cần ghi rõ số tiền, chưa đủ căn cứ để gửi qua tin nhắn',
  },
  {
    code: 'thu-moi-hop-giao-ban',
    channel: 'EMAIL',
    purpose: 'ANNOUNCEMENT',
    subject: 'Thư mời họp giao ban đầu tư công tháng {{thang}}',
    body: 'Kính mời các đồng chí dự họp giao ban đầu tư công tháng {{thang}} tại phòng họp tầng 3, Sở Kế hoạch và Đầu tư.',
    variables: { thang: 'string' },
    end: 'DRAFT',
    reason: 'Mẫu thư mời đang soạn',
  },
];

function variableSchema(spec: TemplateSpec): Obj {
  return { properties: Object.fromEntries(Object.entries(spec.variables).map(([name, type]) => [name, { type, classification: 'INTERNAL' }])) };
}

/** One template: written by the project board, sent to review, decided by the leader. A revision that exists is left alone. */
async function writeTemplate(ctx: SeedContext, spec: TemplateSpec): Promise<string> {
  const existing = await ctx.find(MAKER, '/resources/notification_template_version', (row) => row.code === spec.code && row.channel === spec.channel);
  if (existing !== undefined) return String(existing.id);
  const created = await ctx.command(MAKER, '/notification-templates', {
    code: spec.code,
    channel: spec.channel,
    locale: 'vi-VN',
    purpose: spec.purpose,
    content_ast: spec.subject === undefined ? { body: spec.body } : { subject: spec.subject, body: spec.body },
    variable_schema: variableSchema(spec),
    lockscreen_safe: spec.lockscreenSafe === true,
  });
  if (spec.end === 'DRAFT') return created.resource_id;
  const submitted = await ctx.command(MAKER, `/notification-templates/${created.resource_id}/submit`, { reason: spec.reason }, { version: created });
  if (spec.end === 'REVIEW') return created.resource_id;
  await ctx.command(CHECKER, `/notification-templates/${created.resource_id}/decision`, { decision: spec.end === 'APPROVE' ? 'approve' : 'reject', reason: spec.reason, evidence_ids: [] }, { version: submitted });
  return created.resource_id;
}

async function writeTemplates(ctx: SeedContext): Promise<void> {
  const ids: Record<string, string> = {};
  for (const spec of TEMPLATES) {
    ids[spec.code] = await once(ctx, `not.template.${spec.code}`, () => writeTemplate(ctx, spec));
    made(ctx, 'NOT', 'template', spec.code, `${spec.channel} ${spec.end}`, { id: ids[spec.code], screen: 'NOT-07' });
  }
}

/** The recipients of the test sends of the templates: the people who write and check them. */
async function setTestRecipients(ctx: SeedContext): Promise<void> {
  await once(ctx, 'not.test-recipients', async () => {
    const membershipIds = [MAKER, CHECKER, OWNER].map((key) => ctx.person(key).membershipId);
    await ctx.must(MAKER, 'PUT', '/notification-test-recipients', { membership_ids: membershipIds });
    made(ctx, 'NOT', 'test-recipients', 'test-recipients', '3 people', { screen: 'NOT-08' });
    return { people: membershipIds.length };
  });
}

// ---- workflows of the events ------------------------------------------------------------------------------------------------------

/** How urgent an event is, from what it says: an escalation or a breach is urgent and asks for an acknowledgement. */
function planOf(eventType: string, allowed: string[]): { priority: 'HIGH' | 'NORMAL' | 'LOW'; ack: boolean; purpose: string; expiryDays: number } {
  const urgent = /escalated|breach|missed|overdue|expired|failed/u.test(eventType);
  const quiet = /published|created|approved|completed/u.test(eventType);
  const purpose = (urgent ? ['OPERATIONAL', 'REMINDER'] : /due|expiring|reminder/u.test(eventType) ? ['REMINDER', 'OPERATIONAL'] : ['OPERATIONAL', 'ANNOUNCEMENT'])
    .find((candidate) => allowed.includes(candidate)) ?? allowed[0] ?? 'OPERATIONAL';
  return { priority: urgent ? 'HIGH' : quiet ? 'LOW' : 'NORMAL', ack: urgent, purpose, expiryDays: urgent ? 14 : 7 };
}

/** A workflow of every event type that is Active in the catalogue: the leader writes it, the owner publishes it (the author never publishes). */
async function publishWorkflows(ctx: SeedContext): Promise<void> {
  const catalogue = (await ctx.get<{ items: Obj[] }>(CHECKER, '/notification-event-types')).items.filter((entry) => entry.status === 'Active');
  let made_ = 0;
  for (const entry of catalogue) {
    const type = String(entry.event_type);
    await once(ctx, `not.workflow.${type}`, async () => {
      const published = await ctx.find(CHECKER, '/notification-workflows', (row) => row.event_type === type && row.status === 'Published');
      if (published !== undefined) return String(published.id);
      const plan = planOf(type, (entry.allowed_purposes as string[]) ?? []);
      const definition: Obj = {
        channels: [{ channel: 'IN_APP' }],
        resolver: type === 'iss.issue.escalated' ? { kind: 'explicit' } : { kind: 'role-in-scope', roles: ['CAN_BO_BAN_QLDA', 'LANH_DAO_SO', 'TENANT_OWNER'] },
        priority: plan.priority,
        ackRequired: plan.ack,
        expiresAfterMinutes: plan.expiryDays * 24 * 60,
        purpose: plan.purpose,
      };
      const draft = await ctx.command(CHECKER, '/notification-workflows', { event_type: type, definition });
      const done = await ctx.command(OWNER, `/notification-workflows/${draft.resource_id}/publish`, { decision: 'approve', reason: `Công bố luồng thông báo cho sự kiện ${type}: người xử lý được báo ngay trong hộp thông báo`, evidence_ids: [] }, { version: draft });
      made_ += 1;
      return done.resource_id;
    });
    made(ctx, 'NOT', 'workflow', type, 'published', { screen: 'NOT-06' });
  }
  ctx.log(`  [${ctx.group}/NOT] ${catalogue.length} event types in the catalogue, ${made_} workflows published now`);
}

/** The first phase: runs before the other groups so that the events they raise find a workflow. */
export async function seedNotificationSetup(ctx: SeedContext): Promise<void> {
  await ctx.step('NOT', 'every person holds the role MEMBER (inbox, profile, help desk)', () => grantMemberRoles(ctx));
  await ctx.step('NOT', 'templates of the messages (NOT-07)', () => writeTemplates(ctx));
  await ctx.step('NOT', 'test recipients (NOT-08)', () => setTestRecipients(ctx));
  await ctx.step('NOT', 'workflows of the event types (NOT-05, NOT-06)', () => publishWorkflows(ctx));
}

// ---- consents, preferences, campaigns, inbox ----------------------------------------------------------------------------------------

/** What each person agreed to: e-mail for reminders and announcements, a few more channels, and two decisions that were taken back. */
const CONSENTS: Array<{ person: string; channel: 'EMAIL' | 'SMS' | 'ZALO' | 'PUSH'; purpose: 'OPERATIONAL' | 'REMINDER' | 'ANNOUNCEMENT'; withdraw?: string }> = [
  ...(['owner', 'unitAdmin', 'projectManager', 'capApprover', 'treasuryMaker', 'auditor', 'nobody'] as const).flatMap((person) => [
    { person, channel: 'EMAIL' as const, purpose: 'ANNOUNCEMENT' as const },
    { person, channel: 'EMAIL' as const, purpose: 'REMINDER' as const },
  ]),
  { person: 'projectManager', channel: 'SMS', purpose: 'OPERATIONAL' },
  { person: 'capApprover', channel: 'SMS', purpose: 'OPERATIONAL' },
  { person: 'treasuryMaker', channel: 'PUSH', purpose: 'OPERATIONAL' },
  { person: 'nobody', channel: 'SMS', purpose: 'REMINDER', withdraw: 'Tôi chỉ nhận nhắc hạn qua thư điện tử, không nhận tin nhắn điện thoại' },
  { person: 'auditor', channel: 'ZALO', purpose: 'ANNOUNCEMENT', withdraw: 'Chuyển sang nhận thông báo qua thư điện tử của cơ quan' },
];

async function recordConsents(ctx: SeedContext): Promise<void> {
  await once(ctx, 'not.consents', async () => {
    for (const consent of CONSENTS) {
      const given = await ctx.command(consent.person, '/me/consents', {
        channel: consent.channel,
        purpose: consent.purpose,
        consent_text_version: 'v2026.1',
        capture_method: 'IN_APP',
      });
      if (consent.withdraw !== undefined) await ctx.command(consent.person, `/me/consents/${given.resource_id}/withdraw`, { reason: consent.withdraw }, { version: given });
    }
    made(ctx, 'NOT', 'consent', 'me/consents', `${CONSENTS.length} consents, ${CONSENTS.filter((consent) => consent.withdraw !== undefined).length} withdrawn`, { screen: 'NOT-17' });
    return { consents: CONSENTS.length };
  });
}

/** NOT-03: some people choose how they are reached (the leader keeps the push off the inbox hours; the accountant takes a daily digest of e-mail). */
async function setPreferences(ctx: SeedContext): Promise<void> {
  await once(ctx, 'not.preferences', async () => {
    const choices: Array<{ person: string; items: Obj[]; start: string; end: string }> = [
      { person: 'capApprover', start: '20:00', end: '07:30', items: [{ event_category: '*', channel: 'IN_APP', enabled: true, digest_mode: 'IMMEDIATE' }, { event_category: '*', channel: 'EMAIL', enabled: true, digest_mode: 'DAILY' }] },
      { person: 'treasuryMaker', start: '21:00', end: '06:30', items: [{ event_category: '*', channel: 'IN_APP', enabled: true, digest_mode: 'IMMEDIATE' }, { event_category: '*', channel: 'EMAIL', enabled: true, digest_mode: 'HOURLY' }] },
      { person: 'projectManager', start: '22:00', end: '06:00', items: [{ event_category: '*', channel: 'IN_APP', enabled: true, digest_mode: 'IMMEDIATE' }, { event_category: '*', channel: 'SMS', enabled: false }] },
    ];
    for (const choice of choices) {
      const current = await ctx.get<Obj>(choice.person, '/me/notification-preferences');
      await ctx.must(choice.person, 'PUT', '/me/notification-preferences', { items: choice.items, quiet_start: choice.start, quiet_end: choice.end, time_zone: 'Asia/Ho_Chi_Minh' }, { version: Number(current.version ?? 0) });
    }
    made(ctx, 'NOT', 'preference', 'me/notification-preferences', `${choices.length} people`, { screen: 'NOT-03' });
    return { people: choices.length };
  });
}

interface CampaignSpec {
  key: string;
  name: string;
  purpose: 'ANNOUNCEMENT' | 'REMINDER' | 'OPERATIONAL';
  template: string;
  roles: string[];
  scheduleDays?: number;
  /** How far it gets: left as a draft, previewed, waiting for approval, approved, refused, or approved and then cancelled. */
  end: 'DRAFT' | 'PENDING' | 'APPROVE' | 'REJECT' | 'CANCEL';
  reason: string;
}

const CAMPAIGNS: CampaignSpec[] = [
  { key: 'bao-tri-thang-11', name: 'Thông báo lịch bảo trì hệ thống tháng 11', purpose: 'ANNOUNCEMENT', template: 'thong-bao-lich-bao-tri', roles: ['CAN_BO_BAN_QLDA', 'LANH_DAO_SO', 'KE_TOAN_THANH_TOAN'], end: 'APPROVE', reason: 'Các đơn vị cần biết lịch bảo trì để hoàn tất nhập liệu trước giờ khóa' },
  { key: 'nhac-han-bao-cao-tuan', name: 'Nhắc hạn nộp báo cáo giải ngân tuần', purpose: 'REMINDER', template: 'nhac-han-bao-cao-tuan-email', roles: ['CAN_BO_BAN_QLDA', 'KE_TOAN_THANH_TOAN'], scheduleDays: 2, end: 'APPROVE', reason: 'Nhắc các ban quản lý dự án nộp báo cáo tuần trước hạn thứ Sáu' },
  { key: 'huong-dan-thanh-toan', name: 'Hướng dẫn nộp hồ sơ đề nghị thanh toán điện tử', purpose: 'ANNOUNCEMENT', template: 'huong-dan-nop-ho-so-thanh-toan', roles: ['CAN_BO_BAN_QLDA', 'KE_TOAN_THANH_TOAN'], end: 'PENDING', reason: 'Phổ biến thủ tục mới cho các chủ đầu tư trước khi áp dụng' },
  { key: 'tap-huan-he-thong', name: 'Thông báo lịch tập huấn sử dụng hệ thống', purpose: 'ANNOUNCEMENT', template: 'thong-bao-lich-bao-tri', roles: ['CAN_BO_BAN_QLDA'], end: 'DRAFT', reason: 'Đang chờ chốt thời gian và địa điểm tập huấn' },
  { key: 'khen-thuong-giai-ngan', name: 'Thông báo khen thưởng đơn vị giải ngân tốt quý III', purpose: 'ANNOUNCEMENT', template: 'thong-bao-lich-bao-tri', roles: ['CAN_BO_BAN_QLDA', 'LANH_DAO_SO'], end: 'REJECT', reason: 'Chưa có quyết định khen thưởng chính thức nên chưa thể thông báo diện rộng' },
  { key: 'bao-tri-khan', name: 'Thông báo ngừng hệ thống đột xuất để nâng cấp', purpose: 'ANNOUNCEMENT', template: 'thong-bao-lich-bao-tri', roles: ['CAN_BO_BAN_QLDA', 'LANH_DAO_SO', 'KE_TOAN_THANH_TOAN'], scheduleDays: 5, end: 'CANCEL', reason: 'Lịch nâng cấp thay đổi theo đề nghị của nhà cung cấp, cần hủy và gửi lại sau' },
];

async function runCampaign(ctx: SeedContext, spec: CampaignSpec): Promise<string> {
  const template = await ctx.find(MAKER, '/resources/notification_template_version', (row) => row.code === spec.template && row.status === 'Active');
  if (template === undefined) throw new Error(`the template ${spec.template} is not Active`);
  const created = await ctx.command(MAKER, '/notification-campaigns', {
    name: spec.name,
    purpose: spec.purpose,
    template_version_id: template.id,
    segment: { role_codes: spec.roles },
    ...(spec.scheduleDays === undefined ? {} : { scheduled_at: at(ctx, spec.scheduleDays, 8) }),
  });
  if (spec.end === 'DRAFT') return created.resource_id;
  const preview = await ctx.must<{ preview_hash: string; version: number }>(MAKER, 'POST', `/notification-campaigns/${created.resource_id}/preview`, { reason: 'Kiểm tra danh sách người nhận trước khi trình duyệt' }, { version: created });
  if (spec.end === 'PENDING' || spec.end === 'REJECT' || spec.end === 'APPROVE' || spec.end === 'CANCEL') {
    const submitted = await ctx.command(MAKER, `/notification-campaigns/${created.resource_id}/submit`, { preview_hash: preview.preview_hash, reason: spec.reason }, { version: preview.version });
    if (spec.end === 'PENDING') return created.resource_id;
    const decided = await ctx.command(CHECKER, `/notification-campaigns/${created.resource_id}/decision`, { decision: spec.end === 'REJECT' ? 'reject' : 'approve', reason: spec.reason, evidence_ids: [] }, { version: submitted });
    if (spec.end === 'CANCEL') await ctx.command(MAKER, `/notification-campaigns/${created.resource_id}/cancel`, { reason: spec.reason }, { version: decided });
  }
  return created.resource_id;
}

async function runCampaigns(ctx: SeedContext): Promise<void> {
  for (const spec of CAMPAIGNS) {
    const id = await once(ctx, `not.campaign.${spec.key}`, async () => {
      const existing = await ctx.find(MAKER, '/notification-campaigns', (row) => row.name === spec.name);
      return existing !== undefined ? String(existing.id) : runCampaign(ctx, spec);
    });
    made(ctx, 'NOT', 'campaign', spec.key, spec.end, { id, screen: 'NOT-10' });
  }
}

/** NOT-15: the e-mail account has a daily cap and a monthly budget (set by the person who manages the channels). */
async function setChannelLimits(ctx: SeedContext): Promise<void> {
  await once(ctx, 'not.limits', async () => {
    const accounts = await ctx.list(MAKER, '/resources/channel_account');
    let set = 0;
    for (const account of accounts.filter((row) => row.status === 'Active')) {
      const caps: Record<string, { daily: number; budget: string }> = { EMAIL: { daily: 5000, budget: '3000000' }, SMS: { daily: 1000, budget: '5000000' }, ZALO_OA: { daily: 2000, budget: '2000000' } };
      const cap = caps[String(account.channel)];
      if (cap === undefined) continue;
      await ctx.must(MAKER, 'PUT', `/channel-accounts/${account.id}/limits`, { daily_send_cap: cap.daily, monthly_budget_vnd: cap.budget, reason: 'Hạn mức theo hợp đồng dịch vụ tin nhắn năm 2026 của Sở' }, { version: Number(account.version ?? 1) });
      set += 1;
    }
    made(ctx, 'NOT', 'channel-limits', 'limits', `${set} accounts`, { screen: 'NOT-15' });
    return { accounts: set };
  });
}

/** A test send of the e-mail reminder to the people who check the templates (it carries the mark TEST and is no notification). */
async function testSend(ctx: SeedContext): Promise<void> {
  await once(ctx, 'not.test-send', async () => {
    const template = await ctx.find(MAKER, '/resources/notification_template_version', (row) => row.code === 'nhac-han-bao-cao-tuan-email' && row.status === 'Active');
    if (template === undefined) return { sent: false };
    const reply = await ctx.attempt(MAKER, 'POST', `/notification-templates/${template.id}/test-sends`, {
      test_recipient_ids: [ctx.person(MAKER).membershipId, ctx.person(CHECKER).membershipId],
      sample_variables: { tuan: '45', don_vi: 'Ban Quản lý dự án', han_nop: '14/11/2026' },
    });
    made(ctx, 'NOT', 'test-send', 'nhac-han-bao-cao-tuan-email', reply.ok ? 'sent' : `refused HTTP ${reply.status}`, { screen: 'NOT-08' });
    return { sent: reply.ok };
  });
}

/** The people open their inbox: about two thirds of what has come is read, and what asks for an acknowledgement is acknowledged by some. */
async function readInboxes(ctx: SeedContext): Promise<void> {
  const people = ['projectManager', 'owner', 'nobody', 'capApprover', 'unitAdmin', 'treasuryMaker', 'auditor'];
  let read = 0;
  let acknowledged = 0;
  let total = 0;
  for (const person of people) {
    const reply = await ctx.attempt<{ items?: Obj[] }>(person, 'GET', '/me/notifications', undefined, { query: { limit: 100 } });
    const items = reply.json.items ?? [];
    total += items.length;
    for (const [index, item] of items.entries()) {
      if (item.read_at !== null && item.read_at !== undefined) continue;
      // Deterministic: the first two of every three are opened.
      if (index % 3 === 2) continue;
      const opened = await ctx.attempt(person, 'POST', `/notifications/${item.id}/read`, { opened_via: 'IN_APP' });
      if (opened.ok) read += 1;
      if (opened.ok && item.ack_required === true && index % 2 === 0) {
        const done = await ctx.attempt(person, 'POST', `/notifications/${item.id}/acknowledge`, { comment: 'Đã nhận và giao cán bộ phụ trách xử lý' });
        if (done.ok) acknowledged += 1;
      }
    }
  }
  made(ctx, 'NOT', 'inbox', 'me/notifications', `${total} notifications in the inboxes, ${read} opened now, ${acknowledged} acknowledged now`, { screen: 'NOT-01' });
}

/** The second phase: runs late, when the channel accounts of OMNI exist and the other groups have raised their events. */
export async function seedNotificationActivity(ctx: SeedContext): Promise<void> {
  await ctx.step('NOT', 'consents of the people (NOT-17)', () => recordConsents(ctx));
  await ctx.step('NOT', 'preferences and quiet hours (NOT-03)', () => setPreferences(ctx));
  await ctx.step('NOT', 'limits of the channels (NOT-15)', () => setChannelLimits(ctx));
  await ctx.step('NOT', 'test send of a template (NOT-08)', () => testSend(ctx));
  await ctx.step('NOT', 'broadcast campaigns (NOT-09, NOT-10, NOT-16)', () => runCampaigns(ctx));
  await ctx.step('NOT', 'the people read their inbox (NOT-01, NOT-02)', () => readInboxes(ctx));
}
