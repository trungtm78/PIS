import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { made, once } from './shared.ts';
import TEXTS from './data/iam.json' with { type: 'json' };
import { textsOf } from '../../../support/texts.ts';

const tx = textsOf(TEXTS);

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
    subject: tx('subject.001'),
    description: tx('description.002'),
  },
  {
    person: 'projectManager',
    category: 'HOWTO',
    subject: tx('subject.003'),
    description: tx('description.004'),
  },
  {
    person: 'treasuryMaker',
    category: 'DATA',
    subject: tx('subject.005'),
    description: tx('description.006'),
  },
  {
    person: 'capApprover',
    category: 'INCIDENT',
    subject: tx('subject.007'),
    description: tx('description.008'),
  },
  {
    person: 'unitAdmin',
    category: 'BILLING',
    subject: tx('subject.009'),
    description: tx('description.010'),
  },
  {
    person: 'auditor',
    category: 'OTHER',
    subject: tx('subject.011'),
    description: tx('description.012'),
  },
  {
    person: 'owner',
    category: 'ACCESS',
    subject: tx('subject.013'),
    description: tx('description.014'),
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
        reason: tx('reason.015', person.name),
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
