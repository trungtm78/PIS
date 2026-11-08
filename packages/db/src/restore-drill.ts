import { canonicalJson, sha256Hex, verifyRestore } from '@machvon/kernel';
import type { Measurement, RestoreTimings, RestoreVerificationReport } from '@machvon/kernel';
import { measureTenant } from './restore-ports.ts';
import type { TenantDatabase } from './tenant-database.ts';

export const DRILL_SCHEMA_VERSION = 1;

/** The object-store files that rows refer to, summarised: how many references and a digest of the sorted list of their keys (the same list is made on the source and on the restored cluster). */
export interface FileReferenceSummary {
  references: number;
  digest: string;
}

/** What one cluster holds, tenant by tenant, measured the way the restore of one tenant is verified (`TenantRestoreStore.measure`). One manifest is taken on the source, one on the restored cluster. */
export interface DrillManifest {
  schemaVersion: number;
  role: 'source' | 'restored';
  takenAt: string;
  tenants: Record<string, Measurement>;
  files?: FileReferenceSummary;
}

/** The instants of a drill: the recovery point asked for, where the restore stopped, when the restore started and when the comparison ended (RPO and RTO are measured from them, as for a tenant restore). */
export interface DrillTimings {
  recoveryPoint: Date;
  restoredTo: Date;
  startedAt: Date;
  verifiedAt: Date;
}

export interface DrillTenantResult {
  tenant_id: string;
  matched: boolean;
  mismatches: string[];
  rows_expected: number;
  rows_restored: number;
  money_expected_vnd: string;
  money_restored_vnd: string;
  /** The reference (sha256) of the verification report of this tenant: the same report and reference as for a tenant restore. */
  reference: string;
}

export interface DrillReport {
  schema_version: number;
  matched: boolean;
  tenants: DrillTenantResult[];
  missing_tenants: string[];
  unexpected_tenants: string[];
  files: { expected: FileReferenceSummary | null; restored: FileReferenceSummary | null; match: boolean };
  source_manifest: string;
  restored_manifest: string;
  mismatches: string[];
  rpo_seconds: number;
  rto_seconds: number;
  rpo_target_seconds: number;
  rto_target_seconds: number;
  within_targets: boolean;
}

const sha256Reference = (value: unknown): string => `sha256:${sha256Hex(canonicalJson(value))}`;

/** The reference of a manifest: its sha256 over the canonical text, so that the minutes of a drill name exactly the measures that were compared. */
export const manifestReference = (manifest: DrillManifest): string => sha256Reference(manifest);

/** The reference of the report of a drill. */
export const drillReportReference = (report: DrillReport): string => sha256Reference(report);

/** The summary of a list of object keys: the count and the sha256 of the sorted, de-duplicated keys joined by newlines. */
export function fileReferenceSummary(keys: readonly string[]): FileReferenceSummary {
  const unique = [...new Set(keys.map((key) => key.trim()).filter((key) => key !== ''))].sort();
  return { references: unique.length, digest: `sha256:${sha256Hex(unique.join('\n'))}` };
}

/** Measures each tenant of the cluster `database` points at, one snapshot per tenant, with the measure that verifies a tenant restore. */
export async function measureTenants(database: TenantDatabase, tenantIds: readonly string[], role: DrillManifest['role'], options: { files?: FileReferenceSummary; now?: () => Date } = {}): Promise<DrillManifest> {
  const tenants: Record<string, Measurement> = {};
  for (const tenantId of [...tenantIds].sort()) tenants[tenantId] = await measureTenant(database, tenantId);
  return { schemaVersion: DRILL_SCHEMA_VERSION, role, takenAt: (options.now ?? (() => new Date()))().toISOString(), tenants, ...(options.files === undefined ? {} : { files: options.files }) };
}

function resultOf(tenantId: string, report: RestoreVerificationReport): DrillTenantResult {
  return {
    tenant_id: tenantId,
    matched: report.matched,
    mismatches: report.mismatches,
    rows_expected: report.totals.rows_expected,
    rows_restored: report.totals.rows_restored,
    money_expected_vnd: report.totals.money_expected_vnd,
    money_restored_vnd: report.totals.money_restored_vnd,
    reference: sha256Reference(report),
  };
}

/**
 * Compares the manifest of the source with the manifest of the restored cluster. Each tenant goes through `verifyRestore` (the function that verifies a tenant restore: the same tables,
 * rows, checksums and money totals), so the drill has no comparison logic of its own; on top, a tenant that is in one manifest and not in the other and the file references. The drill
 * `matched` only when nothing differs; `within_targets` says whether the RPO and RTO of the timings meet the targets of NFR-AVAILABILITY-02.
 */
export function compareDrill(source: DrillManifest, restored: DrillManifest, timings: DrillTimings): DrillReport {
  const sourceIds = Object.keys(source.tenants).sort();
  const restoredIds = new Set(Object.keys(restored.tenants));
  const missing = sourceIds.filter((id) => !restoredIds.has(id));
  const unexpected = [...restoredIds].filter((id) => source.tenants[id] === undefined).sort();
  const verifyTimings: RestoreTimings = { recoveryPoint: timings.recoveryPoint, restoredTo: timings.restoredTo, approvedAt: timings.startedAt, verifiedAt: timings.verifiedAt };
  const reports = sourceIds
    .filter((id) => restoredIds.has(id))
    .map((id) => ({ id, report: verifyRestore(source.tenants[id] as Measurement, { ...(restored.tenants[id] as Measurement), foreignRows: 0 }, verifyTimings) }));
  const mismatches = [
    ...missing.map((id) => `missing_tenant:${id}`),
    ...unexpected.map((id) => `unexpected_tenant:${id}`),
    ...reports.flatMap(({ id, report }) => report.mismatches.map((mismatch) => `${id}:${mismatch}`)),
  ];
  const expectedFiles = source.files ?? null;
  const restoredFiles = restored.files ?? null;
  const filesMatch = expectedFiles === null || restoredFiles === null ? expectedFiles === restoredFiles : expectedFiles.references === restoredFiles.references && expectedFiles.digest === restoredFiles.digest;
  if (!filesMatch) mismatches.push('file_references');
  const timing = reports[0]?.report ?? verifyRestore({ tables: {} }, { tables: {}, foreignRows: 0 }, verifyTimings);
  return {
    schema_version: DRILL_SCHEMA_VERSION,
    matched: mismatches.length === 0,
    tenants: reports.map(({ id, report }) => resultOf(id, report)),
    missing_tenants: missing,
    unexpected_tenants: unexpected,
    files: { expected: expectedFiles, restored: restoredFiles, match: filesMatch },
    source_manifest: manifestReference(source),
    restored_manifest: manifestReference(restored),
    mismatches,
    rpo_seconds: timing.rpo_seconds,
    rto_seconds: timing.rto_seconds,
    rpo_target_seconds: timing.rpo_target_seconds,
    rto_target_seconds: timing.rto_target_seconds,
    within_targets: timing.within_targets,
  };
}
