import { DomainError, versionConflict } from '@machvon/kernel';
import { IssSlaDeadlines } from './iss-sla-deadline.ts';
import { IssIssueStore, toHeader } from './iss-issue-store.ts';
import type { IssueHeader, IssueScopes } from './iss-issue-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * How many times the deadline of an issue may be extended (ISS 3.1 step 7: 2 by default). The number is a working assumption of the tenant rules
 * (R-ISS-01, pending the rules of the pilot tenant); it lives here, once, and the database holds the shape of the rule (a counted extension), not the number.
 */
export const ISSUE_MAX_EXTENSIONS = 2;
/** How long a closed issue can be reopened (ISS 3.1 step 6: 30 days by default, a working assumption of the tenant rules, R-ISS-01). */
export const ISSUE_REOPEN_WINDOW_DAYS = 30;
/** The most documents one request for verification names. */
export const MAX_EVIDENCE_DOCUMENTS = 20;
const DAY_MS = 86_400_000;
const MINUTES_PER_HOUR = 60;
const MAX_TEXT = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function textOf(value: string, field: string): string {
  const text = value.trim();
  if (text === '' || text.length > MAX_TEXT || text.includes('\0')) throw invalid(field);
  return text;
}

export interface VerificationRequested extends IssueHeader {
  evidenceCount: number;
}

export interface ClosedIssue extends IssueHeader {
  verifierId: string;
  closedAt: string;
}

export interface ReopenedIssue extends IssueHeader {
  reopenCount: number;
  closedAt: string;
}

export interface ExtendedIssue extends IssueHeader {
  previousDueAt: string;
  extensionCount: number;
  /** The first day the issue was late, when this extension came after it (BR-ISS-04: an extension never hides it). */
  overdueSince: string | null;
}

interface PolicySql {
  require_evidence: boolean;
  resolve_hours: number;
  calendar_code: string;
}

interface DetailSql {
  closed_at: string | null;
  reopen_count: number;
  extension_count: number;
  overdue_since: string | null;
}

const iso = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The end of the life of an issue (ST-ISS-003, ISS 3.1 steps 4 to 7): the handler asks for a verification with evidence, a different person closes it,
 * a closed issue can be reopened within a window, and the deadline can be extended a bounded number of times by a person other than the handler.
 * The commands check state before version, so a command sent again under a new key after it succeeded is an invalid state (409), not a version
 * conflict; the database holds the same rules (V1063) whatever the application did.
 */
export class IssIssueClosure {
  private readonly issues: IssIssueStore;
  private readonly deadlines: IssSlaDeadlines;

  constructor(issues: IssIssueStore = new IssIssueStore(), deadlines: IssSlaDeadlines = new IssSlaDeadlines()) {
    this.issues = issues;
    this.deadlines = deadlines;
  }

  /** The handler declares the work done, with the result and the evidence the policy asks for (IN_PROGRESS to PENDING_VERIFICATION). */
  async requestVerification(
    tx: TenantTx,
    id: string,
    expectedVersion: number,
    input: { resultNote: string; evidenceDocumentVersionIds: readonly string[] },
    actor: string,
    scopes: IssueScopes,
    now: Date,
  ): Promise<VerificationRequested> {
    const locked = await this.issues.lock(tx, id, scopes);
    if (locked.status !== 'IN_PROGRESS') throw new DomainError('ISSUE_STATE_INVALID', 409);
    if (Number(locked.version) !== expectedVersion) throw versionConflict(Number(locked.version));
    // Only the person it was given to declares it done: the verification is of their work.
    if (locked.assignee_id !== actor) throw new DomainError('SCOPE_DENIED', 403);
    const resultNote = textOf(input.resultNote, 'result_note');
    const evidence = this.evidenceIds(input.evidenceDocumentVersionIds);
    const policy = await this.policyOf(tx, id);
    if (policy.require_evidence && evidence.length === 0) throw new DomainError('EVIDENCE_REQUIRED', 422);
    await this.assertClean(tx, evidence);
    await tx.query(
      `update machvon.issue set status = 'PENDING_VERIFICATION', resolved_at = $3::timestamptz, updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1
        where id = $1::uuid`,
      [id, actor, now.toISOString()],
    );
    await this.issues.record(tx, id, actor, {
      kind: 'VERIFICATION_REQUESTED',
      fromStatus: 'IN_PROGRESS',
      toStatus: 'PENDING_VERIFICATION',
      note: resultNote,
      documentVersionId: evidence[0] ?? null,
      payload: { evidence_document_version_ids: evidence },
    });
    return { ...toHeader(locked, { status: 'PENDING_VERIFICATION', version: Number(locked.version) + 1 }), evidenceCount: evidence.length };
  }

  /**
   * A person other than the one who worked the issue confirms the result and closes it (BR-ISS-05). The open escalations of the issue are resolved with
   * it. A refusal of the result is not a command of its own: the verifier gives the issue back with `assignIssue` and the reason.
   */
  async close(tx: TenantTx, id: string, expectedVersion: number, input: { verificationNote: string }, actor: string, scopes: IssueScopes, now: Date): Promise<ClosedIssue> {
    const locked = await this.issues.lock(tx, id, scopes);
    if (locked.status !== 'PENDING_VERIFICATION') throw new DomainError('ISSUE_STATE_INVALID', 409);
    if (Number(locked.version) !== expectedVersion) throw versionConflict(Number(locked.version));
    const note = textOf(input.verificationNote, 'verification_note');
    // The database keeps the verifier apart from the assignee whatever the policy says (issue_verifier_chk), so the answer is the same refusal
    // for every policy: the flag `require_independent_verifier` of the policy is kept and shown, and the rule it names is never switched off.
    if (locked.assignee_id === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const policy = await this.policyOf(tx, id);
    if (policy.require_evidence && (await this.requestedEvidence(tx, id)).length === 0) throw new DomainError('EVIDENCE_REQUIRED', 422);
    const closedAt = now.toISOString();
    await tx.query(
      `update machvon.issue set status = 'CLOSED', closed_at = $3::timestamptz, closed_by = $2::uuid, verifier_id = $2::uuid, updated_at = $3::timestamptz, updated_by = $2::uuid,
              version = version + 1 where id = $1::uuid`,
      [id, actor, closedAt],
    );
    // An escalation is a call for attention to an issue: with the issue closed there is nothing left to accept.
    await tx.query(
      `update machvon.issue_escalation set status = 'RESOLVED', updated_at = $2::timestamptz, updated_by = $3::uuid, version = version + 1
        where issue_id = $1::uuid and status in ('OPEN', 'ACCEPTED')`,
      [id, closedAt, actor],
    );
    await this.issues.record(tx, id, actor, { kind: 'CLOSED', fromStatus: 'PENDING_VERIFICATION', toStatus: 'CLOSED', note, payload: { verifier_id: actor, closed_at: closedAt } });
    return { ...toHeader(locked, { status: 'CLOSED', version: Number(locked.version) + 1 }), verifierId: actor, closedAt };
  }

  /**
   * Opens a closed issue again, with the reason, while the window lasts (CLOSED to REOPENED); the deadline and the days overdue stay what they were.
   * Its escalation begins again: the escalations of its first life were resolved when it was closed, and the job raises new ones if it is still late.
   */
  async reopen(tx: TenantTx, id: string, expectedVersion: number, input: { reason: string }, actor: string, scopes: IssueScopes, now: Date): Promise<ReopenedIssue> {
    const locked = await this.issues.lock(tx, id, scopes);
    if (locked.status !== 'CLOSED') throw new DomainError('ISSUE_STATE_INVALID', 409);
    if (Number(locked.version) !== expectedVersion) throw versionConflict(Number(locked.version));
    const reason = textOf(input.reason, 'reason');
    const detail = await this.detailOf(tx, id);
    const closedAt = detail.closed_at as string;
    if (now.getTime() > Date.parse(closedAt) + ISSUE_REOPEN_WINDOW_DAYS * DAY_MS) throw new DomainError('REOPEN_WINDOW_EXPIRED', 422);
    await tx.query(
      `update machvon.issue set status = 'REOPENED', reopen_count = reopen_count + 1, closed_at = null, closed_by = null, verifier_id = null, resolved_at = null,
              escalation_level = 0, escalated_at = null, escalated_task_force_id = null, updated_at = $3::timestamptz, updated_by = $2::uuid, version = version + 1 where id = $1::uuid`,
      [id, actor, now.toISOString()],
    );
    await this.issues.record(tx, id, actor, { kind: 'REOPENED', fromStatus: 'CLOSED', toStatus: 'REOPENED', note: reason, payload: { reopen_count: detail.reopen_count + 1, closed_at: closedAt } });
    return { ...toHeader(locked, { status: 'REOPENED', version: Number(locked.version) + 1 }), reopenCount: detail.reopen_count + 1, closedAt };
  }

  /**
   * Moves the deadline later (ISS 3.1 step 7), at most `ISSUE_MAX_EXTENSIONS` times, by a person other than the handler whose deadline it is, and by no
   * more than the resolution time of the policy of the issue counted on its working calendar. The day the issue became overdue is kept; when the old
   * deadline had already passed without the job having noticed, it is recorded now, so the extension cannot hide it (BR-ISS-04).
   */
  async extend(tx: TenantTx, id: string, expectedVersion: number, input: { newDueAt: string; reason: string }, actor: string, scopes: IssueScopes, now: Date): Promise<ExtendedIssue> {
    const locked = await this.issues.lock(tx, id, scopes);
    if (locked.status === 'CLOSED' || locked.status === 'PENDING_VERIFICATION') throw new DomainError('ISSUE_STATE_INVALID', 409);
    if (Number(locked.version) !== expectedVersion) throw versionConflict(Number(locked.version));
    const reason = textOf(input.reason, 'reason');
    // The handler's deadline is not theirs to extend: the one who asks and the one who grants are two people.
    if (locked.assignee_id === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    const detail = await this.detailOf(tx, id);
    if (detail.extension_count >= ISSUE_MAX_EXTENSIONS) throw new DomainError('EXTENSION_LIMIT_REACHED', 422);
    const newDueAt = new Date(input.newDueAt);
    const dueAt = Date.parse(locked.due_at);
    if (Number.isNaN(newDueAt.getTime()) || newDueAt.getTime() <= dueAt || newDueAt.getTime() <= now.getTime()) throw invalid('new_due_at');
    const policy = await this.policyOf(tx, id);
    const from = new Date(Math.max(dueAt, now.getTime()));
    const latest = await this.deadlines.addMinutes(tx, policy.calendar_code, from, policy.resolve_hours * MINUTES_PER_HOUR);
    if (newDueAt.getTime() > latest.getTime()) throw invalid('new_due_at');
    const rows = await tx.query<{ overdue_since: string | null }>(
      `update machvon.issue set due_at = $3::timestamptz, extension_count = extension_count + 1, overdue_since = coalesce(overdue_since, case when $4::timestamptz > due_at then due_at end),
              updated_at = $4::timestamptz, updated_by = $2::uuid, version = version + 1 where id = $1::uuid returning ${iso('overdue_since')} as overdue_since`,
      [id, actor, newDueAt.toISOString(), now.toISOString()],
    );
    const extensionCount = detail.extension_count + 1;
    await this.issues.record(tx, id, actor, {
      kind: 'EXTENDED',
      fromStatus: locked.status,
      toStatus: locked.status,
      note: reason,
      payload: { previous_due_at: locked.due_at, new_due_at: newDueAt.toISOString(), extension_number: extensionCount, extension_limit: ISSUE_MAX_EXTENSIONS },
    });
    return {
      ...toHeader(locked, { dueAt: newDueAt.toISOString(), version: Number(locked.version) + 1 }),
      previousDueAt: locked.due_at,
      extensionCount,
      overdueSince: rows[0]?.overdue_since ?? null,
    };
  }

  /** The number of extensions an issue has had and the limit, for the screen that offers the next one. */
  async extensionsOf(tx: TenantTx, id: string): Promise<{ used: number; limit: number }> {
    const detail = await this.detailOf(tx, id);
    return { used: detail.extension_count, limit: ISSUE_MAX_EXTENSIONS };
  }

  private evidenceIds(ids: readonly string[]): string[] {
    if (ids.length > MAX_EVIDENCE_DOCUMENTS) throw invalid('evidence_document_version_ids');
    const lower = ids.map((candidate) => {
      if (!UUID.test(candidate)) throw invalid('evidence_document_version_ids');
      return candidate.toLowerCase();
    });
    return [...new Set(lower)];
  }

  /** The evidence must be documents of the tenant that have been scanned clean: a file nobody has checked is not evidence. */
  private async assertClean(tx: TenantTx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx.query<{ id: string; scan_status: string }>('select id, scan_status from machvon.document_version where id = any($1::uuid[])', [ids]);
    if (rows.length !== ids.length) throw invalid('evidence_document_version_ids');
    if (rows.some((row) => row.scan_status !== 'CLEAN')) throw new DomainError('DOCUMENT_NOT_CLEAN', 422);
  }

  private async policyOf(tx: TenantTx, issueId: string): Promise<PolicySql> {
    const rows = await tx.query<PolicySql>(
      `select p.require_evidence, p.resolve_hours, p.calendar_code
         from machvon.issue i join machvon.issue_sla_policy p on p.tenant_id = i.tenant_id and p.id = i.sla_policy_id where i.id = $1::uuid`,
      [issueId],
    );
    return rows[0] as PolicySql;
  }

  private async detailOf(tx: TenantTx, issueId: string): Promise<DetailSql> {
    const rows = await tx.query<DetailSql>(
      `select ${iso('closed_at')} as closed_at, reopen_count, extension_count, ${iso('overdue_since')} as overdue_since from machvon.issue where id = $1::uuid`,
      [issueId],
    );
    return rows[0] as DetailSql;
  }

  /** The evidence the latest request for verification named. */
  private async requestedEvidence(tx: TenantTx, issueId: string): Promise<string[]> {
    const rows = await tx.query<{ payload: { evidence_document_version_ids?: unknown } }>(
      `select payload from machvon.issue_event where issue_id = $1::uuid and event_kind = 'VERIFICATION_REQUESTED' order by created_at desc, id desc limit 1`,
      [issueId],
    );
    const evidence = rows[0]?.payload.evidence_document_version_ids;
    return Array.isArray(evidence) ? (evidence as string[]) : [];
  }
}
