import { randomUUID } from 'node:crypto';
import { DomainError, bidSecurityFactor, deadlineClock, dueFrom, hasControlChar, moveReputationEvent, versionConflict, vietnamDateOf } from '@machvon/kernel';
import type { BidSecurityFactor, DeadlineClockState, ReputationBehaviour, ReputationEventState, WorkCalendarSource } from '@machvon/kernel';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';
import { VendorPolicyReader } from './vendor-policy.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface ReputationEventRow {
  id: string;
  contractorId: string;
  contractorName: string;
  packageId: string | null;
  contractId: string | null;
  behaviourCode: ReputationBehaviour;
  eventOn: string;
  description: string;
  evidenceDocumentId: string | null;
  status: ReputationEventState;
  recordedBy: string;
  recordedAt: string;
  postDueAt: string;
  deadlinePolicyVersion: string;
  postedBy: string | null;
  postedAt: string | null;
  postingRef: string | null;
  retractedBy: string | null;
  retractedAt: string | null;
  retractReason: string | null;
  version: number;
  /** Where the 7-working-day limit stands on the day the row was read. */
  clock: DeadlineClockState;
}

export interface NewReputationEvent {
  contractorId: string;
  packageId?: string | undefined;
  contractId?: string | undefined;
  behaviourCode: ReputationBehaviour;
  eventOn: string;
  description: string;
  evidenceDocumentId?: string | undefined;
}

interface EventSql {
  id: string;
  contractor_id: string;
  contractor_name: string;
  package_id: string | null;
  contract_id: string | null;
  behaviour_code: ReputationBehaviour;
  event_on: string;
  description: string;
  evidence_document_id: string | null;
  status: ReputationEventState;
  recorded_by: string;
  recorded_at: string;
  post_due_at: string;
  deadline_policy_version: string;
  posted_by: string | null;
  posted_at: string | null;
  posting_ref: string | null;
  retracted_by: string | null;
  retracted_at: string | null;
  retract_reason: string | null;
  version: string;
}

const SELECT = `select e.id, e.contractor_id, c.legal_name as contractor_name, e.package_id, e.contract_id, e.behaviour_code, e.event_on::text as event_on, e.description, e.evidence_document_id, e.status, e.recorded_by,
  ${timestampKey('e.recorded_at')} as recorded_at, ${timestampKey('e.post_due_at')} as post_due_at, e.deadline_policy_version, e.posted_by, ${timestampKey('e.posted_at')} as posted_at, e.posting_ref, e.retracted_by,
  ${timestampKey('e.retracted_at')} as retracted_at, e.retract_reason, e.version::text as version
  from machvon.contractor_reputation_event e join machvon.contractor c on c.tenant_id = e.tenant_id and c.id = e.contractor_id`;

function textOf(value: string, field: string, min: number, max: number): string {
  const text = value.trim();
  if (text.length < min || text.length > max || hasControlChar(text)) throw invalid(field);
  return text;
}

/**
 * The ledger of events of bid conduct (VND-1, V3; Điều 20 NĐ 214/2025). An event is recorded with the day it happened and the day its posting on the national system falls due (7 working days by the rule
 * EGP_POSTING_DEADLINES code REPUTATION_EVENT, counted on the published working calendar); somebody other than the person who recorded it posts it and keeps the receipt, or retracts it with a reason. A posted event raises
 * the factor on the bid security of the contractor for the years the rule `VENDOR_REPUTATION` says. Nothing about what happened is rewritten.
 */
export class VendorReputationStore {
  private readonly policies: VendorPolicyReader;
  private readonly calendars: HomeWorkCalendars;

  constructor(policies: VendorPolicyReader = new VendorPolicyReader(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policies = policies;
    this.calendars = calendars;
  }

  private rowOf(row: EventSql, remindBeforeDays: number, now: Date): ReputationEventRow {
    const doneAt = row.status === 'POSTED' && row.posted_at !== null ? new Date(row.posted_at) : row.status === 'RETRACTED' ? new Date(row.post_due_at) : null;
    return {
      id: row.id,
      contractorId: row.contractor_id,
      contractorName: row.contractor_name,
      packageId: row.package_id,
      contractId: row.contract_id,
      behaviourCode: row.behaviour_code,
      eventOn: row.event_on,
      description: row.description,
      evidenceDocumentId: row.evidence_document_id,
      status: row.status,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
      postDueAt: row.post_due_at,
      deadlinePolicyVersion: row.deadline_policy_version,
      postedBy: row.posted_by,
      postedAt: row.posted_at,
      postingRef: row.posting_ref,
      retractedBy: row.retracted_by,
      retractedAt: row.retracted_at,
      retractReason: row.retract_reason,
      version: Number(row.version),
      clock: deadlineClock({ dueAt: new Date(row.post_due_at), doneAt, now, remindBeforeDays }),
    };
  }

  async list(tx: TenantTx, filter: { contractorId?: string | undefined; status?: ReputationEventState | undefined; limit?: number | undefined }, now: Date): Promise<ReputationEventRow[]> {
    const policy = (await this.policies.postingDeadline(tx, vietnamDateOf(now))).value;
    const rows = await tx.query<EventSql>(`${SELECT} where ($1::uuid is null or e.contractor_id = $1::uuid) and ($2::text is null or e.status = $2) order by e.event_on desc, e.id desc limit $3`, [filter.contractorId ?? null, filter.status ?? null, filter.limit ?? 200]);
    return rows.map((row) => this.rowOf(row, policy.remind_before_days, now));
  }

  async find(tx: TenantTx, id: string, now: Date, lock = false): Promise<ReputationEventRow | undefined> {
    const policy = (await this.policies.postingDeadline(tx, vietnamDateOf(now))).value;
    const rows = await tx.query<EventSql>(`${SELECT} where e.id = $1::uuid${lock ? ' for update of e' : ''}`, [id]);
    return rows[0] === undefined ? undefined : this.rowOf(rows[0], policy.remind_before_days, now);
  }

  private async calendarOf(tx: TenantTx, now: Date): Promise<WorkCalendarSource> {
    const source = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    if (source === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'calendar_code');
    return source;
  }

  /** Records an event. The posting falls due `due_in` working days (the rule) after the day it happened, counted on the published calendar (422 `CALENDAR_NOT_EFFECTIVE` when there is none, never a guessed day). */
  async record(tx: TenantTx, input: NewReputationEvent, actor: string, now: Date): Promise<ReputationEventRow> {
    const today = vietnamDateOf(now);
    const rule = await this.policies.postingDeadline(tx, today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eventOn) || new Date(`${input.eventOn}T00:00:00Z`).toISOString().slice(0, 10) !== input.eventOn || input.eventOn > today) throw invalid('event_on');
    const description = textOf(input.description, 'description', 10, 2000);
    if ((await tx.query('select 1 from machvon.contractor where id = $1::uuid', [input.contractorId])).length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (input.packageId !== undefined && (await tx.query('select 1 from machvon.procurement_package where id = $1::uuid', [input.packageId])).length === 0) throw invalid('package_id');
    if (input.contractId !== undefined && (await tx.query('select 1 from machvon.contract where id = $1::uuid', [input.contractId])).length === 0) throw invalid('contract_id');
    if (input.evidenceDocumentId !== undefined && (await tx.query('select 1 from machvon.document where id = $1::uuid', [input.evidenceDocumentId])).length === 0) throw invalid('evidence_document_id');
    // The day of the event starts the clock: the end of the working window of the last day, counted by the working-time engine.
    const dueAt = dueFrom(rule.value.due_unit, rule.value.due_in, new Date(`${input.eventOn}T12:00:00+07:00`), await this.calendarOf(tx, now));
    const id = randomUUID();
    await tx.query(
      `insert into machvon.contractor_reputation_event (tenant_id, id, contractor_id, package_id, contract_id, behaviour_code, event_on, description, evidence_document_id, recorded_by, recorded_at, post_due_at, deadline_policy_version)
       values (${TENANT}, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $7, $8::uuid, $9::uuid, $10::timestamptz, $11::timestamptz, $12)`,
      [id, input.contractorId, input.packageId ?? null, input.contractId ?? null, input.behaviourCode, input.eventOn, description, input.evidenceDocumentId ?? null, actor, now.toISOString(), dueAt.toISOString(), rule.version],
    );
    return (await this.find(tx, id, now)) as ReputationEventRow;
  }

  private async locked(tx: TenantTx, id: string, expectedVersion: number, now: Date): Promise<ReputationEventRow> {
    const row = await this.find(tx, id, now, true);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (row.version !== expectedVersion) throw versionConflict(row.version);
    return row;
  }

  /** Posts the event on the national system by hand and keeps the receipt; another person than the one who recorded it (403 `SELF_APPROVAL_DENIED`). */
  async post(tx: TenantTx, id: string, expectedVersion: number, receipt: string, actor: string, now: Date): Promise<ReputationEventRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const state = moveReputationEvent(current.status, { move: 'POST', by: actor, at: now, recordedBy: current.recordedBy, receipt });
    await tx.query('update machvon.contractor_reputation_event set status = $2, posted_by = $3::uuid, posted_at = $4::timestamptz, posting_ref = $5, version = version + 1 where id = $1::uuid', [id, state, actor, now.toISOString(), receipt.trim()]);
    return (await this.find(tx, id, now)) as ReputationEventRow;
  }

  /** Retracts an event that was entered wrongly, with a reason of 20 characters, by another person than the recorder. */
  async retract(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<ReputationEventRow> {
    const current = await this.locked(tx, id, expectedVersion, now);
    const state = moveReputationEvent(current.status, { move: 'RETRACT', by: actor, at: now, recordedBy: current.recordedBy, reason });
    await tx.query('update machvon.contractor_reputation_event set status = $2, retracted_by = $3::uuid, retracted_at = $4::timestamptz, retract_reason = $5, version = version + 1 where id = $1::uuid', [id, state, actor, now.toISOString(), reason.trim()]);
    return (await this.find(tx, id, now)) as ReputationEventRow;
  }

  /** The factor on the bid security of a contractor on a day (3 for two years after a posted event, by default), with the events that make it. */
  async bidSecurityFactor(tx: TenantTx, contractorId: string, today: string): Promise<BidSecurityFactor & { policyVersion: string }> {
    const policy = await this.policies.reputation(tx, today);
    const events = await tx.query<{ id: string; status: ReputationEventState; posted_on: string | null }>(
      "select id, status, (posted_at at time zone 'Asia/Ho_Chi_Minh')::date::text as posted_on from machvon.contractor_reputation_event where contractor_id = $1::uuid and status = 'POSTED'",
      [contractorId],
    );
    return { ...bidSecurityFactor(events.map((row) => ({ id: row.id, state: row.status, postedOn: row.posted_on })), today, policy.value), policyVersion: policy.version };
  }

  /** The events that raise an alert now: recorded, not posted, and within the reminder window or past the limit. */
  async alertable(tx: TenantTx, now: Date): Promise<ReputationEventRow[]> {
    const open = await this.list(tx, { status: 'RECORDED', limit: 500 }, now);
    return open.filter((row) => row.clock === 'DUE_SOON' || row.clock === 'OVERDUE');
  }

  /** The figures for the indicator: events posted on time against posted late and past the limit (a retracted event is left out). */
  async figures(tx: TenantTx, now: Date): Promise<{ postedInTime: number; postedLate: number; overdueOpen: number; open: number }> {
    const [row] = await tx.query<{ in_time: number; late: number; overdue: number; open: number }>(
      `select count(*) filter (where status = 'POSTED' and posted_at <= post_due_at)::int as in_time, count(*) filter (where status = 'POSTED' and posted_at > post_due_at)::int as late,
              count(*) filter (where status = 'RECORDED' and post_due_at < $1::timestamptz)::int as overdue, count(*) filter (where status = 'RECORDED')::int as open
         from machvon.contractor_reputation_event`,
      [now.toISOString()],
    );
    return { postedInTime: row?.in_time ?? 0, postedLate: row?.late ?? 0, overdueOpen: row?.overdue ?? 0, open: row?.open ?? 0 };
  }
}
