import {
  DomainError,
  MONITORING_RULE_TYPE,
  addDays,
  assertFeedbackMove,
  assertNoticeMayBeSent,
  assertPackReadyForNotice,
  daysBetween,
  monitoringDefaults,
  monitoringPolicyOf,
  nextMonitoringFeedbackStatus,
  noticeReading,
  packCompleteness,
  responseReading,
  summariseFeedback,
  versionConflict,
} from '@machvon/kernel';
import type { MonitoringFeedbackMove, MonitoringFeedbackStatus, MonitoringPolicy, MonitoringSummary, MonitoringTrigger, NoticeReading, PackCompleteness, ResponseReading } from '@machvon/kernel';
import { resolveDocument } from './gov12-documents.ts';
import type { DocumentRefKind } from './gov12-documents.ts';
import { DAY, ISO, readPolicy } from './gov12-policy.ts';
import type { PolicyReading } from './gov12-policy.ts';
import type { TenantTx } from './tenant-database.ts';

export interface MonitoringFileRow {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  status: 'OPEN' | 'CLOSED';
  triggerKind: MonitoringTrigger | null;
  triggerOn: string | null;
  triggerReason: string | null;
  noticeDays: number | null;
  noticeRuleVersion: number | null;
  noticeSentOn: string | null;
  noticeSentBy: string | null;
  noticeNote: string | null;
  closedAt: string | null;
  version: number;
  createdAt: string;
}

export interface PackItemRow {
  id: string;
  item: string;
  documentId: string;
  documentKind: DocumentRefKind;
  title: string;
  sha256: string | null;
  addedBy: string;
  addedAt: string;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
}

export interface FeedbackRow {
  id: string;
  fileId: string;
  reference: string;
  receivedOn: string;
  channel: string;
  topic: string;
  fromLabel: string | null;
  summary: string;
  status: MonitoringFeedbackStatus;
  responseDays: number;
  ruleVersion: number;
  ownerId: string | null;
  responseText: string | null;
  respondedOn: string | null;
  respondedBy: string | null;
  closedBy: string | null;
  declinedReason: string | null;
  version: number;
  response: ResponseReading;
}

export interface FeedbackEventRow {
  id: string;
  move: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string;
  reason: string | null;
  at: string;
}

export interface FileReading {
  file: MonitoringFileRow;
  notice: NoticeReading;
  pack: PackCompleteness;
  items: PackItemRow[];
  summary: MonitoringSummary;
}

const FILE_COLUMNS = `f.id, f.project_id, p.code as project_code, p.name as project_name, f.status, f.trigger_kind, ${DAY('f.trigger_on')} as trigger_on, f.trigger_reason, f.notice_days, f.notice_rule_version,
  ${DAY('f.notice_sent_on')} as notice_sent_on, f.notice_sent_by, f.notice_note, ${ISO('f.closed_at')} as closed_at, f.version, ${ISO('f.created_at')} as created_at`;
const FILE_FROM = `machvon.monitoring_file f left join machvon.project p on p.tenant_id = f.tenant_id and p.id = f.project_id`;

type Raw = Record<string, unknown>;
const toFile = (row: Raw): MonitoringFileRow => ({
  id: row.id as string,
  projectId: row.project_id as string,
  projectCode: (row.project_code as string | null) ?? null,
  projectName: (row.project_name as string | null) ?? null,
  status: row.status as 'OPEN' | 'CLOSED',
  triggerKind: (row.trigger_kind as MonitoringTrigger | null) ?? null,
  triggerOn: (row.trigger_on as string | null) ?? null,
  triggerReason: (row.trigger_reason as string | null) ?? null,
  noticeDays: (row.notice_days as number | null) ?? null,
  noticeRuleVersion: (row.notice_rule_version as number | null) ?? null,
  noticeSentOn: (row.notice_sent_on as string | null) ?? null,
  noticeSentBy: (row.notice_sent_by as string | null) ?? null,
  noticeNote: (row.notice_note as string | null) ?? null,
  closedAt: (row.closed_at as string | null) ?? null,
  version: Number(row.version),
  createdAt: row.created_at as string,
});

const FEEDBACK_COLUMNS = `id, file_id, reference, ${DAY('received_on')} as received_on, channel, topic, from_label, summary, status, response_days, rule_version, owner_membership_id, response_text,
  ${DAY('responded_on')} as responded_on, responded_by, closed_by, declined_reason, version`;

/** The policy a feedback was received under: its own days, so a later change of the rule does not move its clock. */
const ownPolicy = (days: number, base: MonitoringPolicy): MonitoringPolicy => ({ ...base, response_days: days, reminder_days: Math.min(base.reminder_days, Math.max(0, days - 1)) });

/**
 * The community monitoring file of a project (G4-8). The store keeps the facts and the kernel judges them: the notice deadline is the trigger day plus the days the rule gave when the trigger was set; a feedback is
 * answered by the days the rule gave when it was received. A later change of the rule never moves a clock that is running. Every function runs inside the transaction of the caller.
 */
export class MonitoringStore {
  async policy(tx: TenantTx, today: string): Promise<PolicyReading<MonitoringPolicy>> {
    return readPolicy(tx, MONITORING_RULE_TYPE, today, monitoringPolicyOf, monitoringDefaults);
  }

  async openFile(tx: TenantTx, projectId: string, by: string): Promise<{ file: MonitoringFileRow; created: boolean }> {
    const [project] = await tx.query<{ id: string }>('select id from machvon.project where id = $1::uuid', [projectId]);
    if (project === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.monitoring_file (tenant_id, project_id, created_by) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid)
       on conflict (tenant_id, project_id) do nothing returning id`,
      [projectId, by],
    );
    const [row] = await tx.query<Raw>(`select ${FILE_COLUMNS} from ${FILE_FROM} where f.project_id = $1::uuid`, [projectId]);
    return { file: toFile(row as Raw), created: inserted.length === 1 };
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<MonitoringFileRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${FILE_COLUMNS} from ${FILE_FROM} where f.id = $1::uuid${lock ? ' for update of f' : ''}`, [id]);
    return row === undefined ? undefined : toFile(row);
  }

  private async lockFile(tx: TenantTx, id: string, expectedVersion: number): Promise<MonitoringFileRow> {
    const file = await this.find(tx, id, true);
    if (file === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (file.version !== expectedVersion) throw versionConflict(file.version);
    return file;
  }

  /** Sets what began the duty to notify and fixes the days of the rule of today for it; a day that is set is not changed. */
  async setTrigger(tx: TenantTx, id: string, expectedVersion: number, input: { kind: MonitoringTrigger; on: string; reason: string | null }, today: string): Promise<MonitoringFileRow> {
    const file = await this.lockFile(tx, id, expectedVersion);
    if (file.status === 'CLOSED') throw new DomainError('MONITORING_FILE_CLOSED', 409);
    if (file.triggerOn !== null) throw new DomainError('MONITORING_TRIGGER_SET', 409);
    if (daysBetween(input.on, today) < 0) throw new DomainError('VALIDATION_FAILED', 422, 'trigger_on');
    if (input.kind === 'MANUAL' && (input.reason === null || input.reason.trim().length < 5)) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const reading = await this.policy(tx, today);
    await tx.query(
      `update machvon.monitoring_file set trigger_kind = $2, trigger_on = $3::date, trigger_reason = $4, notice_days = $5, notice_rule_version = $6, version = version + 1 where id = $1::uuid`,
      [id, input.kind, input.on, input.kind === 'MANUAL' ? (input.reason as string).trim() : null, reading.policy.notice_days, reading.version],
    );
    return (await this.find(tx, id)) as MonitoringFileRow;
  }

  async items(tx: TenantTx, fileId: string, includeWithdrawn = false): Promise<PackItemRow[]> {
    const rows = await tx.query<Raw>(
      `select id, item, document_id, document_kind, title, sha256, added_by, ${ISO('added_at')} as added_at, ${ISO('withdrawn_at')} as withdrawn_at, withdrawn_reason from machvon.monitoring_pack_item
        where file_id = $1::uuid${includeWithdrawn ? '' : ' and withdrawn_at is null'} order by item, added_at, id`,
      [fileId],
    );
    return rows.map((row) => ({
      id: row.id as string,
      item: row.item as string,
      documentId: row.document_id as string,
      documentKind: row.document_kind as DocumentRefKind,
      title: row.title as string,
      sha256: (row.sha256 as string | null) ?? null,
      addedBy: row.added_by as string,
      addedAt: row.added_at as string,
      withdrawnAt: (row.withdrawn_at as string | null) ?? null,
      withdrawnReason: (row.withdrawn_reason as string | null) ?? null,
    }));
  }

  async addItem(tx: TenantTx, fileId: string, input: { item: string; documentId: string; documentKind: DocumentRefKind }, by: string): Promise<PackItemRow> {
    const file = await this.find(tx, fileId, true);
    if (file === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (file.status === 'CLOSED') throw new DomainError('MONITORING_FILE_CLOSED', 409);
    // The notice is a fact once it is sent: the pack of that day does not change after it.
    if (file.noticeSentOn !== null && input.item === 'NOTICE_TEXT') throw new DomainError('MONITORING_NOTICE_ALREADY_SENT', 409);
    const document = await resolveDocument(tx, input.documentKind, input.documentId);
    if (document === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.monitoring_pack_item (tenant_id, file_id, item, document_id, document_kind, title, sha256, added_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::uuid, $4, $5, $6, $7::uuid) on conflict do nothing returning id`,
      [fileId, input.item, input.documentId, input.documentKind, document.title.slice(0, 300), document.sha256, by],
    );
    if (inserted.length === 0) throw new DomainError('MONITORING_PACK_DUPLICATE', 409, 'document_id');
    return (await this.items(tx, fileId)).find((entry) => entry.id === (inserted[0] as { id: string }).id) as PackItemRow;
  }

  async withdrawItem(tx: TenantTx, itemId: string, reason: string, by: string): Promise<{ fileId: string; item: string }> {
    const [row] = await tx.query<{ file_id: string; item: string; withdrawn_at: string | null }>('select file_id, item, withdrawn_at::text from machvon.monitoring_pack_item where id = $1::uuid for update', [itemId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (row.withdrawn_at !== null) throw new DomainError('MONITORING_PACK_DUPLICATE', 409, 'id');
    const file = await this.find(tx, row.file_id);
    if (file?.noticeSentOn !== null && file?.noticeSentOn !== undefined) throw new DomainError('MONITORING_NOTICE_ALREADY_SENT', 409);
    if (reason.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    await tx.query('update machvon.monitoring_pack_item set withdrawn_by = $2::uuid, withdrawn_at = now(), withdrawn_reason = $3 where id = $1::uuid', [itemId, by, reason.trim()]);
    return { fileId: row.file_id, item: row.item };
  }

  /** Sends the notice: the trigger is set, the pack holds the required items, the day is not before the trigger and not in the future, and the notice is not already sent. Returns the reading after it. */
  async sendNotice(tx: TenantTx, id: string, expectedVersion: number, input: { sentOn: string; note: string | null }, by: string, today: string): Promise<{ file: MonitoringFileRow; notice: NoticeReading }> {
    const file = await this.lockFile(tx, id, expectedVersion);
    if (file.status === 'CLOSED') throw new DomainError('MONITORING_FILE_CLOSED', 409);
    assertNoticeMayBeSent({ triggerOn: file.triggerOn, sentOn: file.noticeSentOn }, input.sentOn, today);
    assertPackReadyForNotice((await this.items(tx, id)).map((entry) => entry.item));
    await tx.query('update machvon.monitoring_file set notice_sent_on = $2::date, notice_sent_by = $3::uuid, notice_note = $4, version = version + 1 where id = $1::uuid', [id, input.sentOn, by, input.note === null ? null : input.note.trim()]);
    const after = (await this.find(tx, id)) as MonitoringFileRow;
    return { file: after, notice: this.noticeOf(after, today) };
  }

  async close(tx: TenantTx, id: string, expectedVersion: number, by: string): Promise<MonitoringFileRow> {
    const file = await this.lockFile(tx, id, expectedVersion);
    if (file.status === 'CLOSED') throw new DomainError('MONITORING_FILE_CLOSED', 409);
    const [open] = await tx.query<{ n: string }>(`select count(*)::text as n from machvon.monitoring_feedback where file_id = $1::uuid and status in ('RECEIVED', 'IN_REVIEW')`, [id]);
    if (Number((open as { n: string }).n) > 0) throw new DomainError('MONITORING_FEEDBACK_OPEN', 409);
    await tx.query(`update machvon.monitoring_file set status = 'CLOSED', closed_at = now(), closed_by = $2::uuid, version = version + 1 where id = $1::uuid`, [id, by]);
    return (await this.find(tx, id)) as MonitoringFileRow;
  }

  /** The reading of the notice by the days fixed on the file (not by the rule of today). */
  noticeOf(file: MonitoringFileRow, today: string): NoticeReading {
    const base = monitoringDefaults();
    return noticeReading({ triggerOn: file.triggerOn, sentOn: file.noticeSentOn }, today, { ...base, notice_days: file.noticeDays ?? base.notice_days });
  }

  async feedbackOf(tx: TenantTx, fileId: string, today: string): Promise<FeedbackRow[]> {
    const policy = (await this.policy(tx, today)).policy;
    const rows = await tx.query<Raw>(`select ${FEEDBACK_COLUMNS} from machvon.monitoring_feedback where file_id = $1::uuid order by received_on desc, id`, [fileId]);
    return rows.map((row) => this.toFeedback(row, today, policy));
  }

  private toFeedback(row: Raw, today: string, base: MonitoringPolicy): FeedbackRow {
    const status = row.status as MonitoringFeedbackStatus;
    const receivedOn = row.received_on as string;
    const respondedOn = (row.responded_on as string | null) ?? null;
    return {
      id: row.id as string,
      fileId: row.file_id as string,
      reference: row.reference as string,
      receivedOn,
      channel: row.channel as string,
      topic: row.topic as string,
      fromLabel: (row.from_label as string | null) ?? null,
      summary: row.summary as string,
      status,
      responseDays: row.response_days as number,
      ruleVersion: row.rule_version as number,
      ownerId: (row.owner_membership_id as string | null) ?? null,
      responseText: (row.response_text as string | null) ?? null,
      respondedOn,
      respondedBy: (row.responded_by as string | null) ?? null,
      closedBy: (row.closed_by as string | null) ?? null,
      declinedReason: (row.declined_reason as string | null) ?? null,
      version: Number(row.version),
      response: responseReading({ receivedOn, respondedOn, status }, today, ownPolicy(row.response_days as number, base)),
    };
  }

  async getFeedback(tx: TenantTx, id: string, today: string, lock = false): Promise<FeedbackRow | undefined> {
    const policy = (await this.policy(tx, today)).policy;
    const [row] = await tx.query<Raw>(`select ${FEEDBACK_COLUMNS} from machvon.monitoring_feedback where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : this.toFeedback(row, today, policy);
  }

  /** Reads one file with its notice, its pack, its feedback counts. */
  async reading(tx: TenantTx, id: string, today: string): Promise<FileReading | undefined> {
    const file = await this.find(tx, id);
    if (file === undefined) return undefined;
    const items = await this.items(tx, id);
    const feedback = await this.feedbackOf(tx, id, today);
    return { file, notice: this.noticeOf(file, today), pack: packCompleteness(items.map((entry) => entry.item)), items, summary: summariseFeedback(feedback.map((entry) => ({ status: entry.status, response: entry.response }))) };
  }

  async list(tx: TenantTx, filter: { status?: 'OPEN' | 'CLOSED' | undefined; limit: number; offset: number }, today: string): Promise<Array<{ file: MonitoringFileRow; notice: NoticeReading; summary: MonitoringSummary }>> {
    const rows = await tx.query<Raw>(
      `select ${FILE_COLUMNS} from ${FILE_FROM} where ($1::text is null or f.status = $1) order by f.status, f.trigger_on nulls last, f.id limit $2 offset $3`,
      [filter.status ?? null, filter.limit, filter.offset],
    );
    const policy = (await this.policy(tx, today)).policy;
    const out: Array<{ file: MonitoringFileRow; notice: NoticeReading; summary: MonitoringSummary }> = [];
    for (const raw of rows) {
      const file = toFile(raw);
      const feedback = await tx.query<Raw>(`select ${FEEDBACK_COLUMNS} from machvon.monitoring_feedback where file_id = $1::uuid`, [file.id]);
      out.push({ file, notice: this.noticeOf(file, today), summary: summariseFeedback(feedback.map((row) => this.toFeedback(row, today, policy)).map((entry) => ({ status: entry.status, response: entry.response }))) });
    }
    return out;
  }

  async logFeedback(tx: TenantTx, fileId: string, input: { reference: string; receivedOn: string; channel: string; topic: string; fromLabel: string | null; summary: string }, by: string, today: string): Promise<{ feedback: FeedbackRow; created: boolean }> {
    const file = await this.find(tx, fileId, true);
    if (file === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (file.status === 'CLOSED') throw new DomainError('MONITORING_FILE_CLOSED', 409);
    if (daysBetween(input.receivedOn, today) < 0) throw new DomainError('VALIDATION_FAILED', 422, 'received_on');
    const reading = await this.policy(tx, today);
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.monitoring_feedback (tenant_id, file_id, reference, received_on, channel, topic, from_label, summary, response_days, rule_version, created_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::uuid) on conflict (tenant_id, file_id, reference) do nothing returning id`,
      [fileId, input.reference.trim(), input.receivedOn, input.channel, input.topic, input.fromLabel === null ? null : input.fromLabel.trim(), input.summary.trim(), reading.policy.response_days, reading.version, by],
    );
    const [row] = await tx.query<Raw>(`select ${FEEDBACK_COLUMNS} from machvon.monitoring_feedback where file_id = $1::uuid and reference = $2`, [fileId, input.reference.trim()]);
    const feedback = this.toFeedback(row as Raw, today, reading.policy);
    if (inserted.length === 1) await this.event(tx, feedback.id, 'RECEIVED', null, 'RECEIVED', by, null);
    return { feedback, created: inserted.length === 1 };
  }

  private async event(tx: TenantTx, feedbackId: string, move: string, from: string | null, to: string, actor: string, reason: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.monitoring_feedback_event (tenant_id, feedback_id, move, from_status, to_status, actor_membership_id, reason) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5::uuid, $6)`,
      [feedbackId, move, from, to, actor, reason],
    );
  }

  async events(tx: TenantTx, feedbackId: string): Promise<FeedbackEventRow[]> {
    const rows = await tx.query<Raw>(`select id, move, from_status, to_status, actor_membership_id, reason, ${ISO('at')} as at from machvon.monitoring_feedback_event where feedback_id = $1::uuid order by at, id`, [feedbackId]);
    return rows.map((row) => ({ id: row.id as string, move: row.move as string, fromStatus: (row.from_status as string | null) ?? null, toStatus: row.to_status as string, actorId: row.actor_membership_id as string, reason: (row.reason as string | null) ?? null, at: row.at as string }));
  }

  async moveFeedback(tx: TenantTx, id: string, expectedVersion: number, move: MonitoringFeedbackMove, actor: string, input: { text: string | null }, today: string): Promise<FeedbackRow> {
    const current = await this.getFeedback(tx, id, today, true);
    if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (current.version !== expectedVersion) throw versionConflict(current.version);
    const file = await this.find(tx, current.fileId);
    if (file?.status === 'CLOSED' && move !== 'REOPEN') throw new DomainError('MONITORING_FILE_CLOSED', 409);
    const text = input.text === null ? null : input.text.trim();
    assertFeedbackMove({ move, actorId: actor, responderId: current.respondedBy, reason: move === 'DECLINE' || move === 'REOPEN' ? text : null });
    const to = nextMonitoringFeedbackStatus(current.status, move);
    if (move === 'RESPOND' && (text === null || text.length < 10)) throw new DomainError('VALIDATION_FAILED', 422, 'response');
    switch (move) {
      case 'TAKE':
        await tx.query('update machvon.monitoring_feedback set status = $2, owner_membership_id = $3::uuid, version = version + 1 where id = $1::uuid', [id, to, actor]);
        break;
      case 'RESPOND':
        await tx.query('update machvon.monitoring_feedback set status = $2, response_text = $3, responded_on = $4::date, responded_by = $5::uuid, owner_membership_id = coalesce(owner_membership_id, $5::uuid), version = version + 1 where id = $1::uuid', [id, to, text, today, actor]);
        break;
      case 'CLOSE':
        await tx.query('update machvon.monitoring_feedback set status = $2, closed_by = $3::uuid, closed_at = now(), version = version + 1 where id = $1::uuid', [id, to, actor]);
        break;
      case 'DECLINE':
        await tx.query('update machvon.monitoring_feedback set status = $2, declined_reason = $3, owner_membership_id = $4::uuid, version = version + 1 where id = $1::uuid', [id, to, text, actor]);
        break;
      case 'REOPEN':
        // A reopened feedback keeps the answer that was given (the history of what was said), and a closed answer is closed again by a second person.
        await tx.query('update machvon.monitoring_feedback set status = $2, closed_by = null, closed_at = null, declined_reason = null, version = version + 1 where id = $1::uuid', [id, to]);
        break;
    }
    await this.event(tx, id, move, current.status, to, actor, text);
    return (await this.getFeedback(tx, id, today)) as FeedbackRow;
  }

  /** The days between the day the notice is due and today, for the screens' counters; null when there is no deadline. */
  static dueIn(file: MonitoringFileRow, today: string): number | null {
    return file.triggerOn === null || file.noticeDays === null ? null : daysBetween(today, addDays(file.triggerOn, file.noticeDays));
  }
}
