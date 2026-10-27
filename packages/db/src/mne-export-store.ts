import { randomUUID } from 'node:crypto';
import { DomainError, MNE_EXPORT_CONNECTORS, MNE_PACKAGE_EXPIRY_DAYS, versionConflict } from '@machvon/kernel';
import type { MneExportFormat, MneExportTarget, MnePackageStatus } from '@machvon/kernel';
import type { AuditWriter } from './audit-writer.ts';
import { idOf } from './prj-accountability-support.ts';
import { usableDocumentId } from './prj-stage-support.ts';
import type { TenantTx } from './tenant-database.ts';

export const MNE_PACKAGE_RESOURCE = 'mne_export_package';
export type AdapterStatus = 'VERIFIED' | 'PROPOSED' | 'MOCK' | 'MISSING';

export interface MnePackageRow {
  id: string;
  reportId: string;
  targetSystem: MneExportTarget;
  format: MneExportFormat;
  objectKey: string;
  fileSha256: string;
  fileSizeBytes: number | null;
  adapterStatus: AdapterStatus;
  status: MnePackageStatus;
  receiptReference: string | null;
  receiptDocumentId: string | null;
  receiptRecordedBy: string | null;
  receiptRecordedAt: string | null;
  submittedAt: string | null;
  downloadedAt: string | null;
  expiredAt: string | null;
  createdAt: string;
  createdBy: string;
  version: number;
}

interface PackageSql {
  id: string;
  mne_report_id: string;
  target_system: MneExportTarget;
  format: MneExportFormat;
  object_key: string;
  file_sha256: string;
  file_size_bytes: string | null;
  adapter_status: AdapterStatus;
  status: MnePackageStatus;
  receipt_reference: string | null;
  receipt_document_id: string | null;
  receipt_recorded_by: string | null;
  receipt_recorded_at: string | null;
  submitted_at: string | null;
  downloaded_at: string | null;
  expired_at: string | null;
  created_at: string;
  created_by: string;
  version: string;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const COLUMNS = `id, mne_report_id, target_system, format, object_key, file_sha256::text as file_sha256, file_size_bytes::text as file_size_bytes, adapter_status, status, receipt_reference, receipt_document_id,
  receipt_recorded_by, ${ISO('receipt_recorded_at')} as receipt_recorded_at, ${ISO('submitted_at')} as submitted_at, ${ISO('downloaded_at')} as downloaded_at, ${ISO('expired_at')} as expired_at,
  ${ISO('created_at')} as created_at, created_by, version::text as version`;

const rowOf = (row: PackageSql): MnePackageRow => ({
  id: row.id,
  reportId: row.mne_report_id,
  targetSystem: row.target_system,
  format: row.format,
  objectKey: row.object_key,
  fileSha256: row.file_sha256,
  fileSizeBytes: row.file_size_bytes === null ? null : Number(row.file_size_bytes),
  adapterStatus: row.adapter_status,
  status: row.status,
  receiptReference: row.receipt_reference,
  receiptDocumentId: row.receipt_document_id,
  receiptRecordedBy: row.receipt_recorded_by,
  receiptRecordedAt: row.receipt_recorded_at,
  submittedAt: row.submitted_at,
  downloadedAt: row.downloaded_at,
  expiredAt: row.expired_at,
  createdAt: row.created_at,
  createdBy: row.created_by,
  version: Number(row.version),
});

export interface NewPackage {
  reportId: string;
  targetSystem: MneExportTarget;
  format: MneExportFormat;
  id: string;
  objectKey: string;
  fileSha256: string;
  fileSizeBytes: number;
  adapterStatus: AdapterStatus;
  actor: string;
}

export interface ReceiptInput {
  id: string;
  expectedVersion: number;
  reference: string;
  submittedAt: string;
  receiptDocumentId: string | undefined;
  actor: string;
  now: Date;
}

/**
 * The packages of an issued monitoring report (ST-MNE-004, MNE 3.1 F3): one row per file made for a target, told apart by the hash of the file, so that the same content asked for again is the same package. The
 * way to the target is only labelled (the adapter status of its connector, MISSING when the tenant has none): nothing here sends anything anywhere. A package moves GENERATED, DOWNLOADED, SUBMISSION_CONFIRMED
 * (with the receipt the person wrote down), or to EXPIRED when nobody filed it in time; the table keeps the same edges.
 */
export class MneExportStore {
  /** How far the way to a target goes, from the connector of the integration settings that stands for it; MISSING when the tenant has set none up. */
  async adapterStatusOf(tx: TenantTx, target: MneExportTarget): Promise<AdapterStatus> {
    const [row] = await tx.query<{ adapter_status: AdapterStatus }>('select adapter_status from machvon.integration_connector where lower(connector_code) = lower($1)', [MNE_EXPORT_CONNECTORS[target]]);
    return row?.adapter_status ?? 'MISSING';
  }

  async list(tx: TenantTx, reportId: string): Promise<MnePackageRow[]> {
    const rows = await tx.query<PackageSql>(`select ${COLUMNS} from machvon.mne_export_package where mne_report_id = $1::uuid order by created_at, id`, [reportId]);
    return rows.map(rowOf);
  }

  async find(tx: TenantTx, id: string): Promise<MnePackageRow | undefined> {
    const [row] = await tx.query<PackageSql>(`select ${COLUMNS} from machvon.mne_export_package where id = $1::uuid`, [idOf(id, 'id')]);
    return row === undefined ? undefined : rowOf(row);
  }

  /** The package of a file already made and still offered: the same report, target and format and the same content (an expired one does not count). */
  async findByHash(tx: TenantTx, reportId: string, target: MneExportTarget, format: MneExportFormat, sha256: string): Promise<MnePackageRow | undefined> {
    const [row] = await tx.query<PackageSql>(`select ${COLUMNS} from machvon.mne_export_package where mne_report_id = $1::uuid and target_system = $2 and format = $3 and file_sha256 = $4 and status <> 'EXPIRED'`, [reportId, target, format, sha256]);
    return row === undefined ? undefined : rowOf(row);
  }

  /** The package with its row locked for the rest of the transaction (404 when the tenant has none of that id). */
  async lock(tx: TenantTx, id: string): Promise<MnePackageRow> {
    const [row] = await tx.query<PackageSql>(`select ${COLUMNS} from machvon.mne_export_package where id = $1::uuid for update`, [idOf(id, 'id')]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rowOf(row);
  }

  /** The package of the file when one exists (the same content for the same report, target and format), otherwise a new one: `created` says which. */
  async ensure(tx: TenantTx, input: NewPackage): Promise<{ row: MnePackageRow; created: boolean }> {
    const [inserted] = await tx.query<{ id: string }>(
      `insert into machvon.mne_export_package (tenant_id, id, mne_report_id, target_system, format, object_key, file_sha256, file_size_bytes, adapter_status, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6, $7::bigint, $8, 'GENERATED', $9::uuid, $9::uuid)
       on conflict (tenant_id, mne_report_id, target_system, format, file_sha256) where status <> 'EXPIRED' do nothing returning id`,
      [input.id, input.reportId, input.targetSystem, input.format, input.objectKey, input.fileSha256, String(input.fileSizeBytes), input.adapterStatus, input.actor],
    );
    if (inserted !== undefined) return { row: await this.read(tx, inserted.id), created: true };
    const [existing] = await tx.query<PackageSql>(
      `select ${COLUMNS} from machvon.mne_export_package where mne_report_id = $1::uuid and target_system = $2 and format = $3 and file_sha256 = $4 and status <> 'EXPIRED'`,
      [input.reportId, input.targetSystem, input.format, input.fileSha256],
    );
    if (existing === undefined) throw new Error('a package that conflicted is not there');
    return { row: rowOf(existing), created: false };
  }

  /** The first time the file is served: GENERATED to DOWNLOADED (a package already past that, or one that expired, is left as it is); `changed` says whether this call is the one that moved it. */
  async markDownloaded(tx: TenantTx, id: string, at: Date, actor: string): Promise<{ row: MnePackageRow; changed: boolean }> {
    const moved = await tx.query<{ id: string }>(
      `update machvon.mne_export_package set status = 'DOWNLOADED', downloaded_at = $2::timestamptz, updated_at = now(), updated_by = $3::uuid, version = version + 1 where id = $1::uuid and status = 'GENERATED' returning id`,
      [id, at.toISOString(), actor],
    );
    return { row: await this.read(tx, id), changed: moved.length > 0 };
  }

  /**
   * Writes down the receipt of a filing made by hand: the package is SUBMISSION_CONFIRMED with the reference, the day the person says it was filed and, when there is one, the document of the receipt (422
   * DECISION_REQUIRED when it cannot be used). A package that is no longer offered (confirmed, refused or expired) is 409 PACKAGE_STATE_INVALID; a filing day in the future of the record is 422.
   */
  async recordReceipt(tx: TenantTx, input: ReceiptInput): Promise<{ row: MnePackageRow; previousStatus: MnePackageStatus }> {
    const current = await this.lock(tx, input.id);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'GENERATED' && current.status !== 'DOWNLOADED') throw new DomainError('PACKAGE_STATE_INVALID', 409, 'status', { extensions: { package_status: current.status } });
    const reference = input.reference.trim();
    if (reference.length < 3 || reference.length > 100) throw new DomainError('VALIDATION_FAILED', 422, 'receipt_reference');
    const filed = Date.parse(input.submittedAt);
    if (Number.isNaN(filed) || filed > input.now.getTime() + 5 * 60_000) throw new DomainError('VALIDATION_FAILED', 422, 'submitted_at');
    const documentId = input.receiptDocumentId === undefined ? null : await usableDocumentId(tx, input.receiptDocumentId, 'receipt_document_id');
    await tx.query(
      `update machvon.mne_export_package
          set status = 'SUBMISSION_CONFIRMED', receipt_reference = $2, receipt_document_id = $3::uuid, receipt_recorded_by = $4::uuid, receipt_recorded_at = $5::timestamptz, submitted_at = $6::timestamptz,
              updated_at = now(), updated_by = $4::uuid, version = version + 1
        where id = $1::uuid`,
      [current.id, reference, documentId, input.actor, input.now.toISOString(), new Date(filed).toISOString()],
    );
    return { row: await this.read(tx, current.id), previousStatus: current.status };
  }

  /**
   * The packages nobody filed within the days they are offered: GENERATED or DOWNLOADED to EXPIRED. Returns the ones it moved. The files of a report that a correction superseded are left as they are: they are what was
   * issued and offered then, and cannot be made again (a superseded report is not exported).
   */
  async expireOlderThan(tx: TenantTx, cutoff: Date, actor: string, now: Date): Promise<MnePackageRow[]> {
    const rows = await tx.query<PackageSql>(
      `update machvon.mne_export_package set status = 'EXPIRED', expired_at = $3::timestamptz, updated_at = now(), updated_by = $2::uuid, version = version + 1
        where status in ('GENERATED', 'DOWNLOADED') and created_at < $1::timestamptz
          and not exists (select 1 from machvon.mne_report r where r.tenant_id = mne_export_package.tenant_id and r.id = mne_export_package.mne_report_id and r.status = 'SUPERSEDED') returning ${COLUMNS}`,
      [cutoff.toISOString(), actor, now.toISOString()],
    );
    return rows.map(rowOf);
  }

  newId(): string {
    return randomUUID();
  }

  private async read(tx: TenantTx, id: string): Promise<MnePackageRow> {
    const row = await this.find(tx, id);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return row;
  }
}

/**
 * The job `mne.package-expiry` (ST-MNE-004): a package that nobody filed within the days it is offered (90) is EXPIRED, once, with one audit row for each (ids, target, format and hash: never the file). The
 * report keeps its state: an expired file is made again from the report, and the same content is the same hash. A second pass finds nothing to change.
 */
export class MneExportExpiryJob {
  private readonly store = new MneExportStore();

  private readonly audit: Pick<AuditWriter, 'recordInTx'>;
  private readonly days: number;

  constructor(audit: Pick<AuditWriter, 'recordInTx'>, days: number = MNE_PACKAGE_EXPIRY_DAYS) {
    this.audit = audit;
    this.days = days;
  }

  async run(tx: TenantTx, actor: string, now: Date): Promise<{ expired: number }> {
    const cutoff = new Date(now.getTime() - this.days * 86_400_000);
    const changed = await this.store.expireOlderThan(tx, cutoff, actor, now);
    const correlationId = randomUUID();
    for (const row of changed) {
      await this.audit.recordInTx(tx, actor, {
        action: 'mne.package_expired',
        resourceType: MNE_PACKAGE_RESOURCE,
        resourceId: row.id,
        diff: { report_id: row.reportId, target_system: row.targetSystem, format: row.format, file_sha256: row.fileSha256, created_at: row.createdAt, days: this.days },
        correlationId,
        requestId: randomUUID(),
      });
    }
    return { expired: changed.length };
  }
}
