import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { APP_FILTER } from '@nestjs/core';
import { Client } from 'pg';
import { AuditWriter, EffectiveAccessStore, InMemoryAuthzCache, NotificationCampaignStore, TenantDatabase } from '@machvon/db';
import { featureOf, loadErrorRegistry, signTenantContext } from '@machvon/kernel';
import { CommandModule } from '../../src/command.module';
import { CampaignsController } from '../../src/notifications/campaigns/campaigns.controller';
import { ChannelAdapterRegistry, InMemoryChannelAdapter } from '../../src/notifications/delivery/channel-adapters';
import { DeliveryDispatcher } from '../../src/notifications/delivery/dispatcher';
import { DELIVERY_ENGINE } from '../../src/notifications/delivery/tokens';
import { PermissionResourceAccess } from '../../src/notifications/resource-access-port';
import { createDeliveryEngine } from '../../src/notifications/delivery/wiring';
import { PolicyModule } from '../../src/policy.module';
import { ProblemFilter } from '../../src/problem.filter';
import { AuthzHarness, TENANT_A, TENANT_B, id, memberId, unitId } from '../../../../packages/db/test/support/authz-fixtures';
import { TENANT_HEADER } from '../isolation/test-auth.guard';
import { ERROR_CODES_PATH, startTestApp } from '../isolation/test-app';
import type { RunningApp } from '../isolation/test-app';

const SIGNING_KEY = randomBytes(32);
const MAKER = 1; // makes and approves (the role of NOTIFICATION_ADMIN holds both), on the whole tenant
const CHECKER = 2; // approves and reads, on the whole tenant
const SCOPED = 3; // makes within the unit 2 only
const NOBODY = 4;
const READER = 5; // reads the campaigns of the whole tenant
const SECOND_HAT = 6; // the same person as MAKER, with a membership of its own, holds the approval
const UNIT_ONLY_MAKER = 7; // makes within the unit 2 alone, not within the units below it
const OTHER_TENANT_MAKER = 1;
const ACTOR = '00000000-0000-4000-8000-0000000000f0';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e2';
const INBOX_TEMPLATE = '00000000-0000-4000-8000-0000000000e3';
const RETIRED_TEMPLATE = '00000000-0000-4000-8000-0000000000e4';
const SMS_TEMPLATE = '00000000-0000-4000-8000-0000000000e5';
const ONE_SHOT_TEMPLATE = '00000000-0000-4000-8000-0000000000e6';
const PUSH_TEMPLATE = '00000000-0000-4000-8000-0000000000e7';
const VARIABLE_TEMPLATE = '00000000-0000-4000-8000-0000000000e8';
const REASON = 'The holiday notice for the staff of the unit.';
const FIRST_RECIPIENT = 100;
const RECIPIENTS = 130;
const OPTED_OUT = 10;

interface Reply {
  status: number;
  json: Record<string, unknown>;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('broadcast campaigns with preview and maker-checker (ST-NOT-009, NOT-09, NOT-10, NOT-16)', () => {
  const harness = new AuthzHarness();
  const campaigns = new NotificationCampaignStore();
  let app: RunningApp;
  // The plan of the tenant: false is a plan without the feature `notification.campaign`, or one in grace or expired (the gate denies the feature then).
  let entitled = true;

  const tokenOf = (member: number, tenantId = TENANT_A): string => signTenantContext({ tenantId, membershipId: memberId(member), scopeVersion: 1 }, SIGNING_KEY);
  const rows = <R extends object>(sql: string, params: unknown[] = [], tenant = TENANT_A): Promise<R[]> => harness.owner<R>(tenant, [[sql, params]]);

  async function call(method: 'GET' | 'POST', url: string, options: { member?: number; tenantId?: string; body?: unknown; ifMatch?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { [TENANT_HEADER]: tokenOf(options.member ?? MAKER, options.tenantId), 'content-type': 'application/json' };
    if (method === 'POST') headers['idempotency-key'] = `key-${randomUUID()}`;
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch;
    const response = await fetch(`${app.baseUrl}${url}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}) });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  const draftBody = (change: Record<string, unknown> = {}) => ({
    name: 'Holiday notice',
    purpose: 'ANNOUNCEMENT',
    template_version_id: TEMPLATE,
    segment: { unit_ids: [unitId(2)] },
    ...change,
  });
  const create = (change: Record<string, unknown> = {}, member = MAKER) => call('POST', '/notification-campaigns', { member, body: draftBody(change) });
  const version = async (campaignId: string): Promise<number> => Number((await rows<{ version: string }>('select version::text as version from machvon.notification_campaign where id = $1', [campaignId]))[0]?.version);
  const preview = async (campaignId: string, member = MAKER) => call('POST', `/notification-campaigns/${campaignId}/preview`, { member, ifMatch: `"${await version(campaignId)}"`, body: { reason: REASON } });
  const submit = async (campaignId: string, hash: string, member = MAKER) => call('POST', `/notification-campaigns/${campaignId}/submit`, { member, ifMatch: `"${await version(campaignId)}"`, body: { preview_hash: hash } });
  const decide = async (campaignId: string, decision: 'approve' | 'return' | 'reject', member = CHECKER) =>
    call('POST', `/notification-campaigns/${campaignId}/decision`, { member, ifMatch: `"${await version(campaignId)}"`, body: { decision, reason: 'Checked against the notice.', evidence_ids: [] } });
  const cancel = async (campaignId: string, member = MAKER) => call('POST', `/notification-campaigns/${campaignId}/cancel`, { member, ifMatch: `"${await version(campaignId)}"`, body: { reason: REASON } });
  const statusOf = async (campaignId: string): Promise<string> => (await rows<{ status: string }>('select status from machvon.notification_campaign where id = $1', [campaignId]))[0]?.status ?? '';

  /** A campaign made, previewed and sent to approval; returns its id and the hash. */
  async function pending(change: Record<string, unknown> = {}): Promise<{ campaignId: string; hash: string }> {
    const made = await create(change);
    expect(made.status).toBe(201);
    const campaignId = made.json.resource_id as string;
    const shown = await preview(campaignId);
    expect(shown.status).toBe(200);
    const hash = shown.json.preview_hash as string;
    expect((await submit(campaignId, hash)).status).toBe(200);
    return { campaignId, hash };
  }

  const seedPeople = async (numbers: readonly number[], unit: number, options: { status?: string } = {}): Promise<void> => {
    for (const n of numbers) await harness.seedMembership(TENANT_A, n, unit, { validFrom: '2026-01-01T00:00:00Z', ...(options.status === undefined ? {} : { status: options.status }) });
  };
  const grantConsent = (members: readonly number[]): Promise<unknown[]> =>
    rows(
      `insert into machvon.contact_consent (tenant_id, id, contact_id, membership_id, channel, purpose, status, evidence_reference, effective_at, legal_basis, consent_text_version, capture_method)
       select $1, gen_random_uuid(), null, m, 'EMAIL', 'ANNOUNCEMENT', 'Granted', 'test:' || m::text, now() - interval '1 day', 'CONSENT', 'v1', 'IN_APP' from unnest($2::uuid[]) as m`,
      [TENANT_A, members.map(memberId)],
    );
  const optOut = (members: readonly number[]): Promise<unknown[]> =>
    rows(
      `insert into machvon.notification_preference (tenant_id, id, membership_id, event_category, channel, enabled) select $1, gen_random_uuid(), m, 'campaign', 'EMAIL', false from unnest($2::uuid[]) as m`,
      [TENANT_A, members.map(memberId)],
    );
  const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index);

  beforeAll(async () => {
    await harness.start();
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedUnits(tenant, [
        { n: 1, path: `/${unitId(1)}/` },
        { n: 2, path: `/${unitId(1)}/${unitId(2)}/`, parent: 1 },
        { n: 3, path: `/${unitId(1)}/${unitId(3)}/`, parent: 1 },
        { n: 4, path: `/${unitId(1)}/${unitId(4)}/`, parent: 1 },
        { n: 5, path: `/${unitId(1)}/${unitId(5)}/`, parent: 1 },
        { n: 6, path: `/${unitId(1)}/${unitId(2)}/${unitId(6)}/`, parent: 2 },
      ]);
    }
    for (const member of [MAKER, CHECKER, SCOPED, NOBODY, READER]) await harness.seedMembership(TENANT_A, member, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_A, SECOND_HAT, 3, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_A, UNIT_ONLY_MAKER, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_B, OTHER_TENANT_MAKER, 1, { validFrom: '2026-01-01T00:00:00Z' });
    // The second hat is a second membership of the user of MAKER: the maker-checker rule is about people.
    await rows('update machvon.membership set user_id = $2 where id = $1', [memberId(SECOND_HAT), id(0x60, MAKER)]);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await harness.seedRole(tenant, 1, 'CAMPAIGN_ADMIN', ['notification.campaign.manage', 'notification.campaign.approve', 'notification.campaign.read'], 50);
      await harness.seedRole(tenant, 2, 'CAMPAIGN_APPROVER', ['notification.campaign.approve', 'notification.campaign.read'], 50);
      await harness.seedRole(tenant, 3, 'CAMPAIGN_MAKER', ['notification.campaign.manage'], 40);
      await harness.seedRole(tenant, 4, 'CAMPAIGN_READER', ['notification.campaign.read'], 10);
    }
    await harness.seedGrants(TENANT_A, [
      { n: 1, member: MAKER, role: 1, kind: 'TENANT' },
      { n: 2, member: CHECKER, role: 2, kind: 'TENANT' },
      { n: 3, member: SCOPED, role: 3, kind: 'UNIT_SUBTREE', refs: [unitId(2)] },
      { n: 4, member: READER, role: 4, kind: 'TENANT' },
      { n: 5, member: SECOND_HAT, role: 2, kind: 'TENANT' },
      { n: 6, member: UNIT_ONLY_MAKER, role: 3, kind: 'UNIT_ONLY', refs: [unitId(2)] },
    ]);
    await harness.seedGrants(TENANT_B, [{ n: 1, member: OTHER_TENANT_MAKER, role: 1, kind: 'TENANT' }]);
    // The people of the unit 2: 130 of them have an e-mail consent for announcements, ten of them turned the e-mail off for campaigns.
    await seedPeople(range(FIRST_RECIPIENT, RECIPIENTS), 2);
    await grantConsent(range(FIRST_RECIPIENT, RECIPIENTS));
    await optOut(range(FIRST_RECIPIENT, OPTED_OUT));
    await harness.owner(TENANT_A, [
      [
        `insert into machvon.channel_account (tenant_id, id, channel, external_account_id, credential_secret_ref, capability_version, status, verified_at, webhook_secret_ref, display_name)
         values ($1, $2, 'EMAIL', 'mail-1', 'secret://t/x', 'v1', 'Active', now(), 'secret://t/y', 'Mail')`,
        [TENANT_A, id(0xd0, 1)],
      ],
      ...[
        [TEMPLATE, 'campaign.notice', 'EMAIL', 'Active'],
        [INBOX_TEMPLATE, 'campaign.inbox', 'IN_APP', 'Active'],
        [RETIRED_TEMPLATE, 'campaign.old', 'EMAIL', 'Retired'],
        [SMS_TEMPLATE, 'campaign.sms', 'SMS', 'Active'],
        [ONE_SHOT_TEMPLATE, 'campaign.oneshot', 'EMAIL', 'Active'],
        [PUSH_TEMPLATE, 'campaign.push', 'PUSH_FCM', 'Active'],
      ].map(([templateId, code, channel, status]): [string, unknown[]] => [
        `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by, lockscreen_safe)
         values ($1, $2, $3, $4, 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, $5, $6, $7, $4 like 'PUSH%')`,
        [TENANT_A, templateId, code, channel, status, sha(code as string), ACTOR],
      ]),
    ]);
    await rows(
      `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
       values ($1, $2, 'campaign.variable', 'EMAIL', 'vi-VN', 1, '{"body":"Dossier {{code}}"}'::jsonb, '{"type":"object","properties":{"code":{"type":"string"}}}'::jsonb, 'Active', $3, $4)`,
      [TENANT_A, VARIABLE_TEMPLATE, sha('campaign.variable'), ACTOR],
    );
    const tenants = harness.tenants as TenantDatabase;
    app = await startTestApp({
      signingKey: SIGNING_KEY,
      imports: [CommandModule.register({ database: tenants }), PolicyModule.register({ database: tenants, access: new EffectiveAccessStore(tenants, new InMemoryAuthzCache()), entitled: (_tenant, permission) => entitled || featureOf(permission) !== 'notification.campaign' })],
      controllers: [CampaignsController],
      providers: [
        { provide: TenantDatabase, useValue: tenants },
        { provide: DELIVERY_ENGINE, useValue: createDeliveryEngine(new AuditWriter(tenants)) },
        { provide: APP_FILTER, useValue: new ProblemFilter(loadErrorRegistry(ERROR_CODES_PATH)) },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  }, 60_000);

  it('AC-ST-NOT-009-1 UAT-AC30: a segment of 130 people with ten opt-outs is previewed as 120 with the reasons, the self-approval is 403 and the approval by the approver makes 120 notifications', async () => {
    const made = await create();
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ status: 'DRAFT', resource_version: 1 });
    const campaignId = made.json.resource_id as string;
    const shown = await preview(campaignId);
    expect(shown.status).toBe(200);
    expect(shown.json).toMatchObject({ recipient_count: 120, excluded: { opted_out: 10, no_consent: 0, inactive: 0, duplicate: 0 }, version: 2 });
    expect(shown.json.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    // The samples are masked: a letter and stars for each word of the name.
    expect(shown.json.sample_recipients_masked).toHaveLength(5);
    for (const sample of shown.json.sample_recipients_masked as string[]) expect(sample).toMatch(/^(\S\*\*\* ?)+$/);
    expect((await submit(campaignId, shown.json.preview_hash as string)).status).toBe(200);
    // The maker does not approve their own campaign, nor does the same person under another membership.
    const own = await decide(campaignId, 'approve', MAKER);
    expect(own.status).toBe(403);
    expect(own.json.code).toBe('SELF_APPROVAL_DENIED');
    expect((await decide(campaignId, 'approve', SECOND_HAT)).json.code).toBe('SELF_APPROVAL_DENIED');
    expect(await rows('select 1 from machvon.notification_instance where campaign_id = $1', [campaignId])).toHaveLength(0);
    const approved = await decide(campaignId, 'approve', CHECKER);
    expect(approved.status).toBe(200);
    expect(approved.json).toMatchObject({ status: 'SENDING' });
    const made120 = await rows<{ recipient_id: string; status: string; purpose: string; source_event_type: string; channel_plan: string[]; priority: string }>(
      'select recipient_id, status, purpose, source_event_type, channel_plan, priority from machvon.notification_instance where campaign_id = $1',
      [campaignId],
    );
    expect(made120).toHaveLength(120);
    expect(new Set(made120.map((row) => row.recipient_id)).size).toBe(120);
    // None of the ten who turned the e-mail off is among them.
    const outs = range(FIRST_RECIPIENT, OPTED_OUT).map(memberId);
    expect(made120.filter((row) => outs.includes(row.recipient_id))).toHaveLength(0);
    expect(made120[0]).toMatchObject({ status: 'Queued', purpose: 'ANNOUNCEMENT', source_event_type: 'campaign.broadcast', channel_plan: ['EMAIL'], priority: 'NORMAL' });
    // Each one has its first send on the pinned template, due at once.
    const attempts = await rows<{ template_version_id: string; next_retry_at: Date | null; status: string; attempt_no: number }>(
      'select a.template_version_id, a.next_retry_at, a.status, a.attempt_no from machvon.delivery_attempt a join machvon.notification_instance n on n.id = a.notification_id where n.campaign_id = $1',
      [campaignId],
    );
    expect(attempts).toHaveLength(120);
    expect(attempts.every((row) => row.template_version_id === TEMPLATE && row.next_retry_at === null && row.status === 'Queued' && row.attempt_no === 1)).toBe(true);
    const [row] = await rows<{ status: string; approved_by: string; decided_by: string; notification_count: number; preview_recipient_count: number; preview_excluded_count: number }>(
      'select status, approved_by, decided_by, notification_count, preview_recipient_count, preview_excluded_count from machvon.notification_campaign where id = $1',
      [campaignId],
    );
    expect(row).toMatchObject({ status: 'Sending', approved_by: memberId(CHECKER), decided_by: memberId(CHECKER), notification_count: 120, preview_recipient_count: 120, preview_excluded_count: 10 });
    // The trail has the steps, with counts and the hash and never a person; the event says the campaign was approved.
    const audit = await rows<{ action: string; safe_diff: Record<string, unknown> }>("select action, safe_diff from machvon.audit_event where resource_id = $1 and action like 'notification.campaign_%' order by occurred_at, id", [campaignId]);
    expect(audit.map((entry) => entry.action)).toEqual(['notification.campaign_created', 'notification.campaign_previewed', 'notification.campaign_submitted', 'notification.campaign_decided']);
    expect(JSON.stringify(audit)).not.toContain(memberId(FIRST_RECIPIENT + OPTED_OUT));
    expect(audit[3]?.safe_diff).toMatchObject({ decision: 'approve', recipient_count: 120, notification_count: 120 });
    const events = await rows<{ type: string; payload: Record<string, unknown> }>("select type, payload from machvon.outbox_event where aggregate_id = $1 and type = 'not.campaign.approved.v1'", [campaignId]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ campaign_id: campaignId, channel: 'EMAIL', recipient_count: 120 });
  }, 120_000);

  it('AC-ST-NOT-009-2 UAT-AC190: a person who opts out between the preview and the submit makes the preview stale (409 PREVIEW_STALE) until it is made again, and the same holds between the submit and the decision', async () => {
    const made = await create();
    const campaignId = made.json.resource_id as string;
    const first = await preview(campaignId);
    await optOut([FIRST_RECIPIENT + OPTED_OUT]);
    const stale = await submit(campaignId, first.json.preview_hash as string);
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('PREVIEW_STALE');
    expect(await statusOf(campaignId)).toBe('Previewed');
    // The preview made again shows 119 and is the one that can be sent to approval.
    const second = await preview(campaignId);
    expect(second.json).toMatchObject({ recipient_count: 119 });
    expect(second.json.preview_hash).not.toBe(first.json.preview_hash);
    expect((await submit(campaignId, second.json.preview_hash as string)).status).toBe(200);
    // A hash that is not the one previewed is stale too, even when the set has not moved.
    const other = await create();
    const otherId = other.json.resource_id as string;
    await preview(otherId);
    expect((await submit(otherId, 'f'.repeat(64))).json.code).toBe('PREVIEW_STALE');
    // After the submit the set moves again: the approval is for the set that was previewed, so the decision is refused and nothing is made.
    await optOut([FIRST_RECIPIENT + OPTED_OUT + 1]);
    const late = await decide(campaignId, 'approve');
    expect(late.status).toBe(409);
    expect(late.json.code).toBe('PREVIEW_STALE');
    expect(await statusOf(campaignId)).toBe('PendingApproval');
    expect(await rows('select 1 from machvon.notification_instance where campaign_id = $1', [campaignId])).toHaveLength(0);
  }, 120_000);

  it('counts each person left out under one reason: inactive, duplicate, opted out and without consent (also a withdrawn one)', async () => {
    await seedPeople([300, 301, 303, 304, 306], 4);
    await seedPeople([302], 4, { status: 'Suspended' });
    // The user of 300 also has a membership in the unit 5 (its id sorts after 300, so 300 is the one written to).
    await harness.owner(TENANT_A, [
      ['insert into machvon.membership (tenant_id, id, user_id, organization_id, status, valid_from) values ($1, $2, $3, $4, $5, now() - interval \'1 day\')', [TENANT_A, memberId(400), id(0x60, 300), unitId(5), 'Active']],
    ]);
    await grantConsent([300, 301, 302, 304, 306, 400]);
    await optOut([304]);
    await rows("update machvon.contact_consent set status = 'Withdrawn', revoked_at = clock_timestamp(), withdrawn_reason = 'asked', version = version + 1 where membership_id = $1", [memberId(306)]);
    const made = await create({ segment: { unit_ids: [unitId(4), unitId(5)] } });
    const shown = await preview(made.json.resource_id as string);
    expect(shown.json).toMatchObject({ recipient_count: 2, excluded: { inactive: 1, duplicate: 1, opted_out: 1, no_consent: 2 } });
    const view = await call('GET', `/notification-campaigns/${made.json.resource_id as string}`);
    // The units are named, so whoever approves sees which departments get the broadcast and not only how many.
    expect((view.json.segment as { units: unknown[] }).units).toEqual([{ id: unitId(4), name: 'Unit 4', code: 'U4' }, { id: unitId(5), name: 'Unit 5', code: 'U5' }]);
    expect(view.json).toMatchObject({ status: 'Previewed', recipient_count: 2, excluded: { inactive: 1, duplicate: 1, opted_out: 1, no_consent: 2 }, preview_hash: shown.json.preview_hash });
    // Guests are written to only when the segment says so (a contractor row, with the foreign keys to the documents off for the seeding).
    const seeder = new Client({ connectionString: harness.database.adminUrl });
    await seeder.connect();
    try {
      await seeder.query('set session_replication_role = replica');
      await seeder.query("insert into machvon.contractor (tenant_id, id, tax_identifier, legal_name, verification_status, profile_document_id) values ($1, $2, '0100000078', 'Campaign Builders', 'VERIFIED', $3)", [TENANT_A, id(0x80, 1), id(0x77, 4)]);
    } finally {
      await seeder.end();
    }
    await harness.owner(TENANT_A, [
      ['update machvon.membership set membership_type = $2, contractor_id = $3, valid_until = now() + interval \'30 days\' where id = $1', [memberId(301), 'GUEST_CONTRACTOR', id(0x80, 1)]],
    ]);
    expect((await preview(made.json.resource_id as string)).json).toMatchObject({ recipient_count: 1 });
    const withGuests = await create({ segment: { unit_ids: [unitId(4), unitId(5)], include_guests: true } });
    expect((await preview(withGuests.json.resource_id as string)).json).toMatchObject({ recipient_count: 2 });
  }, 120_000);

  it('refuses a segment that names nobody or a unit that is not there, a template that is not Active or is the inbox, and a time that is not ahead', async () => {
    expect((await create({ segment: {} })).json.code).toBe('SEGMENT_INVALID');
    expect((await create({ segment: { unit_ids: [id(0x10, 999)] } })).status).toBe(404);
    const retired = await create({ template_version_id: RETIRED_TEMPLATE });
    expect(retired.status).toBe(422);
    expect(retired.json.code).toBe('TEMPLATE_INVALID');
    expect((await create({ template_version_id: INBOX_TEMPLATE })).json.code).toBe('TEMPLATE_INVALID');
    expect((await create({ template_version_id: id(0xe0, 77) })).json.code).toBe('TEMPLATE_INVALID');
    expect((await create({ scheduled_at: new Date(Date.now() - 3_600_000).toISOString() })).json.code).toBe('VALIDATION_FAILED');
    expect((await create({ name: '' })).json.code).toBe('VALIDATION_FAILED');
    expect((await create({ purpose: 'MARKETING' })).json.code).toBe('VALIDATION_FAILED');
  });

  it('writes a push campaign for an operational purpose, which needs no consent, and refuses a template with variables, which a campaign has no event to fill', async () => {
    const push = await create({ template_version_id: PUSH_TEMPLATE, purpose: 'OPERATIONAL' });
    expect(push.status).toBe(201);
    const shown = await preview(push.json.resource_id as string);
    expect(shown.status).toBe(200);
    expect(shown.json).toMatchObject({ recipient_count: 130, excluded: { no_consent: 0, opted_out: 0 } });
    const withVariables = await create({ template_version_id: VARIABLE_TEMPLATE });
    expect(withVariables.status).toBe(422);
    expect(withVariables.json.code).toBe('TEMPLATE_INVALID');
  });

  it('keeps a maker within their scope: units inside it are fine, a unit outside it and a segment of roles alone are 403, and a person without the permission is 403', async () => {
    expect((await create({}, SCOPED)).status).toBe(201);
    const outside = await create({ segment: { unit_ids: [unitId(3)] } }, SCOPED);
    expect(outside.status).toBe(403);
    expect(outside.json.code).toBe('SCOPE_DENIED');
    expect((await create({ segment: { role_codes: ['STAFF'] } }, SCOPED)).status).toBe(403);
    expect((await create({ segment: { role_codes: ['STAFF'] } }, MAKER)).status).toBe(201);
    // A grant on the unit 2 alone does not reach the unit 6 below it, and a segment of the unit 2 reaches it: the subtree is judged, not the unit named.
    const unitOnly = await create({}, UNIT_ONLY_MAKER);
    expect(unitOnly.status).toBe(403);
    expect(unitOnly.json.code).toBe('SCOPE_DENIED');
    expect((await create({ segment: { unit_ids: [unitId(6)] } }, UNIT_ONLY_MAKER)).status).toBe(403);
    expect((await create({ segment: { unit_ids: [unitId(6)] } }, SCOPED)).status).toBe(201);
    expect((await create({}, NOBODY)).status).toBe(403);
    expect((await create({}, CHECKER)).status).toBe(403);
    // The approver and the maker are told apart by the permission: the maker alone cannot decide.
    const { campaignId } = await pending();
    expect((await decide(campaignId, 'approve', SCOPED)).status).toBe(403);
    expect((await decide(campaignId, 'approve', NOBODY)).status).toBe(403);
    expect(await statusOf(campaignId)).toBe('PendingApproval');
  }, 120_000);

  it('moves a campaign only the ways the table allows (409 CAMPAIGN_STATE_INVALID), asks for the version it saw (409 VERSION_CONFLICT, 428 without If-Match), sends back to a draft or rejects with the reason', async () => {
    const made = await create();
    const campaignId = made.json.resource_id as string;
    // A draft is not submitted without a preview, nor decided.
    expect((await submit(campaignId, 'a'.repeat(64))).json.code).toBe('CAMPAIGN_STATE_INVALID');
    expect((await decide(campaignId, 'approve')).json.code).toBe('CAMPAIGN_STATE_INVALID');
    // The version.
    const stale = await call('POST', `/notification-campaigns/${campaignId}/preview`, { ifMatch: '"7"', body: { reason: REASON } });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('VERSION_CONFLICT');
    expect((await call('POST', `/notification-campaigns/${campaignId}/preview`, { body: { reason: REASON } })).status).toBe(428);
    expect((await call('POST', `/notification-campaigns/${campaignId}/preview`, { ifMatch: `"${await version(campaignId)}"`, body: { reason: 'short' } })).json.code).toBe('VALIDATION_FAILED');
    // Sent back: the draft can be previewed and sent again; the decision is on the trail with its reason, and the maker did not make it.
    const shown = await preview(campaignId);
    await submit(campaignId, shown.json.preview_hash as string);
    expect((await preview(campaignId)).json.code).toBe('CAMPAIGN_STATE_INVALID');
    const sentBack = await decide(campaignId, 'return');
    expect(sentBack.json).toMatchObject({ status: 'DRAFT' });
    expect((await decide(campaignId, 'approve')).json.code).toBe('CAMPAIGN_STATE_INVALID');
    const again = await preview(campaignId);
    await submit(campaignId, again.json.preview_hash as string);
    expect((await decide(campaignId, 'return', MAKER)).json.code).toBe('SELF_APPROVAL_DENIED');
    const rejected = await decide(campaignId, 'reject');
    expect(rejected.json).toMatchObject({ status: 'REJECTED' });
    const [row] = await rows<{ decision_reason: string; decided_by: string; approved_by: string | null }>('select decision_reason, decided_by, approved_by from machvon.notification_campaign where id = $1', [campaignId]);
    expect(row).toMatchObject({ decision_reason: 'Checked against the notice.', decided_by: memberId(CHECKER), approved_by: null });
    // What ended is not cancelled, previewed or decided again.
    expect((await cancel(campaignId)).json.code).toBe('CAMPAIGN_STATE_INVALID');
    expect((await preview(campaignId)).json.code).toBe('CAMPAIGN_STATE_INVALID');
    expect((await decide(campaignId, 'approve')).json.code).toBe('CAMPAIGN_STATE_INVALID');
  }, 120_000);

  it('refuses the approval when the template has been retired or the channel has no Active account, and leaves the campaign waiting', async () => {
    // Three people with an SMS consent and no SMS account in the tenant.
    await rows(
      `insert into machvon.contact_consent (tenant_id, id, contact_id, membership_id, channel, purpose, status, evidence_reference, effective_at, legal_basis, consent_text_version, capture_method)
       select $1, gen_random_uuid(), null, m, 'SMS', 'ANNOUNCEMENT', 'Granted', 'test:sms:' || m::text, now() - interval '1 day', 'CONSENT', 'v1', 'IN_APP' from unnest($2::uuid[]) as m`,
      [TENANT_A, [120, 121, 122].map(memberId)],
    );
    const sms = await pending({ template_version_id: SMS_TEMPLATE, segment: { unit_ids: [unitId(2)] } });
    const noAccount = await decide(sms.campaignId, 'approve');
    expect(noAccount.status).toBe(422);
    expect(noAccount.json.code).toBe('CHANNEL_UNVERIFIED');
    expect(await statusOf(sms.campaignId)).toBe('PendingApproval');
    // A template retired after the submit is no template to send with.
    const { campaignId } = await pending({ template_version_id: ONE_SHOT_TEMPLATE });
    await rows("update machvon.notification_template_version set status = 'Retired' where id = $1", [ONE_SHOT_TEMPLATE]);
    expect((await decide(campaignId, 'approve')).json.code).toBe('TEMPLATE_INVALID');
    expect(await statusOf(campaignId)).toBe('PendingApproval');
    expect(await rows('select 1 from machvon.notification_instance where campaign_id = $1', [campaignId])).toHaveLength(0);
  }, 120_000);

  it('schedules the sends for the time of the campaign, moves it to Sending when the time comes and to Completed when nothing is waiting, and a cancel stops what is not sent', async () => {
    const at = new Date(Date.now() + 2 * 3_600_000);
    const { campaignId } = await pending({ scheduled_at: at.toISOString(), name: 'Scheduled notice' });
    const approved = await decide(campaignId, 'approve');
    expect(approved.json).toMatchObject({ status: 'SCHEDULED' });
    const due = await rows<{ next_retry_at: Date }>('select a.next_retry_at from machvon.delivery_attempt a join machvon.notification_instance n on n.id = a.notification_id where n.campaign_id = $1', [campaignId]);
    // Two more people opted out in the test before this one: 118 are written to.
    expect(due).toHaveLength(118);
    expect(due.every((row) => row.next_retry_at.getTime() === at.getTime())).toBe(true);
    const notified = await rows<{ scheduled_for: Date; expires_at: Date }>('select scheduled_for, expires_at from machvon.notification_instance where campaign_id = $1 limit 1', [campaignId]);
    expect(notified[0]?.scheduled_for.getTime()).toBe(at.getTime());
    expect(notified[0]?.expires_at.getTime()).toBe(at.getTime() + 7 * 86_400_000);
    // The clock: before the time nothing moves; at the time the campaign is Sending; while sends wait it is not Completed; when they have gone it is.
    const tenant = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
    const tick = (now: Date) => (harness.tenants as TenantDatabase).withTenant(tenant, (tx) => campaigns.progress(tx, now));
    expect(await tick(new Date(at.getTime() - 60_000))).toEqual({ started: 0, completed: 0 });
    expect(await tick(new Date(at.getTime() + 1_000))).toEqual({ started: 1, completed: 0 });
    expect(await statusOf(campaignId)).toBe('Sending');
    expect(await tick(new Date(at.getTime() + 2_000))).toEqual({ started: 0, completed: 0 });
    await rows("update machvon.notification_instance set status = 'Delivered' where campaign_id = $1", [campaignId]);
    expect(await tick(new Date(at.getTime() + 3_000))).toEqual({ started: 0, completed: 1 });
    expect(await statusOf(campaignId)).toBe('Completed');
    expect(await rows<{ completed_at: Date | null }>('select completed_at from machvon.notification_campaign where id = $1', [campaignId])).toMatchObject([{ completed_at: expect.any(Date) }]);

    // Cancelled while it waits: the notifications are Cancelled with their sends, and the campaign is Cancelled with the reason.
    const waiting = await pending({ scheduled_at: at.toISOString(), name: 'To cancel' });
    await decide(waiting.campaignId, 'approve');
    // One of them is already going out when the cancel comes.
    const [going] = await rows<{ id: string }>("select id from machvon.notification_instance where campaign_id = $1 order by id limit 1", [waiting.campaignId]);
    await rows("update machvon.notification_instance set status = 'Sending' where id = $1", [going?.id]);
    await rows("update machvon.delivery_attempt set status = 'Sending', sending_at = now(), next_retry_at = null where notification_id = $1", [going?.id]);
    const stopped = await cancel(waiting.campaignId);
    expect(stopped.json).toMatchObject({ status: 'CANCELLED' });
    const left = await rows<{ status: string; n: string }>('select status, count(*)::text as n from machvon.notification_instance where campaign_id = $1 group by status order by status', [waiting.campaignId]);
    expect(left).toEqual([{ status: 'Cancelled', n: '117' }, { status: 'Sending', n: '1' }]);
    expect(await rows("select 1 from machvon.delivery_attempt a join machvon.notification_instance n on n.id = a.notification_id where n.campaign_id = $1 and a.status = 'Queued'", [waiting.campaignId])).toHaveLength(0);
    const [ended] = await rows<{ status: string; cancelled_at: Date | null; decision_reason: string }>('select status, cancelled_at, decision_reason from machvon.notification_campaign where id = $1', [waiting.campaignId]);
    expect(ended).toMatchObject({ status: 'Cancelled', cancelled_at: expect.any(Date), decision_reason: REASON });
    // A campaign that is only a draft is cancelled too, and nothing was made.
    const draft = await create();
    expect((await cancel(draft.json.resource_id as string)).json).toMatchObject({ status: 'CANCELLED' });
  }, 180_000);

  it('does not deadlock a cancel with a claim of one of its notifications: both take the notification before its send', async () => {
    const at = new Date(Date.now() + 3 * 3_600_000);
    const { campaignId } = await pending({ scheduled_at: at.toISOString(), name: 'Cancel race' });
    expect((await decide(campaignId, 'approve')).json).toMatchObject({ status: 'SCHEDULED' });
    const [one] = await rows<{ id: string; attempt: string }>('select n.id, a.id as attempt from machvon.notification_instance n join machvon.delivery_attempt a on a.notification_id = n.id where n.campaign_id = $1 order by n.id limit 1', [campaignId]);
    const tenants = harness.tenants as TenantDatabase;
    const tenant = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    // What a claim does: the notification first, then its send.
    const claimer = tenants.withTenant(tenant, async (tx) => {
      await tx.query('select id from machvon.notification_instance where id = $1::uuid for update', [one?.id]);
      locked();
      await gate;
      await tx.query('select id from machvon.delivery_attempt where id = $1::uuid for update', [one?.attempt]);
    });
    await hasLock;
    const canceller = tenants.withTenant(tenant, (tx) => campaigns.cancelWaiting(tx, campaignId));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [, stopped] = await Promise.all([claimer, canceller]);
    expect(stopped.cancelled).toBe(118);
  }, 120_000);

  it('holds the notifications that are going out while it reads their versions, so the delivery engine cannot move one between the read and its own cancel', async () => {
    const at = new Date(Date.now() + 4 * 3_600_000);
    const { campaignId } = await pending({ scheduled_at: at.toISOString(), name: 'Cancel lock' });
    await decide(campaignId, 'approve');
    const [going] = await rows<{ id: string }>('select id from machvon.notification_instance where campaign_id = $1 order by id limit 1', [campaignId]);
    await rows("update machvon.notification_instance set status = 'Sending' where id = $1", [going?.id]);
    const tenant = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
    await (harness.tenants as TenantDatabase).withTenant(tenant, async (tx) => {
      const stopped = await campaigns.cancelWaiting(tx, campaignId);
      expect(stopped.inFlight).toEqual([{ id: going?.id, version: expect.any(Number) }]);
      // From another connection the row cannot be taken while this transaction is open.
      await expect(rows('select id from machvon.notification_instance where id = $1 for update nowait', [going?.id])).rejects.toThrow(/could not obtain lock/);
    });
  }, 120_000);

  it('marks an uncertain send for cancellation so the reconciliation cannot send it again, and does not complete a campaign while one is uncertain', async () => {
    const at = new Date(Date.now() + 5 * 3_600_000);
    const { campaignId } = await pending({ scheduled_at: at.toISOString(), name: 'Uncertain' });
    await decide(campaignId, 'approve');
    const tenant = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
    const tick = (now: Date) => (harness.tenants as TenantDatabase).withTenant(tenant, (tx) => campaigns.progress(tx, now));
    const [unsure] = await rows<{ id: string }>('select id from machvon.notification_instance where campaign_id = $1 order by id limit 1', [campaignId]);
    // A send moves forward only: taken up, then lost.
    await rows("update machvon.delivery_attempt set status = 'Sending', sending_at = now(), next_retry_at = null where notification_id = $1", [unsure?.id]);
    await rows("update machvon.delivery_attempt set status = 'Unknown', unknown_at = now() where notification_id = $1", [unsure?.id]);
    await rows("update machvon.notification_instance set status = 'Sending' where id = $1", [unsure?.id]);
    await rows("update machvon.notification_instance set status = 'Unknown' where id = $1", [unsure?.id]);
    await rows("update machvon.notification_instance set status = 'Delivered' where campaign_id = $1 and id <> $2", [campaignId, unsure?.id]);
    await tick(new Date(at.getTime() + 1_000));
    expect(await statusOf(campaignId)).toBe('Sending');
    // The uncertain one holds the campaign open: it is not Completed while the reconciliation can still send it again.
    expect(await tick(new Date(at.getTime() + 2_000))).toEqual({ started: 0, completed: 0 });
    expect((await cancel(campaignId)).json).toMatchObject({ status: 'CANCELLED' });
    const [marked] = await rows<{ status: string; cancel_requested_at: Date | null }>('select status, cancel_requested_at from machvon.notification_instance where id = $1', [unsure?.id]);
    expect(marked).toMatchObject({ status: 'Unknown', cancel_requested_at: expect.any(Date) });
  }, 120_000);

  it('replays a failed notification of a campaign on the template the campaign pinned, since its workflow names none', async () => {
    const { campaignId } = await pending({ name: 'Replay pinned' });
    await decide(campaignId, 'approve');
    const [failed] = await rows<{ id: string; version: string }>('select id, version::text as version from machvon.notification_instance where campaign_id = $1 order by id limit 1', [campaignId]);
    await rows("update machvon.delivery_attempt set status = 'Sending', sending_at = now(), next_retry_at = null where notification_id = $1", [failed?.id]);
    await rows("update machvon.delivery_attempt set status = 'Failed', failure_class = 'PERMANENT', error_code = 'HTTP_550', failed_at = now() where notification_id = $1", [failed?.id]);
    await rows("update machvon.notification_instance set status = 'Sending' where id = $1", [failed?.id]);
    await rows("update machvon.notification_instance set status = 'Failed', version = version + 1 where id = $1", [failed?.id]);
    const tenants = harness.tenants as TenantDatabase;
    const engine = createDeliveryEngine(new AuditWriter(tenants));
    const [current] = await rows<{ version: string }>('select version::text as version from machvon.notification_instance where id = $1', [failed?.id]);
    const replayed = await tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 }, (tx) =>
      engine.replay(tx, { notificationId: failed?.id as string, expectedVersion: Number(current?.version), tenantId: TENANT_A, now: new Date() }),
    );
    expect(replayed).toMatchObject({ channel: 'EMAIL', startedNewChain: false });
    const attempts = await rows<{ attempt_no: number; template_version_id: string; status: string }>('select attempt_no, template_version_id, status from machvon.delivery_attempt where notification_id = $1 order by attempt_no', [failed?.id]);
    expect(attempts).toEqual([
      { attempt_no: 1, template_version_id: TEMPLATE, status: 'Failed' },
      { attempt_no: 2, template_version_id: TEMPLATE, status: 'Queued' },
    ]);
  }, 120_000);

  it('does not let the reconciliation move an uncertain send out of a cancel: every notification that can still go is locked before any is looked at by state', async () => {
    const at = new Date(Date.now() + 6 * 3_600_000);
    const { campaignId } = await pending({ scheduled_at: at.toISOString(), name: 'Cancel versus reconcile' });
    await decide(campaignId, 'approve');
    const [unsure] = await rows<{ id: string }>('select id from machvon.notification_instance where campaign_id = $1 order by id limit 1', [campaignId]);
    await rows("update machvon.delivery_attempt set status = 'Sending', sending_at = now(), next_retry_at = null where notification_id = $1", [unsure?.id]);
    await rows("update machvon.delivery_attempt set status = 'Unknown', unknown_at = now() where notification_id = $1", [unsure?.id]);
    await rows("update machvon.notification_instance set status = 'Sending' where id = $1", [unsure?.id]);
    await rows("update machvon.notification_instance set status = 'Unknown' where id = $1", [unsure?.id]);
    const tenants = harness.tenants as TenantDatabase;
    const tenant = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    // The reconciliation: it holds the uncertain notification, finds the provider never received it, and queues it again.
    const reconciler = tenants.withTenant(tenant, async (tx) => {
      await tx.query('select id from machvon.notification_instance where id = $1::uuid for update', [unsure?.id]);
      locked();
      await gate;
      await tx.query("update machvon.notification_instance set status = 'Queued' where id = $1::uuid", [unsure?.id]);
      await tx.query("update machvon.delivery_attempt set status = 'Failed', failure_class = 'RETRYABLE', error_code = 'NOT_FOUND_AT_PROVIDER', failed_at = now() where notification_id = $1::uuid", [unsure?.id]);
      await tx.query(
        `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, next_retry_at)
         select tenant_id, gen_random_uuid(), notification_id, channel_account_id, 2, 'Queued', 0, channel, template_version_id, now() + interval '1 minute' from machvon.delivery_attempt where notification_id = $1::uuid and attempt_no = 1`,
        [unsure?.id],
      );
    });
    await hasLock;
    const canceller = tenants.withTenant(tenant, (tx) => campaigns.cancelWaiting(tx, campaignId));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await Promise.all([reconciler, canceller]);
    // The notification the reconciliation re-queued did not escape: it is Cancelled with its new send.
    expect(await rows<{ status: string }>('select status from machvon.notification_instance where id = $1', [unsure?.id])).toEqual([{ status: 'Cancelled' }]);
    expect(await rows("select 1 from machvon.delivery_attempt where notification_id = $1 and status = 'Queued'", [unsure?.id])).toHaveLength(0);
  }, 120_000);

  it('does not replay a notification of a cancelled campaign', async () => {
    const { campaignId } = await pending({ name: 'Cancelled then replayed' });
    await decide(campaignId, 'approve');
    const [failed] = await rows<{ id: string }>('select id from machvon.notification_instance where campaign_id = $1 order by id limit 1', [campaignId]);
    await rows("update machvon.delivery_attempt set status = 'Sending', sending_at = now(), next_retry_at = null where notification_id = $1", [failed?.id]);
    await rows("update machvon.delivery_attempt set status = 'Failed', failure_class = 'PERMANENT', error_code = 'HTTP_550', failed_at = now() where notification_id = $1", [failed?.id]);
    await rows("update machvon.notification_instance set status = 'Sending' where id = $1", [failed?.id]);
    await rows("update machvon.notification_instance set status = 'Failed' where id = $1", [failed?.id]);
    expect((await cancel(campaignId)).json).toMatchObject({ status: 'CANCELLED' });
    const tenants = harness.tenants as TenantDatabase;
    const [current] = await rows<{ version: string }>('select version::text as version from machvon.notification_instance where id = $1', [failed?.id]);
    await expect(
      tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 }, (tx) =>
        createDeliveryEngine(new AuditWriter(tenants)).replay(tx, { notificationId: failed?.id as string, expectedVersion: Number(current?.version), tenantId: TENANT_A, now: new Date() }),
      ),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_STATE_INVALID', status: 409 });
  }, 120_000);

  it('waits for a cancel that is in the middle of its work before it replays a notification of the campaign, and then refuses', async () => {
    const { campaignId } = await pending({ name: 'Replay versus cancel' });
    await decide(campaignId, 'approve');
    const [failed] = await rows<{ id: string }>('select id from machvon.notification_instance where campaign_id = $1 order by id limit 1', [campaignId]);
    await rows("update machvon.delivery_attempt set status = 'Sending', sending_at = now(), next_retry_at = null where notification_id = $1", [failed?.id]);
    await rows("update machvon.delivery_attempt set status = 'Failed', failure_class = 'PERMANENT', error_code = 'HTTP_550', failed_at = now() where notification_id = $1", [failed?.id]);
    await rows("update machvon.notification_instance set status = 'Sending' where id = $1", [failed?.id]);
    await rows("update machvon.notification_instance set status = 'Failed' where id = $1", [failed?.id]);
    const [current] = await rows<{ version: string }>('select version::text as version from machvon.notification_instance where id = $1', [failed?.id]);
    const tenants = harness.tenants as TenantDatabase;
    const tenant = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    // A cancel in the middle of its work: it holds the campaign and has not yet written that it is cancelled.
    const cancelling = tenants.withTenant(tenant, async (tx) => {
      await tx.query('select id from machvon.notification_campaign where id = $1::uuid for update', [campaignId]);
      locked();
      await gate;
      await tx.query("update machvon.notification_campaign set status = 'Cancelled', cancelled_at = now(), version = version + 1 where id = $1::uuid", [campaignId]);
    });
    await hasLock;
    const replaying = tenants
      .withTenant(tenant, (tx) => createDeliveryEngine(new AuditWriter(tenants)).replay(tx, { notificationId: failed?.id as string, expectedVersion: Number(current?.version), tenantId: TENANT_A, now: new Date() }))
      .then(
        () => 'replayed',
        (error: { code?: string }) => error.code,
      );
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await cancelling;
    expect(await replaying).toBe('NOTIFICATION_STATE_INVALID');
    expect(await rows("select 1 from machvon.delivery_attempt where notification_id = $1 and status = 'Queued'", [failed?.id])).toHaveLength(0);
  }, 120_000);

  it('lists the campaigns of the tenant newest first with their state, for whoever reads the whole tenant; a maker without that reads their own; nobody else reads any', async () => {
    const all = await call('GET', '/notification-campaigns?limit=200', { member: READER });
    expect(all.status).toBe(200);
    const items = all.json.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(5);
    const stamps = items.map((item) => item.created_at as string);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    expect(items[0]).toMatchObject({ template_channel: 'EMAIL', template_code: expect.any(String), segment: { unit_ids: expect.any(Array), role_codes: expect.any(Array), include_guests: expect.any(Boolean) } });
    // Pages.
    const first = await call('GET', '/notification-campaigns?limit=2', { member: READER });
    expect((first.json.items as unknown[]).length).toBe(2);
    expect(first.json.next_cursor).toEqual(expect.any(String));
    const second = await call('GET', `/notification-campaigns?limit=2&cursor=${encodeURIComponent(first.json.next_cursor as string)}`, { member: READER });
    expect((second.json.items as Array<{ id: string }>).map((item) => item.id)).toEqual(items.slice(2, 4).map((item) => item.id));
    // A filter by state, and a state that does not exist.
    const rejected = await call('GET', '/notification-campaigns?status=Rejected', { member: READER });
    expect((rejected.json.items as Array<{ status: string }>).every((item) => item.status === 'Rejected')).toBe(true);
    expect((rejected.json.items as unknown[]).length).toBeGreaterThan(0);
    expect((await call('GET', '/notification-campaigns?status=Nope', { member: READER })).json.code).toBe('VALIDATION_FAILED');
    // A maker who holds no read permission reads nothing, whatever they made.
    const mine = await call('GET', '/notification-campaigns?limit=200', { member: SCOPED });
    expect(mine.status).toBe(403);
    expect((await call('GET', '/notification-campaigns', { member: NOBODY })).status).toBe(403);
    const detail = await call('GET', `/notification-campaigns/${items[0]?.id as string}`, { member: READER });
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({ id: items[0]?.id, version: items[0]?.version });
    expect((await call('GET', `/notification-campaigns/${randomUUID()}`, { member: READER })).status).toBe(404);
  });

  it('sends what an approval made: the notifications go out through the channel on the pinned template, and the campaign is Completed when nothing of it is waiting', async () => {
    await seedPeople([500, 501], 3);
    await grantConsent([500, 501]);
    const mail = new InMemoryChannelAdapter({ provider: 'smtp-relay', channel: 'EMAIL', status: 'MOCK', paid: false });
    const tenants = harness.tenants as TenantDatabase;
    const access = new EffectiveAccessStore(tenants, new InMemoryAuthzCache());
    const dispatcher = new DeliveryDispatcher({ database: tenants, engine: createDeliveryEngine(new AuditWriter(tenants)), adapters: new ChannelAdapterRegistry([mail], 'test'), loadAccess: (ctx) => access.load(ctx), resourceAccess: new PermissionResourceAccess(), now: () => new Date() }, 'test');
    const { campaignId } = await pending({ segment: { unit_ids: [unitId(3)] }, name: 'Sent notice' });
    expect((await decide(campaignId, 'approve')).json).toMatchObject({ status: 'SENDING' });
    const tenant = { tenantId: TENANT_A, membershipId: memberId(MAKER), scopeVersion: 1 };
    // A round sends a batch of what is due, and the earlier campaigns of this suite are due too: rounds go on until the two of this campaign are out.
    for (let round = 0; round < 60; round += 1) {
      await dispatcher.dispatchDue(tenant);
      if ((await rows("select 1 from machvon.delivery_attempt a join machvon.notification_instance n on n.id = a.notification_id where n.campaign_id = $1 and a.status = 'Queued'", [campaignId])).length === 0) break;
    }
    // The dispatcher sends everything that is due, the earlier campaigns of this suite included: look at the two people of this one.
    expect(mail.requests.filter((request) => ['user500@example.test', 'user501@example.test'].includes(request.to))).toHaveLength(2);
    expect(await rows<{ status: string }>("select a.status from machvon.delivery_attempt a join machvon.notification_instance n on n.id = a.notification_id where n.campaign_id = $1", [campaignId])).toEqual([{ status: 'ProviderAccepted' }, { status: 'ProviderAccepted' }]);
    expect(await rows<{ status: string }>('select distinct status from machvon.notification_instance where campaign_id = $1', [campaignId])).toEqual([{ status: 'ProviderAccepted' }]);
    expect(await (harness.tenants as TenantDatabase).withTenant(tenant, (tx) => campaigns.progress(tx, new Date()))).toMatchObject({ completed: expect.any(Number) });
    expect(await statusOf(campaignId)).toBe('Completed');
  }, 120_000);

  it('needs the entitlement notification.campaign: without it every command of the campaign is 403 ENTITLEMENT_DENIED and changes nothing, while the reads still answer', async () => {
    const { campaignId } = await pending();
    const before = await rows<{ n: string }>('select count(*)::text as n from machvon.notification_campaign');
    entitled = false;
    try {
      for (const reply of [await create(), await preview(campaignId), await submit(campaignId, 'a'.repeat(64)), await decide(campaignId, 'approve'), await cancel(campaignId)]) {
        expect(reply.status).toBe(403);
        expect(reply.json.code).toBe('ENTITLEMENT_DENIED');
      }
      expect((await call('GET', '/notification-campaigns?limit=1', { member: READER })).status).toBe(200);
    } finally {
      entitled = true;
    }
    expect(await rows<{ n: string }>('select count(*)::text as n from machvon.notification_campaign')).toEqual(before);
    expect(await statusOf(campaignId)).toBe('PendingApproval');
  }, 120_000);

  it('keeps tenants apart: a campaign of another tenant is not found and a preview of it does nothing', async () => {
    const [foreign] = await rows<{ id: string }>('select id from machvon.notification_campaign limit 1');
    const other = await call('GET', `/notification-campaigns/${foreign?.id as string}`, { member: OTHER_TENANT_MAKER, tenantId: TENANT_B });
    expect(other.status).toBe(404);
    const previewed = await call('POST', `/notification-campaigns/${foreign?.id as string}/preview`, { member: OTHER_TENANT_MAKER, tenantId: TENANT_B, ifMatch: '"1"', body: { reason: REASON } });
    expect(previewed.status).toBe(404);
  });
});
