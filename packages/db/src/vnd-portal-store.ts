import { randomUUID } from 'node:crypto';
import { DomainError, dueFrom, expiryState, hasControlChar, nextPortalRequestStatus, projectPortalProfile, requestClock, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { ExpiryState, ExpiryWarningPolicy, PortalRequestKind, PortalRequestStatus, RequestClock, WorkCalendarSource } from '@machvon/kernel';
import { BidContractorStore } from './bid-contractor-store.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { timestampKey } from './keyset.ts';
import { enterPortalPath } from './portal-boundary.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPortalPolicyReader } from './vnd3-portal-policy.ts';
import { VendorPolicyReader } from './vendor-policy.ts';
import { VendorPortalAttachmentStore } from './vnd-portal-attachment-store.ts';
import { VendorProfileStore } from './vendor-profile-store.ts';
import type { KeyStaffRow, QualificationRow } from './vendor-qualification-store.ts';
import { VendorQualificationStore } from './vendor-qualification-store.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ZERO_CONTRACTOR = '00000000-0000-0000-0000-000000000000';
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface PortalRequestRow {
  id: string;
  contractorId: string;
  contractorName: string;
  kind: PortalRequestKind;
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  body: string;
  dueAt: string;
  deadlinePolicyVersion: string;
  remindBeforeDays: number;
  status: 'OPEN' | 'RESPONDED' | 'ACCEPTED' | 'CANCELLED';
  requestedBy: string;
  requestedAt: string;
  responseText: string | null;
  responseDocumentId: string | null;
  responseQualificationId: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  responseLate: boolean | null;
  round: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  cancelledReason: string | null;
  version: number;
  clock: RequestClock;
}

export interface NewPortalRequest {
  kind: PortalRequestKind;
  title: string;
  body?: string | undefined;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  dueOn?: string | undefined;
}

export interface PortalAnswer {
  text?: string | undefined;
  documentId?: string | undefined;
  qualificationId?: string | undefined;
}

export interface PortalEvaluationRow {
  id: string;
  contractId: string;
  contractCode: string | null;
  evaluationKind: string;
  periodLabel: string;
  rating: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  overallScore: number;
  scoreQuality: number;
  scoreSchedule: number;
  scoreSafetyEnv: number;
  scoreCooperation: number;
  scoreFinancial: number;
  remarks: string | null;
  approvedAt: string | null;
  openRequestId: string | null;
}

export interface PortalCaller {
  contractorId: string;
  membershipId: string;
}

interface RequestSql {
  id: string;
  contractor_id: string;
  contractor_name: string;
  kind: PortalRequestKind;
  subject_type: string | null;
  subject_id: string | null;
  title: string;
  body: string;
  due_at: string;
  deadline_policy_version: string;
  remind_before_days: number;
  status: 'OPEN' | 'RESPONDED' | 'ACCEPTED' | 'CANCELLED';
  requested_by: string;
  requested_at: string;
  response_text: string | null;
  response_document_id: string | null;
  response_qualification_id: string | null;
  responded_by: string | null;
  responded_at: string | null;
  response_late: boolean | null;
  round: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  cancelled_reason: string | null;
  version: string;
}

const SELECT = `select r.id, r.contractor_id, c.legal_name as contractor_name, r.kind, r.subject_type, r.subject_id, r.title, r.body, ${timestampKey('r.due_at')} as due_at, r.deadline_policy_version, r.remind_before_days, r.status,
  r.requested_by, ${timestampKey('r.requested_at')} as requested_at, r.response_text, r.response_document_id, r.response_qualification_id, r.responded_by, ${timestampKey('r.responded_at')} as responded_at, r.response_late, r.round,
  r.reviewed_by, ${timestampKey('r.reviewed_at')} as reviewed_at, r.review_note, r.cancelled_reason, r.version::text as version
  from machvon.contractor_portal_request r join machvon.contractor c on c.tenant_id = r.tenant_id and c.id = r.contractor_id`;

/** The tables a request may point at, with the column that says whose it is (none: it is not about one contractor). */
const SUBJECT_TABLES: Readonly<Record<string, { table: string; owner: string | null }>> = {
  CONTRACT: { table: 'contract', owner: 'contractor_id' },
  PERFORMANCE: { table: 'contractor_performance', owner: 'contractor_id' },
  QUALIFICATION: { table: 'contractor_qualification', owner: 'contractor_id' },
  SCREENING_HIT: { table: 'screening_hit', owner: 'contractor_id' },
  REMEDIATION_PLAN: { table: 'contractor_remediation_plan', owner: 'contractor_id' },
  RESTRICTION_CASE: { table: 'restriction_case', owner: 'contractor_id' },
  PACKAGE: { table: 'procurement_package', owner: null },
};

const textOf = (value: string, field: string, min: number, max: number): string => {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
};

const endOfDay = (day: string): Date => new Date(`${day}T17:00:00+07:00`);

/**
 * The channel of requests between the staff of the investor and a contractor (VND-3, V15; docs/vendor-investigation.md section 5). Staff ask (a time limit by the rule `VENDOR_PORTAL` of the kind of request, counted on the
 * published working calendar), the contractor answers through the portal, staff accept the answer or return it for another round with a reason. A contractor may always answer: a late answer is kept and marked late, never
 * refused. The contractor of a portal call is read ONLY from the guest membership of the caller (`enter`), never from a path or a body, and from then on the database holds the boundary too (V2446): another contractor's row is
 * not there to be read, so it is 404.
 */
export class VendorPortalStore {
  private readonly policies: VendorPortalPolicyReader;
  private readonly calendars: HomeWorkCalendars;
  private readonly contractors = new BidContractorStore();
  private readonly profiles = new VendorProfileStore();
  private readonly qualifications = new VendorQualificationStore();
  private readonly attachments = new VendorPortalAttachmentStore();

  constructor(policies: VendorPortalPolicyReader = new VendorPortalPolicyReader(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policies = policies;
    this.calendars = calendars;
  }

  // -- The portal path ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** Puts the transaction on the portal path of the contractor the caller is bound to: 403 `PORTAL_CONTRACTOR_REQUIRED` for anybody who is not a guest contractor with a contractor. */
  async enter(tx: TenantTx, membershipId: string): Promise<PortalCaller> {
    const standing = await this.contractors.callerOf(tx, membershipId);
    if (!standing.guest || standing.contractorId === ZERO_CONTRACTOR) throw new DomainError('PORTAL_CONTRACTOR_REQUIRED', 403);
    await enterPortalPath(tx, standing.contractorId);
    return { contractorId: standing.contractorId, membershipId };
  }

  // -- Requests ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private rowOf(row: RequestSql, now: Date): PortalRequestRow {
    return {
      id: row.id,
      contractorId: row.contractor_id,
      contractorName: row.contractor_name,
      kind: row.kind,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      title: row.title,
      body: row.body,
      dueAt: row.due_at,
      deadlinePolicyVersion: row.deadline_policy_version,
      remindBeforeDays: row.remind_before_days,
      status: row.status,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      responseText: row.response_text,
      responseDocumentId: row.response_document_id,
      responseQualificationId: row.response_qualification_id,
      respondedBy: row.responded_by,
      respondedAt: row.responded_at,
      responseLate: row.response_late,
      round: row.round,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      reviewNote: row.review_note,
      cancelledReason: row.cancelled_reason,
      version: Number(row.version),
      // An open request that was answered in an earlier round and returned is open again: the clock of the new round is the due day it carries.
      clock: requestClock({ dueAt: new Date(row.due_at), respondedAt: row.status === 'OPEN' || row.status === 'CANCELLED' || row.responded_at === null ? null : new Date(row.responded_at), now, remindBeforeDays: row.remind_before_days }),
    };
  }

  async find(tx: TenantTx, id: string, now: Date, lock = false): Promise<PortalRequestRow | undefined> {
    const rows = await tx.query<RequestSql>(`${SELECT} where r.id = $1::uuid${lock ? ' for update of r' : ''}`, [id]);
    return rows[0] === undefined ? undefined : this.rowOf(rows[0], now);
  }

  async list(tx: TenantTx, filter: { contractorId?: string | undefined; status?: string | undefined; kind?: string | undefined; limit?: number | undefined }, now: Date): Promise<PortalRequestRow[]> {
    const rows = await tx.query<RequestSql>(
      `${SELECT} where ($1::uuid is null or r.contractor_id = $1::uuid) and ($2::text is null or r.status = $2) and ($3::text is null or r.kind = $3) order by r.due_at, r.id limit $4`,
      [filter.contractorId ?? null, filter.status ?? null, filter.kind ?? null, filter.limit ?? 300],
    );
    return rows.map((row) => this.rowOf(row, now));
  }

  private async calendarOf(tx: TenantTx, now: Date): Promise<WorkCalendarSource> {
    const source = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    if (source === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
    return source;
  }

  private async event(tx: TenantTx, request: { id: string; contractorId: string }, move: string, from: string | null, to: string, actor: string, note: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.contractor_portal_request_event (tenant_id, id, request_id, contractor_id, move, from_status, to_status, actor_id, note, at) values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, clock_timestamp())`,
      [randomUUID(), request.id, request.contractorId, move, from, to, actor, note],
    );
  }

  async events(tx: TenantTx, requestId: string): Promise<Array<{ id: string; move: string; fromStatus: string | null; toStatus: string; actorId: string; note: string | null; at: string }>> {
    const rows = await tx.query<{ id: string; move: string; from_status: string | null; to_status: string; actor_id: string; note: string | null; at: string }>(
      `select id, move, from_status, to_status, actor_id, note, ${timestampKey('at')} as at from machvon.contractor_portal_request_event where request_id = $1::uuid order by at, id`,
      [requestId],
    );
    return rows.map((row) => ({ id: row.id, move: row.move, fromStatus: row.from_status, toStatus: row.to_status, actorId: row.actor_id, note: row.note, at: row.at }));
  }

  /** An active guest membership is bound to the contractor: without one a request has nobody to answer it (422 `CONTRACTOR_PORTAL_NOT_BOUND`). */
  async assertBound(tx: TenantTx, contractorId: string, now: Date): Promise<void> {
    const rows = await tx.query(
      "select 1 from machvon.membership where contractor_id = $1::uuid and membership_type = 'GUEST_CONTRACTOR' and status = 'Active' and (valid_until is null or valid_until > $2::timestamptz) limit 1",
      [contractorId, now.toISOString()],
    );
    if (rows.length === 0) throw new DomainError('CONTRACTOR_PORTAL_NOT_BOUND', 422, 'contractor_id');
  }

  private async assertSubject(tx: TenantTx, contractorId: string, type: string | undefined, id: string | undefined): Promise<void> {
    if ((type === undefined) !== (id === undefined)) throw invalid('subject_id');
    if (type === undefined || id === undefined) return;
    const spec = SUBJECT_TABLES[type];
    if (spec === undefined) throw invalid('subject_type');
    const owner = spec.owner === null ? '' : ` and ${spec.owner} = $2::uuid`;
    const found = await tx.query(`select 1 from machvon.${spec.table} where id = $1::uuid${owner}`, spec.owner === null ? [id] : [id, contractorId]);
    if (found.length === 0) throw invalid('subject_id');
  }

  /** Staff ask the contractor for something. The limit is the rule of the kind (days, calendar or working, counted on the published calendar), or the day staff name when it is not before today. */
  async create(tx: TenantTx, contractorId: string, input: NewPortalRequest, actor: string, now: Date): Promise<PortalRequestRow> {
    const today = vietnamDateOf(now);
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    await this.assertBound(tx, contractorId, now);
    await this.assertSubject(tx, contractorId, input.subjectType, input.subjectId);
    const title = textOf(input.title, 'title', 3, 200);
    const body = input.body === undefined ? '' : input.body.trim();
    if (body.length > 4000 || hasControlChar(body.replace(/[\n\r\t]/g, ' '))) throw invalid('body');
    const rule = await this.policies.clock(tx, input.kind, today);
    let dueAt: Date;
    if (input.dueOn !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn) || new Date(`${input.dueOn}T00:00:00Z`).toISOString().slice(0, 10) !== input.dueOn || input.dueOn < today) throw invalid('due_on');
      dueAt = endOfDay(input.dueOn);
    } else {
      dueAt = dueFrom(rule.value.day_unit, rule.value.response_days, now, await this.calendarOf(tx, now));
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_portal_request (tenant_id, id, contractor_id, kind, subject_type, subject_id, title, body, due_at, deadline_policy_version, remind_before_days, requested_by, requested_at)
       values (${TENANT}, $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8::timestamptz, $9, $10, $11::uuid, $12::timestamptz)`,
      [id, contractorId, input.kind, input.subjectType ?? null, input.subjectId ?? null, title, body, dueAt.toISOString(), rule.version, rule.value.remind_before_days, actor, now.toISOString()],
    );
    await this.event(tx, { id, contractorId }, 'OPEN', null, 'OPEN', actor, null);
    return (await this.find(tx, id, now)) as PortalRequestRow;
  }

  private async locked(tx: TenantTx, id: string, expectedVersion: number, now: Date, contractorId?: string): Promise<PortalRequestRow> {
    const row = await this.find(tx, id, now, true);
    // A contractor asks for its own rows only: the row of another contractor is not found (the database says the same, the check keeps the answer 404 when the path is not the portal path).
    if (row === undefined || (contractorId !== undefined && row.contractorId !== contractorId)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  /** Staff accept the answer. The person who accepts is never the person who answered (403 `SELF_APPROVAL_DENIED`; a CHECK too). */
  async accept(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<PortalRequestRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const next = nextPortalRequestStatus(current.status as PortalRequestStatus, 'ACCEPT', 'STAFF');
    if (current.respondedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    await tx.query('update machvon.contractor_portal_request set status = $2, reviewed_by = $3::uuid, reviewed_at = $4::timestamptz, version = version + 1 where id = $1::uuid', [id, next, actor, now.toISOString()]);
    await this.event(tx, current, 'ACCEPT', current.status, next, actor, null);
    return (await this.find(tx, id, now)) as PortalRequestRow;
  }

  /** Staff send the answer back for another round, with a reason: the request opens again with a new limit (the rule of its kind, from now) and the last answer is kept for the contractor to see. */
  async returnRequest(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<PortalRequestRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const next = nextPortalRequestStatus(current.status as PortalRequestStatus, 'RETURN', 'STAFF', reason);
    const rule = await this.policies.clock(tx, current.kind, vietnamDateOf(now));
    const dueAt = dueFrom(rule.value.day_unit, rule.value.response_days, now, await this.calendarOf(tx, now));
    const note = textOf(reason, 'reason', 5, 2000);
    await tx.query(
      'update machvon.contractor_portal_request set status = $2, round = round + 1, review_note = $3, due_at = $4::timestamptz, deadline_policy_version = $5, remind_before_days = $6, version = version + 1 where id = $1::uuid',
      [id, next, note, dueAt.toISOString(), rule.version, rule.value.remind_before_days],
    );
    await this.event(tx, current, 'RETURN', current.status, next, actor, note);
    return (await this.find(tx, id, now)) as PortalRequestRow;
  }

  async cancel(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<PortalRequestRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const next = nextPortalRequestStatus(current.status as PortalRequestStatus, 'CANCEL', 'STAFF', reason);
    const note = textOf(reason, 'reason', 5, 500);
    await tx.query('update machvon.contractor_portal_request set status = $2, cancelled_reason = $3, version = version + 1 where id = $1::uuid', [id, next, note]);
    await this.event(tx, current, 'CANCEL', current.status, next, actor, note);
    return (await this.find(tx, id, now)) as PortalRequestRow;
  }

  // -- The contractor ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The contractor answers. It always may, also after the limit (the answer is then marked late); an answer needs words, a paper or a certificate it put on file. */
  async respond(tx: TenantTx, caller: PortalCaller, id: string, expectedVersion: number, answer: PortalAnswer, now: Date): Promise<PortalRequestRow> {
    const current = await this.locked(tx, id, expectedVersion, now, caller.contractorId);
    const next = nextPortalRequestStatus(current.status as PortalRequestStatus, 'RESPOND', 'CONTRACTOR');
    const text = answer.text === undefined ? null : textOf(answer.text, 'text', 1, 4000);
    if (text === null && answer.documentId === undefined && answer.qualificationId === undefined) throw invalid('text');
    // PORTAL-2: the paper must be one of the contractor's own portal attachments (the register of documents is closed to the portal path).
    if (answer.documentId !== undefined) await this.attachments.take(tx, answer.documentId, 'REQUEST', id);
    if (answer.qualificationId !== undefined && (await tx.query('select 1 from machvon.contractor_qualification where id = $1::uuid and contractor_id = $2::uuid', [answer.qualificationId, caller.contractorId])).length === 0) throw invalid('qualification_id');
    const late = now.getTime() > new Date(current.dueAt).getTime();
    await tx.query(
      `update machvon.contractor_portal_request set status = $2, response_text = $3, response_document_id = $4::uuid, response_qualification_id = $5::uuid, responded_by = $6::uuid, responded_at = $7::timestamptz, response_late = $8,
              reviewed_by = null, reviewed_at = null, version = version + 1 where id = $1::uuid`,
      [id, next, text, answer.documentId ?? null, answer.qualificationId ?? null, caller.membershipId, now.toISOString(), late],
    );
    await this.event(tx, current, 'RESPOND', current.status, next, caller.membershipId, null);
    return (await this.find(tx, id, now)) as PortalRequestRow;
  }

  async listOwn(tx: TenantTx, caller: PortalCaller, status: string | undefined, now: Date): Promise<PortalRequestRow[]> {
    return this.list(tx, { contractorId: caller.contractorId, status }, now);
  }

  /** The profile as the contractor sees it: the whitelist of the kernel and nothing else. */
  async profile(tx: TenantTx, caller: PortalCaller): Promise<Record<string, unknown>> {
    const row = await this.profiles.find(tx, caller.contractorId);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return projectPortalProfile({
      id: row.contractorId,
      legal_name: row.legalName,
      tax_identifier: row.taxIdentifier,
      verification_status: row.verificationStatus,
      legal_rep_name: row.legalRepName,
      legal_rep_position: row.legalRepPosition,
      registered_address: row.registeredAddress,
      phone: row.phone,
      email: row.email,
      business_registration_no: row.businessRegistrationNo,
      ownership_declaration: row.ownershipDeclaration,
      next_review_due: row.nextReviewDue,
      profile_reviewed_at: row.profileReviewedAt,
      version: row.version,
    });
  }

  /** The certificates and the key staff of the contractor with the state of each on the day, by the rule of the expiry warnings. */
  async ownQualifications(tx: TenantTx, caller: PortalCaller, today: string): Promise<{ qualifications: Array<QualificationRow & { state: ExpiryState }>; keyStaff: Array<KeyStaffRow & { state: ExpiryState }>; policies: { qualification: ExpiryWarningPolicy; keyStaff: ExpiryWarningPolicy } }> {
    const reader = new VendorPolicyReader();
    const qualificationPolicy = (await reader.expiry(tx, 'QUALIFICATION', today)).value;
    const staffPolicy = (await reader.expiry(tx, 'KEY_STAFF', today)).value;
    const qualifications = await this.qualifications.qualifications(tx, caller.contractorId);
    const staff = await this.qualifications.keyStaff(tx, caller.contractorId);
    return {
      qualifications: qualifications.map((row) => ({ ...row, state: expiryState({ issuedOn: row.issuedOn, expiresOn: row.expiresOn, revoked: row.revokedAt !== null }, today, qualificationPolicy) })),
      keyStaff: staff.map((row) => ({ ...row, state: expiryState({ issuedOn: row.issuedOn, expiresOn: row.expiresOn, revoked: row.revokedAt !== null }, today, staffPolicy) })),
      policies: { qualification: qualificationPolicy, keyStaff: staffPolicy },
    };
  }

  /** The contractor puts a certificate on file: entered by the guest membership, unverified until a member of staff checks it against the paper (the person who enters it never verifies it). The request it is meant for, if any, must be its own; the answer to the request names the certificate. */
  async submitQualification(tx: TenantTx, caller: PortalCaller, input: Parameters<VendorQualificationStore['addQualification']>[2], requestId: string | undefined, now: Date): Promise<QualificationRow> {
    if (requestId !== undefined) {
      const request = await this.find(tx, requestId, now);
      if (request === undefined || request.contractorId !== caller.contractorId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    }
    const row = await this.qualifications.addQualification(tx, caller.contractorId, input, caller.membershipId, { documentChecked: true });
    if (input.documentId !== undefined) await this.attachments.take(tx, input.documentId, 'QUALIFICATION', row.id);
    return row;
  }

  /** The evaluations of the contract performance that were approved (never a draft or one still being checked), with the open request that asks for the contractor's answer, if any. */
  async ownEvaluations(tx: TenantTx, caller: PortalCaller): Promise<PortalEvaluationRow[]> {
    const rows = await tx.query<{
      id: string; contract_id: string; contract_code: string | null; evaluation_kind: string; period_label: string; rating: PortalEvaluationRow['rating']; overall_score: string; score_quality: number; score_schedule: number; score_safety_env: number;
      score_cooperation: number; score_financial: number; remarks: string | null; approved_at: string | null; open_request_id: string | null;
    }>(
      `select p.id, p.contract_id, k.code as contract_code, p.evaluation_kind, p.period_label, p.rating, p.overall_score::text as overall_score, p.score_quality, p.score_schedule, p.score_safety_env, p.score_cooperation, p.score_financial, p.remarks,
              ${timestampKey('p.approved_at')} as approved_at,
              (select r.id from machvon.contractor_portal_request r where r.contractor_id = p.contractor_id and r.subject_type = 'PERFORMANCE' and r.subject_id = p.id and r.status in ('OPEN', 'RESPONDED') order by r.requested_at desc limit 1) as open_request_id
         from machvon.contractor_performance p left join machvon.contract k on k.tenant_id = p.tenant_id and k.id = p.contract_id
        where p.contractor_id = $1::uuid and p.status = 'APPROVED' order by p.approved_at desc nulls last, p.id`,
      [caller.contractorId],
    );
    return rows.map((row) => ({
      id: row.id,
      contractId: row.contract_id,
      contractCode: row.contract_code,
      evaluationKind: row.evaluation_kind,
      periodLabel: row.period_label,
      rating: row.rating,
      overallScore: Number(row.overall_score),
      scoreQuality: row.score_quality,
      scoreSchedule: row.score_schedule,
      scoreSafetyEnv: row.score_safety_env,
      scoreCooperation: row.score_cooperation,
      scoreFinancial: row.score_financial,
      remarks: row.remarks,
      approvedAt: row.approved_at,
      openRequestId: row.open_request_id,
    }));
  }

  /** The figures of the home page of the portal and the indicator of the register: requests that are waiting, late, answered on time. */
  async figures(tx: TenantTx, now: Date): Promise<{ answeredInTime: number; answeredLate: number; overdueOpen: number; open: number; responded: number }> {
    const [row] = await tx.query<{ in_time: number; late: number; overdue: number; open: number; responded: number }>(
      `select count(*) filter (where responded_at is not null and response_late is false and status in ('RESPONDED', 'ACCEPTED'))::int as in_time,
              count(*) filter (where responded_at is not null and response_late is true and status in ('RESPONDED', 'ACCEPTED'))::int as late,
              count(*) filter (where status = 'OPEN' and due_at < $1::timestamptz)::int as overdue,
              count(*) filter (where status = 'OPEN')::int as open,
              count(*) filter (where status = 'RESPONDED')::int as responded
         from machvon.contractor_portal_request`,
      [now.toISOString()],
    );
    return { answeredInTime: row?.in_time ?? 0, answeredLate: row?.late ?? 0, overdueOpen: row?.overdue ?? 0, open: row?.open ?? 0, responded: row?.responded ?? 0 };
  }

  /** The requests that raise an alert now: answered and waiting for review, due soon, overdue. */
  async alertable(tx: TenantTx, now: Date): Promise<PortalRequestRow[]> {
    const rows = await tx.query<RequestSql>(`${SELECT} where r.status in ('OPEN', 'RESPONDED') order by r.due_at, r.id limit 2000`);
    return rows.map((row) => this.rowOf(row, now)).filter((row) => row.status === 'RESPONDED' || row.clock === 'DUE_SOON' || row.clock === 'OVERDUE');
  }
}
