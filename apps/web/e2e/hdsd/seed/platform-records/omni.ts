import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { STACK_INFO_PATH } from '../../../support/stack-paths.ts';
import { made, once } from './shared.ts';

/**
 * OMNI for the guide. The story: the Department of Planning and Investment of Cao Bằng receives questions about its projects by e-mail, Zalo and
 * text message, from citizens, from the staff of contractors and from the communes. The channel accounts are connected and verified, the routing
 * policy sends what is about compensation to the project board and what is about payment to the Department of Finance, and the conversations
 * arrive the way they do in life: the provider of the channel calls the webhook of the platform with a signed message. The agents then assign,
 * answer, note, link to a project, turn into an issue, resolve and reopen. Nothing here writes to the database.
 */

const AGENT = 'projectManager';
const SUPERVISOR = 'projectManager';

const MAIL = { channel: 'EMAIL', externalId: 'tiepnhan@skhdt.caobang.gov.vn', name: 'Hộp thư tiếp nhận ý kiến của Sở Kế hoạch và Đầu tư', credential: 'secret://caobang/mail-tiepnhan' } as const;
/** The signing secret of the provider's webhook is the one of the stack (the mock relay); the account names it through the same reference as the relay of the stack. */
const WEBHOOK_REF = 'secret://e2e/uat-relay-webhook';
const PROVIDER = 'smtp-relay';

const ACCOUNTS: Array<{ channel: 'EMAIL' | 'SMS' | 'ZALO_OA' | 'ZALO_ZNS' | 'WHATSAPP'; externalId: string; name: string; credential: string; webhook: string; verify: boolean; disable?: string; autoReply?: string }> = [
  { channel: 'EMAIL', externalId: MAIL.externalId, name: MAIL.name, credential: MAIL.credential, webhook: WEBHOOK_REF, verify: true, autoReply: 'Sở Kế hoạch và Đầu tư đã nhận ý kiến của quý vị và sẽ phản hồi trong giờ làm việc, chậm nhất trong 01 ngày làm việc.' },
  { channel: 'SMS', externalId: 'brandname-skhdt-caobang', name: 'Tin nhắn thương hiệu SKHĐT Cao Bằng', credential: 'secret://caobang/sms-brandname', webhook: 'secret://caobang/sms-brandname-webhook', verify: true },
  { channel: 'ZALO_OA', externalId: '4417283569104528391', name: 'Zalo OA Sở Kế hoạch và Đầu tư Cao Bằng', credential: 'secret://caobang/zalo-oa', webhook: 'secret://caobang/zalo-oa-webhook', verify: true, autoReply: 'Cảm ơn quý vị đã nhắn tin cho Sở Kế hoạch và Đầu tư tỉnh Cao Bằng. Cán bộ sẽ trả lời trong giờ làm việc.' },
  { channel: 'ZALO_ZNS', externalId: '4417283569104528402', name: 'Zalo thông báo tiếp nhận hồ sơ', credential: 'secret://caobang/zalo-zns', webhook: 'secret://caobang/zalo-zns-webhook', verify: true },
  { channel: 'WHATSAPP', externalId: '84912340099', name: 'WhatsApp liên hệ nhà thầu nước ngoài', credential: 'secret://caobang/whatsapp', webhook: 'secret://caobang/whatsapp-webhook', verify: false },
  { channel: 'EMAIL', externalId: 'phanhoi-cu@caobang.gov.vn', name: 'Hộp thư phản ánh cũ (thay bằng hộp thư tiếp nhận)', credential: 'secret://caobang/mail-cu', webhook: WEBHOOK_REF, verify: true, disable: 'Hộp thư cũ ngừng sử dụng từ khi chuyển sang hộp thư tiếp nhận mới của Sở' },
];

async function waitFor<T>(read: () => Promise<T | undefined>, seconds = 40): Promise<T | undefined> {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > end) return undefined;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
}

/** OMNI-05, OMNI-06: the accounts of the channels are connected with references to secrets, verified at the provider, set up; one is closed. */
async function connectAccounts(ctx: SeedContext): Promise<void> {
  for (const spec of ACCOUNTS) {
    await once(ctx, `omni.account.${spec.externalId}`, async () => {
      const existing = await ctx.find(SUPERVISOR, '/resources/channel_account', (row) => row.external_account_id === spec.externalId);
      let id = existing === undefined ? undefined : String(existing.id);
      let version = existing === undefined ? 0 : Number(existing.version);
      if (id === undefined) {
        const connected = await ctx.command(SUPERVISOR, '/channel-accounts', { channel: spec.channel, external_account_id: spec.externalId, display_name: spec.name, credential_secret_ref: spec.credential, webhook_secret_ref: spec.webhook });
        id = connected.resource_id;
        version = connected.resource_version;
      }
      if (spec.verify) {
        const asked = existing?.status === 'Active' ? undefined : await ctx.command(SUPERVISOR, `/channel-accounts/${id}/verify`, { reason: 'Xác minh tài khoản kênh trước khi đưa vào sử dụng chính thức' }, { version });
        void asked;
        const active = await waitFor(async () => {
          const row = await ctx.get<Obj>(SUPERVISOR, `/resources/channel_account/${id}`);
          return row.status === 'Active' ? row : undefined;
        });
        if (active === undefined) ctx.warn(`the channel account ${spec.externalId} did not become Active (is the channel verification consumer wired in the stack?)`);
        else version = Number(active.version);
        if (active !== undefined && spec.autoReply !== undefined) {
          await ctx.must(SUPERVISOR, 'PUT', `/channel-accounts/${id}`, { auto_reply_text: spec.autoReply, reason: 'Thiết lập trả lời tự động ngoài giờ làm việc' }, { version });
        }
        if (active !== undefined && spec.disable !== undefined) {
          const fresh = await ctx.get<Obj>(SUPERVISOR, `/resources/channel_account/${id}`);
          await ctx.command(SUPERVISOR, `/channel-accounts/${id}/disable`, { reason: spec.disable }, { version: Number(fresh.version) });
        }
      }
      made(ctx, 'OMNI', 'channel-account', spec.externalId, `${spec.channel}${spec.verify ? ' verified' : ' waiting for verification'}${spec.disable === undefined ? '' : ', then closed'}`, { id, screen: 'OMNI-05' });
      return id;
    });
  }
}

/** The calendar the deadlines are counted on: the published working calendar of ADM, or the code the guide uses. */
async function calendarCode(ctx: SeedContext): Promise<string> {
  const calendars = await ctx.attempt<{ items?: Obj[] }>(SUPERVISOR, 'GET', '/resources/work_calendar_version', undefined, { query: { limit: 50 } });
  const published = (calendars.json.items ?? []).find((row) => row.status === 'Published' || row.status === 'PUBLISHED');
  return String(published?.calendar_code ?? (calendars.json.items ?? [])[0]?.calendar_code ?? 'VN-HANH-CHINH');
}

/** OMNI-07: what is about compensation goes to the project board, what is about payment to the Department of Finance; the first answer is due in four working hours. */
async function publishRouting(ctx: SeedContext): Promise<void> {
  await once(ctx, 'omni.routing-policy', async () => {
    const existing = await ctx.find(SUPERVISOR, '/conversation-routing-policies', (row) => row.status === 'Published' || row.status === 'PUBLISHED');
    if (existing !== undefined) return String(existing.id);
    const draft = await ctx.command(SUPERVISOR, '/conversation-routing-policies', {
      rules: [
        { channels: ['EMAIL', 'ZALO_OA'], keywords: ['bồi thường', 'giải phóng mặt bằng', 'đền bù', 'thu hồi đất'], queue_unit_id: ctx.unitId('CB-SKHDT-QLDA'), priority: 'HIGH' },
        { channels: ['EMAIL', 'ZALO_OA'], keywords: ['thanh toán', 'tạm ứng', 'giải ngân', 'bảo lãnh'], queue_unit_id: ctx.unitId('CB-STC'), priority: 'NORMAL' },
        { queue_unit_id: ctx.unitId('CB-SKHDT-VP'), priority: 'LOW' },
      ],
      calendar_code: await calendarCode(ctx),
      first_response_minutes: 240,
      resolution_hours: 72,
    });
    const published = await ctx.command(SUPERVISOR, `/conversation-routing-policies/${draft.resource_id}/publish`, { reason: 'Công bố quy tắc phân công theo nội dung phản ánh và thời hạn phản hồi đầu tiên' }, { version: draft });
    made(ctx, 'OMNI', 'routing-policy', 'v1', 'published, 3 rules', { id: published.resource_id, screen: 'OMNI-07' });
    return published.resource_id;
  });
}

const CANNED = [
  { code: 'da-tiep-nhan-y-kien', title: 'Đã tiếp nhận ý kiến', body: 'Sở Kế hoạch và Đầu tư đã tiếp nhận ý kiến của quý vị và chuyển cho bộ phận phụ trách. Chúng tôi sẽ phản hồi trong thời hạn quy định.', channels: ['EMAIL', 'ZALO_OA'] },
  { code: 'hoi-bo-sung-ho-so', title: 'Đề nghị bổ sung hồ sơ', body: 'Để xử lý đề nghị của quý vị, xin bổ sung bản sao hợp đồng, biên bản nghiệm thu và bảng khối lượng hoàn thành có xác nhận của chủ đầu tư.', channels: ['EMAIL'] },
  { code: 'tien-do-giai-phong-mat-bang', title: 'Thông tin tiến độ giải phóng mặt bằng', body: 'Việc kiểm đếm và lập phương án bồi thường do Hội đồng bồi thường của địa phương thực hiện. Khi phương án được phê duyệt sẽ được niêm yết công khai tại trụ sở Ủy ban nhân dân phường, xã.', channels: ['EMAIL', 'ZALO_OA', 'SMS'] },
  { code: 'huong-dan-thanh-toan', title: 'Hướng dẫn hồ sơ thanh toán', body: 'Hồ sơ đề nghị thanh toán gồm giấy đề nghị thanh toán, bảng xác định giá trị khối lượng hoàn thành và chứng từ kèm theo. Chủ đầu tư kiểm soát chi qua Kho bạc Nhà nước trước khi thanh toán.', channels: ['EMAIL', 'ZALO_OA'] },
  { code: 'lien-he-dau-moi', title: 'Thông tin đầu mối liên hệ', body: 'Quý vị có thể liên hệ Văn phòng Sở Kế hoạch và Đầu tư trong giờ hành chính, từ thứ Hai đến thứ Sáu, hoặc gửi thư vào hộp thư tiếp nhận của Sở.', channels: ['EMAIL', 'SMS', 'ZALO_OA'] },
];

/** OMNI-08: the answers the agents reuse. */
async function cannedReplies(ctx: SeedContext): Promise<void> {
  for (const reply of CANNED) {
    await once(ctx, `omni.canned.${reply.code}`, async () => {
      const existing = await ctx.find(SUPERVISOR, '/canned-replies', (row) => row.code === reply.code);
      if (existing !== undefined) return String(existing.id);
      const created = await ctx.command(SUPERVISOR, '/canned-replies', { code: reply.code, title: reply.title, body_text: reply.body, channels: reply.channels, classification: 'PUBLIC' });
      made(ctx, 'OMNI', 'canned-reply', reply.code, reply.title, { id: created.resource_id, screen: 'OMNI-08' });
      return created.resource_id;
    });
  }
}

// ---- the people who write ---------------------------------------------------------------------------------------------------------

interface Thread {
  key: string;
  from: string;
  name: string;
  /** Days ago the first message arrived, and its hour. */
  daysAgo: number;
  hour: number;
  messages: string[];
  /** What the agents do with it. */
  flow: 'NEW' | 'ASSIGNED' | 'ANSWERED' | 'RESOLVED' | 'REOPENED' | 'ISSUE' | 'NOTE';
  assignee?: 'projectManager' | 'owner';
  classification: 'CITIZEN' | 'CONTRACTOR_STAFF' | 'AGENCY_STAFF';
}

const THREADS: Thread[] = [
  { key: 't01', from: 'lehoa.thucphan@gmail.com', name: 'Lê Thị Hòa', daysAgo: 9, hour: 8, flow: 'ANSWERED', assignee: 'projectManager', classification: 'CITIZEN',
    messages: ['Gia đình tôi ở tổ 7 phường Thục Phán nằm trong diện giải phóng mặt bằng dự án đường tỉnh 205 đoạn Km0 - Km12. Đã kiểm đếm từ tháng 8 nhưng đến nay chưa thấy thông báo bồi thường. Xin cho biết khi nào có phương án và chi trả.'] },
  { key: 't02', from: 'ketoan@xaydungdonglan.vn', name: 'Nguyễn Thanh Tùng', daysAgo: 8, hour: 9, flow: 'RESOLVED', assignee: 'owner', classification: 'CONTRACTOR_STAFF',
    messages: ['Công ty TNHH Xây dựng Đông Lan đã nộp hồ sơ đề nghị thanh toán đợt 2 gói thầu xây lắp Trường Tiểu học phường Nùng Trí Cao từ ngày 28/10. Xin cho biết hồ sơ đang ở bước nào và khi nào được thanh toán.'] },
  { key: 't03', from: 'vanphong@ubnd-tangiang.caobang.gov.vn', name: 'Hoàng Văn Sơn', daysAgo: 7, hour: 14, flow: 'REOPENED', assignee: 'projectManager', classification: 'AGENCY_STAFF',
    messages: ['Ủy ban nhân dân phường Tân Giang đề nghị cung cấp mẫu báo cáo tiến độ giải ngân dự án Nâng cấp Trạm y tế phường Tân Giang để gửi Sở trước ngày 10 hằng tháng.', 'Cảm ơn Sở đã gửi mẫu. Đề nghị cho biết thêm cột số liệu lũy kế ghi theo năm kế hoạch hay theo toàn bộ dự án.'] },
  { key: 't04', from: 'nongvanthanh1975@gmail.com', name: 'Nông Văn Thành', daysAgo: 6, hour: 7, flow: 'ISSUE', assignee: 'projectManager', classification: 'CITIZEN',
    messages: ['Đoạn thi công đường tỉnh 205 gần cổng trường mầm non xe tải chở vật liệu chạy nhiều, bụi và tiếng ồn ảnh hưởng người dân. Đề nghị Sở yêu cầu nhà thầu che chắn và tưới nước giảm bụi.', 'Tôi bổ sung: tình trạng này kéo dài từ đầu tháng, thường nặng nhất lúc 6 đến 8 giờ sáng.'] },
  { key: 't05', from: 'giamdoc@congtydaiphat-cb.vn', name: 'Triệu Quang Huy', daysAgo: 5, hour: 10, flow: 'NOTE', assignee: 'projectManager', classification: 'CONTRACTOR_STAFF',
    messages: ['Công ty Cổ phần Đại Phát đã hoàn thành hạng mục mái và hoàn thiện Trạm y tế phường Tân Giang. Đề nghị Sở và chủ đầu tư bố trí lịch nghiệm thu hoàn thành trong tuần này.'] },
  { key: 't06', from: 'hoangmai.nungtricao@gmail.com', name: 'Hoàng Thị Mai', daysAgo: 4, hour: 15, flow: 'NEW', classification: 'CITIZEN',
    messages: ['Xin hỏi tiến độ xây dựng Trường Tiểu học phường Nùng Trí Cao, dự kiến khi nào bàn giao đưa vào sử dụng để gia đình đăng ký cho cháu nhập học năm sau.'] },
  { key: 't07', from: 'phuong.thucphan@caobang.gov.vn', name: 'Lương Văn Đạt', daysAgo: 3, hour: 9, flow: 'ASSIGNED', assignee: 'owner', classification: 'AGENCY_STAFF',
    messages: ['Phường Thục Phán đề nghị bổ sung địa danh tổ dân phố mới vào danh mục địa bàn dùng chung theo Nghị quyết sắp xếp đơn vị hành chính. Đề nghị Sở hướng dẫn hồ sơ đề xuất.'] },
  { key: 't08', from: 'phutrach@tuvanxaydung-bangiang.vn', name: 'Đinh Thị Hạnh', daysAgo: 3, hour: 11, flow: 'ASSIGNED', assignee: 'projectManager', classification: 'CONTRACTOR_STAFF',
    messages: ['Công ty Tư vấn Xây dựng Bằng Giang xin gia hạn bảo lãnh thực hiện hợp đồng tư vấn giám sát đến hết tháng 12/2026. Đề nghị Sở cho biết hồ sơ cần nộp và đầu mối tiếp nhận.'] },
  { key: 't09', from: 'trinhvanbao.1982@gmail.com', name: 'Trịnh Văn Bảo', daysAgo: 2, hour: 16, flow: 'RESOLVED', assignee: 'projectManager', classification: 'CITIZEN',
    messages: ['Tôi muốn biết tổng mức đầu tư và nguồn vốn của dự án Nâng cấp Trạm y tế phường Tân Giang để theo dõi. Thông tin này có công khai không?'] },
  { key: 't10', from: 'tamung@xaydungdonglan.vn', name: 'Lâm Quốc Việt', daysAgo: 1, hour: 8, flow: 'NEW', classification: 'CONTRACTOR_STAFF',
    messages: ['Về khoản tạm ứng hợp đồng gói thầu trường học: chủ đầu tư yêu cầu thu hồi dần theo từng đợt thanh toán. Xin Sở hướng dẫn tỷ lệ thu hồi theo quy định hiện hành.'] },
  { key: 't11', from: 'dothihuong.tangiang@gmail.com', name: 'Đỗ Thị Hương', daysAgo: 1, hour: 13, flow: 'NEW', classification: 'CITIZEN',
    messages: ['Gia đình tôi bị ảnh hưởng thu hồi đất khi nâng cấp Trạm y tế phường Tân Giang. Xin hỏi đơn giá bồi thường áp dụng theo bảng giá đất năm nào và nộp khiếu nại ở đâu.'] },
  { key: 't12', from: 'quanly@vlxd-caobang.vn', name: 'Bế Văn Cường', daysAgo: 0, hour: 7, flow: 'NEW', classification: 'CONTRACTOR_STAFF',
    messages: ['Cửa hàng vật liệu xây dựng cung cấp xi măng, thép cho nhà thầu thi công đường 205. Nhà thầu chưa thanh toán công nợ, xin hỏi Sở có thể hỗ trợ làm việc với nhà thầu không.'] },
];

function webhookSecret(): string {
  const info = JSON.parse(readFileSync(STACK_INFO_PATH, 'utf8')) as { provider?: { webhookSecret?: string } };
  const secret = info.provider?.webhookSecret;
  if (secret === undefined) throw new Error('the stack info has no provider.webhookSecret');
  return secret;
}

/** What the provider of the channel does when a person writes: a signed call to the webhook of the platform (no session: the signature is the proof). */
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
  return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Obj) };
}

async function write(ctx: SeedContext, thread: Thread, index: number, text: string, when: Date): Promise<void> {
  const reply = await providerCall(ctx, {
    id: `cb-${thread.key}-in-${index}`,
    account: MAIL.externalId,
    type: 'message.inbound',
    at: when.toISOString(),
    inbound: { message: `cb-${thread.key}-m${index}`, thread: `cb-thread-${thread.key}`, from: thread.from, name: thread.name, text },
  });
  if (reply.status !== 200) throw new Error(`webhook answered HTTP ${reply.status} ${JSON.stringify(reply.json)}`);
}

function instant(ctx: SeedContext, daysAgo: number, hour: number, offsetMinutes = 0): Date {
  const [y, m, d] = ctx.day(-daysAgo).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, hour - 7, offsetMinutes));
}

async function conversationOf(ctx: SeedContext, thread: Thread): Promise<Obj> {
  // The conversation is found by its first message.
  const all = await ctx.list(SUPERVISOR, '/resources/conversation');
  for (const conversation of all) {
    const messages = await ctx.list(SUPERVISOR, '/resources/channel_message', { conversation_id: String(conversation.id) });
    if (messages.some((message) => String(message.text ?? '').startsWith(thread.messages[0]!.slice(0, 40)))) return conversation;
  }
  throw new Error(`the conversation of thread ${thread.key} is not there`);
}

/** OMNI-01, OMNI-02, OMNI-11: the people write; the first message of a thread opens a conversation routed by the policy. */
async function receiveMessages(ctx: SeedContext): Promise<void> {
  const mail = (await ctx.find(SUPERVISOR, '/resources/channel_account', (row) => row.external_account_id === MAIL.externalId));
  if (mail === undefined || mail.status !== 'Active') {
    ctx.warn('the e-mail account is not Active: no conversation can be received (channel verification consumer missing in the stack?)');
    return;
  }
  for (const thread of THREADS) {
    await once(ctx, `omni.inbound.${thread.key}`, async () => {
      for (const [index, text] of thread.messages.entries()) await write(ctx, thread, index, text, instant(ctx, thread.daysAgo - (index === 0 ? 0 : 1) * 0, thread.hour, index * 190));
      made(ctx, 'OMNI', 'conversation', thread.key, `${thread.messages.length} message(s) from ${thread.name}`, { screen: 'OMNI-01' });
      return { messages: thread.messages.length };
    });
  }
  // OMNI-11: a delivery receipt for a message the platform never sent is applied again by the integration inbox (1, 5, 30 minutes), and stays on the monitor as failed.
  await once(ctx, 'omni.orphan-receipt', async () => {
    const reply = await providerCall(ctx, { id: 'cb-receipt-orphan-1', account: MAIL.externalId, message: 'smtp-relay-msg-unknown-7781', status: 'DELIVERED', type: 'delivery.status', at: instant(ctx, 1, 9).toISOString() });
    made(ctx, 'OMNI', 'webhook-event', 'cb-receipt-orphan-1', `receipt of an unknown message, HTTP ${reply.status}`, { screen: 'OMNI-11' });
    return { status: reply.status };
  });
}

// ---- contacts, identities, consents -------------------------------------------------------------------------------------------

interface ContactSpec {
  key: string;
  name: string;
  classification: 'CITIZEN' | 'CONTRACTOR_STAFF' | 'AGENCY_STAFF';
  identities: Array<{ channel: 'PHONE' | 'EMAIL' | 'ZALO'; value: string; verify?: string }>;
  consents?: Array<{ channel: 'EMAIL' | 'SMS' | 'ZALO'; purpose: 'OPERATIONAL' | 'REMINDER' | 'ANNOUNCEMENT' | 'SUPPORT_CONVERSATION'; withdraw?: string }>;
}

const CONTACTS: ContactSpec[] = [
  {
    key: 'bui-van-quy', name: 'Bùi Văn Quý - Ban Quản lý dự án', classification: 'AGENCY_STAFF',
    identities: [{ channel: 'EMAIL', value: 'quybv@banqlda.caobang.gov.vn', verify: 'Quyết định điều động số 41/QĐ-SKHĐT' }, { channel: 'PHONE', value: '0912 345 118', verify: 'Quyết định điều động số 41/QĐ-SKHĐT' }],
    consents: [{ channel: 'EMAIL', purpose: 'OPERATIONAL' }, { channel: 'SMS', purpose: 'REMINDER' }],
  },
  {
    key: 'duong-thi-nga', name: 'Dương Thị Nga - Công ty TNHH Xây dựng Đông Lan', classification: 'CONTRACTOR_STAFF',
    identities: [{ channel: 'EMAIL', value: 'ngadt@xaydungdonglan.vn', verify: 'Giấy giới thiệu số 12/GT-ĐL ngày 05/10/2026' }, { channel: 'PHONE', value: '0912 777 305', verify: 'Giấy giới thiệu số 12/GT-ĐL ngày 05/10/2026' }],
    consents: [{ channel: 'EMAIL', purpose: 'SUPPORT_CONVERSATION' }, { channel: 'SMS', purpose: 'OPERATIONAL', withdraw: 'Công ty đề nghị chỉ nhận thông tin qua thư điện tử' }],
  },
  {
    key: 'ly-van-hung', name: 'Lý Văn Hùng - Công ty Cổ phần Đại Phát', classification: 'CONTRACTOR_STAFF',
    identities: [{ channel: 'EMAIL', value: 'hungly@congtydaiphat-cb.vn', verify: 'Giấy giới thiệu số 08/GT-ĐP ngày 15/09/2026' }, { channel: 'ZALO', value: 'lyvanhung_dp' }],
    consents: [{ channel: 'EMAIL', purpose: 'ANNOUNCEMENT' }],
  },
  {
    key: 'ma-thi-lan', name: 'Mã Thị Lan', classification: 'CITIZEN',
    identities: [{ channel: 'PHONE', value: '0975 440 216', verify: 'Phiếu xác minh trực tiếp tại bộ phận một cửa số 118' }, { channel: 'ZALO', value: 'malan.thucphan' }],
    consents: [{ channel: 'SMS', purpose: 'SUPPORT_CONVERSATION' }],
  },
  {
    key: 'nong-van-tuan', name: 'Nông Văn Tuấn - UBND phường Nùng Trí Cao', classification: 'AGENCY_STAFF',
    identities: [{ channel: 'EMAIL', value: 'tuannv@nungtricao.caobang.gov.vn', verify: 'Công văn giới thiệu số 22/UBND ngày 02/10/2026' }],
    consents: [{ channel: 'EMAIL', purpose: 'REMINDER' }, { channel: 'EMAIL', purpose: 'ANNOUNCEMENT', withdraw: 'Đổi địa chỉ thư điện tử nhận thông báo của phường' }],
  },
  {
    key: 'tran-quoc-bao', name: 'Trần Quốc Bảo', classification: 'CITIZEN',
    identities: [{ channel: 'PHONE', value: '0966 120 874' }, { channel: 'EMAIL', value: 'tranquocbao.cb@gmail.com' }],
  },
  {
    key: 'vi-thi-hue', name: 'Vi Thị Huệ - Công ty TNHH Tư vấn Giám sát Cao Bằng', classification: 'CONTRACTOR_STAFF',
    identities: [{ channel: 'EMAIL', value: 'huevt@giamsatcaobang.vn', verify: 'Giấy giới thiệu số 03/GT-GS ngày 20/08/2026' }],
    consents: [{ channel: 'EMAIL', purpose: 'OPERATIONAL' }],
  },
];

/** OMNI-03, OMNI-04: the directory of people outside the Department, with the proofs of their identities and the consents they gave or took back. */
async function makeContacts(ctx: SeedContext): Promise<void> {
  for (const spec of CONTACTS) {
    await once(ctx, `omni.contact.${spec.key}`, async () => {
      const existing = await ctx.find(SUPERVISOR, '/resources/contact', (row) => row.display_name === spec.name);
      if (existing !== undefined) return String(existing.id);
      const created = await ctx.command(SUPERVISOR, '/contacts', { display_name: spec.name, classification: spec.classification });
      for (const identity of spec.identities) {
        const added = await ctx.command(SUPERVISOR, `/contacts/${created.resource_id}/identities`, { channel: identity.channel, external_id: identity.value });
        if (identity.verify !== undefined) {
          await ctx.command(SUPERVISOR, `/contacts/${created.resource_id}/identities/${added.resource_id}/verify`, { method: 'ADMIN_DOCUMENT', document_ref: identity.verify }, { version: added });
        }
      }
      for (const consent of spec.consents ?? []) {
        const given = await ctx.attempt(SUPERVISOR, 'POST', `/contacts/${created.resource_id}/consents`, { channel: consent.channel, purpose: consent.purpose, consent_text_version: 'v2026.1', capture_method: 'WEB_FORM', evidence_reference: `Phiếu đồng ý nhận tin ${spec.key}` });
        if (given.ok && consent.withdraw !== undefined) await ctx.must(SUPERVISOR, 'POST', `/contact-consents/${given.json.resource_id}/withdraw`, { reason: consent.withdraw }, { version: given.json.resource_version as number });
      }
      made(ctx, 'OMNI', 'contact', spec.key, `${spec.classification}, ${spec.identities.length} identities`, { id: created.resource_id, screen: 'OMNI-03' });
      return created.resource_id;
    });
  }
}

// ---- the agents work -----------------------------------------------------------------------------------------------------------------

async function freshVersion(ctx: SeedContext, conversationId: string): Promise<number> {
  return Number((await ctx.get<Obj>(SUPERVISOR, `/resources/conversation/${conversationId}`)).version);
}

/** The contact of a conversation gets a verified e-mail and a consent to be written to, so that an agent may answer (BR-NOT-07). */
async function readyToAnswer(ctx: SeedContext, conversation: Obj, thread: Thread): Promise<void> {
  const contactId = String(conversation.contact_id);
  const contact = await ctx.get<Obj>(SUPERVISOR, `/resources/contact/${contactId}`);
  const identities = (contact.identities as Obj[] | undefined) ?? [];
  const email = identities.find((identity) => identity.channel === 'EMAIL');
  if (email !== undefined && email.status !== 'Verified') {
    await ctx.attempt(SUPERVISOR, 'POST', `/contacts/${contactId}/identities/${email.id}/verify`, { method: 'ADMIN_DOCUMENT', document_ref: `Phiếu xác minh qua thư điện tử số ${thread.key.slice(1)}/2026` }, { version: Number(email.version) });
  }
  await ctx.attempt(SUPERVISOR, 'POST', `/contacts/${contactId}/consents`, { channel: 'EMAIL', purpose: 'SUPPORT_CONVERSATION', consent_text_version: 'v2026.1', capture_method: 'CHANNEL_OPT_IN', evidence_reference: `Thư của ${thread.name} ngày ${ctx.day(-thread.daysAgo)}` });
}

const ANSWERS: Record<string, string> = {
  t01: 'Kính gửi bà Lê Thị Hòa, phương án bồi thường dự án đường tỉnh 205 hiện do Hội đồng bồi thường phường Thục Phán hoàn thiện sau kiểm đếm. Dự kiến niêm yết công khai trong tháng 11. Chúng tôi sẽ thông báo khi có kết quả.',
  t02: 'Kính gửi Công ty Đông Lan, hồ sơ thanh toán đợt 2 đã được chủ đầu tư kiểm tra và chuyển Kho bạc Nhà nước Cao Bằng kiểm soát chi. Thời hạn xử lý theo quy định là 04 ngày làm việc.',
  t03: 'Kính gửi anh Hoàng Văn Sơn, cột lũy kế ghi theo năm kế hoạch vốn đang thực hiện. Mẫu báo cáo đã được gửi kèm thư này.',
  t09: 'Kính gửi ông Trịnh Văn Bảo, thông tin tổng mức đầu tư và nguồn vốn của dự án được công khai theo Luật Đầu tư công. Dự án Nâng cấp Trạm y tế phường Tân Giang có tổng mức đầu tư 12 tỷ đồng từ ngân sách tỉnh.',
};

async function agentsWork(ctx: SeedContext): Promise<void> {
  const mail = await ctx.find(SUPERVISOR, '/resources/channel_account', (row) => row.external_account_id === MAIL.externalId);
  if (mail === undefined || mail.status !== 'Active') return;
  const projects = await ctx.list(SUPERVISOR, '/projects').catch(() => [] as Obj[]);
  const roadProject = projects.find((project) => String(project.code ?? '') === 'DA-DT205');
  for (const thread of THREADS) {
    await once(ctx, `omni.work.${thread.key}`, async () => {
      if (thread.flow === 'NEW') return { done: 'new' };
      const conversation = await conversationOf(ctx, thread);
      const id = String(conversation.id);
      if (thread.assignee !== undefined) {
        await ctx.command(SUPERVISOR, `/conversations/${id}/assign`, { assignee_membership_id: ctx.person(thread.assignee).membershipId, reason: 'Phân công theo nội dung và đơn vị phụ trách' }, { version: await freshVersion(ctx, id) });
      }
      if (thread.flow === 'ASSIGNED') return { done: 'assigned' };
      if (thread.flow === 'NOTE' || thread.flow === 'ISSUE') {
        await ctx.command(AGENT, `/conversations/${id}/messages`, { kind: 'INTERNAL_NOTE', channel_account_id: String(mail.id), text: thread.flow === 'NOTE' ? 'Đã trao đổi với chủ đầu tư: lịch nghiệm thu dự kiến thứ Năm tuần này, cần Ban QLDA xác nhận thành phần tham dự.' : 'Phản ánh hợp lý, cần nhắc nhà thầu che chắn và tưới nước giảm bụi. Chuyển thành vướng mắc của dự án để theo dõi xử lý.' }, { version: await freshVersion(ctx, id) });
      }
      if (thread.flow === 'ISSUE') {
        if (roadProject !== undefined) {
          await ctx.attempt(AGENT, 'POST', `/conversations/${id}/links`, { resource_type: 'project', resource_id: String(roadProject.id) }, { version: await freshVersion(ctx, id) });
          const options = await ctx.attempt<{ issue_types?: string[]; projects?: Obj[] }>(AGENT, 'GET', '/conversation-conversion-options');
          const issueType = String((options.json.issue_types ?? [])[0] ?? 'ENVIRONMENT');
          await ctx.attempt(AGENT, 'POST', `/conversations/${id}/issues`, { project_id: String(roadProject.id), issue_type: issueType, summary: 'Người dân phản ánh bụi và tiếng ồn từ xe chở vật liệu đoạn gần cổng trường mầm non', due_date: ctx.day(7) }, { version: await freshVersion(ctx, id) });
        } else ctx.warn('the project DA-DT205 is not there: the conversation t04 is not turned into an issue');
        return { done: 'issue' };
      }
      if (thread.flow === 'ANSWERED' || thread.flow === 'RESOLVED' || thread.flow === 'REOPENED') {
        await readyToAnswer(ctx, conversation, thread);
        await ctx.attempt(AGENT, 'POST', `/conversations/${id}/messages`, { kind: 'EXTERNAL', channel_account_id: String(mail.id), purpose: 'SUPPORT_CONVERSATION', text: ANSWERS[thread.key] ?? 'Sở Kế hoạch và Đầu tư đã tiếp nhận và sẽ phản hồi.' }, { version: await freshVersion(ctx, id) });
      }
      if (thread.flow === 'RESOLVED' || thread.flow === 'REOPENED') {
        await ctx.attempt(AGENT, 'POST', `/conversations/${id}/resolve`, { reason: 'Đã trả lời đầy đủ nội dung đề nghị của người gửi' }, { version: await freshVersion(ctx, id) });
      }
      return { done: thread.flow };
    });
  }
  made(ctx, 'OMNI', 'work', 'agents', 'conversations assigned, answered, noted, linked, resolved', { screen: 'OMNI-02' });
}

/** The second message of thread t03 arrives after the conversation was resolved: it reopens by itself (the agents then see it in the queue again). */
async function followUp(ctx: SeedContext): Promise<void> {
  await once(ctx, 'omni.follow-up', async () => {
    const thread = THREADS.find((candidate) => candidate.key === 't03');
    if (thread === undefined) return {};
    await write(ctx, thread, 5, 'Xin lỗi, tôi gửi nhầm phường: đề nghị gửi mẫu báo cáo cho cả phường Nùng Trí Cao theo cùng cách ghi lũy kế.', instant(ctx, 0, 8, 25));
    made(ctx, 'OMNI', 'conversation', 't03', 'a new message reopens a resolved conversation', { screen: 'OMNI-01' });
    return {};
  });
}

export async function seedOmni(ctx: SeedContext): Promise<void> {
  await ctx.step('OMNI', 'channel accounts (OMNI-05, OMNI-06)', () => connectAccounts(ctx));
  await ctx.step('OMNI', 'routing policy and SLA (OMNI-07)', () => publishRouting(ctx));
  await ctx.step('OMNI', 'canned replies (OMNI-08)', () => cannedReplies(ctx));
  await ctx.step('OMNI', 'contacts, identities, consents (OMNI-03, OMNI-04)', () => makeContacts(ctx));
  await ctx.step('OMNI', 'messages from the provider webhook (OMNI-01, OMNI-11)', () => receiveMessages(ctx));
  await ctx.step('OMNI', 'agents assign, answer, link, convert, resolve (OMNI-02, OMNI-09)', () => agentsWork(ctx));
  await ctx.step('OMNI', 'a follow-up reopens a conversation', () => followUp(ctx));
}
