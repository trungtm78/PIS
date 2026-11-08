import {
  DomainError,
  GIFT_RULE_TYPE,
  PHOTO_INTEGRITY_RULE_TYPE,
  WHISTLE_RULE_TYPE,
  assertGiftClose,
  assertGiftInput,
  assertHandlerIndependent,
  assertPhotoFindingMove,
  assertWhistleInput,
  assertWhistleMove,
  findPhotoPairs,
  giftDefaults,
  giftPolicyOf,
  giftReading,
  nextPhotoFindingStatus,
  nextWhistleStatus,
  photoIntegrityDefaults,
  photoIntegrityPolicyOf,
  versionConflict,
  whistleClock,
  whistleDefaults,
  whistlePolicyOf,
} from '@machvon/kernel';
import type { GiftOutcome, GiftPolicy, GiftReading, GiftStatus, GiverKind, PhotoFact, PhotoFindingKind, PhotoFindingMove, PhotoFindingStatus, PhotoIntegrityPolicy, WhistleCategory, WhistleClock, WhistleMove, WhistlePolicy, WhistleStatus } from '@machvon/kernel';
import { DAY, ISO, readPolicy } from './gov12-policy.ts';
import type { PolicyReading } from './gov12-policy.ts';
import type { TenantTx } from './tenant-database.ts';

type Raw = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Anonymous channel: the handlers' side. The reporter's side is the functions of V2605.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface WhistleRow {
  id: string;
  category: WhistleCategory;
  body: string;
  status: WhistleStatus;
  receivedOn: string;
  subjectUnitId: string | null;
  handlerId: string | null;
  acknowledgedOn: string | null;
  closedOn: string | null;
  publicNote: string | null;
  version: number;
  clock: WhistleClock;
}

export interface WhistleMessageRow {
  seq: number;
  sender: 'REPORTER' | 'HANDLER';
  body: string;
  sentOn: string;
  handlerId: string | null;
}

const WHISTLE_COLUMNS = `id, category, body, status, ${DAY('received_on')} as received_on, acknowledge_days, resolve_days, subject_unit_id, handler_membership_id, ${DAY('acknowledged_on')} as acknowledged_on, ${DAY('closed_on')} as closed_on, public_note, version`;

const toWhistle = (row: Raw, today: string): WhistleRow => {
  const receivedOn = row.received_on as string;
  const acknowledgedOn = (row.acknowledged_on as string | null) ?? null;
  const closedOn = (row.closed_on as string | null) ?? null;
  return {
    id: row.id as string,
    category: row.category as WhistleCategory,
    body: row.body as string,
    status: row.status as WhistleStatus,
    receivedOn,
    subjectUnitId: (row.subject_unit_id as string | null) ?? null,
    handlerId: (row.handler_membership_id as string | null) ?? null,
    acknowledgedOn,
    closedOn,
    publicNote: (row.public_note as string | null) ?? null,
    version: Number(row.version),
    clock: whistleClock({ receivedOn, acknowledgedOn, closedOn }, today, { ...whistleDefaults(), acknowledge_days: row.acknowledge_days as number, resolve_days: row.resolve_days as number }),
  };
};

/** The units of a person, for the rule that an involved handler does not handle a report: the units they are placed in and the ones above them. */
async function unitsOf(tx: TenantTx, membershipId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    `select distinct u.id from machvon.organization_unit u join machvon.membership m on m.tenant_id = u.tenant_id and m.id = $1::uuid
      join machvon.organization_unit own on own.tenant_id = m.tenant_id and own.id = m.organization_id where own.path like u.path || '%'`,
    [membershipId],
  );
  return rows.map((row) => row.id);
}

export class WhistleStore {
  policy(tx: TenantTx, today: string): Promise<PolicyReading<WhistlePolicy>> {
    return readPolicy(tx, WHISTLE_RULE_TYPE, today, whistlePolicyOf, whistleDefaults);
  }

  async list(tx: TenantTx, filter: { status?: WhistleStatus | undefined; limit: number; offset: number }, today: string): Promise<WhistleRow[]> {
    const rows = await tx.query<Raw>(`select ${WHISTLE_COLUMNS} from machvon.whistle_report where ($1::text is null or status = $1) order by received_on, id limit $2 offset $3`, [filter.status ?? null, filter.limit, filter.offset]);
    return rows.map((row) => toWhistle(row, today));
  }

  async find(tx: TenantTx, id: string, today: string, lock = false): Promise<WhistleRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${WHISTLE_COLUMNS} from machvon.whistle_report where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : toWhistle(row, today);
  }

  async thread(tx: TenantTx, id: string): Promise<WhistleMessageRow[]> {
    const rows = await tx.query<Raw>(`select seq, sender, body, ${DAY('sent_on')} as sent_on, handler_membership_id from machvon.whistle_message where report_id = $1::uuid order by seq`, [id]);
    return rows.map((row) => ({ seq: row.seq as number, sender: row.sender as 'REPORTER' | 'HANDLER', body: row.body as string, sentOn: row.sent_on as string, handlerId: (row.handler_membership_id as string | null) ?? null }));
  }

  /** A handler who belongs to the unit the report is about does not see it, handle it or answer it: they are told it does not exist. */
  async findFor(tx: TenantTx, id: string, handler: string, today: string, lock = false): Promise<WhistleRow | undefined> {
    const report = await this.find(tx, id, today, lock);
    if (report === undefined) return undefined;
    try {
      assertHandlerIndependent({ handlerUnitIds: await unitsOf(tx, handler), subjectUnitId: report.subjectUnitId });
    } catch {
      return undefined;
    }
    return report;
  }

  async listFor(tx: TenantTx, handler: string, filter: { status?: WhistleStatus | undefined; limit: number; offset: number }, today: string): Promise<WhistleRow[]> {
    const units = await unitsOf(tx, handler);
    const rows = await tx.query<Raw>(
      `select ${WHISTLE_COLUMNS} from machvon.whistle_report where ($1::text is null or status = $1) and (subject_unit_id is null or not (subject_unit_id = any($4::uuid[]))) order by received_on, id limit $2 offset $3`,
      [filter.status ?? null, filter.limit, filter.offset, units],
    );
    return rows.map((row) => toWhistle(row, today));
  }

  /** Assigns the unit the report is about (set by a handler who read it); the handlers of that unit then lose sight of it. */
  async assignSubject(tx: TenantTx, id: string, expectedVersion: number, unitId: string | null, handler: string, today: string): Promise<WhistleRow> {
    const report = await this.findFor(tx, id, handler, today, true);
    if (report === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (report.version !== expectedVersion) throw versionConflict(report.version);
    if (unitId !== null) {
      const [unit] = await tx.query<{ id: string }>('select id from machvon.organization_unit where id = $1::uuid', [unitId]);
      if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'unit_id');
      // A handler cannot hand a report to a unit they themselves belong to: they would be hiding it from themselves and from their peers.
      assertHandlerIndependent({ handlerUnitIds: await unitsOf(tx, handler), subjectUnitId: unitId });
    }
    await tx.query('update machvon.whistle_report set subject_unit_id = $2::uuid, version = version + 1 where id = $1::uuid', [id, unitId]);
    return (await this.find(tx, id, today)) as WhistleRow;
  }

  async move(tx: TenantTx, id: string, expectedVersion: number, move: WhistleMove, handler: string, note: string | null, today: string): Promise<WhistleRow> {
    const report = await this.findFor(tx, id, handler, today, true);
    if (report === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (report.version !== expectedVersion) throw versionConflict(report.version);
    const text = note === null ? null : note.trim();
    assertWhistleMove({ move, note: text });
    const to = nextWhistleStatus(report.status, move);
    await tx.query(
      `update machvon.whistle_report set status = $2, handler_membership_id = coalesce(handler_membership_id, $3::uuid), acknowledged_on = case when $4 then coalesce(acknowledged_on, $5::date) else acknowledged_on end,
              closed_on = case when $2 in ('RESOLVED', 'DISMISSED') then $5::date else closed_on end, public_note = case when $2 in ('RESOLVED', 'DISMISSED') then $6 else public_note end, version = version + 1 where id = $1::uuid`,
      [id, to, handler, move === 'ACKNOWLEDGE', today, text],
    );
    return (await this.find(tx, id, today)) as WhistleRow;
  }

  /** A handler's answer to the reporter: a message of the thread, which the reporter reads with the code. */
  async reply(tx: TenantTx, id: string, handler: string, body: string, today: string): Promise<WhistleMessageRow> {
    const report = await this.findFor(tx, id, handler, today, true);
    if (report === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (report.status === 'RESOLVED' || report.status === 'DISMISSED') throw new DomainError('WHISTLE_STATE_INVALID', 409, 'status');
    const text = body.trim();
    if (text.length < 1 || text.length > 4000) throw new DomainError('VALIDATION_FAILED', 422, 'body');
    const [next] = await tx.query<{ seq: number }>('select coalesce(max(seq), 0) + 1 as seq from machvon.whistle_message where report_id = $1::uuid', [id]);
    const seq = (next as { seq: number }).seq;
    await tx.query(
      `insert into machvon.whistle_message (tenant_id, report_id, sender, body, sent_on, handler_membership_id, seq) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, 'HANDLER', $2, $3::date, $4::uuid, $5)`,
      [id, text, today, handler, seq],
    );
    return { seq, sender: 'HANDLER', body: text, sentOn: today, handlerId: handler };
  }

  async counts(tx: TenantTx, today: string): Promise<{ total: number; open: number; acknowledgeOverdue: number; resolveOverdue: number }> {
    const rows = await tx.query<Raw>(`select ${WHISTLE_COLUMNS} from machvon.whistle_report`);
    const readings = rows.map((row) => toWhistle(row, today));
    return {
      total: readings.length,
      open: readings.filter((entry) => entry.status !== 'RESOLVED' && entry.status !== 'DISMISSED').length,
      acknowledgeOverdue: readings.filter((entry) => entry.clock.acknowledgeState === 'OVERDUE').length,
      resolveOverdue: readings.filter((entry) => entry.clock.resolveState === 'OVERDUE').length,
    };
  }
}

/** The reporter's side, over the control plane: the functions of V2605 take the slug and the hash of the access code. They hold no address, agent or account, and nothing here logs one. */
export class WhistlePublicReads {
  async submit(tx: TenantTx, slug: string, input: { category: string; text: string; codeHash: string; receivedOn: string }, policy: WhistlePolicy): Promise<void> {
    assertWhistleInput({ category: input.category, text: input.text });
    try {
      await tx.query('select machvon.whistle_submit($1, $2, $3, $4, $5::date, $6, $7)', [slug, input.category, input.text.trim(), input.codeHash, input.receivedOn, policy.acknowledge_days, policy.resolve_days]);
    } catch (error) {
      throw mapPublicError(error);
    }
  }

  async lookup(tx: TenantTx, slug: string, codeHash: string): Promise<{ category: string; status: string; receivedOn: string; acknowledgedOn: string | null; closedOn: string | null; publicNote: string | null } | undefined> {
    const [row] = await tx.query<Raw>(
      `select category, status, ${DAY('received_on')} as received_on, ${DAY('acknowledged_on')} as acknowledged_on, ${DAY('closed_on')} as closed_on, public_note from machvon.whistle_lookup($1, $2)`,
      [slug, codeHash],
    );
    return row === undefined ? undefined : { category: row.category as string, status: row.status as string, receivedOn: row.received_on as string, acknowledgedOn: (row.acknowledged_on as string | null) ?? null, closedOn: (row.closed_on as string | null) ?? null, publicNote: (row.public_note as string | null) ?? null };
  }

  async thread(tx: TenantTx, slug: string, codeHash: string): Promise<Array<{ seq: number; sender: string; body: string; sentOn: string }>> {
    const rows = await tx.query<Raw>(`select seq, sender, body, ${DAY('sent_on')} as sent_on from machvon.whistle_thread($1, $2)`, [slug, codeHash]);
    return rows.map((row) => ({ seq: row.seq as number, sender: row.sender as string, body: row.body as string, sentOn: row.sent_on as string }));
  }

  async reply(tx: TenantTx, slug: string, codeHash: string, body: string, sentOn: string): Promise<number> {
    const text = body.trim();
    if (text.length < 1 || text.length > 4000) throw new DomainError('VALIDATION_FAILED', 422, 'body');
    try {
      const [row] = await tx.query<{ whistle_reply: number }>('select machvon.whistle_reply($1, $2, $3, $4::date)', [slug, codeHash, text, sentOn]);
      return (row as { whistle_reply: number }).whistle_reply;
    } catch (error) {
      throw mapPublicError(error);
    }
  }
}

function mapPublicError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (/WHISTLE_CHANNEL_OFF/.test(error.message)) return new DomainError('RESOURCE_NOT_FOUND', 404);
  if (/WHISTLE_CODE_UNKNOWN/.test(error.message)) return new DomainError('RESOURCE_NOT_FOUND', 404);
  if (/WHISTLE_REPORT_CLOSED/.test(error.message)) return new DomainError('WHISTLE_STATE_INVALID', 409, 'status');
  return error;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Gifts register.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface GiftRow {
  id: string;
  recipientId: string;
  declaredBy: string;
  giverName: string;
  giverKind: GiverKind;
  projectId: string | null;
  description: string;
  valueVnd: string;
  receivedOn: string;
  declaredOn: string;
  status: GiftStatus;
  reviewerId: string | null;
  outcome: GiftOutcome | null;
  outcomeNote: string | null;
  closedOn: string | null;
  ruleVersion: number;
  reading: GiftReading;
  version: number;
}

const GIFT_COLUMNS = `id, recipient_membership_id, declared_by, giver_name, giver_kind, project_id, description, value_vnd::text as value_vnd, ${DAY('received_on')} as received_on, ${DAY('declared_on')} as declared_on, late, needs_review, may_be_kept,
  rule_version, status, reviewer_membership_id, outcome, outcome_note, ${DAY('closed_on')} as closed_on, version`;
const toGift = (row: Raw, policy: GiftPolicy): GiftRow => {
  const receivedOn = row.received_on as string;
  const declaredOn = row.declared_on as string;
  return {
    id: row.id as string,
    recipientId: row.recipient_membership_id as string,
    declaredBy: row.declared_by as string,
    giverName: row.giver_name as string,
    giverKind: row.giver_kind as GiverKind,
    projectId: (row.project_id as string | null) ?? null,
    description: row.description as string,
    valueVnd: row.value_vnd as string,
    receivedOn,
    declaredOn,
    status: row.status as GiftStatus,
    reviewerId: (row.reviewer_membership_id as string | null) ?? null,
    outcome: (row.outcome as GiftOutcome | null) ?? null,
    outcomeNote: (row.outcome_note as string | null) ?? null,
    closedOn: (row.closed_on as string | null) ?? null,
    ruleVersion: row.rule_version as number,
    // The flags are those stored at declaration (the rule of that day), not recomputed with today's rule.
    reading: { late: row.late as boolean, declareDueOn: giftReading({ receivedOn, declaredOn, valueVnd: row.value_vnd as string }, policy).declareDueOn, needsReview: row.needs_review as boolean, mayBeKept: row.may_be_kept as boolean },
    version: Number(row.version),
  };
};

export class GiftStore {
  policy(tx: TenantTx, today: string): Promise<PolicyReading<GiftPolicy>> {
    return readPolicy(tx, GIFT_RULE_TYPE, today, giftPolicyOf, giftDefaults);
  }

  async declare(
    tx: TenantTx,
    input: { recipientId: string; giverName: string; giverKind: string; projectId: string | null; description: string; valueVnd: string; receivedOn: string },
    declaredBy: string,
    today: string,
  ): Promise<GiftRow> {
    assertGiftInput({ giverName: input.giverName, giverKind: input.giverKind, valueVnd: input.valueVnd, receivedOn: input.receivedOn, declaredOn: today, description: input.description });
    const [member] = await tx.query<{ id: string }>('select id from machvon.membership where id = $1::uuid', [input.recipientId]);
    if (member === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'recipient_id');
    if (input.projectId !== null) {
      const [project] = await tx.query<{ id: string }>('select id from machvon.project where id = $1::uuid', [input.projectId]);
      if (project === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    }
    const reading = await this.policy(tx, today);
    const flags = giftReading({ receivedOn: input.receivedOn, declaredOn: today, valueVnd: input.valueVnd }, reading.policy);
    const [row] = await tx.query<{ id: string }>(
      `insert into machvon.gift_register (tenant_id, recipient_membership_id, declared_by, giver_name, giver_kind, project_id, description, value_vnd, received_on, declared_on, late, needs_review, may_be_kept, rule_version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7::numeric, $8::date, $9::date, $10, $11, $12, $13) returning id`,
      [input.recipientId, declaredBy, input.giverName.trim(), input.giverKind, input.projectId, input.description.trim(), input.valueVnd, input.receivedOn, today, flags.late, flags.needsReview, flags.mayBeKept, reading.version],
    );
    return (await this.find(tx, (row as { id: string }).id, today)) as GiftRow;
  }

  async find(tx: TenantTx, id: string, today: string, lock = false): Promise<GiftRow | undefined> {
    const policy = (await this.policy(tx, today)).policy;
    const [row] = await tx.query<Raw>(`select ${GIFT_COLUMNS} from machvon.gift_register where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : toGift(row, policy);
  }

  async list(tx: TenantTx, filter: { status?: GiftStatus | undefined; recipientId?: string | undefined; limit: number; offset: number }, today: string): Promise<GiftRow[]> {
    const policy = (await this.policy(tx, today)).policy;
    const rows = await tx.query<Raw>(
      `select ${GIFT_COLUMNS} from machvon.gift_register where ($1::text is null or status = $1) and ($2::uuid is null or recipient_membership_id = $2::uuid) order by declared_on desc, id limit $3 offset $4`,
      [filter.status ?? null, filter.recipientId ?? null, filter.limit, filter.offset],
    );
    return rows.map((row) => toGift(row, policy));
  }

  /** A second person takes the review. */
  async take(tx: TenantTx, id: string, expectedVersion: number, reviewer: string, today: string): Promise<GiftRow> {
    const gift = await this.find(tx, id, today, true);
    if (gift === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (gift.version !== expectedVersion) throw versionConflict(expectedVersion === gift.version ? gift.version : gift.version);
    if (gift.status !== 'DECLARED') throw new DomainError('GIFT_STATE_INVALID', 409, 'status');
    if (gift.recipientId === reviewer) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'reviewer');
    await tx.query(`update machvon.gift_register set status = 'UNDER_REVIEW', reviewer_membership_id = $2::uuid, version = version + 1 where id = $1::uuid`, [id, reviewer]);
    return (await this.find(tx, id, today)) as GiftRow;
  }

  async close(tx: TenantTx, id: string, expectedVersion: number, outcome: GiftOutcome, note: string, reviewer: string, today: string): Promise<GiftRow> {
    const gift = await this.find(tx, id, today, true);
    if (gift === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (gift.version !== expectedVersion) throw versionConflict(gift.version);
    if (gift.status !== 'UNDER_REVIEW') throw new DomainError('GIFT_STATE_INVALID', 409, 'status');
    // The one who took the review closes it: two people never close one gift between them in a way nobody owns.
    if (gift.reviewerId !== reviewer) throw new DomainError('SCOPE_DENIED', 403, 'reviewer');
    assertGiftClose({ outcome, reading: gift.reading, recipientId: gift.recipientId, reviewerId: reviewer, note: note.trim() });
    await tx.query(`update machvon.gift_register set status = 'CLOSED', outcome = $2, outcome_note = $3, closed_on = $4::date, version = version + 1 where id = $1::uuid`, [id, outcome, note.trim(), today]);
    return (await this.find(tx, id, today)) as GiftRow;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Photo findings.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PhotoFindingRow {
  id: string;
  kind: PhotoFindingKind;
  firstPhotoId: string;
  secondPhotoId: string;
  firstProjectId: string;
  secondProjectId: string;
  metres: number | null;
  minutes: number | null;
  ruleVersion: number;
  status: PhotoFindingStatus;
  reviewerId: string | null;
  reason: string | null;
  firstFlaggedAt: string;
  version: number;
}

const FINDING_COLUMNS = `id, kind, first_photo_id, second_photo_id, first_project_id, second_project_id, metres, minutes::float8 as minutes, rule_version, status, reviewer_membership_id, reason, ${ISO('first_flagged_at')} as first_flagged_at, version`;
const toFinding = (row: Raw): PhotoFindingRow => ({
  id: row.id as string,
  kind: row.kind as PhotoFindingKind,
  firstPhotoId: row.first_photo_id as string,
  secondPhotoId: row.second_photo_id as string,
  firstProjectId: row.first_project_id as string,
  secondProjectId: row.second_project_id as string,
  metres: (row.metres as number | null) ?? null,
  minutes: row.minutes === null || row.minutes === undefined ? null : Number(row.minutes),
  ruleVersion: row.rule_version as number,
  status: row.status as PhotoFindingStatus,
  reviewerId: (row.reviewer_membership_id as string | null) ?? null,
  reason: (row.reason as string | null) ?? null,
  firstFlaggedAt: row.first_flagged_at as string,
  version: Number(row.version),
});

export class PhotoFindingStore {
  policy(tx: TenantTx, today: string): Promise<PolicyReading<PhotoIntegrityPolicy>> {
    return readPolicy(tx, PHOTO_INTEGRITY_RULE_TYPE, today, photoIntegrityPolicyOf, photoIntegrityDefaults);
  }

  /** Looks at every registered photo, writes the pairs that need explaining (a pair once, whoever scans), and leaves the pairs it already has as they are. */
  async scan(tx: TenantTx, today: string): Promise<{ photos: number; pairs: number; created: number }> {
    const reading = await this.policy(tx, today);
    const rows = await tx.query<Raw>(
      `select id, project_id, file_sha256, ${DAY("(select d.record_date from machvon.site_diary d where d.tenant_id = p.tenant_id and d.id = p.site_diary_id)")} as diary_day, ${ISO('taken_at_exif')} as taken_at, gps_lat::float8 as lat, gps_lng::float8 as lng
         from machvon.site_photo p where scan_status <> 'INFECTED'`,
    );
    const photos: PhotoFact[] = rows.map((row) => ({
      id: row.id as string,
      projectId: row.project_id as string,
      sha256: (row.file_sha256 as string).trim(),
      diaryDay: (row.diary_day as string | null) ?? null,
      takenAt: row.taken_at === null ? null : new Date(row.taken_at as string),
      lat: (row.lat as number | null) ?? null,
      lng: (row.lng as number | null) ?? null,
    }));
    const projectOf = new Map(photos.map((photo) => [photo.id, photo.projectId]));
    const pairs = findPhotoPairs(photos, reading.policy);
    let created = 0;
    for (const pair of pairs) {
      const inserted = await tx.query<{ id: string }>(
        `insert into machvon.photo_finding (tenant_id, kind, first_photo_id, second_photo_id, first_project_id, second_project_id, metres, minutes, rule_version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8) on conflict (tenant_id, first_photo_id, second_photo_id) do nothing returning id`,
        [pair.kind, pair.firstId, pair.secondId, projectOf.get(pair.firstId), projectOf.get(pair.secondId), pair.metres, pair.minutes, reading.version],
      );
      if (inserted.length === 1) {
        created += 1;
        await this.event(tx, (inserted[0] as { id: string }).id, 'FLAGGED', 'OPEN', null, null);
      }
    }
    return { photos: photos.length, pairs: pairs.length, created };
  }

  private async event(tx: TenantTx, id: string, move: string, to: string, actor: string | null, reason: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.photo_finding_event (tenant_id, finding_id, move, to_status, actor_membership_id, reason) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5)`,
      [id, move, to, actor, reason],
    );
  }

  async list(tx: TenantTx, filter: { status?: PhotoFindingStatus | undefined; kind?: PhotoFindingKind | undefined; limit: number; offset: number }): Promise<PhotoFindingRow[]> {
    const rows = await tx.query<Raw>(`select ${FINDING_COLUMNS} from machvon.photo_finding where ($1::text is null or status = $1) and ($2::text is null or kind = $2) order by first_flagged_at, id limit $3 offset $4`, [filter.status ?? null, filter.kind ?? null, filter.limit, filter.offset]);
    return rows.map(toFinding);
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<PhotoFindingRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${FINDING_COLUMNS} from machvon.photo_finding where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : toFinding(row);
  }

  async events(tx: TenantTx, id: string): Promise<Array<{ id: string; move: string; toStatus: string; actorId: string | null; reason: string | null; at: string }>> {
    const rows = await tx.query<Raw>(`select id, move, to_status, actor_membership_id, reason, ${ISO('at')} as at from machvon.photo_finding_event where finding_id = $1::uuid order by at, id`, [id]);
    return rows.map((row) => ({ id: row.id as string, move: row.move as string, toStatus: row.to_status as string, actorId: (row.actor_membership_id as string | null) ?? null, reason: (row.reason as string | null) ?? null, at: row.at as string }));
  }

  /** The people who uploaded the two photos: they do not explain their own pair. */
  private async authors(tx: TenantTx, finding: PhotoFindingRow): Promise<string[]> {
    const rows = await tx.query<{ uploaded_by: string }>('select uploaded_by from machvon.site_photo where id in ($1::uuid, $2::uuid)', [finding.firstPhotoId, finding.secondPhotoId]);
    return rows.map((row) => row.uploaded_by);
  }

  async move(tx: TenantTx, id: string, expectedVersion: number, move: PhotoFindingMove, actor: string, reason: string | null): Promise<PhotoFindingRow> {
    const finding = await this.find(tx, id, true);
    if (finding === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (finding.version !== expectedVersion) throw versionConflict(finding.version);
    const text = reason === null ? null : reason.trim();
    assertPhotoFindingMove({ move, reason: text, actorId: actor, photoAuthorIds: await this.authors(tx, finding) });
    const to = nextPhotoFindingStatus(finding.status, move);
    await tx.query('update machvon.photo_finding set status = $2, reviewer_membership_id = $3::uuid, reason = coalesce($4, reason), version = version + 1 where id = $1::uuid', [id, to, actor, text]);
    await this.event(tx, id, move, to, actor, text);
    return (await this.find(tx, id)) as PhotoFindingRow;
  }
}
