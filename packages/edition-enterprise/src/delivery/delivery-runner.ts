import { createHash } from 'node:crypto';
import { ReportStore, WORKER_MEMBERSHIP_ID, loadAccessIn } from '@machvon/db';
import type { AuditWriter, ReportIssueRow, TenantDatabase, TenantTx } from '@machvon/db';
import { NOOP_METRICS, vietnamDateOf } from '@machvon/kernel';
import type { ChannelAttachment, ChannelSendResult, EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { DELIVERY_BATCH, DELIVERY_MEDIA_TYPES, decideDelivery, deliveryDue, deliveryMessage, outcomeOf } from './delivery-rules.ts';
import type { DeliveryFormat, DeliveryOutcome, IssuedHead } from './delivery-rules.ts';
import { ReportMailStore } from './delivery-store.ts';
import type { MailScheduleRow, MailingRow } from './delivery-store.ts';

export const MAILING_SENT_METRIC = 'report_mailing_sent_total';
export const MAILING_FAILED_METRIC = 'report_mailing_failed_total';
export const MAILING_BLOCKED_METRIC = 'report_mailing_blocked_total';
const RESOURCE = 'report_mailing';
/** The heads read for one schedule in one run; the oldest of those not yet mailed are taken first. */
const HEAD_WINDOW = 200;

/** What the e-mail channel gives the runner: whether it can send at all for the tenant, and the send itself. The adapter behind it is the channel port (`ChannelAdapter`); this module never builds a message of its own protocol. */
export interface ReportMailer {
  ready(ctx: TenantContext): Promise<{ ok: true } | { ok: false; reason: string }>;
  send(ctx: TenantContext, request: { idempotencyKey: string; to: string; subject: string; text: string; attachments: ChannelAttachment[] }): Promise<ChannelSendResult>;
}

/** The PDF of an issued copy, when the report engine can make one (ENT-4b); without it a schedule that asks for PDF skips its copies with `FORMAT_UNAVAILABLE`. */
export interface IssuedPdfSource {
  pdfOf(tx: TenantTx, copy: ReportIssueRow): Promise<{ bytes: Uint8Array; fileName: string } | undefined>;
}

export interface MailRunnerDeps {
  database: Pick<TenantDatabase, 'withTenant'>;
  mailer: ReportMailer;
  /** Whether the recipient may read the form now: the right to read issued copies over the whole tenant and the guard of the form. Judged for every message, as the BI export is. */
  mayRead(access: EffectiveAccess, layoutCode: string, now: Date): boolean;
  pdf?: IssuedPdfSource;
  /** The stores and the reading of a member's access; the real ones unless a test gives its own. */
  store?: Pick<ReportMailStore, 'settleLost' | 'activeForRun' | 'markRun' | 'held' | 'begin' | 'skip' | 'settle' | 'addressOf'>;
  reports?: Pick<ReportStore, 'listIssues' | 'outputBytes' | 'findLayout'>;
  accessOf?: (tx: TenantTx, membershipId: string) => Promise<EffectiveAccess>;
  audit?: Pick<AuditWriter, 'recordInTx'>;
  metrics?: MetricsSink;
  clock?: () => Date;
}

export interface MailSend {
  schedule: MailScheduleRow;
  copy: ReportIssueRow;
  mailing: MailingRow;
}

export interface MailRun {
  scheduleId: string;
  sent: number;
  failed: number;
  skipped: number;
}

const headOf = (copy: ReportIssueRow): IssuedHead => ({
  id: copy.id,
  layoutCode: copy.layoutCode,
  periodCode: copy.periodCode,
  revision: copy.revision,
  countsAsAccepted: copy.countsAsAccepted,
  issuedAt: copy.issuedAt,
  xlsxSha256: copy.xlsxSha256,
  docxSha256: copy.docxSha256,
});

/**
 * The job `report-mail-runner` (ENT-4d): for each active schedule whose next time has come it mails the ISSUED head copies of its form that were issued after the schedule was made. In two steps with the network call
 * outside any transaction: the first writes the rows of the log (SENDING, or SKIPPED with a reason) and commits; the second, for each message, reads the file and the address, makes the call, and settles the row with what
 * the channel said. A process that dies between the two leaves SENDING rows, which the next run settles as UNKNOWN and never sends again on its own: a message is sent at most once for each (schedule, copy, recipient)
 * unless the channel said it failed in a way that may pass. A run that leaves copies over (more than a batch) does not mark itself done and goes on at the next minute.
 */
export class ReportMailRunner {
  private readonly store: NonNullable<MailRunnerDeps['store']>;
  private readonly reports: NonNullable<MailRunnerDeps['reports']>;
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(private readonly deps: MailRunnerDeps) {
    this.store = deps.store ?? new ReportMailStore();
    this.reports = deps.reports ?? new ReportStore();
    this.metrics = deps.metrics ?? NOOP_METRICS;
    this.clock = deps.clock ?? ((): Date => new Date());
  }

  async run(ctx: TenantContext, now: Date = this.clock()): Promise<MailRun[]> {
    const ready = await this.deps.mailer.ready(ctx);
    if (!ready.ok) {
      // No channel to send on: nothing is written and no schedule is marked as run, so the copies wait for the channel instead of being logged as failed.
      this.metrics.increment(MAILING_BLOCKED_METRIC);
      return [];
    }
    const sends: MailSend[] = [];
    const runs = new Map<string, MailRun>();
    await this.deps.database.withTenant(ctx, async (tx) => {
      await this.store.settleLost(tx, now);
      for (const schedule of await this.store.activeForRun(tx)) {
        if (!deliveryDue(schedule, now)) continue;
        const run: MailRun = { scheduleId: schedule.id, sent: 0, failed: 0, skipped: 0 };
        runs.set(schedule.id, run);
        const complete = await this.plan(tx, schedule, now, sends, run);
        if (complete) await this.store.markRun(tx, schedule.id, now);
      }
    });
    for (const send of sends) {
      const outcome = await this.deliver(ctx, send, now);
      const run = runs.get(send.schedule.id) as MailRun;
      if (outcome.status === 'SENT') run.sent += 1;
      else run.failed += 1;
    }
    return [...runs.values()];
  }

  /** Writes the rows for one schedule: the oldest copies that still have something to do, up to a batch. Returns whether no copy was left over. */
  private async plan(tx: TenantTx, schedule: MailScheduleRow, now: Date, sends: MailSend[], run: MailRun): Promise<boolean> {
    const copies = (await this.reports.listIssues(tx, { layoutCode: schedule.layoutCode, headsOnly: true, limit: HEAD_WINDOW })).filter((copy) => Date.parse(copy.issuedAt) >= Date.parse(schedule.createdAt)).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
    const held = await this.store.held(tx, schedule.id, copies.map((copy) => copy.id));
    const decisions = copies.map((copy) => ({
      copy,
      each: schedule.recipients.map((recipient) => ({ recipient, decision: decideDelivery({ copy: headOf(copy), format: schedule.format, scheduleCreatedAt: schedule.createdAt, held: held.get(`${copy.id}|${recipient}`), pdfAvailable: this.deps.pdf !== undefined }) })),
    }));
    const pending = decisions.filter((entry) => entry.each.some((one) => one.decision.kind !== 'DONE'));
    for (const entry of pending.slice(0, DELIVERY_BATCH)) {
      for (const { recipient, decision } of entry.each) {
        if (decision.kind === 'SKIP') {
          await this.store.skip(tx, { scheduleId: schedule.id, issueId: entry.copy.id, recipientId: recipient, format: schedule.format, reason: decision.reason, at: now });
          run.skipped += 1;
        } else if (decision.kind === 'SEND') {
          const mailing = await this.store.begin(tx, { scheduleId: schedule.id, issueId: entry.copy.id, recipientId: recipient, format: schedule.format, at: now });
          if (mailing !== undefined) sends.push({ schedule, copy: entry.copy, mailing });
        }
      }
    }
    return pending.length <= DELIVERY_BATCH;
  }

  /** The file of the copy in the format asked, with the check that its bytes are the ones the hash names. */
  private async fileOf(tx: TenantTx, copy: ReportIssueRow, format: DeliveryFormat): Promise<{ bytes: Uint8Array; fileName: string } | 'FILE_MISSING' | 'FILE_INTEGRITY' | 'PDF_UNAVAILABLE'> {
    if (format === 'PDF') return (await this.deps.pdf?.pdfOf(tx, copy)) ?? 'PDF_UNAVAILABLE';
    const sha = format === 'XLSX' ? copy.xlsxSha256 : copy.docxSha256;
    const fileName = format === 'XLSX' ? copy.xlsxName : copy.docxName;
    if (sha === null || fileName === null) return 'FILE_MISSING';
    const stored = await this.reports.outputBytes(tx, sha);
    if (stored === undefined) return 'FILE_MISSING';
    return createHash('sha256').update(stored.bytes).digest('hex') === sha ? { bytes: stored.bytes, fileName } : 'FILE_INTEGRITY';
  }

  private async deliver(ctx: TenantContext, send: MailSend, now: Date): Promise<DeliveryOutcome> {
    const { schedule, copy, mailing } = send;
    const refused = (errorCode: string): DeliveryOutcome => ({ status: 'REFUSED', errorCode, providerMessageId: null });
    // The read: the recipient as they are now, the file, the address. Closed before the call is made.
    const prepared = await this.deps.database.withTenant(ctx, async (tx) => {
      const access = await (this.deps.accessOf ?? loadAccessIn)(tx, mailing.recipientId);
      if (!access.membershipActive || !this.deps.mayRead(access, copy.layoutCode, now)) return refused('RECIPIENT_NOT_ALLOWED');
      const file = await this.fileOf(tx, copy, schedule.format);
      if (typeof file === 'string') return refused(file);
      const to = await this.store.addressOf(tx, mailing.recipientId);
      if (to === undefined) return refused('NO_ADDRESS');
      const layout = await this.reports.findLayout(tx, copy.layoutCode, copy.layoutVersion);
      return { file, to, formName: layout?.name ?? copy.layoutCode };
    });
    let outcome: DeliveryOutcome;
    let attached: { name: string; sha256: string } | undefined;
    if ('status' in prepared) outcome = prepared;
    else {
      const sha256 = createHash('sha256').update(prepared.file.bytes).digest('hex');
      attached = { name: prepared.file.fileName, sha256 };
      const message = deliveryMessage({ formName: prepared.formName, periodCode: copy.periodCode, revision: copy.revision, issuedOn: vietnamDateOf(new Date(copy.issuedAt)), fileName: prepared.file.fileName, fileSha256: sha256, note: schedule.note });
      const attachment: ChannelAttachment = { fileName: prepared.file.fileName, mediaType: DELIVERY_MEDIA_TYPES[schedule.format], content: prepared.file.bytes, sha256 };
      let result: ChannelSendResult;
      try {
        // The key is the mailing and its attempt: a provider that supports idempotency keys sends once however often it is asked.
        result = await this.deps.mailer.send(ctx, { idempotencyKey: `${mailing.id}:EMAIL:${mailing.attempts}`, to: prepared.to, subject: message.subject, text: message.text, attachments: [attachment] });
      } catch {
        // The adapter failed in a way it did not classify: the request may have left, so it is not repeated on its own.
        result = { kind: 'UNKNOWN', errorCode: 'ADAPTER_ERROR' };
      }
      outcome = outcomeOf(result);
    }
    const settled = this.clock();
    await this.deps.database.withTenant(ctx, async (tx) => {
      const row = await this.store.settle(tx, mailing.id, outcome, attached, settled);
      await this.deps.audit?.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
        action: outcome.status === 'SENT' ? 'report.mail_sent' : 'report.mail_not_sent',
        resourceType: RESOURCE,
        resourceId: row.id,
        classification: 'INTERNAL',
        diff: { schedule_id: schedule.id, issue_id: copy.id, recipient_id: mailing.recipientId, status: row.status, file_format: schedule.format, file_sha256: row.fileSha256, code: row.errorCode, attempt: row.attempts },
      });
    });
    this.metrics.increment(outcome.status === 'SENT' ? MAILING_SENT_METRIC : MAILING_FAILED_METRIC);
    return outcome;
  }
}
