import { DomainError, assertAcceptable, assertDeliverable, canonicalJson, countsAsAcceptedCopy, hasControlChar, hasControlCharExceptWhitespace, issueKeyOf, sha256Hex } from '@machvon/kernel';
import type { IssuedCopyMarks, IssuedCopyRef } from '@machvon/kernel';

/**
 * The push of an issued report to HPM, the reporting platform of the customer (ENT-2, eng-review R8, R17, R18). The technical interface of HPM is unknown, so everything here is PENDING-EXTERNAL: the adapter behind
 * `HpmPort` writes a delivery package to a file and never calls the network; a delivery counts as accepted only when a person records the receipt of HPM, and a copy made on a DEMO form is never accepted (R18).
 * This module is the pure rules; the ledger that keeps them true lives in `hpm-store.ts`.
 */

export const HPM_CONNECTOR_CODE = 'hpm.reports';
/** The version of the delivery package the file writer produces: a working assumption until HPM publishes its interface. */
export const HPM_PACKAGE_FORMAT = 'HPM-FILE-WORKING-ASSUMPTION-2026.1';
export const HPM_PACKAGE_FORMATS: readonly string[] = [HPM_PACKAGE_FORMAT];
/** The adapter is a substitute (a file), so the verdict on the connector is PROPOSED and never VERIFIED. */
export const HPM_ADAPTER_STATUS = 'PROPOSED' as const;
export const HPM_MIN_REASON = 10;
export const HPM_MAX_REASON = 2000;
export const HPM_MAX_REFERENCE = 200;

export type HpmAcceptance = 'PENDING_EXTERNAL' | 'ACCEPTABLE';

/** Whether what rests on this package format can be accepted: a working assumption cannot (R18); the recipient has to confirm the interface first. */
export function hpmAcceptance(packageFormat: string): HpmAcceptance {
  return packageFormat.includes('WORKING-ASSUMPTION') ? 'PENDING_EXTERNAL' : 'ACCEPTABLE';
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A reason or a note as it is kept: trimmed, at least `min` characters, no control character other than whitespace. */
export function hpmReasonOf(value: unknown, field = 'reason', min: number = HPM_MIN_REASON): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text.length < min || text.length > HPM_MAX_REASON || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

/** A short reference (the number HPM gave a receipt, a ticket): one line, no control character. */
export function hpmReferenceOf(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text === '' || text.length > HPM_MAX_REFERENCE || hasControlChar(text)) throw invalid(field);
  return text;
}

// ---- the connection ------------------------------------------------------------------------------------------------------------------------------

/** Switching the connection off or on: both need a reason and a move to the state it is already in is refused, so that an audit row always means a change. */
export function hpmConnectionMove(current: { enabled: boolean }, target: { enabled: unknown; reason: unknown }): { enabled: boolean; reason: string } {
  if (typeof target.enabled !== 'boolean') throw invalid('enabled');
  if (target.enabled === current.enabled) throw invalid('enabled');
  return { enabled: target.enabled, reason: hpmReasonOf(target.reason) };
}

/** A push needs the connection on (409 `HPM_CONNECTION_DISABLED`). */
export function assertHpmPushAllowed(connection: { enabled: boolean }): void {
  if (!connection.enabled) throw new DomainError('HPM_CONNECTION_DISABLED', 409, 'connection');
}

// ---- the copy and its key ------------------------------------------------------------------------------------------------------------------------

const SHA256 = /^[0-9a-f]{64}$/;
const LAYOUT_CODE = /^[A-Z][A-Z0-9_-]{1,59}$/;
/** The period of a report as `periodCode` of the kernel writes it: `2026-M10`, `2026-Q3`, `2026-H1`, `2026` or a day. */
const PERIOD = /^(\d{4})(?:-(?:M(0[1-9]|1[0-2])|Q[1-4]|H[12]|(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])))?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isHpmPeriod = (value: unknown): value is string => typeof value === 'string' && PERIOD.test(value);

/** What a person (or the issued-report source of RPT-1) says about the report to push. The bytes are the file in the object store whose hash is `sha256`. */
export interface HpmCopyRequest {
  orgId: string;
  layoutCode: string;
  period: string;
  revision: number;
  sha256: string;
  fileObjectKey: string;
  /** The snapshot the copy was made from, with its revision and the common cut-off day (R17); null when the copy has none. */
  snapshot: { snapshotId: string; revision: number; cutoff: string } | null;
  /** The marks of the form the copy was made on; absent for an official form. */
  marks: IssuedCopyMarks | null;
  /** The approved correction that lets this revision replace an accepted one, when it does. */
  correctionId: string | null;
}

const object = (value: unknown): Readonly<Record<string, unknown>> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : {});

/** The request of a push, judged field by field (422 `VALIDATION_FAILED` naming the field). */
export function hpmCopyRequestOf(body: Readonly<Record<string, unknown>>, defaultOrgId: string): HpmCopyRequest {
  const text = (value: unknown, field: string, shape: RegExp, optional = false): string | null => {
    if (value === undefined || value === null) {
      if (optional) return null;
      throw invalid(field);
    }
    if (typeof value !== 'string' || !shape.test(value)) throw invalid(field);
    return value;
  };
  const orgId = text(body.org_unit_id, 'org_unit_id', UUID, true)?.toLowerCase() ?? defaultOrgId.toLowerCase();
  const layoutCode = text(body.layout_code, 'layout_code', LAYOUT_CODE) as string;
  const period = text(body.period, 'period', PERIOD) as string;
  const revision = body.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1 || revision > 10_000) throw invalid('revision');
  const sha256 = text(body.sha256, 'sha256', SHA256) as string;
  const key = body.file_object_key;
  if (typeof key !== 'string' || key.trim() === '' || key.length > 500 || hasControlChar(key)) throw invalid('file_object_key');
  const snapshotBody = body.snapshot === undefined || body.snapshot === null ? null : object(body.snapshot);
  let snapshot: HpmCopyRequest['snapshot'] = null;
  if (snapshotBody !== null) {
    const snapshotId = text(snapshotBody.snapshot_id, 'snapshot.snapshot_id', UUID) as string;
    const snapshotRevision = snapshotBody.revision;
    if (typeof snapshotRevision !== 'number' || !Number.isInteger(snapshotRevision) || snapshotRevision < 1) throw invalid('snapshot.revision');
    const cutoff = text(snapshotBody.cutoff, 'snapshot.cutoff', /^\d{4}-\d{2}-\d{2}$/) as string;
    snapshot = { snapshotId: snapshotId.toLowerCase(), revision: snapshotRevision, cutoff };
  }
  const marksBody = body.marks === undefined || body.marks === null ? null : object(body.marks);
  let marks: IssuedCopyMarks | null = null;
  if (marksBody !== null) {
    const status = marksBody.form_status;
    if (status !== 'DEMO' && status !== 'READY' && status !== 'DRAFT' && status !== 'PENDING_EXTERNAL') throw invalid('marks.form_status');
    const demoMark = marksBody.demo_mark;
    if (demoMark !== undefined && demoMark !== null && (typeof demoMark !== 'string' || demoMark.length > 200 || hasControlChar(demoMark))) throw invalid('marks.demo_mark');
    marks = { formStatus: status, demoMark: typeof demoMark === 'string' ? demoMark : null };
  }
  const correctionId = text(body.correction_id, 'correction_id', UUID, true)?.toLowerCase() ?? null;
  return { orgId, layoutCode, period, revision, sha256, fileObjectKey: key.trim(), snapshot, marks, correctionId };
}

/** The copy as the kernel judges it. The id is the key of the push, so a copy and its ledger entry are the same thing. */
export function copyRefOf(request: HpmCopyRequest, id: string, supersedes: string | null): IssuedCopyRef {
  return {
    id,
    orgId: request.orgId,
    layoutCode: request.layoutCode,
    layoutVersion: '',
    period: request.period,
    revision: request.revision,
    supersedes,
    sha256: request.sha256,
    snapshot: request.snapshot === null ? null : { snapshotId: request.snapshot.snapshotId, revision: request.snapshot.revision, cutoff: request.snapshot.cutoff },
    ...(request.marks === null ? {} : { marks: request.marks }),
  };
}

/** The idempotency key of a push: organisation, layout, period and revision of the report (the tenant is the row-level scope of the ledger). It never changes for the same revision, however often the push is repeated. */
export const hpmKeyOf = (request: Pick<HpmCopyRequest, 'orgId' | 'layoutCode' | 'period' | 'revision'>): string => issueKeyOf(request);

/** The hash of what the push asks for: a repeat of the same key with other content is a different request, and refused. */
export function hpmRequestHash(request: HpmCopyRequest): string {
  return sha256Hex(
    canonicalJson({
      org: request.orgId,
      layout: request.layoutCode,
      period: request.period,
      revision: request.revision,
      sha256: request.sha256,
      snapshot: request.snapshot,
      demo: request.marks?.formStatus === 'DEMO',
    }),
  );
}

// ---- the push ledger -----------------------------------------------------------------------------------------------------------------------------

export const HPM_PUSH_STATES = ['PENDING', 'WRITTEN', 'FAILED', 'ACCEPTED', 'REJECTED'] as const;
export type HpmPushState = (typeof HPM_PUSH_STATES)[number];

/** The ledger entry of a key as the rules read it. */
export interface HpmLedgerEntry {
  requestHash: string;
  status: HpmPushState;
  attempts: number;
}

export interface HpmPushContext {
  intent: 'SUBMIT' | 'RETRY';
  copy: IssuedCopyRef;
  /** The newest copy of the series that exists (issued, or asked to be pushed): a copy that is not it is stale. */
  head: IssuedCopyRef;
  /** The copy of the series the receiver last accepted (a recorded receipt), or null. */
  accepted: IssuedCopyRef | null;
  existing: HpmLedgerEntry | null;
  requestHash: string;
  /** Whether the period is reopened (an approved reopening whose window is open) and an approved, unused correction names this revision: both are needed to replace an accepted copy. */
  overwrite: { periodReopened: boolean; correctionApproved: boolean };
  maxAttempts: number;
}

export type HpmDecision =
  /** The package is to be written now: `attempt` is the number of this try (1 for a first push, more for a re-send of the same key). */
  | { action: 'SEND'; attempt: number; overwrites: boolean }
  /** Nothing is written: the receiver already holds these bytes, or the package was written and waits for the receipt. */
  | { action: 'ALREADY_DELIVERED' };

/**
 * What a push does (R8, R17). In this order:
 *  1. the key was seen: another content under the same key is `HPM_KEY_REUSED`; one the receiver rejected is `HPM_PUSH_STATE_INVALID` (a correction is a new revision, never the same key again);
 *  2. the kernel rule of delivery: a copy older than the newest copy of the series, or older than what the receiver accepted, is `REPORT_OUT_OF_DATE` (409, with the current revision), a package that was replaced included;
 *     then a push the receiver accepted or that was written is `ALREADY_DELIVERED` (a retry of a written package re-sends the same key), as are the same bytes as the accepted copy; a failed one is re-sent with the next attempt number, up to the cap (`HPM_RETRY_EXHAUSTED`);
 *  3. replacing an accepted period (a newer revision than the accepted one) needs a reopened period and an approved correction, else `HPM_OVERWRITE_NOT_AUTHORISED` naming what is missing.
 */
export function decideHpmPush(context: HpmPushContext): HpmDecision {
  const { existing } = context;
  if (existing !== null) {
    if (existing.requestHash !== context.requestHash) throw new DomainError('HPM_KEY_REUSED', 409, 'key');
    if (existing.status === 'REJECTED') throw new DomainError('HPM_PUSH_STATE_INVALID', 409, 'status');
  }
  // Staleness is judged before a repeat is answered: a package of a revision that a newer one replaced is refused whatever its own state is.
  const verdict = assertDeliverable(context.copy, context.head, context.accepted);
  if (existing !== null && (existing.status === 'ACCEPTED' || (existing.status === 'WRITTEN' && context.intent === 'SUBMIT'))) return { action: 'ALREADY_DELIVERED' };
  if (verdict === 'ALREADY_DELIVERED') return { action: 'ALREADY_DELIVERED' };
  if (existing !== null && existing.attempts >= context.maxAttempts && existing.status === 'FAILED') throw new DomainError('HPM_RETRY_EXHAUSTED', 409, 'attempts');
  const accepted = context.accepted !== null && countsAsAcceptedCopy(context.accepted) ? context.accepted : null;
  const overwrites = accepted !== null && context.copy.revision > accepted.revision;
  if (overwrites && !(context.overwrite.periodReopened && context.overwrite.correctionApproved)) {
    const missing = [...(context.overwrite.periodReopened ? [] : ['PERIOD_REOPENED']), ...(context.overwrite.correctionApproved ? [] : ['APPROVED_CORRECTION'])];
    throw new DomainError('HPM_OVERWRITE_NOT_AUTHORISED', 409, 'overwrite', { extensions: { missing, accepted_revision: (accepted as IssuedCopyRef).revision } });
  }
  return { action: 'SEND', attempt: (existing?.attempts ?? 0) + 1, overwrites };
}

/**
 * The receipt of the receiver: the person who pushed does not record the receipt (403 `SELF_APPROVAL_DENIED`), only a package that was written and awaits it takes one (409 `HPM_PUSH_STATE_INVALID`),
 * a rejection needs a note, and a copy made on a DEMO form is never recorded as accepted (`TEMPLATE_UNCONFIRMED`, R18).
 */
export function hpmReceiptMove(push: { status: HpmPushState; pushedBy: string; marks: IssuedCopyMarks | null }, step: { outcome: unknown; actorId: string; reference: unknown; note: unknown }): { to: 'ACCEPTED' | 'REJECTED'; reference: string; note: string | null } {
  if (step.outcome !== 'ACCEPTED' && step.outcome !== 'REJECTED') throw invalid('outcome');
  if (push.status !== 'WRITTEN') throw new DomainError('HPM_PUSH_STATE_INVALID', 409, 'status');
  if (push.pushedBy === step.actorId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  const reference = hpmReferenceOf(step.reference, 'reference');
  if (step.outcome === 'ACCEPTED') {
    assertAcceptable({ marks: push.marks ?? undefined });
    const note = step.note === undefined || step.note === null || step.note === '' ? null : hpmReasonOf(step.note, 'note', 1);
    return { to: 'ACCEPTED', reference, note };
  }
  return { to: 'REJECTED', reference, note: hpmReasonOf(step.note, 'note') };
}

// ---- the correction that lets an accepted period be replaced ------------------------------------------------------------------------------------------

export const HPM_CORRECTION_STATES = ['PROPOSED', 'APPROVED', 'REJECTED', 'CONSUMED'] as const;
export type HpmCorrectionState = (typeof HPM_CORRECTION_STATES)[number];

export interface HpmCorrectionRequest {
  layoutCode: string;
  period: string;
  /** The accepted revision the correction replaces. */
  fromRevision: number;
  periodReopenId: string;
  reason: string;
}

/** The proposal of a correction, judged field by field. The reopening is the approved request of DIS to reopen the period; the store checks it is approved and open. */
export function hpmCorrectionRequestOf(body: Readonly<Record<string, unknown>>): HpmCorrectionRequest {
  const layoutCode = body.layout_code;
  const period = body.period;
  const fromRevision = body.from_revision;
  const reopen = body.period_reopen_id;
  if (typeof layoutCode !== 'string' || !LAYOUT_CODE.test(layoutCode)) throw invalid('layout_code');
  if (!isHpmPeriod(period)) throw invalid('period');
  if (typeof fromRevision !== 'number' || !Number.isInteger(fromRevision) || fromRevision < 1 || fromRevision > 10_000) throw invalid('from_revision');
  if (typeof reopen !== 'string' || !UUID.test(reopen)) throw invalid('period_reopen_id');
  return { layoutCode, period, fromRevision, periodReopenId: reopen.toLowerCase(), reason: hpmReasonOf(body.reason) };
}

/** A decision on a correction: only a proposed one is decided (409 `HPM_CORRECTION_STATE_INVALID`), never by the person who proposed it (403 `SELF_APPROVAL_DENIED`), and always with a reason. */
export function hpmCorrectionDecision(correction: { state: HpmCorrectionState; proposedBy: string }, step: { decision: unknown; actorId: string; reason: unknown }): { to: 'APPROVED' | 'REJECTED'; reason: string } {
  if (step.decision !== 'APPROVE' && step.decision !== 'REJECT') throw invalid('decision');
  if (correction.state !== 'PROPOSED') throw new DomainError('HPM_CORRECTION_STATE_INVALID', 409, 'state');
  if (correction.proposedBy === step.actorId) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'actor');
  return { to: step.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', reason: hpmReasonOf(step.reason) };
}

// ---- health: the push log against the rule HPM_PUSH_POLICY -----------------------------------------------------------------------------------------

/** The numbers of `HPM_PUSH_POLICY`: the tries before a push stops being retried, and the age of the last good delivery that is called aging and stale. */
export interface HpmPolicyParams {
  max_attempts: number;
  warn_after_hours: number;
  max_age_hours: number;
  stale_severity: 'URGENT' | 'ACTION' | 'WATCH';
}

export type HpmHealthStatus = 'NEVER_PUSHED' | 'FRESH' | 'AGING' | 'STALE';

export type HpmAlertCode = 'HPM_PUSH_FAILED' | 'HPM_PUSH_STALE';
export const HPM_ALERT_CODES: readonly HpmAlertCode[] = ['HPM_PUSH_FAILED', 'HPM_PUSH_STALE'];

export interface HpmHealth {
  status: HpmHealthStatus;
  /** Hours since the last delivery the receiver accepted (or, with none yet, since the last package was written), or null when nothing was ever pushed. */
  ageHours: number | null;
  failedPushes: number;
  awaitingReceipt: number;
  acceptance: HpmAcceptance;
  alert: { code: HpmAlertCode; severity: 'URGENT' | 'ACTION' | 'WATCH' } | null;
}

/**
 * The health of the push log (BID-22 style, ENT-2): a failed push that nobody retried is an alert of its own (`HPM_PUSH_FAILED`); a last delivery older than `max_age_hours` is `HPM_PUSH_STALE` at the severity of the rule.
 * A tenant that never pushed is not nagged, and a connection switched off with a reason is not either: it chose to stop. The result always carries PENDING_EXTERNAL while the adapter is the file writer.
 */
export function hpmHealthOf(input: { lastDeliveryAt: Date | null; now: Date; params: HpmPolicyParams; failedPushes: number; awaitingReceipt: number; enabled: boolean; packageFormat?: string }): HpmHealth {
  const acceptance = hpmAcceptance(input.packageFormat ?? HPM_PACKAGE_FORMAT);
  const base = { failedPushes: input.failedPushes, awaitingReceipt: input.awaitingReceipt, acceptance };
  if (input.lastDeliveryAt === null) {
    return { status: 'NEVER_PUSHED', ageHours: null, ...base, alert: input.enabled && input.failedPushes > 0 ? { code: 'HPM_PUSH_FAILED', severity: input.params.stale_severity } : null };
  }
  const ageHours = Math.max(0, (input.now.getTime() - input.lastDeliveryAt.getTime()) / 3_600_000);
  const status: HpmHealthStatus = ageHours > input.params.max_age_hours ? 'STALE' : ageHours > input.params.warn_after_hours ? 'AGING' : 'FRESH';
  const alert = !input.enabled ? null : input.failedPushes > 0 ? { code: 'HPM_PUSH_FAILED' as const, severity: input.params.stale_severity } : status === 'STALE' ? { code: 'HPM_PUSH_STALE' as const, severity: input.params.stale_severity } : null;
  return { status, ageHours, ...base, alert };
}

/** The rule number as the application reads it: a malformed rule is a defect of the rule registry, never of the request. */
export function hpmPolicyParamsOf(params: Readonly<Record<string, unknown>>): HpmPolicyParams {
  const int = (name: string): number => {
    const value = params[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`HPM_PUSH_POLICY: ${name} must be a positive integer`);
    return value;
  };
  const severity = params.stale_severity;
  if (severity !== 'URGENT' && severity !== 'ACTION' && severity !== 'WATCH') throw new Error('HPM_PUSH_POLICY: stale_severity is not a severity');
  return { max_attempts: int('max_attempts'), warn_after_hours: int('warn_after_hours'), max_age_hours: int('max_age_hours'), stale_severity: severity };
}
