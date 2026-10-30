import { createHash } from 'node:crypto';
import { CAMPAIGN_EVENT_TYPE, CAMPAIGN_VALIDITY_MS, DomainError, MAX_CAMPAIGN_RECIPIENTS, consentPurposeOf, consentRequirement, emptyExclusions, exclusionOf, preferenceChannelOf, previewHashOf } from '@machvon/kernel';
import type { CampaignDraft, CampaignPurpose, CampaignSegment, CampaignStatus, Exclusions } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TIME = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
/** The people a segment may reach before it is refused as too wide to look at (the cap on the recipients is far below it). */
const MAX_CANDIDATES = 50_000;
const SAMPLES = 5;

export interface CampaignRecord {
  id: string;
  name: string;
  purpose: CampaignPurpose;
  templateVersionId: string;
  templateCode: string;
  templateChannel: string;
  segment: CampaignSegment;
  /** The units the segment names, with their names: what an approver reads. */
  units: Array<{ id: string; name: string; code: string }>;
  scheduledAt: string | null;
  status: CampaignStatus;
  recipientCount: number | null;
  excluded: Exclusions | null;
  previewHash: string | null;
  previewedAt: string | null;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  notificationCount: number;
  waitingCount: number;
  version: number;
  sortKey: string;
}

interface CampaignRow {
  id: string;
  name: string;
  purpose: CampaignPurpose;
  template_version_id: string;
  template_code: string;
  template_channel: string;
  segment_json: { unit_ids?: string[]; role_codes?: string[]; include_guests?: boolean };
  units: Array<{ id: string; name: string; code: string }>;
  scheduled_at: string | null;
  status: CampaignStatus;
  preview_recipient_count: number | null;
  preview_excluded: Partial<Exclusions> | null;
  preview_hash: string | null;
  previewed_at: string | null;
  created_by: string;
  created_at: string;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  cancelled_at: string | null;
  completed_at: string | null;
  notification_count: number;
  waiting_count: string;
  version: string;
  sort_key: string;
}

const COLUMNS = `c.id, c.name, c.purpose, c.template_version_id, t.code as template_code, t.channel as template_channel, c.segment_json,
  (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'code', o.code) order by o.name, o.id), '[]'::jsonb) from machvon.organization_unit o
    where o.id in (select (jsonb_array_elements_text(c.segment_json -> 'unit_ids'))::uuid)) as units,
  ${TIME('c.scheduled_at')} as scheduled_at, c.status,
  c.preview_recipient_count, c.preview_excluded, c.preview_hash, ${TIME('c.previewed_at')} as previewed_at, c.created_by, ${TIME('c.created_at')} as created_at, ${TIME('c.submitted_at')} as submitted_at,
  c.approved_by, ${TIME('c.approved_at')} as approved_at, c.decided_by, ${TIME('c.decided_at')} as decided_at, c.decision_reason, ${TIME('c.cancelled_at')} as cancelled_at, ${TIME('c.completed_at')} as completed_at,
  c.notification_count,
  (select count(*) from machvon.notification_instance n where n.campaign_id = c.id and n.status in ('Created', 'Scheduled', 'Queued'))::text as waiting_count,
  c.version::text as version, ${TIME('c.created_at')} as sort_key`;
const FROM = 'from machvon.notification_campaign c join machvon.notification_template_version t on t.tenant_id = c.tenant_id and t.id = c.template_version_id';

const toRecord = (row: CampaignRow): CampaignRecord => ({
  id: row.id,
  name: row.name,
  purpose: row.purpose,
  templateVersionId: row.template_version_id,
  templateCode: row.template_code,
  templateChannel: row.template_channel,
  segment: { unitIds: row.segment_json.unit_ids ?? [], roleCodes: row.segment_json.role_codes ?? [], includeGuests: row.segment_json.include_guests === true },
  units: row.units,
  scheduledAt: row.scheduled_at,
  status: row.status,
  recipientCount: row.preview_recipient_count,
  excluded: row.preview_excluded === null ? null : { ...emptyExclusions(), ...row.preview_excluded },
  previewHash: row.preview_hash,
  previewedAt: row.previewed_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
  submittedAt: row.submitted_at,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  cancelledAt: row.cancelled_at,
  completedAt: row.completed_at,
  notificationCount: row.notification_count,
  waitingCount: Number(row.waiting_count),
  version: Number(row.version),
  sortKey: row.sort_key,
});

/** Who a segment reaches, for the channel and the purpose of the campaign: the people to write to (in the order of their ids), and the people left out by reason. */
export interface Resolution {
  recipientIds: string[];
  excluded: Exclusions;
  /** The memberships the segment reached before anybody was left out. */
  considered: number;
  hash: string;
}

const RESOLVE_SQL = `
  with scope_units as (select path from machvon.organization_unit where id = any($1::uuid[])),
  candidates as (
    select m.id, m.user_id, (m.status = 'Active' and m.valid_from <= $5::timestamptz and (m.valid_until is null or m.valid_until > $5::timestamptz)) as active
      from machvon.membership m
     where m.status in ('Invited', 'Active', 'Suspended')
       and m.membership_type = any($3::text[])
       and (cardinality($1::uuid[]) = 0 or exists (select 1 from machvon.organization_unit o, scope_units s where o.id = m.organization_id and starts_with(o.path, s.path)))
       and (cardinality($2::text[]) = 0 or exists (
             select 1 from machvon.role_grant g join machvon.role_definition r on r.tenant_id = g.tenant_id and r.id = g.role_id
              where g.membership_id = m.id and r.code = any($2::text[]) and g.status = 'Active' and g.effective_from <= $5::timestamptz and (g.effective_until is null or g.effective_until > $5::timestamptz)))
     limit ${MAX_CANDIDATES + 1}),
  ranked as (select c.*, (row_number() over (partition by c.user_id order by c.active desc, c.id) = 1) as first_of_person from candidates c)
  select r.id, r.active, r.first_of_person,
         coalesce((select p.enabled from machvon.notification_preference p
                    where p.membership_id = r.id and p.channel = $4 and p.event_category in ('campaign', '*') order by (p.event_category = '*') limit 1), true) as channel_enabled,
         __CONSENT__ as consented
    from ranked r order by r.id`;

const CONSENT_LOOKUP = `coalesce((select c.status = 'Granted' from machvon.contact_consent c
                                   where c.membership_id = r.id and c.channel = $4 and c.purpose = $6
                                   order by greatest(c.effective_at, coalesce(c.revoked_at, c.effective_at)) desc, c.effective_at desc, c.id desc limit 1), false)`;

interface CandidateRow {
  id: string;
  active: boolean;
  first_of_person: boolean;
  channel_enabled: boolean;
  consented: boolean;
}

const mask = (name: string): string =>
  name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `${[...word][0] ?? ''}***`)
    .join(' ');

/**
 * Broadcast campaigns (ST-NOT-009, NOT 3.5, BR-NOT-12). The store resolves the segment, fingerprints the set, keeps the steps of the flow under the row lock and, on approval, makes the notifications of the recipients: in one
 * statement, the way a wide send must be made, and with the pinned template and the time of the campaign. Every query runs in the caller's tenant transaction.
 */
export class NotificationCampaignStore {
  /** A new campaign is a draft. The template must be Active and of a channel the engine sends on (the inbox is delivered by the insert itself and has no time to wait for [gap: inbox campaigns]). */
  async create(tx: TenantTx, creator: string, draft: CampaignDraft): Promise<CampaignRecord> {
    const [template] = await tx.query<{ status: string; channel: string; variables: number }>(
      "select status, channel, case when jsonb_typeof(variable_schema -> 'properties') = 'object' then (select count(*) from jsonb_object_keys(variable_schema -> 'properties')) else 0 end as variables from machvon.notification_template_version where id = $1::uuid",
      [draft.templateVersionId],
    );
    if (template === undefined || template.status !== 'Active') throw new DomainError('TEMPLATE_INVALID', 422, 'template_version_id');
    if (template.channel === 'IN_APP') throw new DomainError('TEMPLATE_INVALID', 422, 'channel');
    // A campaign has no event to take values from: a template with variables could not be written (every send would fail to render), so only one without variables is accepted.
    if (Number(template.variables) > 0) throw new DomainError('TEMPLATE_INVALID', 422, 'variables');
    const [made] = await tx.query<{ id: string }>(
      `insert into machvon.notification_campaign (tenant_id, id, name, purpose, template_version_id, segment_json, scheduled_at, status, created_by)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3::uuid, $4::jsonb, $5::timestamptz, 'Draft', $6::uuid) returning id`,
      [draft.name, draft.purpose, draft.templateVersionId, JSON.stringify({ unit_ids: draft.segment.unitIds, role_codes: draft.segment.roleCodes, include_guests: draft.segment.includeGuests }), draft.scheduledAt?.toISOString() ?? null, creator],
    );
    return await this.require(tx, (made as { id: string }).id);
  }

  async find(tx: TenantTx, id: string): Promise<CampaignRecord | undefined> {
    const [row] = await tx.query<CampaignRow>(`select ${COLUMNS} ${FROM} where c.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  async require(tx: TenantTx, id: string): Promise<CampaignRecord> {
    const found = await this.find(tx, id);
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return found;
  }

  async list(tx: TenantTx, filters: { status?: string | undefined; createdBy?: string | undefined }, page: { limit: number; after: { code: string; id: string } | undefined }): Promise<CampaignRecord[]> {
    assertTimestampCursor(page.after?.code);
    const rows = await tx.query<CampaignRow>(
      `select ${COLUMNS} ${FROM}
        where ($1::text is null or c.status = $1) and ($5::uuid is null or c.created_by = $5::uuid)
          and ($2::timestamptz is null or (c.created_at, c.id) < ($2::timestamptz, $3::uuid))
        order by c.created_at desc, c.id desc limit $4::int`,
      [filters.status ?? null, page.after?.code ?? null, page.after?.id ?? null, page.limit, filters.createdBy ?? null],
    );
    return rows.map(toRecord);
  }

  /** Takes the row for the rest of the transaction and checks the version the caller saw. */
  async lock(tx: TenantTx, id: string, expectedVersion: number): Promise<CampaignRecord> {
    await tx.query('select 1 from machvon.notification_campaign where id = $1::uuid for update', [id]);
    const current = await this.require(tx, id);
    if (current.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: current.version } });
    return current;
  }

  /**
   * Who the segment reaches now, and the people left out (inactive, a second membership of a person, a person who turned the channel off for campaigns, a person without the consent BR-NOT-07 asks for). Read at one
   * instant, so the set and its hash agree. A segment that reaches more people than a campaign may have is refused (SEGMENT_INVALID).
   */
  async resolve(tx: TenantTx, campaign: Pick<CampaignRecord, 'segment' | 'purpose' | 'templateVersionId' | 'templateChannel' | 'scheduledAt'>, now: Date): Promise<Resolution> {
    const channel = preferenceChannelOf(campaign.templateChannel);
    if (channel === undefined) throw new DomainError('TEMPLATE_INVALID', 422, 'channel');
    const consentPurpose = consentPurposeOf(campaign.purpose);
    const requirement = consentRequirement(channel, campaign.purpose);
    const needsConsent = requirement === 'CONSENT';
    if (needsConsent && consentPurpose === undefined) throw new DomainError('TEMPLATE_INVALID', 422, 'purpose');
    const types = campaign.segment.includeGuests ? ['STAFF', 'GUEST_CONTRACTOR'] : ['STAFF'];
    const rows = await tx.query<CandidateRow>(RESOLVE_SQL.replace('__CONSENT__', needsConsent ? CONSENT_LOOKUP : '($6::text is null or true)'), [
      campaign.segment.unitIds,
      campaign.segment.roleCodes,
      types,
      channel,
      now.toISOString(),
      needsConsent ? consentPurpose : null,
    ]);
    if (rows.length > MAX_CANDIDATES) throw new DomainError('SEGMENT_INVALID', 409, 'segment');
    const excluded = emptyExclusions();
    const recipientIds: string[] = [];
    for (const row of rows) {
      const reason = exclusionOf({ active: row.active, firstOfPerson: row.first_of_person, channelEnabled: row.channel_enabled, consented: row.consented });
      if (reason === undefined) recipientIds.push(row.id);
      else excluded[reason] += 1;
    }
    if (recipientIds.length > MAX_CAMPAIGN_RECIPIENTS) throw new DomainError('SEGMENT_INVALID', 409, 'recipient_count');
    const scheduledAt = campaign.scheduledAt === null ? undefined : new Date(campaign.scheduledAt);
    return { recipientIds, excluded, considered: rows.length, hash: previewHashOf({ recipientIds, templateVersionId: campaign.templateVersionId, scheduledAt }) };
  }

  /** A few of the people the campaign would reach, with their names masked (a screen must not become a directory). */
  async maskedSamples(tx: TenantTx, recipientIds: readonly string[]): Promise<string[]> {
    const picked = recipientIds.slice(0, SAMPLES);
    if (picked.length === 0) return [];
    const rows = await tx.query<{ display_name: string }>(
      'select d.display_name from machvon.tenant_user_directory d where d.membership_id = any($1::uuid[]) order by d.membership_id',
      [picked],
    );
    return rows.map((row) => mask(row.display_name));
  }

  /** Keeps the result of a preview and moves the campaign to Previewed (a draft, or one that was previewed before). */
  async savePreview(tx: TenantTx, campaign: CampaignRecord, resolution: Resolution, now: Date): Promise<CampaignRecord> {
    await tx.query(
      `update machvon.notification_campaign
          set status = 'Previewed', preview_recipient_count = $2, preview_excluded_count = $3, preview_excluded = $4::jsonb, preview_hash = $5, previewed_at = $6::timestamptz, version = version + 1
        where id = $1::uuid`,
      [campaign.id, resolution.recipientIds.length, Object.values(resolution.excluded).reduce((sum, count) => sum + count, 0), JSON.stringify(resolution.excluded), resolution.hash, now.toISOString()],
    );
    return await this.require(tx, campaign.id);
  }

  /** Moves a campaign on, with the columns the step sets. The row is the one the caller locked. */
  async move(tx: TenantTx, id: string, status: CampaignStatus, patch: { submittedAt?: Date; approvedBy?: string; approvedAt?: Date; decidedBy?: string; decidedAt?: Date; decisionReason?: string; cancelledAt?: Date; completedAt?: Date; notificationCount?: number } = {}): Promise<CampaignRecord> {
    await tx.query(
      `update machvon.notification_campaign set status = $2, version = version + 1,
          submitted_at = coalesce($3::timestamptz, submitted_at), approved_by = coalesce($4::uuid, approved_by), approved_at = coalesce($5::timestamptz, approved_at),
          decided_by = coalesce($6::uuid, decided_by), decided_at = coalesce($7::timestamptz, decided_at), decision_reason = coalesce($8, decision_reason),
          cancelled_at = coalesce($9::timestamptz, cancelled_at), completed_at = coalesce($10::timestamptz, completed_at), notification_count = coalesce($11::int, notification_count)
        where id = $1::uuid`,
      [
        id,
        status,
        patch.submittedAt?.toISOString() ?? null,
        patch.approvedBy ?? null,
        patch.approvedAt?.toISOString() ?? null,
        patch.decidedBy ?? null,
        patch.decidedAt?.toISOString() ?? null,
        patch.decisionReason ?? null,
        patch.cancelledAt?.toISOString() ?? null,
        patch.completedAt?.toISOString() ?? null,
        patch.notificationCount ?? null,
      ],
    );
    return await this.require(tx, id);
  }

  /** Whether `a` and `b` are the same person: the same membership, or two memberships of the same user (the maker-checker rule is about people, not about hats). */
  async samePerson(tx: TenantTx, a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const people = await tx.query<{ id: string; user_id: string }>('select id, user_id from machvon.membership where id = any($1::uuid[])', [[a, b]]);
    const userA = people.find((row) => row.id === a)?.user_id;
    const userB = people.find((row) => row.id === b)?.user_id;
    return userA !== undefined && userA === userB;
  }

  /**
   * Makes the notifications of an approved campaign: one for each recipient, with the dedupe key of the campaign as the source event (a second run makes none twice), the pinned template and the time of the campaign
   * on the first send; a campaign without a time, or one already past, sends at once. Returns the number made. The campaign needs an Active account of its channel (422 CHANNEL_UNVERIFIED).
   */
  async launch(
    tx: TenantTx,
    campaign: CampaignRecord,
    recipientIds: readonly string[],
    input: { approver: string; now: Date; dedupeKeyOf: (recipientId: string) => string },
  ): Promise<number> {
    if (recipientIds.length === 0) return 0;
    const [account] = await tx.query<{ id: string }>("select id from machvon.channel_account where channel = $1 and status = 'Active' order by id limit 1", [campaign.templateChannel]);
    if (account === undefined) throw new DomainError('CHANNEL_UNVERIFIED', 422, 'channel');
    const workflowId = await this.campaignWorkflow(tx, campaign.createdBy, input.approver);
    const dueAt = campaign.scheduledAt !== null && new Date(campaign.scheduledAt).getTime() > input.now.getTime() ? new Date(campaign.scheduledAt) : undefined;
    const sendAt = dueAt ?? input.now;
    const made = await tx.query<{ id: string }>(
      `insert into machvon.notification_instance
          (tenant_id, id, event_id, workflow_version_id, recipient_id, purpose, dedupe_key, expires_at, status, source_event_type, event_version, priority, ack_required, channel_plan, campaign_id, scheduled_for)
       select ${TENANT}, gen_random_uuid(), $1::uuid, $2::uuid, r.recipient, $3, r.key, $4::timestamptz, 'Queued', $5, 1, 'NORMAL', false, array[$6]::text[], $1::uuid, $7::timestamptz
         from unnest($8::uuid[], $9::text[]) as r(recipient, key)
       on conflict (tenant_id, dedupe_key) do nothing
       returning id`,
      [
        campaign.id,
        workflowId,
        campaign.purpose,
        new Date(sendAt.getTime() + CAMPAIGN_VALIDITY_MS).toISOString(),
        CAMPAIGN_EVENT_TYPE,
        campaign.templateChannel,
        dueAt?.toISOString() ?? null,
        [...recipientIds],
        recipientIds.map((recipient) => input.dedupeKeyOf(recipient)),
      ],
    );
    await tx.query(
      `insert into machvon.delivery_attempt (tenant_id, id, notification_id, channel_account_id, attempt_no, status, cost, channel, template_version_id, next_retry_at)
       select ${TENANT}, gen_random_uuid(), n, $1::uuid, 1, 'Queued', 0, $2, $3::uuid, $4::timestamptz from unnest($5::uuid[]) as n`,
      [account.id, campaign.templateChannel, campaign.templateVersionId, dueAt?.toISOString() ?? null, made.map((row) => row.id)],
    );
    return made.length;
  }

  /** The workflow the notifications of campaigns hang on (a notification belongs to a published workflow version): one for the tenant, made the first time a campaign is approved and published by that approval. */
  private async campaignWorkflow(tx: TenantTx, creator: string, approver: string): Promise<string> {
    const find = async (): Promise<string | undefined> => (await tx.query<{ id: string }>("select id from machvon.workflow_version where kind = 'NOTIFICATION' and event_type = $1 and status = 'Published' limit 1", [CAMPAIGN_EVENT_TYPE]))[0]?.id;
    const known = await find();
    if (known !== undefined) return known;
    await tx.query("select pg_advisory_xact_lock(hashtext('campaign-workflow:' || current_setting('app.tenant_id', true)))");
    const again = await find();
    if (again !== undefined) return again;
    const definition = JSON.stringify({ channels: [], system: 'campaign' });
    const [latest] = await tx.query<{ revision: number | null }>("select max(revision) as revision from machvon.workflow_version where kind = 'NOTIFICATION' and event_type = $1", [CAMPAIGN_EVENT_TYPE]);
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.workflow_version (tenant_id, id, business_type, event_type, revision, definition_json, status, kind, created_by, last_edited_by, published_by, published_at, effective_from, definition_hash)
       values (${TENANT}, gen_random_uuid(), $1, $1, $2, $3::jsonb, 'Published', 'NOTIFICATION', $4::uuid, $4::uuid, $5::uuid, now(), now(), $6) returning id`,
      [CAMPAIGN_EVENT_TYPE, (latest?.revision ?? 0) + 1, definition, creator, approver, createHash('sha256').update(definition).digest('hex')],
    );
    return (row as { id: string }).id;
  }

  /** The notifications of a campaign that are still going, for the cancel: those not yet taken up (Created, Scheduled, Queued) are cancelled with their waiting sends; the others are returned to be cancelled one by one. */
  async cancelWaiting(tx: TenantTx, campaignId: string): Promise<{ cancelled: number; inFlight: Array<{ id: string; version: number }> }> {
    // The same order as a claim in the delivery engine, which holds the notification before its attempt: the notifications first (by id), then their sends.
    // All of the notifications that can still go anywhere are locked before any of them is looked at by state, so the reconciliation cannot move an uncertain one to Queued between the two and let it escape.
    await tx.query("select id from machvon.notification_instance where campaign_id = $1::uuid and status in ('Created', 'Scheduled', 'Queued', 'Sending', 'Unknown') order by id for update", [campaignId]);
    await tx.query(
      `update machvon.delivery_attempt set status = 'Cancelled', error_code = 'CANCELLED'
        where status = 'Queued' and notification_id in (select id from machvon.notification_instance where campaign_id = $1::uuid and status in ('Created', 'Scheduled', 'Queued'))`,
      [campaignId],
    );
    const cancelled = await tx.query<{ id: string }>(
      "update machvon.notification_instance set status = 'Cancelled', version = version + 1 where campaign_id = $1::uuid and status in ('Created', 'Scheduled', 'Queued') returning id",
      [campaignId],
    );
    // Held while the versions are read, so the delivery engine cannot move one of them between the read and its own cancel (it would reject the version it was given and undo the whole cancellation).
    const going = await tx.query<{ id: string; version: string }>("select id, version::text as version from machvon.notification_instance where campaign_id = $1::uuid and status = 'Sending' order by id for update", [campaignId]);
    // An uncertain send may still turn out never to have reached the provider, and the reconciliation would then queue it again: the intention to cancel is written on it (the engine does not cancel an Unknown notification, it only honours this mark).
    await tx.query("update machvon.notification_instance set cancel_requested_at = now(), version = version + 1 where campaign_id = $1::uuid and status = 'Unknown' and cancel_requested_at is null", [campaignId]);
    return { cancelled: cancelled.length, inFlight: going.map((row) => ({ id: row.id, version: Number(row.version) })) };
  }

  /** The campaigns that are being sent move on with the clock: a scheduled one whose time came is Sending; a sending one whose notifications have all left the waiting states (an uncertain one still counts: the reconciliation may send it again) is Completed. Returns the campaigns moved. */
  async progress(tx: TenantTx, now: Date): Promise<{ started: number; completed: number }> {
    const started = await tx.query<{ id: string }>(
      "update machvon.notification_campaign set status = 'Sending', version = version + 1 where status = 'Scheduled' and scheduled_at <= $1::timestamptz returning id",
      [now.toISOString()],
    );
    const completed = await tx.query<{ id: string }>(
      `update machvon.notification_campaign c set status = 'Completed', completed_at = $1::timestamptz, version = version + 1
        where c.status = 'Sending'
          and not exists (select 1 from machvon.notification_instance n where n.campaign_id = c.id and n.status in ('Created', 'Scheduled', 'Queued', 'Sending', 'Unknown'))
        returning c.id`,
      [now.toISOString()],
    );
    return { started: started.length, completed: completed.length };
  }
}
