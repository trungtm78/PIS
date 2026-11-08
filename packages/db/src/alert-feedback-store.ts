import { DomainError, assertFeedbackInput, nextAlertFeedbackStatus, unhelpfulShare, versionConflict } from '@machvon/kernel';
import type { AlertFeedbackStatus, FeedbackMove, FeedbackReason } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export interface FeedbackRow {
  id: string;
  source: string;
  sourceId: string;
  alertTypeCode: string;
  severity: string;
  reporterId: string;
  reason: FeedbackReason;
  /** The words of the reporter: only the reporter and the reviewers read them. */
  note: string | null;
  status: AlertFeedbackStatus;
  reviewerId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  proposalNote: string | null;
  governanceRuleId: string | null;
  duplicateOfId: string | null;
  version: number;
  createdAt: string;
}

export interface FeedbackSubmit {
  source: string;
  sourceId: string;
  alertTypeCode: string;
  severity: string;
  reporter: string;
  reason: unknown;
  note?: unknown;
}

export interface FeedbackDecision {
  move: Exclude<FeedbackMove, 'WITHDRAW'>;
  reviewNote?: string | undefined;
  proposalNote?: string | undefined;
  governanceRuleId?: string | undefined;
  duplicateOfId?: string | undefined;
}

export interface FeedbackQueueFilter {
  status?: AlertFeedbackStatus | undefined;
  alertTypeCode?: string | undefined;
  limit: number;
  after?: { at: string; id: string } | undefined;
}

export interface TypeFeedbackStat {
  alertTypeCode: string;
  reports: number;
  shown: number;
  /** In percent with one decimal; null when nothing of the type was shown (never zero). */
  share: number | null;
  pending: number;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

interface Row {
  id: string;
  source: string;
  source_id: string;
  alert_type_code: string;
  severity: string;
  reporter_membership_id: string;
  reason: FeedbackReason;
  note: string | null;
  status: AlertFeedbackStatus;
  reviewer_membership_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  proposal_note: string | null;
  governance_rule_id: string | null;
  duplicate_of_id: string | null;
  version: number;
  created_at: string;
}

const COLUMNS = `f.id, f.source, f.source_id, f.alert_type_code, f.severity, f.reporter_membership_id, f.reason, f.note, f.status, f.reviewer_membership_id, ${ISO('f.reviewed_at')} as reviewed_at, f.review_note, f.proposal_note,
  f.governance_rule_id, f.duplicate_of_id, f.version, ${ISO('f.created_at')} as created_at`;

const toRow = (row: Row): FeedbackRow => ({
  id: row.id,
  source: row.source,
  sourceId: row.source_id,
  alertTypeCode: row.alert_type_code,
  severity: row.severity,
  reporterId: row.reporter_membership_id,
  reason: row.reason,
  note: row.note,
  status: row.status,
  reviewerId: row.reviewer_membership_id,
  reviewedAt: row.reviewed_at,
  reviewNote: row.review_note,
  proposalNote: row.proposal_note,
  governanceRuleId: row.governance_rule_id,
  duplicateOfId: row.duplicate_of_id,
  version: row.version,
  createdAt: row.created_at,
});

/**
 * The "this alert is wrong" reports (G2-9). A report never hides or silences an item: it is read by the reviewers of the type, and what it can lead to is a proposal that goes through the governance rules. One report of a
 * person about an item is open at a time; the reviewer is never the reporter (a rule of the kernel and a constraint of the table).
 */
export class AlertFeedbackStore {
  /** Records a report; a second open report of the same person about the same item is 409 ALERT_FEEDBACK_ALREADY_REPORTED. */
  async submit(tx: TenantTx, input: FeedbackSubmit): Promise<FeedbackRow> {
    const checked = assertFeedbackInput({ reason: input.reason, note: input.note });
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.alert_feedback (tenant_id, source, source_id, alert_type_code, severity, reporter_membership_id, reason, note)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3, $4, $5::uuid, $6, $7)
       on conflict (tenant_id, source, source_id, reporter_membership_id) where status = 'PENDING' do nothing returning id`,
      [input.source, input.sourceId, input.alertTypeCode, input.severity, input.reporter, checked.reason, checked.note],
    );
    const id = inserted[0]?.id;
    if (id === undefined) throw new DomainError('ALERT_FEEDBACK_ALREADY_REPORTED', 409, 'source_id');
    return this.require(tx, id);
  }

  async find(tx: TenantTx, id: string): Promise<FeedbackRow | undefined> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from machvon.alert_feedback f where f.id = $1::uuid`, [id]);
    return row === undefined ? undefined : toRow(row);
  }

  async require(tx: TenantTx, id: string): Promise<FeedbackRow> {
    const found = await this.find(tx, id);
    if (found === undefined) throw new DomainError('NOT_FOUND', 404, 'id');
    return found;
  }

  /** The reporter withdraws their own pending report. */
  async withdraw(tx: TenantTx, id: string, expectedVersion: number, actor: string): Promise<FeedbackRow> {
    const current = await this.lock(tx, id);
    this.assertVersion(current, expectedVersion);
    nextAlertFeedbackStatus(current.status, 'WITHDRAW', { actor, reporter: current.reporterId });
    await tx.query(`update machvon.alert_feedback set status = 'WITHDRAWN', version = version + 1 where id = $1::uuid`, [id]);
    return this.require(tx, id);
  }

  /** The owner of the type decides: accept for tuning, reject with a reason, or mark as the duplicate of another report. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, actor: string, decision: FeedbackDecision): Promise<FeedbackRow> {
    const current = await this.lock(tx, id);
    this.assertVersion(current, expectedVersion);
    const status = nextAlertFeedbackStatus(current.status, decision.move, { actor, reporter: current.reporterId, reviewNote: decision.reviewNote ?? null });
    if (decision.move === 'MARK_DUPLICATE') {
      if (decision.duplicateOfId === undefined || decision.duplicateOfId === id) throw new DomainError('VALIDATION_FAILED', 422, 'duplicate_of_id');
      const other = await this.find(tx, decision.duplicateOfId);
      if (other === undefined || other.alertTypeCode !== current.alertTypeCode) throw new DomainError('VALIDATION_FAILED', 422, 'duplicate_of_id');
    }
    await tx.query(
      `update machvon.alert_feedback set status = $2, reviewer_membership_id = $3::uuid, reviewed_at = now(), review_note = $4, proposal_note = $5, governance_rule_id = $6::uuid, duplicate_of_id = $7::uuid, version = version + 1
        where id = $1::uuid`,
      [id, status, actor, decision.reviewNote?.trim() ?? null, decision.proposalNote?.trim() ?? null, decision.governanceRuleId ?? null, decision.duplicateOfId ?? null],
    );
    return this.require(tx, id);
  }

  private async lock(tx: TenantTx, id: string): Promise<FeedbackRow> {
    const [row] = await tx.query<Row>(`select ${COLUMNS} from machvon.alert_feedback f where f.id = $1::uuid for update`, [id]);
    if (row === undefined) throw new DomainError('NOT_FOUND', 404, 'id');
    return toRow(row);
  }

  private assertVersion(current: FeedbackRow, expected: number): void {
    if (current.version !== expected) throw versionConflict(current.version);
  }

  /** The queue of the reviewers, oldest first within a status (a pending report waits in the order it was made). */
  async queue(tx: TenantTx, filter: FeedbackQueueFilter): Promise<FeedbackRow[]> {
    const params: unknown[] = [];
    const add = (value: unknown): string => `$${params.push(value)}`;
    const where: string[] = [];
    if (filter.status !== undefined) where.push(`f.status = ${add(filter.status)}`);
    if (filter.alertTypeCode !== undefined) where.push(`f.alert_type_code = ${add(filter.alertTypeCode)}`);
    if (filter.after !== undefined) where.push(`(f.created_at, f.id) > (${add(filter.after.at)}::timestamptz, ${add(filter.after.id)}::uuid)`);
    const limit = add(filter.limit);
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.alert_feedback f ${where.length === 0 ? '' : `where ${where.join(' and ')}`} order by f.created_at, f.id limit ${limit}`, params);
    return rows.map(toRow);
  }

  /** The reports a person made, newest first. */
  async mine(tx: TenantTx, reporter: string, limit: number): Promise<FeedbackRow[]> {
    const rows = await tx.query<Row>(`select ${COLUMNS} from machvon.alert_feedback f where f.reporter_membership_id = $1::uuid order by f.created_at desc, f.id desc limit $2`, [reporter, limit]);
    return rows.map(toRow);
  }

  /** The items among `items` that the person reported and that are not decided yet: the list shows "reported" on them. */
  async reportedBy(tx: TenantTx, reporter: string, items: ReadonlyArray<{ source: string; sourceId: string }>): Promise<Set<string>> {
    if (items.length === 0) return new Set();
    const rows = await tx.query<{ source: string; source_id: string }>(
      `select f.source, f.source_id from machvon.alert_feedback f
        where f.reporter_membership_id = $1::uuid and f.status = 'PENDING' and (f.source, f.source_id) in (select * from unnest($2::text[], $3::text[]))`,
      [reporter, items.map((item) => item.source), items.map((item) => item.sourceId)],
    );
    return new Set(rows.map((row) => `${row.source}\u0000${row.source_id}`));
  }

  /** How many reports each type has in a period of days, against how many alerts of that type were shown (first seen in it): the unhelpful share of each type. */
  async statsByType(tx: TenantTx, from: string, to: string): Promise<TypeFeedbackStat[]> {
    const rows = await tx.query<{ code: string; reports: string; pending: string; shown: string }>(
      `with reports as (
         select f.alert_type_code as code, count(*) filter (where f.status <> 'WITHDRAWN') as reports, count(*) filter (where f.status = 'PENDING') as pending
           from machvon.alert_feedback f where f.created_at >= $1::date and f.created_at < $2::date group by 1),
       shown as (
         select coalesce(o.alert_type_code, o.kind) as code, count(*) as shown from machvon.alert_observation o where o.first_seen_at >= $1::date and o.first_seen_at < $2::date group by 1)
       select coalesce(r.code, s.code) as code, coalesce(r.reports, 0)::text as reports, coalesce(r.pending, 0)::text as pending, coalesce(s.shown, 0)::text as shown
         from reports r full join shown s on s.code = r.code
        where coalesce(r.reports, 0) > 0 order by coalesce(r.reports, 0) desc, 1`,
      [from, to],
    );
    return rows.map((row) => ({ alertTypeCode: row.code, reports: Number(row.reports), pending: Number(row.pending), shown: Number(row.shown), share: unhelpfulShare(Number(row.reports), Number(row.shown)) }));
  }
}
