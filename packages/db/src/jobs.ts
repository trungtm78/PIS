import { WORKER_MEMBERSHIP_ID } from './consumer-inbox.ts';
import { APPROVAL_OPEN_GAUGE, APPROVAL_OVERDUE_GAUGE } from './approval-sla-job.ts';
import { DELEGATION_ACTIVE_GAUGE } from './delegation-store.ts';
import type { DelegationPassResult } from './delegation-store.ts';
import { SUPPORT_ACCESS_ACTIVE_GAUGE } from './support-access-store.ts';
import type { SupportPassResult } from './support-access-store.ts';
import type { SlaSweepResult } from './approval-store.ts';
import { DGV_NOT_ASSESSED_GAUGE } from './dgv-quality-run-job.ts';
import type { AuditSealJob } from './audit-seal-job.ts';
import type { ControlDatabase } from './control-database.ts';
import { PLATFORM_TENANT_ID } from './control-database.ts';
import type { IdempotencyStore } from './idempotency-store.ts';
import type { JobHandler } from './job-runner.ts';
import { OPEN_ISSUES_GAUGE, PENDING_ESCALATIONS_GAUGE } from './iss-sla-job.ts';
import type { SlaPassResult } from './iss-sla-job.ts';
import { SLA_SEVERITIES } from './iss-sla-policy-store.ts';
import { RETENTION_PENDING_GAUGE } from './retention-job.ts';
import { PAYMENT_UNMATCHED_GAUGE } from './billing-payment-store.ts';
import { EINVOICE_FAILED_GAUGE } from './billing-store.ts';
import { REORGANIZATION_FAILED_GAUGE } from './unit-reorganization-store.ts';
import { NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';

/** The scheduled jobs of the platform (ADM section 9: seal every 5 minutes, verify and purge hourly, the cache every minute). */
export const JOB_INTERVAL_SECONDS = {
  'audit-seal': 300,
  'audit-verify': 3600,
  'outbox-relay': 5,
  'idempotency-purge': 3600,
  'certificate-expiry': 86400,
  // Hourly, so a version whose date has come is in force within the hour; the pass is idempotent.
  'master-activation': 3600,
  // Every six hours: a baseline that the platform publishes reaches a tenant within the shift; the pass is idempotent.
  'master-baseline-sync': 21600,
  // Every 15 minutes: a period is soft closed within a quarter of an hour after its deadline; the pass is idempotent (ST-DIS-001).
  'dis-period-autoclose': 900,
  // Every 5 minutes: the end of a reopening window is stored (EXPIRED) and audited within 5 minutes of its last instant. The rule itself never waits for this run: the submit guard and the reads judge the window by the clock (ST-DIS-002); the pass is idempotent.
  'dis-reopen-expiry': 300,
  // Hourly tick that works only in the 01:00 hour of Vietnam time, so the retention run happens once a night at a fixed hour wherever the process started (ST-ADM-017).
  'retention-purge': 3600,
  // Hourly tick that works only in the 06:00 hour of Vietnam time, so the guarantee reminders and expiries run once a morning wherever the process started; the pass is idempotent (ST-CTR-003).
  'guarantee-expiry': 3600,
  // Hourly tick that works only in the 06:00 hour of Vietnam time, so the reminders of the earliest day of a hold of retention run once a morning wherever the process started; the pass is idempotent (ST-CTR-010).
  'retention-due': 3600,
  // Hourly: a revision of a contract whose first day has come takes over from the one in force within the hour of midnight in Vietnam (the spec says 00:05; the pass is idempotent and also makes good a missed night, ST-CTR-007).
  'revision-effective': 3600,
  // Hourly: a petition of a contractor that waits past the last day of its deadline is found, and its reminder sent once, within the hour of midnight in Vietnam; the pass is idempotent (ST-BID-007).
  'petition-due': 3600,
  // Hourly tick that works only in the 06:00 hour of Vietnam time, so the permit reminders and expiries run once a morning wherever the process started; the pass is idempotent (ST-PMT-006).
  'permit-expiry': 3600,
  // Hourly tick that works only in the 00:00 hour of Vietnam time, so the waivers of the permit gates whose last day has passed are ended once a night; the pass is idempotent.
  'gate-waiver-expiry': 3600,
  // Every minute: an event of the integration inbox waits at most a minute after its time has come (1, 5, 30 minutes between attempts, ST-ADM-018); the pass is idempotent.
  // Every 15 minutes: an issue that reaches 100 or 150 percent of its SLA is escalated within a quarter of an hour; the pass is idempotent (ST-ISS-004).
  'issue-sla': 900,
  // Every minute: a reorganisation of organisation units that is being applied and whose day has come is carried out, a step at a time (ST-ADM-015); the pass is idempotent.
  'unit-reorganization': 60,
  // Every minute: a delegation whose first instant has come is put in force, one whose window ended or whose delegator lost the authority it passed on is Ended (ST-ADM-014); the pass is idempotent.
  'delegation-lifecycle': 60,
  // Every minute: an approved support access grant whose first instant has come is put in force, one whose window ended is Expired and a request nobody decided on within a week lapses (ST-SAS-015); the pass is idempotent.
  'support-access-lifecycle': 60,
  // Every 5 minutes: an approval task is reminded at 80 percent of the working time to its deadline and dealt with at the deadline as its step says (ST-ADM-013); the pass is idempotent.
  'approval-sla': 300,
  'integration-inbox': 60,
  // Every 5 seconds, like the outbox relay: a retry on the schedule of 30 seconds is taken up within seconds of its time (ST-NOT-002, BR-NOT-03); the pass is idempotent.
  'notification-dispatch': 5,
  // Every 5 minutes: a send whose result was lost is found, and an Unknown one is asked about at its provider for a day (BR-NOT-04).
  'notification-reconcile': 300,
  // Every 10 seconds: a requested quality run is executed within seconds of its request; a run is executed once, whoever asks and however often (ST-DGV-002).
  'dgv-quality-run': 10,
  // Hourly: a trial that has ended, a plan that waited for its day and a billing period that has passed are dealt with within the hour (ST-SAS-008); the pass is idempotent.
  'subscription-cycle': 3600,
  // Every 5 minutes: the invoices of the periods that closed are made, a provider that did not answer is asked again (10 minutes after the first failure, then 1, 4 and 12 hours, five attempts in 24 hours), and an invoice past its due day is Overdue (ST-SAS-011); the pass is idempotent.
  'einvoice-billing': 300,
  // Every minute: a payment that came in and waits is matched with the invoice its note names when the amount is exactly what is outstanding, or sent to review (ST-SAS-012); the pass is idempotent.
  'payment-reconciliation': 60,
  // Hourly: a request to carry capital over that nobody decided lapses within the hour of its last day (ST-CAP-007); the pass is idempotent.
  'allocation-extension-lapse': 3600,
  // Every 15 minutes: a fiscal year whose reopening has ended is locked again and the capital that came back lapses again (ST-CAP-008); the pass is idempotent.
  'fiscal-year-relock': 900,
  // Every minute: an entitlement override whose window has ended stops counting and the tenant is told within the minute (ST-SAS-009, "takes effect within 60 seconds"); the pass is idempotent.
  'entitlement-override-expiry': 60,
  // Every minute: a license moves Issued -> Active -> Grace -> Expired at its boundaries by the clock of the server, one event for each move (ST-SAS-003); the pass is idempotent.
  'license-status': 60,
  // Hourly: an invitation nobody accepted before its day runs out, with its membership, so the seat and the address are free again (ST-ADM-006); the pass is idempotent.
  'membership-invitation-expiry': 3600,
  // Hourly: a stage of land clearance whose planned end has passed becomes late within the hour and asks ISS for its issue (ST-LND-010); the pass is idempotent.
  'land-stage-late': 3600,
  // Every 15 minutes: a request for an explanation that was asked or returned and is past its due moment becomes overdue within the quarter of an hour (ST-PRJ-006); the pass is idempotent.
  'prj-explanation-overdue': 900,
  // Hourly: an export package of a monitoring report that nobody filed within 90 days is expired, once (ST-MNE-004); the pass is idempotent.
  'mne-package-expiry': 3600,
  // Every 15 minutes: an approved transfer of a project between units whose day has come (by the date in Vietnam) is made within the quarter of an hour of the day starting (ST-PRJ-007); the pass is idempotent.
  'prj-transfer-apply': 900,
  // Hourly: a letter that is assigned or being processed and whose deadline has passed on a working day is marked overdue, once, and the handler is told (ST-DOC-011, BR-DOC-18); the pass is idempotent.
  'incoming-overdue': 3600,
  // Every 15 minutes: an incident of data quality past its due time is marked and its owner told once, and a waiver that has ended is followed by an open exception within the quarter of an hour (ST-DGV-003); the pass is idempotent.
  'dgv-incident-sweep': 900,
  // Hourly: an item of difference that still waits and is past its day is reported within the hour, once, and asks ISS for its issue (ST-PAY-007); the pass is idempotent.
  'reconciliation-overdue': 3600,
  // Hourly tick that works only in the 06:00 hour of Vietnam time, so the reminders of the verification deadline of a settlement go once a morning wherever the process started; the pass is idempotent (ST-PAY-009).
  'settlement-deadline': 3600,
  // Hourly tick that works only in the 02:00 hour of Vietnam time, so the balances of capital are compared with their ledger once a night wherever the process started; nothing is changed by it (ST-CAP-006).
  'capital-balance-reconcile': 3600,
  // Hourly tick that works only in the 02:00 hour of Vietnam time, so the recovered amount of each recommendation of AUD is compared with its ledger once a night wherever the process started; nothing is changed by it (ST-AUD-004).
  'aud-recovery-reconcile': 3600,
  // Every 5 minutes: the old key of a rotation is revoked at the end of its last day and a key that reached its expiry is recorded as revoked, after LiteLLM has stopped it (ST-LLM-002); the pass is idempotent.
  'llm-key-sweep': 300,
  // Every 5 minutes: a reservation held for a request that never came back, past its end, waits for the reconciliation instead of being released, and the age of the oldest open one is reported (ST-LLM-003); the pass is idempotent.
  'llm-reservation-expiry': 300,
  'access-cache-expiry': 60,
} as const;

export type JobName = keyof typeof JOB_INTERVAL_SECONDS;

/** The hour of the night, in Vietnam time (UTC+7, no daylight saving), in which the retention run works (ADM 3.12: daily at 01:00). */
export const RETENTION_HOUR = 1;
const VIETNAM_UTC_OFFSET_HOURS = 7;
/** The hour of the morning, in Vietnam time, in which the guarantee reminders and expiries run (CTR 3.5: 06:00). */
export const GUARANTEE_EXPIRY_HOUR = 6;
/** The hour of the night, in Vietnam time, in which the balances of capital are compared with their ledger (CAP: nightly, after the Treasury files of the evening are matched). */
export const CAPITAL_RECONCILE_HOUR = 2;
/** The hour of the night, in Vietnam time, in which the recovered amounts of the recommendations of AUD are compared with their ledgers (AUD 9: daily at 02:00). */
export const AUD_RECONCILE_HOUR = 2;
/** The hour of the morning, in Vietnam time, in which the reminders of the verification deadline of a settlement go (PAY 3.5: 06:00). */
export const SETTLEMENT_DEADLINE_HOUR = 6;
/** The gauge of the revision job: the pending revisions more than a day past their first day, which the alert `CTR_REVISION_OVERDUE` watches. */
export const REVISION_OVERDUE_GAUGE = 'ctr_revision_overdue';
/** The gauge of the petition job: the petitions that wait for an answer past the last day of their deadline, which the alert `BID_PETITION_OVERDUE` watches. */
export const PETITION_OVERDUE_GAUGE = 'bid_petition_overdue';
/** The gauges of the guarantee job: the ACTIVE guarantees within `days` days of their expiry, and the advance guarantees at risk with an advance still owed. */
export const GUARANTEE_EXPIRING_GAUGE = 'ctr_guarantee_expiring';
export const ADVANCE_GUARANTEE_AT_RISK_GAUGE = 'ctr_advance_guarantee_at_risk';
/** The hour of the morning, in Vietnam time, in which the reminders of the earliest release day of a hold of retention run (CTR 3.5: 06:00). */
export const RETENTION_DUE_HOUR = 6;
/** The hour of the morning, in Vietnam time, in which the permit reminders and expiries run (PMT 3.1: 06:00). */
export const PERMIT_EXPIRY_HOUR = 6;
/** The gauge of the permit job: the ISSUED permits within `days` days of their last day. */
export const PERMIT_EXPIRING_GAUGE = 'pmt_permit_expiring';
/** The hour, in Vietnam time, in which the waivers of the permit gates whose last day has passed are ended (PMT: 00:10, so the tick of the 00:00 hour). */
export const GATE_WAIVER_EXPIRY_HOUR = 0;
/** The gauge of the waiver job: the waivers in force. */
export const GATE_WAIVER_ACTIVE_GAUGE = 'pmt_waiver_active';

/** The hour of the day, 0 to 23, in Vietnam. */
export const vietnamHourOf = (instant: Date): number => (instant.getUTCHours() + VIETNAM_UTC_OFFSET_HOURS) % 24;

/** The jobs that need only the database, so a command line can run them on their own. */
export const DATABASE_JOBS: readonly JobName[] = ['audit-seal', 'audit-verify', 'idempotency-purge'];

/** One or more tenants failed in a job that visits them all; the others were still processed. */
export class TenantJobsFailed extends Error {
  readonly failed: number;
  /** The error classes seen (never messages: they can carry personal data), sorted. */
  readonly errorClasses: readonly string[];

  constructor(failed: number, errorClasses: readonly string[]) {
    super(`${failed} tenant(s) failed: ${errorClasses.join(', ')}`);
    this.name = 'TenantJobsFailed';
    this.failed = failed;
    this.errorClasses = errorClasses;
  }
}

/** The audit chain of at least one tenant did not verify (the AUDIT_CHAIN_BROKEN alert names which). */
export class AuditChainBroken extends Error {
  constructor(broken: number) {
    super(`${broken} tenant(s) with a broken audit chain`);
    this.name = 'AuditChainBroken';
  }
}

export interface StandardJobDeps {
  /** Every tenant whose rows the jobs visit. */
  tenantIds(): Promise<readonly string[]>;
  seal: Pick<AuditSealJob, 'seal' | 'verify'>;
  idempotency: Pick<IdempotencyStore, 'purgeExpired'>;
  /** One pass of the outbox relay; only the API process, which owns the broker adapter, has it. */
  relay?: { runOnce(): Promise<unknown> };
  /** Makes the stored status of the signing certificates whose validity has ended Expired (ST-ADM-008); the API process has the store. */
  certificates?: { expireDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<number> };
  /**
   * Puts the master data versions whose date has come in force and retires the records whose retirement date has come
   * (ST-MDM-001); also tells how many change requests of the tenant wait for a reviewer, for the gauge below.
   */
  masterData?: { activateDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<{ changed: number; pendingReviews: number }> };
  /** Applies the baseline pack of the platform to the tenant (ST-MDM-003): the catalogues and the rule data every tenant starts from. */
  masterBaseline?: { apply(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /** Soft-closes the reporting periods past their deadline and locks them three working days later, by the same moves as the commands (ST-DIS-001). */
  disPeriods?: { autoclose(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /** Stores the end of the reopening windows of locked periods that have ended (APPROVED to EXPIRED) and audits it (ST-DIS-002). */
  disReopens?: { expire(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /**
   * The nightly retention run of a tenant (ST-ADM-017): removes the technical data that has outlived its period and puts the expired business
   * records on the review list, never deleting them; tells how many items wait, for the gauge below. Only the 01:00 hour of Vietnam time works.
   */
  retention?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ pending: number }> };
  /**
   * The daily pass over the guarantees of a tenant (ST-CTR-003): the reminders at 30, 15, 7 and 0 days and the expiry of the ones past their day;
   * tells how many guarantees are within each threshold, for the gauges. Only the 06:00 hour of Vietnam time works.
   */
  guaranteeExpiry?: {
    run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ expiring: Readonly<Record<number, number>>; advanceAtRisk: number }>;
  };
  /**
   * The daily pass over the holds of retention of a tenant (ST-CTR-010): the ones whose earliest release day has come are reminded once; tells how many reminders it sent. Only the 06:00 hour of Vietnam time works.
   */
  retentionDue?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ reminded: number }> };
  /**
   * The pass over the revisions of the contracts of a tenant that wait for their day (ST-CTR-007): the ones whose first day has come take over from the revision in force; tells how many
   * are late by more than a day, for the gauge.
   */
  revisionEffective?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ overdue: number }> };
  /**
   * The pass over the petitions of contractors of a tenant that wait for an answer (ST-BID-007): the first pass that finds one past the last day of its deadline sends its reminder;
   * tells how many petitions are overdue, for the gauge.
   */
  petitionDue?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ overdue: number }> };
  /**
   * The daily pass over the issued permits of a tenant (ST-PMT-006): the reminders at 60, 30, 15 and 0 days and the expiry of the ones past their last day;
   * tells how many permits are within each threshold, for the gauges. Only the 06:00 hour of Vietnam time works.
   */
  permitExpiry?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ expiring: Readonly<Record<number, number>> }> };
  /**
   * The daily pass over the waivers of the permit gates of a tenant (ST-PMT-005): a waiver in force whose last day has passed becomes EXPIRED; tells how many are
   * still in force, for the gauge. Only the 00:00 hour of Vietnam time works.
   */
  gateWaiverExpiry?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ active: number }> };
  /**
   * The pass over the issues of a tenant that are being worked (ST-ISS-004): writes the day an issue became overdue and raises the escalations whose threshold the
   * working time has reached; tells how many issues are open and how many escalations wait, for the gauges.
   */
  issueSla?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<SlaPassResult> };
  /** The pass over the reorganisations of organisation units of a tenant (ST-ADM-015): carries out the ones whose day has come; tells how many have stopped on a step, for the gauge. */
  unitReorganization?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ stopped: number }> };
  /** The pass over the delegations of a tenant that are not over (ST-ADM-014): puts the waiting ones in force and ends the ones whose window or source is over; tells how many are in force, for the gauge. */
  delegationLifecycle?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<DelegationPassResult> };
  /** The pass over the support access grants of a tenant (ST-SAS-015): puts the approved ones in force, ends the ones whose window is over, lapses the requests nobody decided on; tells how many are in force, for the gauge. */
  supportAccessLifecycle?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<SupportPassResult> };
  /** The pass over the open approval tasks of a tenant (ST-ADM-013): the reminders, the escalations and the expiries of the SLA; tells how many tasks are open and overdue, for the gauges. */
  approvalSla?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<SlaSweepResult> };
  /** Takes up the inbound provider events that are due and have an adapter, and retries the failed ones when their wait is over (ST-ADM-018). */
  inbox?: { processDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown> };
  /** Sends the notifications that are due on each channel, and reconciles the sends whose result was lost (ST-NOT-002); the API process has the adapters. */
  notificationDelivery?: {
    dispatchDue(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown>;
    reconcile(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<unknown>;
  };
  /** Executes the quality runs that are waiting (ST-DGV-002); tells how many datasets of the tenant have no finished run, for the gauge. */
  dgvQuality?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }): Promise<{ notAssessed: number }> };
  /**
   * The pass over the subscription of a tenant (ST-SAS-008): a trial that has ended becomes Active, a plan change that waited for its day takes effect, a period
   * that has passed gives way to the next and a subscription set to end ends. It reads the plan catalogue, so it runs through the control plane.
   */
  subscriptionCycle?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** The billing pass of a tenant (ST-SAS-011): the invoices of the periods that closed, the retries of the provider and the invoices past their due day; tells how many invoices are IssueFailed, for the gauge. */
  einvoiceBilling?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ failed: number }> };
  /** The pass over the payments of the platform that wait (ST-SAS-012): one pass for the platform, not one for each tenant; tells how many wait for a person, for the gauge. */
  paymentReconciliation?: { run(now: Date): Promise<{ waiting: number }> };
  /** Lets the requests to carry capital over to the next year lapse once their last day has passed (ST-CAP-007); tells how many lapsed. */
  extensionLapse?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ lapsed: number }> };
  /** Locks again the fiscal years whose reopening has ended (ST-CAP-008); tells which years. */
  fiscalYearRelock?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<{ years: number[] }> };
  /** The pass over the entitlement overrides of a tenant (ST-SAS-009): an override in force whose window has ended expires and the tenant gets a new entitlement version; a request that waited past its window expires. */
  overrideExpiry?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** The pass over the licenses of a tenant (ST-SAS-003): each one moves along Issued, Active, Grace and Expired by the clock of the server, with an event for every move. */
  /** The pass over the invitations of a tenant (ST-ADM-006): an invitation that ran out and the membership it was for become Expired, with an event for each. */
  invitationExpiry?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  licenseStatus?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  stageLate?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  explanationOverdue?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  packageExpiry?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  transferApply?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  incomingOverdue?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  dgvIncidentSweep?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** Reports the items of difference that wait past their day, once each (ST-PAY-007), and sets the gauges of the backlog. */
  reconciliationOverdue?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** Compares the balances of capital with their ledger, once a night, and reports a difference without correcting it (ST-CAP-006). */
  capitalBalanceReconcile?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  audRecoveryReconcile?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** Reminds the settlements whose verification deadline is near and reports the ones that are past it, once each (ST-PAY-009); sets the gauge of the late ones. */
  settlementDeadline?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** The pass over the virtual keys of a tenant (ST-LLM-002): a rotating key whose last day is over, and a key past its expiry, are stopped at LiteLLM and recorded as revoked. */
  llmKeySweep?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** The pass over the budget reservations of a tenant (ST-LLM-003): an open reservation past its end becomes PENDING_RECONCILE and keeps its hold. */
  llmReservationExpiry?: { run(ctx: { tenantId: string; membershipId: string; scopeVersion: number }, now: Date): Promise<unknown> };
  /** The clock of the jobs that depend on the time of day; default: the system clock. */
  clock?: () => Date;
  /** Receives `mdm_change_pending_gauge`, the number of master data change requests that wait for a reviewer in all tenants. */
  metrics?: MetricsSink;
  /** Drops the lapsed entries of the access cache of this process. */
  accessCache?: { expire(): number };
}

const workerContext = (tenantId: string): { tenantId: string; membershipId: string; scopeVersion: number } => ({
  tenantId,
  membershipId: WORKER_MEMBERSHIP_ID,
  scopeVersion: 0,
});

/** Runs `work` for every tenant, one failure not stopping the others, then reports how many failed. */
async function eachTenant(tenantIds: readonly string[], work: (tenantId: string) => Promise<void>): Promise<void> {
  let failed = 0;
  const classes = new Set<string>();
  for (const tenantId of tenantIds) {
    try {
      await work(tenantId);
    } catch (error) {
      failed += 1;
      classes.add(error instanceof Error ? error.constructor.name : 'UnknownError');
    }
  }
  if (failed > 0) throw new TenantJobsFailed(failed, [...classes].sort());
}

/** The tenants of the registry plus the platform tenant that holds the audit rows of control-plane commands. */
export async function registeredTenantIds(control: ControlDatabase): Promise<string[]> {
  const rows = await control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant order by id'));
  return [...rows.map((row) => row.id), PLATFORM_TENANT_ID];
}

/** The handlers of the jobs `deps` can serve, in the order of JOB_INTERVAL_SECONDS. */
export function standardJobs(deps: StandardJobDeps): JobHandler[] {
  const handlers: JobHandler[] = [
    { name: 'audit-seal', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await deps.seal.seal(workerContext(tenantId)))) },
    {
      name: 'audit-verify',
      run: async () => {
        let broken = 0;
        let failure: unknown;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            if (!(await deps.seal.verify(workerContext(tenantId))).ok) broken += 1;
          });
        } catch (error) {
          failure = error;
        }
        // A broken chain is the more important signal; the tenants that could not be checked come second.
        if (broken > 0) throw new AuditChainBroken(broken);
        if (failure !== undefined) throw failure;
      },
    },
  ];
  const { relay, accessCache, certificates, masterData, masterBaseline, disPeriods, disReopens, retention, inbox } = deps;
  if (relay !== undefined) handlers.push({ name: 'outbox-relay', run: async () => void (await relay.runOnce()) });
  handlers.push({
    name: 'idempotency-purge',
    run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await deps.idempotency.purgeExpired(workerContext(tenantId)))),
  });
  if (certificates !== undefined) {
    handlers.push({ name: 'certificate-expiry', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await certificates.expireDue(workerContext(tenantId)))) });
  }
  if (masterData !== undefined) {
    handlers.push({
      name: 'master-activation',
      run: async () => {
        const metrics = deps.metrics ?? NOOP_METRICS;
        let pending = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            pending += (await masterData.activateDue(workerContext(tenantId))).pendingReviews;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge('mdm_change_pending_gauge', pending);
        }
      },
    });
  }
  if (masterBaseline !== undefined) {
    handlers.push({ name: 'master-baseline-sync', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await masterBaseline.apply(workerContext(tenantId)))) });
  }
  if (disPeriods !== undefined) {
    handlers.push({ name: 'dis-period-autoclose', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await disPeriods.autoclose(workerContext(tenantId)))) });
  }
  if (disReopens !== undefined) {
    handlers.push({ name: 'dis-reopen-expiry', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await disReopens.expire(workerContext(tenantId)))) });
  }
  if (retention !== undefined) {
    handlers.push({
      name: 'retention-purge',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== RETENTION_HOUR) return;
        const metrics = deps.metrics ?? NOOP_METRICS;
        let pending = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            pending += (await retention.run(workerContext(tenantId), now)).pending;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(RETENTION_PENDING_GAUGE, pending);
        }
      },
    });
  }
  const guarantees = deps.guaranteeExpiry;
  if (guarantees !== undefined) {
    handlers.push({
      name: 'guarantee-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== GUARANTEE_EXPIRY_HOUR) return;
        const metrics = deps.metrics ?? NOOP_METRICS;
        const expiring: Record<number, number> = { 0: 0, 7: 0, 15: 0, 30: 0 };
        let atRisk = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            const pass = await guarantees.run(workerContext(tenantId), now);
            for (const [days, count] of Object.entries(pass.expiring)) expiring[Number(days)] = (expiring[Number(days)] ?? 0) + count;
            atRisk += pass.advanceAtRisk;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauges for the others.
          for (const [days, count] of Object.entries(expiring)) metrics.gauge(GUARANTEE_EXPIRING_GAUGE, count, { days });
          metrics.gauge(ADVANCE_GUARANTEE_AT_RISK_GAUGE, atRisk);
        }
      },
    });
  }
  const retentionDue = deps.retentionDue;
  if (retentionDue !== undefined) {
    handlers.push({
      name: 'retention-due',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== RETENTION_DUE_HOUR) return;
        await eachTenant(await deps.tenantIds(), async (tenantId) => {
          await retentionDue.run(workerContext(tenantId), now);
        });
      },
    });
  }
  const revisions = deps.revisionEffective;
  if (revisions !== undefined) {
    handlers.push({
      name: 'revision-effective',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        let overdue = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            overdue += (await revisions.run(workerContext(tenantId), now)).overdue;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(REVISION_OVERDUE_GAUGE, overdue);
        }
      },
    });
  }
  const petitions = deps.petitionDue;
  if (petitions !== undefined) {
    handlers.push({
      name: 'petition-due',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        let overdue = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            overdue += (await petitions.run(workerContext(tenantId), now)).overdue;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(PETITION_OVERDUE_GAUGE, overdue);
        }
      },
    });
  }
  const permits = deps.permitExpiry;
  if (permits !== undefined) {
    handlers.push({
      name: 'permit-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== PERMIT_EXPIRY_HOUR) return;
        const metrics = deps.metrics ?? NOOP_METRICS;
        const expiring: Record<number, number> = { 0: 0, 15: 0, 30: 0, 60: 0 };
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            const pass = await permits.run(workerContext(tenantId), now);
            for (const [days, count] of Object.entries(pass.expiring)) expiring[Number(days)] = (expiring[Number(days)] ?? 0) + count;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauges for the others.
          for (const [days, count] of Object.entries(expiring)) metrics.gauge(PERMIT_EXPIRING_GAUGE, count, { days });
        }
      },
    });
  }
  const waivers = deps.gateWaiverExpiry;
  if (waivers !== undefined) {
    handlers.push({
      name: 'gate-waiver-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== GATE_WAIVER_EXPIRY_HOUR) return;
        const metrics = deps.metrics ?? NOOP_METRICS;
        let active = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            const pass = await waivers.run(workerContext(tenantId), now);
            active += pass.active;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(GATE_WAIVER_ACTIVE_GAUGE, active);
        }
      },
    });
  }
  const sla = deps.issueSla;
  if (sla !== undefined) {
    handlers.push({
      name: 'issue-sla',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        const open: Record<string, number> = Object.fromEntries(SLA_SEVERITIES.map((severity) => [severity, 0]));
        let pending = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            const pass = await sla.run(workerContext(tenantId), now);
            for (const [severity, count] of Object.entries(pass.open)) open[severity] = (open[severity] ?? 0) + count;
            pending += pass.pending;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauges for the others.
          for (const [severity, count] of Object.entries(open)) metrics.gauge(OPEN_ISSUES_GAUGE, count, { severity });
          metrics.gauge(PENDING_ESCALATIONS_GAUGE, pending);
        }
      },
    });
  }
  const reorganizations = deps.unitReorganization;
  if (reorganizations !== undefined) {
    handlers.push({
      name: 'unit-reorganization',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        let stopped = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            stopped += (await reorganizations.run(workerContext(tenantId), now)).stopped;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(REORGANIZATION_FAILED_GAUGE, stopped);
        }
      },
    });
  }
  const delegations = deps.delegationLifecycle;
  if (delegations !== undefined) {
    handlers.push({
      name: 'delegation-lifecycle',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        let active = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            active += (await delegations.run(workerContext(tenantId), now)).active;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(DELEGATION_ACTIVE_GAUGE, active);
        }
      },
    });
  }
  const support = deps.supportAccessLifecycle;
  if (support !== undefined) {
    handlers.push({
      name: 'support-access-lifecycle',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        let active = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            active += (await support.run(workerContext(tenantId), now)).active;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(SUPPORT_ACCESS_ACTIVE_GAUGE, active);
        }
      },
    });
  }
  const approvals = deps.approvalSla;
  if (approvals !== undefined) {
    handlers.push({
      name: 'approval-sla',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        let open = 0;
        let overdue = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            const pass = await approvals.run(workerContext(tenantId), now);
            open += pass.open;
            overdue += pass.overdue;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauges for the others.
          metrics.gauge(APPROVAL_OPEN_GAUGE, open);
          metrics.gauge(APPROVAL_OVERDUE_GAUGE, overdue);
        }
      },
    });
  }
  if (inbox !== undefined) {
    handlers.push({ name: 'integration-inbox', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await inbox.processDue(workerContext(tenantId)))) });
  }
  const delivery = deps.notificationDelivery;
  if (delivery !== undefined) {
    handlers.push({ name: 'notification-dispatch', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await delivery.dispatchDue(workerContext(tenantId)))) });
    handlers.push({ name: 'notification-reconcile', run: async () => eachTenant(await deps.tenantIds(), async (tenantId) => void (await delivery.reconcile(workerContext(tenantId)))) });
  }
  const dgvQuality = deps.dgvQuality;
  if (dgvQuality !== undefined) {
    handlers.push({
      name: 'dgv-quality-run',
      run: async () => {
        const metrics = deps.metrics ?? NOOP_METRICS;
        let notAssessed = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            notAssessed += (await dgvQuality.run(workerContext(tenantId))).notAssessed;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(DGV_NOT_ASSESSED_GAUGE, notAssessed);
        }
      },
    });
  }
  const subscriptions = deps.subscriptionCycle;
  if (subscriptions !== undefined) {
    handlers.push({
      name: 'subscription-cycle',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await subscriptions.run(workerContext(tenantId), now)));
      },
    });
  }
  const billing = deps.einvoiceBilling;
  if (billing !== undefined) {
    handlers.push({
      name: 'einvoice-billing',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        let failed = 0;
        try {
          await eachTenant(await deps.tenantIds(), async (tenantId) => {
            failed += (await billing.run(workerContext(tenantId), now)).failed;
          });
        } finally {
          // The tenants that could be read still count: a failing tenant must not blank the gauge for the others.
          metrics.gauge(EINVOICE_FAILED_GAUGE, failed);
        }
      },
    });
  }
  const reconciliation = deps.paymentReconciliation;
  if (reconciliation !== undefined) {
    handlers.push({
      name: 'payment-reconciliation',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        const metrics = deps.metrics ?? NOOP_METRICS;
        const { waiting } = await reconciliation.run(now);
        metrics.gauge(PAYMENT_UNMATCHED_GAUGE, waiting);
      },
    });
  }
  const extensions = deps.extensionLapse;
  if (extensions !== undefined) {
    handlers.push({
      name: 'allocation-extension-lapse',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await extensions.run(workerContext(tenantId), now)));
      },
    });
  }
  const relock = deps.fiscalYearRelock;
  if (relock !== undefined) {
    handlers.push({
      name: 'fiscal-year-relock',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await relock.run(workerContext(tenantId), now)));
      },
    });
  }
  const overrides = deps.overrideExpiry;
  if (overrides !== undefined) {
    handlers.push({
      name: 'entitlement-override-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await overrides.run(workerContext(tenantId), now)));
      },
    });
  }
  const licenses = deps.licenseStatus;
  if (licenses !== undefined) {
    handlers.push({
      name: 'license-status',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await licenses.run(workerContext(tenantId), now)));
      },
    });
  }
  const invitations = deps.invitationExpiry;
  if (invitations !== undefined) {
    handlers.push({
      name: 'membership-invitation-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await invitations.run(workerContext(tenantId), now)));
      },
    });
  }
  const lateStages = deps.stageLate;
  if (lateStages !== undefined) {
    handlers.push({
      name: 'land-stage-late',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await lateStages.run(workerContext(tenantId), now)));
      },
    });
  }
  const overdueExplanations = deps.explanationOverdue;
  if (overdueExplanations !== undefined) {
    handlers.push({
      name: 'prj-explanation-overdue',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await overdueExplanations.run(workerContext(tenantId), now)));
      },
    });
  }
  const packageExpiry = deps.packageExpiry;
  if (packageExpiry !== undefined) {
    handlers.push({
      name: 'mne-package-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await packageExpiry.run(workerContext(tenantId), now)));
      },
    });
  }
  const transferApply = deps.transferApply;
  if (transferApply !== undefined) {
    handlers.push({
      name: 'prj-transfer-apply',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await transferApply.run(workerContext(tenantId), now)));
      },
    });
  }
  const overdueLetters = deps.incomingOverdue;
  if (overdueLetters !== undefined) {
    handlers.push({
      name: 'incoming-overdue',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await overdueLetters.run(workerContext(tenantId), now)));
      },
    });
  }
  const dgvSweep = deps.dgvIncidentSweep;
  if (dgvSweep !== undefined) {
    handlers.push({
      name: 'dgv-incident-sweep',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await dgvSweep.run(workerContext(tenantId), now)));
      },
    });
  }
  const overdueItems = deps.reconciliationOverdue;
  if (overdueItems !== undefined) {
    handlers.push({
      name: 'reconciliation-overdue',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await overdueItems.run(workerContext(tenantId), now)));
      },
    });
  }
  const settlementDeadlines = deps.settlementDeadline;
  if (settlementDeadlines !== undefined) {
    handlers.push({
      name: 'settlement-deadline',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== SETTLEMENT_DEADLINE_HOUR) return;
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await settlementDeadlines.run(workerContext(tenantId), now)));
      },
    });
  }
  const capitalBalances = deps.capitalBalanceReconcile;
  if (capitalBalances !== undefined) {
    handlers.push({
      name: 'capital-balance-reconcile',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== CAPITAL_RECONCILE_HOUR) return;
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await capitalBalances.run(workerContext(tenantId), now)));
      },
    });
  }
  const audRecoveries = deps.audRecoveryReconcile;
  if (audRecoveries !== undefined) {
    handlers.push({
      name: 'aud-recovery-reconcile',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        if (vietnamHourOf(now) !== AUD_RECONCILE_HOUR) return;
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await audRecoveries.run(workerContext(tenantId), now)));
      },
    });
  }
  const keySweep = deps.llmKeySweep;
  if (keySweep !== undefined) {
    handlers.push({
      name: 'llm-key-sweep',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await keySweep.run(workerContext(tenantId), now)));
      },
    });
  }
  const reservationExpiry = deps.llmReservationExpiry;
  if (reservationExpiry !== undefined) {
    handlers.push({
      name: 'llm-reservation-expiry',
      run: async () => {
        const now = (deps.clock ?? (() => new Date()))();
        await eachTenant(await deps.tenantIds(), async (tenantId) => void (await reservationExpiry.run(workerContext(tenantId), now)));
      },
    });
  }
  if (accessCache !== undefined) handlers.push({ name: 'access-cache-expiry', run: async () => void accessCache.expire() });
  return handlers;
}
