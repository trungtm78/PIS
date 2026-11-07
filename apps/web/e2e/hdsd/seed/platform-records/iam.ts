import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { made, once } from './shared.ts';

/**
 * IAM for the guide: what a person of the provincial tenant does for themselves. The first step is a plain fact of the product, not a story: every
 * member of a tenant holds the system role MEMBER (inbox, profile, sessions, help desk). The seven people of the guide were given the roles of their
 * work only, so the owner of the tenant grants MEMBER to the ones who lack it, through the command of ADM-03; after that every one of them has an
 * inbox (NOT-01), a profile (IAM-05), devices and sessions (IAM-06) and may ask for help (IAM-08).
 */

/** Phones of the people, in the numbering of Vietnam (a mobile number of a provincial official). */
const PROFILES: Record<string, { phone: string }> = {
  owner: { phone: '+84912340001' },
  unitAdmin: { phone: '+84912340002' },
  projectManager: { phone: '+84912340003' },
  capApprover: { phone: '+84912340004' },
  treasuryMaker: { phone: '+84912340005' },
  auditor: { phone: '+84912340006' },
  nobody: { phone: '+84912340007' },
};

/** The devices of the people: the phone each one carries the application on. */
const DEVICES: Array<{ person: string; id: string; platform: 'ios' | 'android'; version: string }> = [
  { person: 'projectManager', id: 'cb-pm-pixel-7', platform: 'android', version: '1.4.2' },
  { person: 'projectManager', id: 'cb-pm-ipad-office', platform: 'ios', version: '1.4.2' },
  { person: 'capApprover', id: 'cb-ld-iphone-14', platform: 'ios', version: '1.4.2' },
  { person: 'owner', id: 'cb-ch-galaxy-s23', platform: 'android', version: '1.4.1' },
  { person: 'treasuryMaker', id: 'cb-kt-redmi-note-12', platform: 'android', version: '1.4.2' },
  { person: 'unitAdmin', id: 'cb-qt-iphone-13', platform: 'ios', version: '1.4.0' },
  { person: 'nobody', id: 'cb-tv-galaxy-a54', platform: 'android', version: '1.3.9' },
];

/** The help desk: what the people ask the operator of the platform (IAM-08). Each is written by the person who would write it. */
const TICKETS: Array<{ person: string; category: 'ACCESS' | 'DATA' | 'BILLING' | 'INCIDENT' | 'HOWTO' | 'OTHER'; subject: string; description: string }> = [
  {
    person: 'nobody',
    category: 'ACCESS',
    subject: 'Không vào được màn hình Báo cáo giải ngân tuần',
    description: 'Từ sáng thứ Hai tôi mở mục Báo cáo giải ngân thì hệ thống báo không đủ quyền, trong khi tuần trước vẫn xem được. Nhờ kiểm tra lại phạm vi quyền của tài khoản Đỗ Thị Hà, Văn phòng Sở Kế hoạch và Đầu tư.',
  },
  {
    person: 'projectManager',
    category: 'HOWTO',
    subject: 'Hướng dẫn nhập hàng loạt danh mục địa bàn từ tệp Excel',
    description: 'Ban Quản lý dự án cần nhập thêm 14 xã thuộc huyện Hà Quảng từ tệp của Sở Nội vụ. Nhờ hướng dẫn mẫu tệp và các cột bắt buộc để lô nhập không bị từ chối.',
  },
  {
    person: 'treasuryMaker',
    category: 'DATA',
    subject: 'Số liệu giải ngân tháng 10 chưa khớp với sao kê Kho bạc',
    description: 'Tổng giải ngân tháng 10 trên hệ thống thấp hơn sao kê Kho bạc Nhà nước Cao Bằng khoảng 2,4 tỷ đồng. Đề nghị kiểm tra lô đối soát nhập ngày 28/10 và cho biết dòng nào chưa được ghép.',
  },
  {
    person: 'capApprover',
    category: 'INCIDENT',
    subject: 'Ký số văn bản bị treo ở bước chờ xác nhận OTP',
    description: 'Sáng nay lãnh đạo Sở ký quyết định giao kế hoạch vốn nhưng màn hình dừng ở bước nhập mã OTP, không có tin nhắn gửi về điện thoại. Cần xử lý gấp vì quyết định phải ban hành trong ngày.',
  },
  {
    person: 'unitAdmin',
    category: 'BILLING',
    subject: 'Đề nghị xuất hóa đơn điện tử quý III cho Sở Kế hoạch và Đầu tư',
    description: 'Phòng Kế hoạch - Tài chính của Sở cần hóa đơn điện tử cho kỳ thanh toán quý III với đúng mã số thuế đơn vị. Nhờ kiểm tra thông tin người mua trên hóa đơn.',
  },
  {
    person: 'auditor',
    category: 'OTHER',
    subject: 'Đề nghị cấp quyền xuất nhật ký kiểm toán cho đoàn kiểm toán nhà nước',
    description: 'Đoàn kiểm toán dự kiến làm việc từ tuần sau, cần xuất nhật ký kiểm toán giai đoạn 01/2026 đến 10/2026. Đề nghị hướng dẫn thủ tục và thời hạn xử lý yêu cầu.',
  },
  {
    person: 'owner',
    category: 'ACCESS',
    subject: 'Thêm cán bộ mới của Ban Quản lý dự án vào hệ thống',
    description: 'Ban Quản lý dự án vừa tiếp nhận hai cán bộ theo quyết định điều động. Nhờ hướng dẫn quy trình mời thành viên và gán vai trò cho đúng phạm vi đơn vị.',
  },
];

/** Gives every person of the guide the role MEMBER on the whole tenant (the owner grants it), unless they already hold it. */
export async function grantMemberRoles(ctx: SeedContext): Promise<void> {
  await once(ctx, 'iam.member-role', async () => {
    const roles = await ctx.list('owner', '/resources/role_definition');
    const member = roles.find((role) => role.code === 'MEMBER');
    if (member === undefined) throw new Error('the system role MEMBER does not exist in the tenant');
    const grants = await ctx.list('owner', '/resources/role_grant');
    let granted = 0;
    for (const person of Object.values(ctx.people)) {
      const holds = grants.some((grant) => grant.membership_id === person.membershipId && grant.role_id === member.id && (grant.status === undefined || grant.status === 'Active'));
      if (holds) continue;
      await ctx.command('owner', '/role-grants', {
        membership_id: person.membershipId,
        role_id: member.id,
        scope_kind: 'TENANT',
        reason: `Cán bộ ${person.name} là thành viên của hệ thống: cần hộp thông báo, hồ sơ cá nhân và yêu cầu hỗ trợ`,
      });
      granted += 1;
    }
    made(ctx, 'IAM', 'role-grant', 'MEMBER', `granted to ${granted} people`, { screen: 'ADM-03' });
    return { granted };
  });
}

/** IAM-05: each person keeps their profile (language, time zone, phone). */
async function updateProfiles(ctx: SeedContext): Promise<void> {
  await once(ctx, 'iam.profiles', async () => {
    for (const [key, profile] of Object.entries(PROFILES)) {
      const current = await ctx.get<Obj>(key, '/me/profile');
      await ctx.must(key, 'PUT', '/me/profile', { locale: 'vi-VN', time_zone: 'Asia/Ho_Chi_Minh', phone_e164: profile.phone }, { version: Number(current.version ?? 1) });
    }
    made(ctx, 'IAM', 'profile', 'me/profile', `${Object.keys(PROFILES).length} profiles completed`, { screen: 'IAM-05' });
    return { people: Object.keys(PROFILES).length };
  });
}

/** IAM-06 and NOT-14: the phones that carry the application (a device registers its push token the way the mobile application does). */
async function registerDevices(ctx: SeedContext): Promise<void> {
  await once(ctx, 'iam.devices', async () => {
    for (const device of DEVICES) {
      await ctx.command(device.person, '/devices', {
        device_public_id: device.id,
        platform: device.platform,
        push_token: `${device.platform === 'ios' ? 'apns' : 'fcm'}:${device.id}:${ctx.sha256(Buffer.from(device.id)).slice(0, 48)}`,
        permission_state: 'granted',
        app_version: device.version,
        locale: 'vi-VN',
      });
    }
    made(ctx, 'IAM', 'device', 'devices', `${DEVICES.length} devices registered`, { screen: 'IAM-06' });
    return { devices: DEVICES.length };
  });
}

/** IAM-08: the requests for help of the people. */
async function raiseTickets(ctx: SeedContext): Promise<void> {
  await once(ctx, 'iam.tickets', async () => {
    for (const ticket of TICKETS) {
      const reply = await ctx.command(ticket.person, '/support-tickets', { category: ticket.category, subject: ticket.subject, description: ticket.description });
      made(ctx, 'IAM', 'support-ticket', ticket.category, ticket.subject, { id: reply.resource_id, screen: 'IAM-08' });
    }
    return { tickets: TICKETS.length };
  });
}

/** IAM-06: the sessions of a person exist only where the person signed in with the identity provider; the dev token of the seed opens none. Logged, not faked. */
async function noteSessions(ctx: SeedContext): Promise<void> {
  const sessions = await ctx.get<Obj>('projectManager', '/me/sessions');
  const count = Array.isArray(sessions.items) ? sessions.items.length : 0;
  made(ctx, 'IAM', 'session', 'me/sessions', `${count} real sessions (made by signing in through the identity provider, not by the seed)`, { screen: 'IAM-06' });
}

export async function seedIam(ctx: SeedContext): Promise<void> {
  await ctx.step('IAM', 'every person holds the role MEMBER', () => grantMemberRoles(ctx));
  await ctx.step('IAM', 'profiles of the people (IAM-05)', () => updateProfiles(ctx));
  await ctx.step('IAM', 'devices registered (IAM-06, NOT-14)', () => registerDevices(ctx));
  await ctx.step('IAM', 'requests for help (IAM-08)', () => raiseTickets(ctx));
  await ctx.step('IAM', 'sessions (IAM-06)', () => noteSessions(ctx));
}
