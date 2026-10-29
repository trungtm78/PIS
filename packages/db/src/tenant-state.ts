import { DomainError, assertArchivable, exportWindowEnd, isWithinExportWindow, offboardingDefects, versionConflict } from '@machvon/kernel';
import { assertTenantTransition } from './tenant-registry.ts';
import type { TenantStatus } from './tenant-registry.ts';
import type { TenantTx } from './tenant-database.ts';

/** Why a tenant is suspended (SAS 3.6, `TenantSuspend.reason_code`). */
export const SUSPENSION_REASONS = ['NON_PAYMENT', 'SECURITY_INCIDENT', 'CUSTOMER_REQUEST', 'LICENSE_REVOKED', 'LEGAL_ORDER'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** What a suspended tenant may still do: read and export, or nothing (a security incident). */
export type SuspensionAccessPolicy = 'READ_ONLY_EXPORT' | 'NO_ACCESS';

/** The change a state command made; the hook that runs inside the command receives it. */
export interface StateChange {
  tenantId: string;
  from: TenantStatus;
  to: TenantStatus;
  version: number;
  reasonCode?: SuspensionReason;
  /** When the window to export ends, for the change that starts offboarding. */
  exportWindowEndsAt?: Date;
}

export interface SuspendInput {
  tenantId: string;
  reasonCode: SuspensionReason;
  accessPolicy: SuspensionAccessPolicy;
  expectedVersion: number;
  /** The tenant the command transaction acts as outside the hook (the platform tenant). */
  restoreTenantId: string;
}

export interface ResumeInput {
  tenantId: string;
  expectedVersion: number;
  restoreTenantId: string;
  /** The time the window to export is judged at; defaults to the clock. */
  now?: Date;
}

export interface OffboardInput {
  tenantId: string;
  contractEndDate: string;
  exportWindowDays: number;
  reason: string;
  expectedVersion: number;
  restoreTenantId: string;
  now?: Date;
}

export interface ArchiveInput {
  tenantId: string;
  expectedVersion: number;
  restoreTenantId: string;
  now?: Date;
}

/**
 * The access policy a reason implies. The database function `tenant_runtime` derives the policy from the stored
 * reason (a security incident is NO_ACCESS, every other suspension READ_ONLY_EXPORT), so the request may only name the
 * policy that agrees with its reason.
 */
export function accessPolicyOf(reason: SuspensionReason): SuspensionAccessPolicy {
  return reason === 'SECURITY_INCIDENT' ? 'NO_ACCESS' : 'READ_ONLY_EXPORT';
}

export function assertPolicyMatchesReason(reason: SuspensionReason, policy: SuspensionAccessPolicy): void {
  if (accessPolicyOf(reason) !== policy) throw new DomainError('VALIDATION_FAILED', 422, 'access_policy');
}

interface StateRow {
  status: TenantStatus;
  version: string;
  export_window_ends_at: Date | null;
  offboarding_started_at: Date | null;
}

const LOCK_SQL = 'select status, version::text as version, export_window_ends_at, offboarding_started_at from machvon.tenant where id = $1::uuid for update';

const SUSPEND_SQL = `update machvon.tenant
  set status = 'Suspended', lifecycle_reason = $2, suspended_at = now(), version = version + 1
  where id = $1::uuid returning version::text as version`;

// Back to Active from Suspended or, inside the window to export, from Offboarding (a renewal of the contract): what offboarding recorded is cleared.
const RESUME_SQL = `update machvon.tenant
  set status = 'Active', lifecycle_reason = null, suspended_at = null, offboarding_started_at = null, contract_end_date = null, export_window_days = null, export_window_ends_at = null, version = version + 1
  where id = $1::uuid returning version::text as version`;

const OFFBOARD_SQL = `update machvon.tenant
  set status = 'Offboarding', lifecycle_reason = null, offboarding_started_at = $2::timestamptz, contract_end_date = $3::date, export_window_days = $4::int, export_window_ends_at = $5::timestamptz, version = version + 1
  where id = $1::uuid returning version::text as version`;

const ARCHIVE_SQL = `update machvon.tenant
  set status = 'Archived', archived_at = $2::timestamptz, version = version + 1
  where id = $1::uuid returning version::text as version`;

async function actAs(tx: TenantTx, tenantId: string): Promise<void> {
  await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

// Locks the tenant row, so two operators serialise, and checks the version and the lifecycle table.
async function lockedState(tx: TenantTx, tenantId: string, expectedVersion: number, required: TenantStatus | readonly TenantStatus[], to: TenantStatus): Promise<StateRow> {
  const [state] = await tx.query<StateRow>(LOCK_SQL, [tenantId]);
  if (state === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
  if (Number(state.version) !== expectedVersion) throw versionConflict(Number(state.version));
  // Resuming is the way out of Suspended only: an Offboarding tenant returns to Active through a renewal, not through this command.
  if (!(Array.isArray(required) ? required : [required]).includes(state.status)) throw new DomainError('TENANT_STATE_INVALID', 409, `${state.status}->${to}`);
  assertTenantTransition(state.status, to);
  return state;
}

async function runHook(tx: TenantTx, change: StateChange, restoreTenantId: string, hook: (change: StateChange) => Promise<void>): Promise<void> {
  // The audit row and the event of the change belong to the affected tenant: the transaction acts as that tenant while they are written.
  await actAs(tx, change.tenantId);
  await hook(change);
  await actAs(tx, restoreTenantId);
}

/**
 * Active to Suspended inside the transaction of a control-plane command. `whileActing` runs while the transaction
 * acts as the suspended tenant (audit row, events); the version is bumped so an operator with a stale view is refused.
 */
export async function suspendTenant(tx: TenantTx, input: SuspendInput, whileActing: (change: StateChange) => Promise<void>): Promise<StateChange> {
  assertPolicyMatchesReason(input.reasonCode, input.accessPolicy);
  const { status: from } = await lockedState(tx, input.tenantId, input.expectedVersion, 'Active', 'Suspended');
  const [updated] = await tx.query<{ version: string }>(SUSPEND_SQL, [input.tenantId, input.reasonCode]);
  const change: StateChange = { tenantId: input.tenantId, from, to: 'Suspended', version: Number(updated?.version), reasonCode: input.reasonCode };
  await runHook(tx, change, input.restoreTenantId, whileActing);
  return change;
}

/**
 * Suspended to Active, or Offboarding to Active while the window to export is open (a renewal of the contract, SAS.md 3.2); the reason, the suspension time and what offboarding recorded are cleared, the history stays in the
 * audit trail. An Offboarding tenant whose window has ended is not brought back this way (409 TENANT_STATE_INVALID).
 */
export async function resumeTenant(tx: TenantTx, input: ResumeInput, whileActing: (change: StateChange) => Promise<void>): Promise<StateChange> {
  const state = await lockedState(tx, input.tenantId, input.expectedVersion, ['Suspended', 'Offboarding'], 'Active');
  const from = state.status;
  if (from === 'Offboarding' && !isWithinExportWindow(state.export_window_ends_at, input.now ?? new Date())) throw new DomainError('TENANT_STATE_INVALID', 409, 'Offboarding->Active');
  const [updated] = await tx.query<{ version: string }>(RESUME_SQL, [input.tenantId]);
  const change: StateChange = { tenantId: input.tenantId, from, to: 'Active', version: Number(updated?.version) };
  await runHook(tx, change, input.restoreTenantId, whileActing);
  return change;
}

/**
 * Active or Suspended to Offboarding: the tenant is read-only and may export (the runtime already answers READ_ONLY_EXPORT for it). The end of the contract and the days of the window are recorded, and the window runs from the later of
 * the end of the contract and now. A start with fields that cannot be accepted is 422 (the first one is named).
 */
export async function offboardTenant(tx: TenantTx, input: OffboardInput, whileActing: (change: StateChange) => Promise<void>): Promise<StateChange> {
  const defects = offboardingDefects({ contractEndDate: input.contractEndDate, exportWindowDays: input.exportWindowDays, reason: input.reason });
  if (defects[0] !== undefined) throw new DomainError('VALIDATION_FAILED', 422, defects[0]);
  const now = input.now ?? new Date();
  const { status: from } = await lockedState(tx, input.tenantId, input.expectedVersion, ['Active', 'Suspended'], 'Offboarding');
  const windowEndsAt = exportWindowEnd(input.contractEndDate, now, input.exportWindowDays);
  const [updated] = await tx.query<{ version: string }>(OFFBOARD_SQL, [input.tenantId, now.toISOString(), input.contractEndDate, input.exportWindowDays, windowEndsAt.toISOString()]);
  const change: StateChange = { tenantId: input.tenantId, from, to: 'Offboarding', version: Number(updated?.version), exportWindowEndsAt: windowEndsAt };
  await runHook(tx, change, input.restoreTenantId, whileActing);
  return change;
}

/**
 * Offboarding to Archived: the tenant is closed to its people for good. It needs an export that was Delivered or a window that has ended (409 EXPORT_NOT_CONFIRMED); the legal holds of the tenant do not stop the archive,
 * they stop the purge (the retention job skips what is held).
 */
export async function archiveTenantState(tx: TenantTx, input: ArchiveInput, whileActing: (change: StateChange) => Promise<void>): Promise<StateChange> {
  const state = await lockedState(tx, input.tenantId, input.expectedVersion, 'Offboarding', 'Archived');
  // The jobs of the tenant are its own rows (row-level security): they are asked while the transaction acts as that tenant.
  await actAs(tx, input.tenantId);
  // Only an export whose snapshot was taken after offboarding began counts: the tenant was read-only from then, so it holds the data as it stays.
  const [delivered] = await tx.query<{ delivered: boolean }>('select machvon.tenant_export_delivered($1::uuid, $2::timestamptz) as delivered', [input.tenantId, state.offboarding_started_at?.toISOString() ?? null]);
  await actAs(tx, input.restoreTenantId);
  const now = input.now ?? new Date();
  assertArchivable({ deliveredExport: delivered?.delivered === true, windowEndsAt: state.export_window_ends_at }, now);
  const [updated] = await tx.query<{ version: string }>(ARCHIVE_SQL, [input.tenantId, now.toISOString()]);
  const change: StateChange = { tenantId: input.tenantId, from: state.status, to: 'Archived', version: Number(updated?.version) };
  await runHook(tx, change, input.restoreTenantId, whileActing);
  return change;
}

export interface OffboardingState {
  status: TenantStatus;
  version: number;
  contractEndDate: string | null;
  exportWindowDays: number | null;
  exportWindowEndsAt: Date | null;
  offboardingStartedAt: Date | null;
  archivedAt: Date | null;
  /** The legal holds in force on the tenant, which the purge after the archive honours. */
  legalHoldsActive: number;
  exportDelivered: boolean;
}

/** What the System Admin needs to decide on an archive: the window, whether an export was delivered and whether a legal hold is in force. The transaction acts as the tenant while it asks (the jobs and the holds are its own rows). */
export async function offboardingOf(tx: TenantTx, tenantId: string, restoreTenantId: string): Promise<OffboardingState | undefined> {
  const [row] = await tx.query<{ status: TenantStatus; version: string; contract_end_date: string | null; export_window_days: number | null; export_window_ends_at: Date | null; offboarding_started_at: Date | null; archived_at: Date | null }>(
    'select status, version::text as version, contract_end_date::text, export_window_days, export_window_ends_at, offboarding_started_at, archived_at from machvon.tenant where id = $1::uuid',
    [tenantId],
  );
  if (row === undefined) return undefined;
  await actAs(tx, tenantId);
  try {
    const [facts] = await tx.query<{ holds: number; delivered: boolean }>('select machvon.tenant_legal_holds_active($1::uuid) as holds, machvon.tenant_export_delivered($1::uuid, $2::timestamptz) as delivered', [tenantId, row.offboarding_started_at?.toISOString() ?? null]);
    return {
      status: row.status,
      version: Number(row.version),
      contractEndDate: row.contract_end_date,
      exportWindowDays: row.export_window_days,
      exportWindowEndsAt: row.export_window_ends_at,
      offboardingStartedAt: row.offboarding_started_at,
      archivedAt: row.archived_at,
      legalHoldsActive: facts?.holds ?? 0,
      exportDelivered: facts?.delivered === true,
    };
  } finally {
    await actAs(tx, restoreTenantId);
  }
}
