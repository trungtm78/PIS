import { DomainError, versionConflict } from '@machvon/kernel';
import type { IssuedCopyMarks, IssuedCopyRef } from '@machvon/kernel';
import { GovernancePolicyPort, timestampKey } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { HPM_PACKAGE_FORMAT, copyRefOf, decideHpmPush, hpmCopyRequestOf, hpmCorrectionDecision, hpmCorrectionRequestOf, hpmHealthOf, hpmKeyOf, hpmPolicyParamsOf, hpmPeriodRange, hpmRangesTouch, hpmReceiptMove, hpmRequestHash } from './hpm-rules.ts';
import type { HpmCopyRequest, HpmCorrectionState, HpmHealth, HpmPolicyParams, HpmPushState } from './hpm-rules.ts';
import type { HpmPort } from './hpm-port.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const UNIQUE_VIOLATION = '23505';
export const HPM_POLICY_RULE_TYPE = 'HPM_PUSH_POLICY';
export const HPM_POLICY_RULE_CODE = 'DEFAULT';
/** How many attempts a page of the push log shows inside each push. */
const ATTEMPTS_SHOWN = 10;

// ---- the period of DIS, behind a small port ----------------------------------------------------------------------------------------------------------

/** What a reopening answers for the report period a correction names: nothing of that id, in force for that period, not in force (not approved or its window is over), or it is the reopening of another period or of some projects only. */
export type PeriodReopenStatus = 'MISSING' | 'OPEN' | 'CLOSED' | 'OTHER_PERIOD';

/**
 * Whether the reopening a correction names is in force for the period of the report being corrected: approved, its window not over, covering the whole period (not some projects), and a period of
 * DIS that falls within the days the report covers. The port is the only thing the push knows of the reopening of DIS (the tables of another lane are not read here).
 */
export interface PeriodReopenPort {
  status(tx: TenantTx, reopenId: string, reportPeriod: string, now: Date): Promise<PeriodReopenStatus>;
}

/** The reopening of DIS (`period_reopen` and its `reporting_period`): approved, inside its window, for the whole period, and touching the days of the report period. */
export class DisPeriodReopenPort implements PeriodReopenPort {
  async status(tx: TenantTx, reopenId: string, reportPeriod: string, now: Date): Promise<PeriodReopenStatus> {
    const rows = await tx.query<{ status: string; window_until: string | null; scope_kind: string; start_date: string; end_date: string }>(
      `select r.status, r.window_until::text as window_until, r.scope_kind, p.start_date::text as start_date, p.end_date::text as end_date
         from machvon.period_reopen r join machvon.reporting_period p on p.tenant_id = r.tenant_id and p.id = r.period_id where r.id = $1::uuid`,
      [reopenId],
    );
    const row = rows[0];
    if (row === undefined) return 'MISSING';
    const range = hpmPeriodRange(reportPeriod);
    if (row.scope_kind !== 'PERIOD' || range === undefined || !hpmRangesTouch({ from: row.start_date, to: row.end_date }, range)) return 'OTHER_PERIOD';
    return row.status === 'APPROVED' && row.window_until !== null && Date.parse(row.window_until) > now.getTime() ? 'OPEN' : 'CLOSED';
  }
}

// ---- rows ------------------------------------------------------------------------------------------------------------------------------------------------

export interface HpmAttemptRow {
  attemptNo: number;
  outcome: 'WRITTEN' | 'FAILED';
  errorCode: string | null;
  packageSha256: string | null;
  actorId: string;
  attemptedAt: string;
}

export interface HpmPushRow {
  id: string;
  key: string;
  orgUnitId: string;
  layoutCode: string;
  period: string;
  revision: number;
  sha256: string;
  requestHash: string;
  fileObjectKey: string;
  snapshot: { snapshotId: string; revision: number; cutoff: string } | null;
  marks: IssuedCopyMarks | null;
  packageFormat: string;
  status: HpmPushState;
  attempts: number;
  lastAttemptAt: string;
  lastAttemptAtKey: string;
  lastErrorCode: string | null;
  response: Record<string, unknown> | null;
  correctionId: string | null;
  overwrites: boolean;
  pushedBy: string;
  receiptReference: string | null;
  receiptNote: string | null;
  receiptBy: string | null;
  receiptAt: string | null;
  version: number;
  createdAt: string;
  attemptRows: HpmAttemptRow[];
}

interface PushSql {
  id: string;
  idempotency_key: string;
  org_unit_id: string;
  layout_code: string;
  period: string;
  revision: number;
  sha256: string;
  request_hash: string;
  file_object_key: string;
  snapshot_id: string | null;
  snapshot_revision: number | null;
  snapshot_cutoff: string | null;
  form_status: IssuedCopyMarks['formStatus'] | null;
  demo_mark: string | null;
  package_format: string;
  status: HpmPushState;
  attempts: number;
  last_attempt_at: string;
  last_attempt_at_key: string;
  last_error_code: string | null;
  response: Record<string, unknown> | null;
  correction_id: string | null;
  overwrites: boolean;
  pushed_by: string;
  receipt_reference: string | null;
  receipt_note: string | null;
  receipt_by: string | null;
  receipt_at: string | null;
  version: string;
  created_at: string;
}

const PUSH_SELECT = `select p.id, p.idempotency_key, p.org_unit_id, p.layout_code, p.period, p.revision, p.sha256, p.request_hash, p.file_object_key, p.snapshot_id, p.snapshot_revision, p.snapshot_cutoff::text as snapshot_cutoff,
  p.form_status, p.demo_mark, p.package_format, p.status, p.attempts, to_char(p.last_attempt_at at time zone 'UTC', ${ISO}) as last_attempt_at, ${timestampKey('p.last_attempt_at')} as last_attempt_at_key,
  p.last_error_code, p.response, p.correction_id, p.overwrites, p.pushed_by, p.receipt_reference, p.receipt_note, p.receipt_by, to_char(p.receipt_at at time zone 'UTC', ${ISO}) as receipt_at, p.version::text as version,
  to_char(p.created_at at time zone 'UTC', ${ISO}) as created_at from machvon.hpm_push p`;

const pushOf = (row: PushSql): HpmPushRow => ({
  id: row.id,
  key: row.idempotency_key,
  orgUnitId: row.org_unit_id,
  layoutCode: row.layout_code,
  period: row.period,
  revision: row.revision,
  sha256: row.sha256,
  requestHash: row.request_hash,
  fileObjectKey: row.file_object_key,
  snapshot: row.snapshot_id === null ? null : { snapshotId: row.snapshot_id, revision: row.snapshot_revision as number, cutoff: row.snapshot_cutoff as string },
  marks: row.form_status === null ? null : { formStatus: row.form_status, demoMark: row.demo_mark },
  packageFormat: row.package_format,
  status: row.status,
  attempts: row.attempts,
  lastAttemptAt: row.last_attempt_at,
  lastAttemptAtKey: row.last_attempt_at_key,
  lastErrorCode: row.last_error_code,
  response: row.response,
  correctionId: row.correction_id,
  overwrites: row.overwrites,
  pushedBy: row.pushed_by,
  receiptReference: row.receipt_reference,
  receiptNote: row.receipt_note,
  receiptBy: row.receipt_by,
  receiptAt: row.receipt_at,
  version: Number(row.version),
  createdAt: row.created_at,
  attemptRows: [],
});

/** The copy a ledger row stands for, as the kernel judges it. */
export const copyOfRow = (row: HpmPushRow): IssuedCopyRef => ({
  id: row.id,
  orgId: row.orgUnitId,
  layoutCode: row.layoutCode,
  layoutVersion: '',
  period: row.period,
  revision: row.revision,
  supersedes: null,
  sha256: row.sha256,
  snapshot: row.snapshot,
  ...(row.marks === null ? {} : { marks: row.marks }),
});

/** The request a ledger row was made from (a retry re-sends exactly this). */
export const requestOfRow = (row: HpmPushRow): HpmCopyRequest => ({
  orgId: row.orgUnitId,
  layoutCode: row.layoutCode,
  period: row.period,
  revision: row.revision,
  sha256: row.sha256,
  fileObjectKey: row.fileObjectKey,
  snapshot: row.snapshot,
  marks: row.marks,
  correctionId: row.correctionId,
});

export interface HpmCorrectionRow {
  id: string;
  layoutCode: string;
  period: string;
  fromRevision: number;
  periodReopenId: string;
  reason: string;
  state: HpmCorrectionState;
  proposedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  consumedByPushId: string | null;
  consumedAt: string | null;
  version: number;
  createdAt: string;
  createdAtKey: string;
}

interface CorrectionSql {
  id: string;
  layout_code: string;
  period: string;
  from_revision: number;
  period_reopen_id: string;
  reason: string;
  state: HpmCorrectionState;
  proposed_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  consumed_by_push_id: string | null;
  consumed_at: string | null;
  version: string;
  created_at: string;
  created_at_key: string;
}

const CORRECTION_SELECT = `select c.id, c.layout_code, c.period, c.from_revision, c.period_reopen_id, c.reason, c.state, c.proposed_by, c.decided_by, to_char(c.decided_at at time zone 'UTC', ${ISO}) as decided_at,
  c.decision_reason, c.consumed_by_push_id, to_char(c.consumed_at at time zone 'UTC', ${ISO}) as consumed_at, c.version::text as version, to_char(c.created_at at time zone 'UTC', ${ISO}) as created_at,
  ${timestampKey('c.created_at')} as created_at_key from machvon.hpm_correction c`;

const correctionOf = (row: CorrectionSql): HpmCorrectionRow => ({
  id: row.id,
  layoutCode: row.layout_code,
  period: row.period,
  fromRevision: row.from_revision,
  periodReopenId: row.period_reopen_id,
  reason: row.reason,
  state: row.state,
  proposedBy: row.proposed_by,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  consumedByPushId: row.consumed_by_push_id,
  consumedAt: row.consumed_at,
  version: Number(row.version),
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
});

// ---- the ledger ------------------------------------------------------------------------------------------------------------------------------------

export type HpmSendOutcome = 'SENT' | 'ALREADY_DELIVERED' | 'FAILED';

export interface HpmSendResult {
  outcome: HpmSendOutcome;
  /** The row before this call (null when the call created it). */
  before: HpmPushRow | null;
  row: HpmPushRow;
  /** The correction this push consumed, when it was the push that replaced an accepted period. */
  consumed: HpmCorrectionRow | null;
}

export interface HpmSendInput {
  tenantId: string;
  actor: string;
  now: Date;
  port: HpmPort;
  reopen: PeriodReopenPort;
  bytes: Uint8Array;
  fileName: string;
}

export interface HpmPushFilter {
  status?: HpmPushState | undefined;
  layoutCode?: string | undefined;
  period?: string | undefined;
}

/** The error code a failed delivery is recorded under: the code of a domain error, else a generic one (a message of the adapter never reaches the log, it may carry a path). */
export function deliveryErrorCodeOf(error: unknown): string {
  return error instanceof DomainError ? error.code : 'HPM_DELIVERY_FAILED';
}

/**
 * The push log (R8, R17, R18). Each push is keyed by (organisation, layout, period, revision): the key is unique, the request hash makes another content under the same key a refusal, a retry re-sends the same key with the
 * next attempt number and never creates a second row, the newest accepted copy and the newest copy of the series judge staleness through the kernel rule, and replacing an accepted period consumes an approved correction while
 * the reopening of the period is in force. The adapter is a port; the answer it gives is kept as the response. A failed delivery is recorded and answered (the command does not roll it back), so that "failed" is a state a person can retry.
 */
export class HpmPushStore {
  private readonly policy = new GovernancePolicyPort();

  async policyOf(tx: TenantTx, now: Date): Promise<{ params: HpmPolicyParams; rule: Awaited<ReturnType<GovernancePolicyPort['require']>> }> {
    const rule = await this.policy.require(tx, HPM_POLICY_RULE_TYPE, HPM_POLICY_RULE_CODE, now);
    return { params: hpmPolicyParamsOf(rule.params as unknown as Readonly<Record<string, unknown>>), rule };
  }

  async find(tx: TenantTx, id: string, lock = false): Promise<HpmPushRow | undefined> {
    const rows = await tx.query<PushSql>(`${PUSH_SELECT} where p.id = $1::uuid${lock ? ' for update of p' : ''}`, [id]);
    return rows[0] === undefined ? undefined : pushOf(rows[0]);
  }

  async findByKey(tx: TenantTx, key: string, lock = false): Promise<HpmPushRow | undefined> {
    const rows = await tx.query<PushSql>(`${PUSH_SELECT} where p.idempotency_key = $1${lock ? ' for update of p' : ''}`, [key]);
    return rows[0] === undefined ? undefined : pushOf(rows[0]);
  }

  /** The pushes newest first, each with its newest attempts; the cursor is the time of the last attempt and the id. */
  async list(tx: TenantTx, filter: HpmPushFilter, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<HpmPushRow[]> {
    const rows = await tx.query<PushSql>(
      `select * from (${PUSH_SELECT} where ($1::text is null or p.status = $1) and ($2::text is null or p.layout_code = $2) and ($3::text is null or p.period = $3)) x
        where ($4::text is null or (x.last_attempt_at_key, x.id) < ($4::text, $5::uuid)) order by x.last_attempt_at_key desc, x.id desc limit $6`,
      [filter.status ?? null, filter.layoutCode ?? null, filter.period ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    const pushes = rows.map(pushOf);
    await this.attach(tx, pushes);
    return pushes;
  }

  /** Puts the newest attempts of each push on it. */
  async attach(tx: TenantTx, pushes: HpmPushRow[]): Promise<void> {
    if (pushes.length === 0) return;
    const attempts = await tx.query<{ push_id: string; attempt_no: number; outcome: 'WRITTEN' | 'FAILED'; error_code: string | null; package_sha256: string | null; actor_id: string; attempted_at: string }>(
      `select push_id, attempt_no, outcome, error_code, package_sha256, actor_id, to_char(attempted_at at time zone 'UTC', ${ISO}) as attempted_at
         from machvon.hpm_push_attempt where push_id = any($1::uuid[]) order by push_id, attempt_no desc`,
      [pushes.map((push) => push.id)],
    );
    for (const push of pushes) {
      push.attemptRows = attempts
        .filter((attempt) => attempt.push_id === push.id)
        .slice(0, ATTEMPTS_SHOWN)
        .map((attempt) => ({ attemptNo: attempt.attempt_no, outcome: attempt.outcome, errorCode: attempt.error_code, packageSha256: attempt.package_sha256, actorId: attempt.actor_id, attemptedAt: attempt.attempted_at }));
    }
  }

  /** The newest copy of the series, whatever its state (the head), and the newest copy the receiver accepted. */
  private async series(tx: TenantTx, request: HpmCopyRequest): Promise<{ head: HpmPushRow | undefined; accepted: HpmPushRow | undefined }> {
    const rows = await tx.query<PushSql>(`${PUSH_SELECT} where p.org_unit_id = $1::uuid and p.layout_code = $2 and p.period = $3 order by p.revision desc, p.created_at desc`, [request.orgId, request.layoutCode, request.period]);
    const pushes = rows.map(pushOf);
    return { head: pushes[0], accepted: pushes.find((push) => push.status === 'ACCEPTED') };
  }

  private async correctionFor(tx: TenantTx, id: string): Promise<HpmCorrectionRow | undefined> {
    const rows = await tx.query<CorrectionSql>(`${CORRECTION_SELECT} where c.id = $1::uuid for update of c`, [id]);
    return rows[0] === undefined ? undefined : correctionOf(rows[0]);
  }

  /**
   * One try of a key: the first push creates the row, a repeat of the key re-sends it. The rules decide first (`decideHpmPush`); a refusal throws and nothing is written. When the package is to be written, the adapter is
   * called inside the transaction: its failure is recorded as a FAILED attempt and the row is left FAILED for a retry, its success as WRITTEN with the answer of the adapter. An accepted period is replaced only with
   * an approved correction and an open reopening; the correction is consumed by the first try of the push that replaces the period.
   */
  async send(tx: TenantTx, request: HpmCopyRequest, intent: 'SUBMIT' | 'RETRY', input: HpmSendInput): Promise<HpmSendResult> {
    const key = hpmKeyOf(request);
    const requestHash = hpmRequestHash(request);
    const existing = await this.findByKey(tx, key, true);
    const { head, accepted } = await this.series(tx, request);
    const policy = await this.policyOf(tx, input.now);
    const copy = copyRefOf(request, existing?.id ?? key, null);
    const headRef: IssuedCopyRef = head !== undefined && head.revision > request.revision ? copyOfRow(head) : copy;
    const acceptedRef = accepted === undefined ? null : copyOfRow(accepted);
    let consumed: HpmCorrectionRow | null = null;
    let overwrite = { periodReopened: false, correctionApproved: false };
    if (accepted !== undefined && request.revision > accepted.revision && request.correctionId !== null) {
      const correction = await this.correctionFor(tx, request.correctionId);
      const matches = correction !== undefined && correction.layoutCode === request.layoutCode && correction.period === request.period && correction.fromRevision === accepted.revision;
      if (matches && (correction.state === 'APPROVED' || correction.state === 'PROPOSED')) {
        // A proposal that waits for its decision still says whether the period is reopened: what is missing is told as it is.
        overwrite = { periodReopened: (await input.reopen.status(tx, correction.periodReopenId, request.period, input.now)) === 'OPEN', correctionApproved: correction.state === 'APPROVED' };
        if (correction.state === 'APPROVED') consumed = correction;
      } else if (matches && correction.state === 'CONSUMED' && existing !== undefined && correction.consumedByPushId === existing.id) {
        // The push that consumed the correction is being retried: what was authorised once stays authorised for the same key.
        overwrite = { periodReopened: true, correctionApproved: true };
      }
    }
    const decision = decideHpmPush({
      intent,
      copy,
      head: headRef,
      accepted: acceptedRef,
      existing: existing === undefined ? null : { requestHash: existing.requestHash, status: existing.status, attempts: existing.attempts },
      requestHash,
      overwrite,
      maxAttempts: policy.params.max_attempts,
    });
    if (decision.action === 'ALREADY_DELIVERED') {
      const same = existing ?? accepted;
      if (same === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      await this.attach(tx, [same]);
      return { outcome: 'ALREADY_DELIVERED', before: same, row: same, consumed: null };
    }
    const row = existing ?? (await this.insert(tx, request, key, requestHash, input, decision.overwrites));
    if (consumed !== null && decision.overwrites) await this.consume(tx, consumed, row.id, input);
    else consumed = null;
    const before = existing ?? null;
    const delivered = await this.deliver(tx, row, request, key, requestHash, decision.attempt, input);
    return { outcome: delivered.status === 'WRITTEN' ? 'SENT' : 'FAILED', before, row: delivered, consumed };
  }

  private async insert(tx: TenantTx, request: HpmCopyRequest, key: string, requestHash: string, input: HpmSendInput, overwrites: boolean): Promise<HpmPushRow> {
    try {
      const rows = await tx.query<PushSql>(
        `with inserted as (
           insert into machvon.hpm_push (tenant_id, id, idempotency_key, org_unit_id, layout_code, period, revision, sha256, request_hash, file_object_key, snapshot_id, snapshot_revision, snapshot_cutoff,
             form_status, demo_mark, package_format, status, attempts, last_attempt_at, correction_id, overwrites, pushed_by, created_by, updated_by)
           values (${TENANT}, gen_random_uuid(), $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11::date, $12, $13, $14, 'PENDING', 1, $15::timestamptz, $16::uuid, $17, $18::uuid, $18::uuid, $18::uuid)
           returning *)
         ${PUSH_SELECT.replace('from machvon.hpm_push p', 'from inserted p')}`,
        [
          key,
          request.orgId,
          request.layoutCode,
          request.period,
          request.revision,
          request.sha256,
          requestHash,
          request.fileObjectKey,
          request.snapshot?.snapshotId ?? null,
          request.snapshot?.revision ?? null,
          request.snapshot?.cutoff ?? null,
          request.marks?.formStatus ?? null,
          request.marks?.demoMark ?? null,
          HPM_PACKAGE_FORMAT,
          input.now.toISOString(),
          request.correctionId,
          overwrites,
          input.actor,
        ],
      );
      return pushOf(rows[0] as PushSql);
    } catch (error) {
      // Two requests with the same key at once: the unique key lets one in, the other is the repeat it would have been.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('HPM_KEY_REUSED', 409, 'key');
      throw error;
    }
  }

  private async consume(tx: TenantTx, correction: HpmCorrectionRow, pushId: string, input: HpmSendInput): Promise<void> {
    await tx.query(
      `update machvon.hpm_correction set state = 'CONSUMED', consumed_by_push_id = $2::uuid, consumed_at = $3::timestamptz, version = version + 1, updated_at = $3::timestamptz, updated_by = $4::uuid where id = $1::uuid`,
      [correction.id, pushId, input.now.toISOString(), input.actor],
    );
  }

  private async deliver(tx: TenantTx, row: HpmPushRow, request: HpmCopyRequest, key: string, requestHash: string, attempt: number, input: HpmSendInput): Promise<HpmPushRow> {
    let errorCode: string | null = null;
    let response: Record<string, unknown> | null = null;
    try {
      const answer = await input.port.deliver({
        key,
        requestHash,
        tenantId: input.tenantId,
        attempt,
        copy: { orgId: request.orgId, layoutCode: request.layoutCode, period: request.period, revision: request.revision, sha256: request.sha256, snapshot: request.snapshot, marks: request.marks },
        fileName: input.fileName,
        bytes: input.bytes,
        sentAt: input.now,
      });
      response = { ...answer };
    } catch (error) {
      errorCode = deliveryErrorCodeOf(error);
    }
    const ok = errorCode === null;
    await tx.query(
      `insert into machvon.hpm_push_attempt (tenant_id, id, push_id, attempt_no, outcome, error_code, package_sha256, actor_id, attempted_at)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6::uuid, $7::timestamptz)`,
      [row.id, attempt, ok ? 'WRITTEN' : 'FAILED', errorCode, ok ? ((response as Record<string, unknown>).packageSha256 as string) : null, input.actor, input.now.toISOString()],
    );
    await tx.query(
      `update machvon.hpm_push set status = $2, attempts = $3, last_attempt_at = $4::timestamptz, last_error_code = $5, response = coalesce($6::jsonb, response), version = version + 1, updated_at = $4::timestamptz, updated_by = $7::uuid
        where id = $1::uuid`,
      [row.id, ok ? 'WRITTEN' : 'FAILED', attempt, input.now.toISOString(), errorCode, response === null ? null : JSON.stringify(response), input.actor],
    );
    const updated = (await this.find(tx, row.id)) as HpmPushRow;
    await this.attach(tx, [updated]);
    return updated;
  }

  /** Records the answer of the receiver: accepted or rejected, with its reference; the rules say who may and what it takes. */
  async recordReceipt(tx: TenantTx, id: string, expectedVersion: number, step: { outcome: unknown; reference: unknown; note: unknown }, actor: string, now: Date): Promise<{ before: HpmPushRow; row: HpmPushRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = hpmReceiptMove({ status: before.status, pushedBy: before.pushedBy, marks: before.marks }, { ...step, actorId: actor });
    await tx.query(
      `update machvon.hpm_push set status = $2, receipt_reference = $3, receipt_note = $4, receipt_by = $5::uuid, receipt_at = $6::timestamptz, version = version + 1, updated_at = $6::timestamptz, updated_by = $5::uuid
        where id = $1::uuid`,
      [id, decided.to, decided.reference, decided.note, actor, now.toISOString()],
    );
    const row = (await this.find(tx, id)) as HpmPushRow;
    await this.attach(tx, [row]);
    return { before, row };
  }

  /** The health of the push log against the rule `HPM_PUSH_POLICY`: the last delivery, the pushes that failed and the ones that wait for a receipt. */
  async health(tx: TenantTx, now: Date, enabled: boolean): Promise<{ health: HpmHealth; lastDeliveryAt: string | null; lastFailedAt: string | null; rule: { source: string; version: number; unverified: boolean; formula: string | null; sourceText: string | null; asOf: string | null; legalStatus: string | null; params: HpmPolicyParams } }> {
    const { params, rule } = await this.policyOf(tx, now);
    const [counts] = await tx.query<{ last_delivery: string | null; last_failed: string | null; failed: string; waiting: string }>(
      `select to_char(max(last_attempt_at) filter (where status in ('WRITTEN', 'ACCEPTED')) at time zone 'UTC', ${ISO}) as last_delivery,
              to_char(max(last_attempt_at) filter (where status = 'FAILED') at time zone 'UTC', ${ISO}) as last_failed,
              count(*) filter (where status = 'FAILED')::text as failed, count(*) filter (where status = 'WRITTEN')::text as waiting
         from machvon.hpm_push`,
    );
    const lastDeliveryAt = counts?.last_delivery ?? null;
    const health = hpmHealthOf({ lastDeliveryAt: lastDeliveryAt === null ? null : new Date(lastDeliveryAt), now, params, failedPushes: Number(counts?.failed ?? 0), awaitingReceipt: Number(counts?.waiting ?? 0), enabled });
    return {
      health,
      lastDeliveryAt,
      lastFailedAt: counts?.last_failed ?? null,
      rule: { source: rule.source, version: rule.version, unverified: rule.unverified, formula: rule.provenance?.formula ?? null, sourceText: rule.provenance?.source ?? null, asOf: rule.provenance?.asOf ?? null, legalStatus: rule.provenance?.legalStatus ?? null, params },
    };
  }

  /** How many pushes there are in each state, for the screen. */
  async counts(tx: TenantTx): Promise<{ pushes: number; written: number; accepted: number; failed: number; rejected: number }> {
    const [row] = await tx.query<{ pushes: string; written: string; accepted: string; failed: string; rejected: string }>(
      `select count(*)::text as pushes, count(*) filter (where status = 'WRITTEN')::text as written, count(*) filter (where status = 'ACCEPTED')::text as accepted,
              count(*) filter (where status = 'FAILED')::text as failed, count(*) filter (where status = 'REJECTED')::text as rejected from machvon.hpm_push`,
    );
    return { pushes: Number(row?.pushes ?? 0), written: Number(row?.written ?? 0), accepted: Number(row?.accepted ?? 0), failed: Number(row?.failed ?? 0), rejected: Number(row?.rejected ?? 0) };
  }

  /** The newest accepted copy of every series, for the screen: what HPM holds. */
  async acceptedSeries(tx: TenantTx, limit: number): Promise<Array<{ layoutCode: string; period: string; revision: number; acceptedAt: string | null }>> {
    const rows = await tx.query<{ layout_code: string; period: string; revision: number; accepted_at: string | null }>(
      `select distinct on (org_unit_id, layout_code, period) layout_code, period, revision, to_char(receipt_at at time zone 'UTC', ${ISO}) as accepted_at
         from machvon.hpm_push where status = 'ACCEPTED' order by org_unit_id, layout_code, period, revision desc limit $1`,
      [limit],
    );
    return rows.map((row) => ({ layoutCode: row.layout_code, period: row.period, revision: row.revision, acceptedAt: row.accepted_at }));
  }
}

// ---- the correction --------------------------------------------------------------------------------------------------------------------------------

export interface HpmCorrectionFilter {
  state?: HpmCorrectionState | undefined;
  layoutCode?: string | undefined;
  period?: string | undefined;
}

/** The corrections that let an accepted period be replaced: proposed by one person, decided by another, used once. */
export class HpmCorrectionStore {
  async find(tx: TenantTx, id: string, lock = false): Promise<HpmCorrectionRow | undefined> {
    const rows = await tx.query<CorrectionSql>(`${CORRECTION_SELECT} where c.id = $1::uuid${lock ? ' for update of c' : ''}`, [id]);
    return rows[0] === undefined ? undefined : correctionOf(rows[0]);
  }

  async list(tx: TenantTx, filter: HpmCorrectionFilter, request: { limit: number; after: { key: string; id: string } | undefined }): Promise<HpmCorrectionRow[]> {
    const rows = await tx.query<CorrectionSql>(
      `select * from (${CORRECTION_SELECT} where ($1::text is null or c.state = $1) and ($2::text is null or c.layout_code = $2) and ($3::text is null or c.period = $3)) x
        where ($4::text is null or (x.created_at_key, x.id) < ($4::text, $5::uuid)) order by x.created_at_key desc, x.id desc limit $6`,
      [filter.state ?? null, filter.layoutCode ?? null, filter.period ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(correctionOf);
  }

  /**
   * Proposes a correction: the revision it replaces must be one the receiver accepted (404 `RESOURCE_NOT_FOUND` otherwise: there is nothing to correct), and the reopening of the period it names must be in force now (409
   * `HPM_OVERWRITE_NOT_AUTHORISED`, `PERIOD_REOPENED` missing). One proposal at a time for a revision: another waits for the first to be decided (409 `HPM_CORRECTION_STATE_INVALID`).
   */
  async propose(tx: TenantTx, body: Readonly<Record<string, unknown>>, actor: string, now: Date, reopen: PeriodReopenPort): Promise<HpmCorrectionRow> {
    const request = hpmCorrectionRequestOf(body);
    const accepted = await tx.query<{ id: string }>(`select id from machvon.hpm_push where layout_code = $1 and period = $2 and revision = $3 and status = 'ACCEPTED' limit 1`, [request.layoutCode, request.period, request.fromRevision]);
    if (accepted[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'from_revision');
    if ((await reopen.status(tx, request.periodReopenId, request.period, now)) !== 'OPEN') throw new DomainError('HPM_OVERWRITE_NOT_AUTHORISED', 409, 'overwrite', { extensions: { missing: ['PERIOD_REOPENED'], accepted_revision: request.fromRevision } });
    try {
      const rows = await tx.query<CorrectionSql>(
        `with inserted as (
           insert into machvon.hpm_correction (tenant_id, id, layout_code, period, from_revision, period_reopen_id, reason, state, proposed_by, created_by, updated_by, created_at, updated_at)
           values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::uuid, $5, 'PROPOSED', $6::uuid, $6::uuid, $6::uuid, $7::timestamptz, $7::timestamptz) returning *)
         ${CORRECTION_SELECT.replace('from machvon.hpm_correction c', 'from inserted c')}`,
        [request.layoutCode, request.period, request.fromRevision, request.periodReopenId, request.reason, actor, now.toISOString()],
      );
      return correctionOf(rows[0] as CorrectionSql);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw new DomainError('HPM_CORRECTION_STATE_INVALID', 409, 'state');
      throw error;
    }
  }

  /** Approves or rejects a proposal: a stale version is 409 VERSION_CONFLICT; the rules say who may and that a reason is needed. An approval is judged against the reopening again: a window that ended meanwhile approves nothing. */
  async decide(tx: TenantTx, id: string, expectedVersion: number, step: { decision: unknown; reason: unknown }, actor: string, now: Date, reopen: PeriodReopenPort): Promise<{ before: HpmCorrectionRow; row: HpmCorrectionRow }> {
    const before = await this.find(tx, id, true);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw versionConflict(before.version);
    const decided = hpmCorrectionDecision(before, { ...step, actorId: actor });
    if (decided.to === 'APPROVED' && (await reopen.status(tx, before.periodReopenId, before.period, now)) !== 'OPEN') throw new DomainError('HPM_OVERWRITE_NOT_AUTHORISED', 409, 'overwrite', { extensions: { missing: ['PERIOD_REOPENED'], accepted_revision: before.fromRevision } });
    await tx.query(
      `update machvon.hpm_correction set state = $2, decided_by = $3::uuid, decided_at = $4::timestamptz, decision_reason = $5, version = version + 1, updated_at = $4::timestamptz, updated_by = $3::uuid where id = $1::uuid`,
      [id, decided.to, actor, now.toISOString(), decided.reason],
    );
    return { before, row: (await this.find(tx, id)) as HpmCorrectionRow };
  }
}

/** The request of a push, parsed from a body, with the default organisation (the tenant) when the body names none. */
export const hpmRequestOfBody = (body: Readonly<Record<string, unknown>>, defaultOrgId: string): HpmCopyRequest => hpmCopyRequestOf(body, defaultOrgId);
