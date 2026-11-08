import {
  DomainError,
  EGP_EXPORT_KINDS,
  EGP_OBLIGATION_FACTS,
  EGP_POSTING_RULE_TYPE,
  EGP_SEVERITY_RULE_CODE,
  EGP_SEVERITY_RULE_TYPE,
  EgpFileAdapter,
  egpAlertFor,
  egpObligationClock,
  egpPostingFacet,
  egpSeverityParamsOf,
  moveObligation,
  openObligation,
  versionConflict,
} from '@machvon/kernel';
import type { EgpClock, EgpObligation, EgpObligationMove, EgpPostingKind, EgpPostingPacket, EgpPostingFacet, EgpResolvedRule, EgpSeverityParams, EgpSubjectType, WorkCalendarSource } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const UNIQUE_VIOLATION = '23505';
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
/** The most facts one pass of the sweep opens: a pass that reaches it says so and the next pass goes on (what was opened is not opened again). */
export const EGP_SWEEP_LIMIT = 500;

export type EgpObligationHistoryAction = 'OPENED' | 'PREPARED' | 'SUBMITTED' | 'RECEIPTED' | 'REJECTED' | 'CANCELLED';

export interface EgpObligationRow {
  id: string;
  kind: EgpPostingKind;
  subjectType: EgpSubjectType;
  subjectId: string;
  subjectCode: string;
  sourceRef: string;
  triggerEvent: EgpObligation['triggerEvent'];
  triggeredAt: string;
  dueAt: string;
  dueAtKey: string;
  ruleCode: string;
  ruleVersion: number;
  ruleSource: 'RULE' | 'DEFAULT';
  remindBeforeDays: number;
  legalStatus: 'UNVERIFIED' | 'VERIFIED';
  state: EgpObligation['state'];
  ownerId: string;
  preparedBy: string | null;
  preparedAt: string | null;
  packet: EgpPostingPacket | Record<string, unknown> | null;
  packetSha256: string | null;
  exportBatchId: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  receiptRef: string | null;
  receiptedAt: string | null;
  receiptRecordedBy: string | null;
  version: number;
  createdAt: string;
}

interface ObligationSql {
  id: string;
  kind: EgpPostingKind;
  subject_type: EgpSubjectType;
  subject_id: string;
  subject_code: string;
  source_ref: string;
  trigger_event: EgpObligation['triggerEvent'];
  triggered_at: string;
  due_at: string;
  due_at_key: string;
  rule_code: string;
  rule_version: number;
  rule_source: 'RULE' | 'DEFAULT';
  remind_before_days: number;
  legal_status: 'UNVERIFIED' | 'VERIFIED';
  state: EgpObligation['state'];
  owner_id: string;
  prepared_by: string | null;
  prepared_at: string | null;
  packet: EgpObligationRow['packet'];
  packet_sha256: string | null;
  export_batch_id: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  receipt_ref: string | null;
  receipted_at: string | null;
  receipt_recorded_by: string | null;
  version: string;
  created_at: string;
}

const OBLIGATION_SELECT = `select o.id, o.kind, o.subject_type, o.subject_id, o.subject_code, o.source_ref, o.trigger_event, to_char(o.triggered_at at time zone 'UTC', ${ISO}) as triggered_at,
  to_char(o.due_at at time zone 'UTC', ${ISO}) as due_at, ${timestampKey('o.due_at')} as due_at_key, o.rule_code, o.rule_version, o.rule_source, o.remind_before_days, o.legal_status, o.state, o.owner_id,
  o.prepared_by, to_char(o.prepared_at at time zone 'UTC', ${ISO}) as prepared_at, o.packet, o.packet_sha256, o.export_batch_id, o.submitted_by, to_char(o.submitted_at at time zone 'UTC', ${ISO}) as submitted_at,
  to_char(o.rejected_at at time zone 'UTC', ${ISO}) as rejected_at, o.rejection_reason, o.cancelled_by, to_char(o.cancelled_at at time zone 'UTC', ${ISO}) as cancelled_at, o.cancel_reason,
  r.receipt_ref, to_char(r.receipted_at at time zone 'UTC', ${ISO}) as receipted_at, r.recorded_by as receipt_recorded_by, o.version::text as version, to_char(o.created_at at time zone 'UTC', ${ISO}) as created_at
  from machvon.egp_posting_obligation o left join machvon.egp_posting_receipt r on r.tenant_id = o.tenant_id and r.obligation_id = o.id`;

const rowOf = (row: ObligationSql): EgpObligationRow => ({
  id: row.id,
  kind: row.kind,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  subjectCode: row.subject_code,
  sourceRef: row.source_ref,
  triggerEvent: row.trigger_event,
  triggeredAt: row.triggered_at,
  dueAt: row.due_at,
  dueAtKey: row.due_at_key,
  ruleCode: row.rule_code,
  ruleVersion: row.rule_version,
  ruleSource: row.rule_source,
  remindBeforeDays: row.remind_before_days,
  legalStatus: row.legal_status,
  state: row.state,
  ownerId: row.owner_id,
  preparedBy: row.prepared_by,
  preparedAt: row.prepared_at,
  packet: row.packet,
  packetSha256: row.packet_sha256,
  exportBatchId: row.export_batch_id,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at,
  rejectedAt: row.rejected_at,
  rejectionReason: row.rejection_reason,
  cancelledBy: row.cancelled_by,
  cancelledAt: row.cancelled_at,
  cancelReason: row.cancel_reason,
  receiptRef: row.receipt_ref,
  receiptedAt: row.receipted_at,
  receiptRecordedBy: row.receipt_recorded_by,
  version: Number(row.version),
  createdAt: row.created_at,
});

/** The obligation as the kernel judges it (the state machine and the clock are the kernel's). */
export const obligationOf = (row: EgpObligationRow): EgpObligation => ({
  kind: row.kind,
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  triggerEvent: row.triggerEvent,
  triggeredAt: row.triggeredAt,
  dueAt: row.dueAt,
  ruleCode: row.ruleCode,
  ruleVersion: row.ruleVersion,
  remindBeforeDays: row.remindBeforeDays,
  legalStatus: row.legalStatus,
  state: row.state,
  ownerId: row.ownerId,
  preparedById: row.preparedBy,
  preparedAt: row.preparedAt,
  submittedById: row.submittedBy,
  submittedAt: row.submittedAt,
  receiptRef: row.receiptRef,
  receiptedAt: row.receiptedAt,
  rejectionReason: row.rejectionReason,
  cancelReason: row.cancelReason,
});

export interface EgpObligationFilter {
  /** `OPEN`: still asks something of a person (DUE, PREPARED, REJECTED); `SUBMITTED`: waits for the receipt; `CLOSED`: RECEIPTED or CANCELLED. */
  group?: 'OPEN' | 'SUBMITTED' | 'CLOSED' | undefined;
  kind?: EgpPostingKind | undefined;
  /** `OVERDUE`: open and past its deadline; `DUE_SOON`: open and inside the reminder window of its rule. */
  clock?: 'OVERDUE' | 'DUE_SOON' | undefined;
  ownerId?: string | undefined;
  subjectId?: string | undefined;
}

export interface EgpObligationCounts {
  total: number;
  byState: Record<EgpObligation['state'], number>;
  overdue: number;
  dueSoon: number;
  /** MET / MET_LATE judged on the submission against the deadline. */
  met: number;
  metLate: number;
  /** Counted from the rows at `now`: the same rows give the same figures. */
  asOf: string;
}

export interface EgpOpenInput {
  kind: EgpPostingKind;
  subjectType: EgpSubjectType;
  subjectId: string;
  subjectCode: string;
  sourceRef: string;
  triggeredAt: Date;
  ownerId: string;
}

/** What opening needs and one pass can reuse: the rule of a kind in force today and the working calendars. */
export interface EgpOpenContext {
  rule: EgpResolvedRule;
  ruleSource: 'RULE' | 'DEFAULT';
  calendars: WorkCalendarSource;
}

/** One reading of the facts of the register for the sweep. */
interface FactSql {
  source_ref: string;
  subject_id: string;
  subject_code: string;
  at: string;
}

const dayStart = (column: string): string => `((${column})::timestamp at time zone 'Asia/Ho_Chi_Minh')`;

/** The facts of the register that open an obligation, one query each: the fact, the subject it is about and the instant it happened. `$1` is the first day (Vietnam) the sweep looks at. */
const FACT_QUERIES: Readonly<Record<string, string>> = {
  PLAN_APPROVED: `select pl.id as source_ref, pl.id as subject_id, left(p.code || '-R' || pl.revision::text, 100) as subject_code, to_char(pl.approved_at at time zone 'UTC', ${ISO}) as at
      from machvon.procurement_plan pl join machvon.project p on p.tenant_id = pl.tenant_id and p.id = pl.project_id
     where pl.status in ('APPROVED', 'SUPERSEDED') and pl.approved_at is not null and (pl.approved_at at time zone 'Asia/Ho_Chi_Minh')::date >= $1::date order by pl.approved_at, pl.id limit $2`,
  RESULT_APPROVED: `select r.id as source_ref, r.id as subject_id, k.code as subject_code, to_char(r.approved_at at time zone 'UTC', ${ISO}) as at
      from machvon.procurement_result r join machvon.procurement_package k on k.tenant_id = r.tenant_id and k.id = r.package_id
     where r.status = 'APPROVED' and r.outcome <> 'CANCELLED' and r.approved_at is not null and (r.approved_at at time zone 'Asia/Ho_Chi_Minh')::date >= $1::date order by r.approved_at, r.id limit $2`,
  CONTRACT_SIGNED: `select c.id as source_ref, c.id as subject_id, c.code as subject_code, to_char(${dayStart('c.signed_on')} at time zone 'UTC', ${ISO}) as at
      from machvon.contract c where c.signed_on is not null and c.signed_on >= $1::date order by c.signed_on, c.id limit $2`,
  EVALUATION_APPROVED: `select e.id as source_ref, c.id as subject_id, c.code as subject_code, to_char(e.approved_at at time zone 'UTC', ${ISO}) as at
      from machvon.contractor_performance e join machvon.contract c on c.tenant_id = e.tenant_id and c.id = e.contract_id
     where e.status = 'APPROVED' and e.evaluation_kind = 'COMPLETION' and e.approved_at is not null and (e.approved_at at time zone 'Asia/Ho_Chi_Minh')::date >= $1::date order by e.approved_at, e.id limit $2`,
  VIOLATION_CONFIRMED: `select v.id as source_ref, ct.id as subject_id, ct.tax_identifier as subject_code, to_char(${dayStart('v.occurred_on')} at time zone 'UTC', ${ISO}) as at
      from machvon.contractor_violation v join machvon.contractor ct on ct.tenant_id = v.tenant_id and ct.id = v.contractor_id
     where v.status = 'CONFIRMED' and v.occurred_on >= $1::date order by v.occurred_on, v.id limit $2`,
};

/** The subject of each fact: what the obligation is about (see `EGP_POSTING_SUBJECTS`). */
const SUBJECT_OF_KIND: Readonly<Record<EgpPostingKind, EgpSubjectType>> = {
  PLAN: 'PLAN',
  NOTICE: 'NOTICE',
  RESULT: 'RESULT',
  CONTRACT_INFO: 'CONTRACT',
  CONTRACTOR_PERFORMANCE: 'CONTRACT',
  VIOLATION: 'CONTRACTOR',
  REPUTATION_EVENT: 'CONTRACTOR',
  CONTRACTOR_RESPONSE: 'CONTRACTOR',
};

export interface EgpSweepOutcome {
  fact: string;
  kind: EgpPostingKind;
  opened: number;
  existing: number;
  /** The pass stopped at the limit: another pass goes on. */
  truncated: boolean;
}

/**
 * The duties of posting to the national procurement network (EGP-2, BID-25). The deadline of each is fixed when it opens, from the rule `EGP_POSTING_DEADLINES` read through `GovernancePolicyPort` (a tenant rule, else the
 * built-in default flagged UNVERIFIED) and the published working calendar (a year without one is 422 `CALENDAR_NOT_EFFECTIVE`: a deadline is never guessed). The state machine, the maker-checker rule between the person who prepares
 * and the one who submits, and the clock are the kernel's (`moveObligation`, `egpObligationClock`); the database holds the same edges and the same rule, so a race ends in the same answer. Nothing here opens a
 * connection: a person posts on the network by hand and the packet is what they take to it.
 */
export class EgpObligationStore {
  private readonly policy = new GovernancePolicyPort();
  private readonly calendars = new HomeWorkCalendars();
  private readonly port = new EgpFileAdapter();

  /** The rule of a kind in force today and the calendars, once for as many obligations of the kind as a pass opens. */
  async contextOf(tx: TenantTx, kind: EgpPostingKind, now: Date): Promise<EgpOpenContext> {
    const resolved = await this.policy.require(tx, EGP_POSTING_RULE_TYPE, kind, now);
    const calendars = await this.calendars.load(tx, WORK_CALENDAR_CODE, now);
    if (calendars === undefined) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'year');
    return { rule: { code: resolved.code, version: resolved.version, params: resolved.params as unknown as Readonly<Record<string, unknown>>, unverified: resolved.unverified }, ruleSource: resolved.source, calendars };
  }

  /** The rule that says how near to the deadline a posting turns urgent, in force today (with where its numbers come from, for the "i" of the screen). */
  async severityRule(tx: TenantTx, now: Date): Promise<{ params: EgpSeverityParams; version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null }> {
    const rule = await this.policy.require(tx, EGP_SEVERITY_RULE_TYPE, EGP_SEVERITY_RULE_CODE, now);
    return {
      params: egpSeverityParamsOf(rule.params as unknown as Readonly<Record<string, unknown>>),
      version: rule.version,
      source: rule.source,
      unverified: rule.unverified,
      formula: rule.provenance?.formula ?? null,
      sourceText: rule.provenance?.source ?? null,
      asOf: rule.provenance?.asOf ?? null,
      legalStatus: rule.provenance?.legalStatus ?? null,
    };
  }

  /** The rule of the deadlines of a kind with its provenance, for the "i" of a deadline. */
  async deadlineRule(tx: TenantTx, kind: EgpPostingKind, now: Date): Promise<{ version: number; source: 'RULE' | 'DEFAULT'; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null; params: Record<string, unknown> }> {
    const rule = await this.policy.require(tx, EGP_POSTING_RULE_TYPE, kind, now);
    return {
      version: rule.version,
      source: rule.source,
      unverified: rule.unverified,
      formula: rule.provenance?.formula ?? null,
      sourceText: rule.provenance?.source ?? null,
      asOf: rule.provenance?.asOf ?? null,
      legalStatus: rule.provenance?.legalStatus ?? null,
      params: rule.params as unknown as Record<string, unknown>,
    };
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<EgpObligationRow | undefined> {
    const rows = await tx.query<ObligationSql>(`${OBLIGATION_SELECT} where o.id = $1::uuid${lock ? ' for update of o' : ''}`, [id]);
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  private async findByFact(tx: TenantTx, kind: EgpPostingKind, sourceRef: string, triggeredAt: Date): Promise<EgpObligationRow | undefined> {
    const rows = await tx.query<ObligationSql>(`${OBLIGATION_SELECT} where o.kind = $1 and o.source_ref = $2::uuid and o.triggered_at = $3::timestamptz`, [kind, sourceRef, triggeredAt.toISOString()]);
    return rows[0] === undefined ? undefined : rowOf(rows[0]);
  }

  private async record(tx: TenantTx, row: { id: string; version: number; state: EgpObligation['state'] }, action: EgpObligationHistoryAction, actor: string, reason: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.egp_posting_event (tenant_id, id, obligation_id, action, actor_id, reason, state_after, obligation_version) values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3::uuid, $4, $5, $6::bigint)`,
      [row.id, action, actor, reason, row.state, row.version],
    );
  }

  /**
   * Opens the obligation a fact creates, DUE, with its deadline from the rule. Opening the same fact again (same kind, same source, same instant) changes nothing and returns the one that is there.
   * The owner is an active member of the tenant (422 `owner_id`).
   */
  async open(tx: TenantTx, input: EgpOpenInput, context: EgpOpenContext, actor: string): Promise<{ row: EgpObligationRow; created: boolean }> {
    if (SUBJECT_OF_KIND[input.kind] !== input.subjectType) throw new DomainError('VALIDATION_FAILED', 422, 'subject_type');
    const earlier = await this.findByFact(tx, input.kind, input.sourceRef, input.triggeredAt);
    if (earlier !== undefined) return { row: earlier, created: false };
    const members = await tx.query<{ id: string }>('select id from machvon.membership where id = $1::uuid', [input.ownerId]);
    if (members[0] === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'owner_id');
    const planned = openObligation({ kind: input.kind, subjectId: input.subjectId, triggeredAt: input.triggeredAt, ownerId: input.ownerId, rule: context.rule, calendars: context.calendars });
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.egp_posting_obligation
         (tenant_id, id, kind, subject_type, subject_id, subject_code, source_ref, trigger_event, triggered_at, due_at, rule_code, rule_version, rule_source, remind_before_days, legal_status, state, owner_id, created_by, updated_by)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3::uuid, $4, $5::uuid, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12, $13, 'DUE', $14::uuid, $15::uuid, $15::uuid)
       on conflict (tenant_id, kind, source_ref, triggered_at) do nothing returning id`,
      [input.kind, input.subjectType, input.subjectId, input.subjectCode, input.sourceRef, planned.triggerEvent, planned.triggeredAt, planned.dueAt, planned.ruleCode, planned.ruleVersion, context.ruleSource, planned.remindBeforeDays, planned.legalStatus, input.ownerId, actor],
    );
    if (inserted[0] === undefined) return { row: (await this.findByFact(tx, input.kind, input.sourceRef, input.triggeredAt)) as EgpObligationRow, created: false };
    const row = (await this.find(tx, inserted[0].id)) as EgpObligationRow;
    await this.record(tx, row, 'OPENED', actor, null);
    return { row, created: true };
  }

  /**
   * Opens the obligations of the facts the register states, from `since` (a day in Vietnam: the agency chooses the cutover, an older fact is not a duty of this system). Idempotent: what was opened is not opened again.
   * Returns, per fact, how many were opened and how many were already there, and the rows that were opened (for the audit rows and the events of the command).
   */
  async sweep(tx: TenantTx, request: { since: string; ownerId: string; kinds?: readonly EgpPostingKind[] | undefined }, actor: string, now: Date): Promise<{ outcomes: EgpSweepOutcome[]; opened: EgpObligationRow[] }> {
    const outcomes: EgpSweepOutcome[] = [];
    const opened: EgpObligationRow[] = [];
    for (const { fact, kind } of EGP_OBLIGATION_FACTS) {
      if (request.kinds !== undefined && !request.kinds.includes(kind)) continue;
      const found = await tx.query<FactSql>(FACT_QUERIES[fact] as string, [request.since, EGP_SWEEP_LIMIT + 1]);
      const context = found.length === 0 ? undefined : await this.contextOf(tx, kind, now);
      let fresh = 0;
      let existing = 0;
      for (const item of found.slice(0, EGP_SWEEP_LIMIT)) {
        const result = await this.open(
          tx,
          { kind, subjectType: SUBJECT_OF_KIND[kind], subjectId: item.subject_id, subjectCode: item.subject_code, sourceRef: item.source_ref, triggeredAt: new Date(item.at), ownerId: request.ownerId },
          context as EgpOpenContext,
          actor,
        );
        if (result.created) {
          fresh += 1;
          opened.push(result.row);
        } else existing += 1;
      }
      outcomes.push({ fact, kind, opened: fresh, existing, truncated: found.length > EGP_SWEEP_LIMIT });
    }
    return { outcomes, opened };
  }

  /** Locks the obligation, judges the version and applies one move of the kernel; the row, the history and the version are written once. */
  private async apply(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    step: EgpObligationMove,
    action: EgpObligationHistoryAction,
    columns: (before: EgpObligationRow, after: EgpObligation) => Record<string, unknown>,
    reason: string | null,
  ): Promise<{ before: EgpObligationRow; row: EgpObligationRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const after = moveObligation(obligationOf(before), step);
    const set = { state: after.state, ...columns(before, after) };
    const names = Object.keys(set);
    await tx.query(
      `update machvon.egp_posting_obligation set ${names.map((name, index) => `${name} = $${index + 3}`).join(', ')}, version = version + 1, updated_at = now(), updated_by = $2::uuid where id = $1::uuid`,
      [id, step.actorId, ...names.map((name) => (set as Record<string, unknown>)[name])],
    );
    const row = (await this.find(tx, id)) as EgpObligationRow;
    await this.record(tx, row, action, step.actorId, reason);
    return { before, row };
  }

  /**
   * Prepares the posting: the packet is what a person takes to the network. For the contractor evaluation and the violations the packet is the file of a batch of the contractor export (CTR-24), named by its hash;
   * for the others it is the fields the kind needs, built by the port (every field required, no other, no control character). A rejected posting is prepared again: the submission that was rejected is cleared.
   */
  async prepare(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    input: { fields: Readonly<Record<string, string>> | undefined; batch: { id: string; fileSha256: string; rowCount: number; scope: string; periodFrom: string; periodTo: string } | undefined },
    actor: string,
    now: Date,
  ): Promise<{ before: EgpObligationRow; row: EgpObligationRow }> {
    const current = await this.find(tx, id);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    let packet: Record<string, unknown>;
    let sha: string;
    if (input.batch !== undefined) {
      if (!EGP_EXPORT_KINDS.includes(current.kind)) throw new DomainError('VALIDATION_FAILED', 422, 'export_batch_id');
      const wanted = current.kind === 'VIOLATION' ? 'VIOLATION' : 'PERFORMANCE';
      if (input.batch.scope !== 'BOTH' && input.batch.scope !== wanted) throw new DomainError('VALIDATION_FAILED', 422, 'export_batch_id');
      packet = { kind: current.kind, export_batch_id: input.batch.id, export_file_sha256: input.batch.fileSha256, rows: input.batch.rowCount, scope: input.batch.scope, period_from: input.batch.periodFrom, period_to: input.batch.periodTo };
      sha = input.batch.fileSha256;
    } else {
      if (input.fields === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'fields');
      const prepared = await this.port.publish({ obligation: { kind: current.kind, subjectType: current.subjectType, subjectId: current.subjectId, dueAt: current.dueAt }, fields: input.fields });
      packet = prepared.packet as unknown as Record<string, unknown>;
      sha = prepared.packet.payloadSha256;
    }
    return this.apply(
      tx,
      id,
      expectedVersion,
      { move: 'PREPARE', actorId: actor, at: now },
      'PREPARED',
      (_before, after) => ({ prepared_by: after.preparedById, prepared_at: after.preparedAt, packet: JSON.stringify(packet), packet_sha256: sha, export_batch_id: input.batch?.id ?? null, submitted_by: null, submitted_at: null, rejected_at: null, rejection_reason: null }),
      null,
    );
  }

  /** Records that the person took the packet to the network. A second person than the one who prepared it (403 `SELF_APPROVAL_DENIED`). */
  async submit(tx: TenantTx, id: string, expectedVersion: number, actor: string, now: Date): Promise<{ before: EgpObligationRow; row: EgpObligationRow }> {
    return this.apply(tx, id, expectedVersion, { move: 'SUBMIT', actorId: actor, at: now }, 'SUBMITTED', (_before, after) => ({ submitted_by: after.submittedById, submitted_at: after.submittedAt }), null);
  }

  /**
   * Writes down what the network answered: the reference and the time. One reference stands for one posting in the tenant (409 `EGP_RECEIPT_DUPLICATE`). The receipt is a row of its own that never changes. When the packet is a
   * batch of the contractor export (CTR-24), the receipt is the receipt of the batch as well.
   */
  async receipt(tx: TenantTx, id: string, expectedVersion: number, input: { receiptRef: string; receiptedAt: Date }, actor: string, now: Date): Promise<{ before: EgpObligationRow; row: EgpObligationRow }> {
    if (input.receiptedAt.getTime() > now.getTime() + 60_000) throw new DomainError('VALIDATION_FAILED', 422, 'receipted_at');
    try {
      const done = await this.apply(tx, id, expectedVersion, { move: 'RECEIPT', actorId: actor, at: input.receiptedAt, receiptRef: input.receiptRef }, 'RECEIPTED', () => ({}), input.receiptRef.trim());
      await tx.query(
        `insert into machvon.egp_posting_receipt (tenant_id, id, obligation_id, receipt_ref, receipted_at, recorded_by) values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3::timestamptz, $4::uuid)`,
        [id, input.receiptRef.trim(), input.receiptedAt.toISOString(), actor],
      );
      return { before: done.before, row: (await this.find(tx, id)) as EgpObligationRow };
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('EGP_RECEIPT_DUPLICATE', 409, 'receipt_ref');
      throw error;
    }
  }

  /** The network refused the posting: the reason is kept, the clock keeps running, the posting is prepared again. */
  async reject(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<{ before: EgpObligationRow; row: EgpObligationRow }> {
    return this.apply(tx, id, expectedVersion, { move: 'REJECT', actorId: actor, at: now, reason }, 'REJECTED', (_before, after) => ({ rejection_reason: after.rejectionReason, rejected_at: now.toISOString() }), reason.trim());
  }

  /** There is nothing to post any more (the package was cancelled): the reason is kept and the duty ends. */
  async cancel(tx: TenantTx, id: string, expectedVersion: number, reason: string, actor: string, now: Date): Promise<{ before: EgpObligationRow; row: EgpObligationRow }> {
    return this.apply(tx, id, expectedVersion, { move: 'CANCEL', actorId: actor, at: now, reason }, 'CANCELLED', (_before, after) => ({ cancel_reason: after.cancelReason, cancelled_by: actor, cancelled_at: now.toISOString() }), reason.trim());
  }

  private where(filter: EgpObligationFilter, now: Date, params: unknown[]): string {
    const parts: string[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filter.group === 'OPEN') parts.push("o.state in ('DUE', 'PREPARED', 'REJECTED')");
    if (filter.group === 'SUBMITTED') parts.push("o.state = 'SUBMITTED'");
    if (filter.group === 'CLOSED') parts.push("o.state in ('RECEIPTED', 'CANCELLED')");
    if (filter.kind !== undefined) parts.push(`o.kind = ${bind(filter.kind)}`);
    if (filter.ownerId !== undefined) parts.push(`o.owner_id = ${bind(filter.ownerId)}::uuid`);
    if (filter.subjectId !== undefined) parts.push(`o.subject_id = ${bind(filter.subjectId)}::uuid`);
    if (filter.clock === 'OVERDUE') parts.push(`o.state in ('DUE', 'PREPARED', 'REJECTED') and o.due_at < ${bind(now.toISOString())}::timestamptz`);
    if (filter.clock === 'DUE_SOON') parts.push(`o.state in ('DUE', 'PREPARED', 'REJECTED') and o.due_at >= ${bind(now.toISOString())}::timestamptz and o.due_at <= ${bind(now.toISOString())}::timestamptz + make_interval(days => o.remind_before_days)`);
    return parts.length === 0 ? '' : ` and ${parts.join(' and ')}`;
  }

  /** The obligations, the earliest deadline first (the open ones before the closed ones are the caller's filter). */
  async list(tx: TenantTx, filter: EgpObligationFilter, request: { limit: number; after: { key: string; id: string } | undefined }, now: Date): Promise<EgpObligationRow[]> {
    const params: unknown[] = [];
    const where = this.where(filter, now, params);
    params.push(request.after?.key ?? null, request.after?.id ?? null, request.limit);
    const base = params.length - 3;
    const rows = await tx.query<ObligationSql>(
      `select * from (${OBLIGATION_SELECT} where true${where}) x where ($${base + 1}::text is null or (x.due_at_key, x.id) > ($${base + 1}::text, $${base + 2}::uuid)) order by x.due_at_key, x.id limit $${base + 3}`,
      params,
    );
    return rows.map(rowOf);
  }

  /** The counts the board shows, from the rows themselves at `now`: by state, the open ones that are overdue and inside their reminder window, and the submitted ones by whether the submission was in time. */
  async counts(tx: TenantTx, now: Date): Promise<EgpObligationCounts> {
    const rows = await tx.query<{ state: EgpObligation['state']; overdue: string; due_soon: string; met: string; met_late: string; n: string }>(
      `select o.state, count(*)::text as n,
              count(*) filter (where o.state in ('DUE', 'PREPARED', 'REJECTED') and o.due_at < $1::timestamptz)::text as overdue,
              count(*) filter (where o.state in ('DUE', 'PREPARED', 'REJECTED') and o.due_at >= $1::timestamptz and o.due_at <= $1::timestamptz + make_interval(days => o.remind_before_days))::text as due_soon,
              count(*) filter (where o.state in ('SUBMITTED', 'RECEIPTED') and o.submitted_at <= o.due_at)::text as met,
              count(*) filter (where o.state in ('SUBMITTED', 'RECEIPTED') and o.submitted_at > o.due_at)::text as met_late
         from machvon.egp_posting_obligation o group by o.state`,
      [now.toISOString()],
    );
    const byState = { DUE: 0, PREPARED: 0, SUBMITTED: 0, RECEIPTED: 0, REJECTED: 0, CANCELLED: 0 } as Record<EgpObligation['state'], number>;
    let overdue = 0;
    let dueSoon = 0;
    let met = 0;
    let metLate = 0;
    let total = 0;
    for (const row of rows) {
      byState[row.state] = Number(row.n);
      total += Number(row.n);
      overdue += Number(row.overdue);
      dueSoon += Number(row.due_soon);
      met += Number(row.met);
      metLate += Number(row.met_late);
    }
    return { total, byState, overdue, dueSoon, met, metLate, asOf: now.toISOString() };
  }

  /** What was done to an obligation, oldest first. */
  async history(tx: TenantTx, id: string): Promise<Array<{ id: string; action: EgpObligationHistoryAction; actorId: string; reason: string | null; stateAfter: EgpObligation['state']; version: number; occurredAt: string }>> {
    const rows = await tx.query<{ id: string; action: EgpObligationHistoryAction; actor_id: string; reason: string | null; state_after: EgpObligation['state']; obligation_version: string; occurred_at: string }>(
      `select id, action, actor_id, reason, state_after, obligation_version::text as obligation_version, to_char(occurred_at at time zone 'UTC', ${ISO}) as occurred_at
         from machvon.egp_posting_event where obligation_id = $1::uuid order by obligation_version, occurred_at, id`,
      [id],
    );
    return rows.map((row) => ({ id: row.id, action: row.action, actorId: row.actor_id, reason: row.reason, stateAfter: row.state_after, version: Number(row.obligation_version), occurredAt: row.occurred_at }));
  }

  /** What our register can offer to fill the packet of a posting: values taken from the fact the obligation started from (never typed over: the person confirms them). */
  async suggestedFields(tx: TenantTx, row: EgpObligationRow): Promise<Record<string, string>> {
    const one = async (sql: string): Promise<Record<string, string | null> | undefined> => (await tx.query<Record<string, string | null>>(sql, [row.sourceRef]))[0];
    const clean = (values: Record<string, string | null> | undefined): Record<string, string> => Object.fromEntries(Object.entries(values ?? {}).filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== ''));
    switch (row.kind) {
      case 'PLAN':
        return clean(await one(`select pl.title as plan_name, to_char((pl.approved_at at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') as approved_on from machvon.procurement_plan pl where pl.id = $1::uuid`));
      case 'RESULT':
        return clean(
          await one(
            `select k.code as package_code, to_char((r.approved_at at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') as approved_on, case r.outcome when 'AWARDED' then 'AWARDED' when 'NO_ACCEPTABLE_BID' then 'NO_QUALIFIED_BID' else 'CANCELLED' end as result_kind
               from machvon.procurement_result r join machvon.procurement_package k on k.tenant_id = r.tenant_id and k.id = r.package_id where r.id = $1::uuid`,
          ),
        );
      case 'CONTRACT_INFO':
        return clean(
          await one(
            `select c.code as contract_no, to_char(c.signed_on, 'YYYY-MM-DD') as signed_on, ct.tax_identifier as contractor_tax_code, c.contract_value_vnd::text as contract_price
               from machvon.contract c join machvon.contractor ct on ct.tenant_id = c.tenant_id and ct.id = c.contractor_id where c.id = $1::uuid`,
          ),
        );
      case 'VIOLATION':
        return clean(await one(`select ct.tax_identifier as contractor_tax_code, to_char(v.occurred_on, 'YYYY-MM-DD') as occurred_on from machvon.contractor_violation v join machvon.contractor ct on ct.tenant_id = v.tenant_id and ct.id = v.contractor_id where v.id = $1::uuid`));
      case 'CONTRACTOR_PERFORMANCE':
        return clean(
          await one(
            `select c.code as contract_no, ct.tax_identifier as contractor_tax_code, to_char((e.approved_at at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') as completed_on
               from machvon.contractor_performance e join machvon.contract c on c.tenant_id = e.tenant_id and c.id = e.contract_id join machvon.contractor ct on ct.tenant_id = e.tenant_id and ct.id = e.contractor_id where e.id = $1::uuid`,
          ),
        );
      default:
        return {};
    }
  }

  /** The members who may answer for a posting: active members holding a right over the whole tenant (a grant on the whole tenant of a role that lists the permission). */
  async holdersOf(tx: TenantTx, permission: string, now: Date): Promise<string[]> {
    const rows = await tx.query<{ membership_id: string }>(
      `select distinct g.membership_id from machvon.role_grant g join machvon.role_definition d on d.tenant_id = g.tenant_id and d.id = g.role_id
        where $1 = any (d.permissions) and d.status = 'Active' and g.scope_kind = 'TENANT' and g.status = 'Active' and g.effective_from <= $2::timestamptz and (g.effective_until is null or g.effective_until > $2::timestamptz) and g.revoked_at is null
        order by g.membership_id`,
      [permission, now.toISOString()],
    );
    return rows.map((row) => row.membership_id);
  }
}

/** The clock of a row at `now`, the alert it raises and its severity facet. */
export function clockOfRow(row: EgpObligationRow, now: Date, severity: EgpSeverityParams): { clock: EgpClock; alert: ReturnType<typeof egpAlertFor>; facet: EgpPostingFacet | undefined } {
  const clock = egpObligationClock(obligationOf(row), now);
  return { clock, alert: egpAlertFor(clock), facet: egpPostingFacet(clock, severity) };
}
