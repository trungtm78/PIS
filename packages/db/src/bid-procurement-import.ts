import { randomUUID } from 'node:crypto';
import { MILESTONE_KINDS, PROCUREMENT_ADAPTER_STATUS, PROCUREMENT_SOURCE_SYSTEM, milestoneOrderIssue, procurementFileFormat, vietnamDayOf } from '@machvon/kernel';
import type { Difference, MilestoneDates, MilestoneKind, ProcurementRow, Rejection } from '@machvon/kernel';
import { BidExternalLinks, diffWithMilestone } from './bid-external-link.ts';
import type { LinkDiff } from './bid-external-link.ts';
import { PACKAGE_STATUSES_WITHOUT_MILESTONES } from './bid-milestone-store.ts';
import { isActiveMember } from './file-import-item-store.ts';
import type { FileImportAdapter, ImportEntry } from './file-import-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** What the import of a file does with one row it accepts: the dry run says it, the apply does it. */
export type ProcurementOutcome = 'CREATE' | 'FILL' | 'UNCHANGED' | 'MILESTONE_MISMATCH' | 'CODE_MISMATCH';

/** A milestone that the import wrote, for the audit rows and the events of the command. */
export interface ImportedMilestone {
  packageId: string;
  packageCode: string;
  projectId: string;
  kind: MilestoneKind;
  actualAt: string;
  action: 'CREATED' | 'FILLED';
  /** The version of the package after the write. */
  version: number;
  batchId: string;
}

interface PackageSql {
  id: string;
  code: string;
  status: string;
  version: string;
  project_id: string;
  project_code: string;
  created_by: string | null;
  external_package_code: string | null;
}

interface MilestoneSql {
  id: string;
  milestone_kind: MilestoneKind;
  planned_at: string | null;
  actual_at: string | null;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const MILESTONE_SQL = `id, milestone_kind, to_char(planned_at at time zone 'UTC', ${ISO}) as planned_at, to_char(actual_at at time zone 'UTC', ${ISO}) as actual_at`;
const KIND_ORDER = `array[${MILESTONE_KINDS.map((kind) => `'${kind}'`).join(',')}]`;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

export interface ProcurementImportContext {
  /** The projects the caller may touch (the permission `bid.import`). */
  scope: ScopeBuilder;
  actor: string;
  now: Date;
  /** The batch that carries the milestones this import writes; absent for a dry run, which writes nothing. */
  batchId?: string | undefined;
}

/**
 * The adapter of the file of the national bidding system for the file import framework (ST-KERNEL-070, ST-BID-005): the layout and the judgement of a row are the pure format
 * of the kernel; this half reads what the register holds. A row is applied to a live package the caller may touch: it links the package to its code on the network, writes the
 * actual date of a milestone that has none (source IMPORT) and leaves a date the register already has alone. When the file and the register disagree (another date for a
 * milestone, another code on the network for the package) the register is not overwritten: the disagreement is a difference with an owner, kept on the link and settled by hand
 * with `recordProcurementMilestone`.
 */
export class ProcurementImportAdapter implements FileImportAdapter<ProcurementRow> {
  readonly connectorCode = procurementFileFormat.connectorCode;
  readonly formatVersion = procurementFileFormat.formatVersion;
  /** The milestones this import wrote, for the audit rows and the events of the command. */
  readonly imported: ImportedMilestone[] = [];

  private readonly context: ProcurementImportContext;
  private readonly links = new BidExternalLinks();
  private readonly owners = new Map<string, string>();

  constructor(context: ProcurementImportContext) {
    this.context = context;
  }

  parse = procurementFileFormat.parse;
  judge = procurementFileFormat.judge;
  mask = procurementFileFormat.mask;

  /** The live package a row names, or the reason there is none. Two live packages with one code are told apart by the project code of the file. */
  private async packageOf(tx: TenantTx, row: ProcurementRow, lock: boolean): Promise<{ pack: PackageSql } | Rejection> {
    const predicate = this.context.scope(3);
    const found = await tx.query<PackageSql>(
      `select k.id, k.code, k.status, k.version::text as version, p.id as project_id, p.code as project_code, k.created_by, k.external_package_code
         from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.code = $1 and ($2::text is null or p.code = $2) and ${predicate.sql}
        order by k.id${lock ? ' for update of k' : ''}`,
      [row.packageCode, row.projectCode, ...predicate.params],
    );
    // A package outside the scope of the caller is indistinguishable from one that does not exist.
    if (found.length === 0) return { code: 'PACKAGE_NOT_FOUND', field: 'package_code' };
    const live = found.filter((pack) => !PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status));
    if (live.length === 0) return { code: 'PACKAGE_STATE_INVALID', field: 'package_code' };
    if (live.length > 1) return { code: 'PACKAGE_AMBIGUOUS', field: 'package_code' };
    return { pack: live[0] as PackageSql };
  }

  private async milestonesOf(tx: TenantTx, packageId: string, lock: boolean): Promise<MilestoneSql[]> {
    return tx.query<MilestoneSql>(`select ${MILESTONE_SQL} from machvon.procurement_milestone where package_id = $1::uuid order by array_position(${KIND_ORDER}, milestone_kind)${lock ? ' for update' : ''}`, [packageId]);
  }

  async examine(tx: TenantTx, entry: ImportEntry<ProcurementRow>): Promise<Rejection | undefined> {
    const found = await this.packageOf(tx, entry.record, false);
    if ('code' in found) return found;
    const { pack } = found;
    // A milestone that has happened is not in the future.
    if (Date.parse(entry.record.actualAt) > this.context.now.getTime()) return { code: 'ACTUAL_AT_IN_FUTURE', field: 'actual_at' };
    // Only a package the caller may see can hold the code against the row: a code held outside the scope is not revealed by a dry run. The apply is made on the whole tenant
    // (the command requires it), so it judges every package.
    const visible = this.context.scope(4);
    const holder = await tx.query<{ id: string }>(
      `select l.id from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.procurement_external_link l on l.tenant_id = k.tenant_id and l.package_id = k.id
        where l.external_system = $1 and l.external_code = $2 and k.id <> $3::uuid and ${visible.sql}`,
      [PROCUREMENT_SOURCE_SYSTEM, entry.record.externalCode, pack.id, ...visible.params],
    );
    if (holder[0] !== undefined) return { code: 'EXTERNAL_CODE_TAKEN', field: 'external_code' };
    const held = await this.milestonesOf(tx, pack.id, false);
    const current = held.find((row) => row.milestone_kind === entry.record.milestoneKind);
    // A date the register already has is not touched, so only the date the file would write is judged against the order of the others.
    if (current?.actual_at == null) {
      const dates: Partial<Record<MilestoneKind, MilestoneDates>> = {};
      for (const row of held) dates[row.milestone_kind] = { plannedAt: row.planned_at, actualAt: row.actual_at };
      if (milestoneOrderIssue(dates, { kind: entry.record.milestoneKind, actualAt: entry.record.actualAt }) !== undefined) return { code: 'MILESTONE_ORDER_INVALID', field: 'actual_at' };
    }
    return undefined;
  }

  /** What the apply would do with the row (the dry run says it). */
  async outcomeOf(tx: TenantTx, entry: ImportEntry<ProcurementRow>): Promise<ProcurementOutcome> {
    const found = await this.packageOf(tx, entry.record, false);
    if ('code' in found) return 'UNCHANGED';
    const link = await tx.query<{ external_code: string }>('select external_code from machvon.procurement_external_link where package_id = $1::uuid and external_system = $2', [found.pack.id, PROCUREMENT_SOURCE_SYSTEM]);
    if (link[0] !== undefined && link[0].external_code !== entry.record.externalCode) return 'CODE_MISMATCH';
    const current = (await this.milestonesOf(tx, found.pack.id, false)).find((row) => row.milestone_kind === entry.record.milestoneKind);
    if (current === undefined) return 'CREATE';
    if (current.actual_at === null) return 'FILL';
    return vietnamDayOf(current.actual_at) === vietnamDayOf(entry.record.actualAt) ? 'UNCHANGED' : 'MILESTONE_MISMATCH';
  }

  async apply(tx: TenantTx, entry: ImportEntry<ProcurementRow>): Promise<readonly Difference[]> {
    const batchId = this.context.batchId;
    if (batchId === undefined) throw new Error('an import is applied under a batch');
    const found = await this.packageOf(tx, entry.record, true);
    if ('code' in found) throw new Error('a package that examine found is gone before apply');
    const { pack } = found;
    const record = entry.record;
    const owner = await this.ownerOf(tx, pack);
    this.owners.set(entry.businessKey, owner);

    let link = await this.links.lock(tx, pack.id);
    link ??= await this.links.create(tx, { packageId: pack.id, externalCode: record.externalCode, batchId, actor: this.context.actor });
    if (link.externalCode !== record.externalCode) {
      // The package is linked to another tender on the network: the file may be about another tender, so nothing of the row is written and the disagreement is for a person.
      await this.links.save(tx, link, { ...link.diff, external_code: { register: link.externalCode, file: record.externalCode } }, owner, this.context.actor, batchId);
      return [{ code: 'EXTERNAL_CODE_MISMATCH', expected: link.externalCode, actual: record.externalCode, detail: pack.code }];
    }
    let diff: LinkDiff = { ...link.diff };
    delete diff.external_code;
    const differences: Difference[] = [];
    const current = (await this.milestonesOf(tx, pack.id, true)).find((row) => row.milestone_kind === record.milestoneKind);
    let written: 'CREATED' | 'FILLED' | undefined;
    if (current === undefined) {
      await tx.query(
        `insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, import_batch_id, created_by, updated_by, version)
         values (${TENANT}, $1::uuid, $2::uuid, $3, $4::timestamptz, 'IMPORT', $5::uuid, $6::uuid, $6::uuid, 1)`,
        [randomUUID(), pack.id, record.milestoneKind, record.actualAt, batchId, this.context.actor],
      );
      written = 'CREATED';
      diff = diffWithMilestone(diff, record.milestoneKind, undefined);
    } else if (current.actual_at === null) {
      await tx.query(
        `update machvon.procurement_milestone set actual_at = $2::timestamptz, source = 'IMPORT', import_batch_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`,
        [current.id, record.actualAt, batchId, this.context.actor],
      );
      written = 'FILLED';
      diff = diffWithMilestone(diff, record.milestoneKind, undefined);
    } else if (vietnamDayOf(current.actual_at) === vietnamDayOf(record.actualAt)) {
      diff = diffWithMilestone(diff, record.milestoneKind, undefined);
    } else {
      diff = diffWithMilestone(diff, record.milestoneKind, { register: current.actual_at, file: record.actualAt });
      differences.push({ code: 'MILESTONE_DATE_MISMATCH', expected: vietnamDayOf(current.actual_at), actual: vietnamDayOf(record.actualAt), detail: `${pack.code} ${record.milestoneKind}` });
    }
    let version = Number(pack.version);
    if (written !== undefined) {
      version += 1;
      await tx.query('update machvon.procurement_package set version = $2::bigint where id = $1::uuid', [pack.id, version]);
      this.imported.push({ packageId: pack.id, packageCode: pack.code, projectId: pack.project_id, kind: record.milestoneKind, actualAt: record.actualAt, action: written, version, batchId });
    }
    if (pack.external_package_code === null) {
      await tx.query('update machvon.procurement_package set external_package_code = $2 where id = $1::uuid', [pack.id, record.externalCode]);
    }
    await this.links.save(tx, link, diff, owner, this.context.actor, batchId);
    return differences;
  }

  async ownerFor(_tx: TenantTx, subject: { code: string; businessKey: string; line: number }): Promise<string | undefined> {
    return this.owners.get(subject.businessKey);
  }

  /** The planner who made the package owns what is different about it, when they are still a member; the person who imported the file otherwise. */
  private async ownerOf(tx: TenantTx, pack: PackageSql): Promise<string> {
    if (pack.created_by !== null && (await isActiveMember(tx, pack.created_by))) return pack.created_by;
    return this.context.actor;
  }
}

export interface BatchCounts {
  rowsTotal: number;
  rowsOk: number;
  rowsError: number;
  errors: ReadonlyArray<Record<string, unknown>>;
}

/**
 * The batch of an applied file (`procurement_import_batch`): the record of the import that the milestones and the links point to. A dry run writes nothing, so it has no batch
 * (BR-BID-13); the batch of an apply is opened before the rows are applied, closed with the counts and the faults of the rows, and is not changed again.
 */
export class BidProcurementImport {
  async begin(tx: TenantTx, input: { fileSha256: string; fileObjectKey: string; actor: string }): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.procurement_import_batch (tenant_id, id, source_system, adapter_status, file_sha256, file_object_key, mode, status, created_by, updated_by, version)
       values (${TENANT}, $1::uuid, $2, $3, $4, $5, 'APPLY', 'STAGED', $6::uuid, $6::uuid, 1)`,
      [id, PROCUREMENT_SOURCE_SYSTEM, PROCUREMENT_ADAPTER_STATUS, input.fileSha256, input.fileObjectKey, input.actor],
    );
    return id;
  }

  async finish(tx: TenantTx, batchId: string, counts: BatchCounts, actor: string): Promise<void> {
    await tx.query(
      `update machvon.procurement_import_batch
          set rows_total = $2::int, rows_ok = $3::int, rows_error = $4::int, errors_json = $5::jsonb, status = 'APPLIED', updated_at = now(), updated_by = $6::uuid, version = version + 1
        where id = $1::uuid`,
      [batchId, counts.rowsTotal, counts.rowsOk, counts.rowsError, JSON.stringify(counts.errors), actor],
    );
  }
}
