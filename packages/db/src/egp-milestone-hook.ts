import { randomUUID } from 'node:crypto';
import { MILESTONE_KINDS, egpNoticeMilestones, egpResultMilestones, milestoneOrderIssue, vietnamDayOf } from '@machvon/kernel';
import type { EgpMilestoneDate, EgpMilestoneOutcome, EgpNoticeRecord, EgpResultRecord, MilestoneDates, MilestoneKind } from '@machvon/kernel';
import { BidWorkflowStore } from './bid-workflow-store.ts';
import { PACKAGE_STATUSES_WITHOUT_MILESTONES } from './bid-milestone-store.ts';
import { assertOpeningNotResealed } from './bid-proposal-release.ts';
import type { TenantTx } from './tenant-database.ts';

const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export interface EgpMilestoneFill {
  packageId: string;
  packageCode: string;
  projectId: string;
  kind: MilestoneKind;
  at: string;
  outcome: EgpMilestoneOutcome;
  /** The milestone that was written or filled (only for FILLED). */
  milestoneId: string | null;
  /** The notice or the result of the network the date came from, and the import that brought it. */
  externalType: 'EGP_NOTICE' | 'EGP_RESULT';
  externalCode: string;
  importId: string;
}

export interface EgpMilestoneResult {
  packageId: string;
  packageCode: string;
  fills: EgpMilestoneFill[];
  /** The codes of the checklist items of the running workflow that the new dates completed. */
  itemsCompleted: string[];
}

interface PackageSql {
  id: string;
  code: string;
  status: string;
  version: string;
  project_id: string;
}

interface CodeSql {
  subject_type: 'NOTICE' | 'RESULT';
  external_code: string;
}

interface HeldSql {
  id: string;
  milestone_kind: MilestoneKind;
  planned_at: string | null;
  actual_at: string | null;
}

interface RecordSql<R> {
  import_id: string;
  record: R;
}

/**
 * The consumer of what the national procurement network said about a package (EGP-2, the hook EGP-1 left in `docs/egp-connector.md` section 10): when a person approves the mapping of a notice or a result of the network to a
 * package, or a file is applied for a package that is already mapped, the dates of the notice (published, bids closed, bids opened) and of the result (published, approved) that `egp_record` holds become the actual dates of the
 * milestones of the package, and the workflow of the package completes the items those milestones carry (`BidWorkflowStore.syncMilestonesOfPackage`).
 *
 * The rules, all of them the ones BID-19 already follows for the file of the milestones: a date is written only where the package has none (an actual date of a person is never overwritten: a different day is shown by the
 * reconciliation, not taken in silently), a milestone must keep the order of the milestones (`milestoneOrderIssue`) and a milestone that has happened is not in the future; the source is IMPORT, carried by a batch that
 * mirrors the e-GP file (`procurement_import_batch`: the milestone keeps the proof of the file that gave it). A package the plan has not approved, one that was replaced or dropped, takes none. It is idempotent: a second
 * pass finds the dates there and changes nothing. Only the ACTIVE mappings count: the notice and the result of the network that a person approved for the package, never one found by name or code alone.
 */
export class EgpMilestoneHook {
  private readonly workflows = new BidWorkflowStore();

  private async batchOf(tx: TenantTx, importId: string, actor: string): Promise<string> {
    const [file] = await tx.query<{ file_sha256: string; file_object_key: string; rows_total: number; rows_applied: number }>('select file_sha256, file_object_key, rows_total, rows_applied from machvon.file_import where id = $1::uuid', [importId]);
    if (file === undefined) throw new Error('the import of a record is not there');
    const found = await tx.query<{ id: string }>(`select id from machvon.procurement_import_batch where file_sha256 = $1 and mode = 'APPLY' and status = 'APPLIED'`, [file.file_sha256]);
    if (found[0] !== undefined) return found[0].id;
    const id = randomUUID();
    await tx.query(
      `insert into machvon.procurement_import_batch (tenant_id, id, source_system, adapter_status, file_sha256, file_object_key, mode, rows_total, rows_ok, rows_error, status, created_by, updated_by)
       values (${TENANT}, $1::uuid, 'MUASAMCONG', 'PROPOSED', $2, $3, 'APPLY', $4, $5, 0, 'APPLIED', $6::uuid, $6::uuid) on conflict do nothing`,
      [id, file.file_sha256, file.file_object_key, file.rows_total, file.rows_applied, actor],
    );
    const again = await tx.query<{ id: string }>(`select id from machvon.procurement_import_batch where file_sha256 = $1 and mode = 'APPLY' and status = 'APPLIED'`, [file.file_sha256]);
    return (again[0] as { id: string }).id;
  }

  /** The packages whose notice or result mapping this mapping is (a notice and a result are about a package: the subject of the mapping is the package). */
  async packageOfMapping(tx: TenantTx, mappingId: string): Promise<{ packageId: string; subjectType: 'PACKAGE' | 'NOTICE' | 'RESULT' } | undefined> {
    const rows = await tx.query<{ subject_id: string; subject_type: 'PACKAGE' | 'NOTICE' | 'RESULT' }>(
      `select subject_id, subject_type from machvon.master_crosswalk where id = $1::uuid and source_system = 'MUASAMCONG' and subject_type in ('PACKAGE', 'NOTICE', 'RESULT') and status = 'ACTIVE'`,
      [mappingId],
    );
    return rows[0] === undefined ? undefined : { packageId: rows[0].subject_id, subjectType: rows[0].subject_type };
  }

  /** The packages that have an ACTIVE notice or result mapping to a notice or result of the file of an import (the ones a newly applied file may now give dates to). */
  async packagesOfImport(tx: TenantTx, importId: string): Promise<string[]> {
    const rows = await tx.query<{ package_id: string }>(
      `select distinct x.subject_id as package_id from machvon.master_crosswalk x
        where x.source_system = 'MUASAMCONG' and x.status = 'ACTIVE' and x.subject_type in ('NOTICE', 'RESULT')
          and exists (select 1 from machvon.egp_record r where r.import_id = $1::uuid and ((x.subject_type = 'NOTICE' and r.kind = 'TBMT' and r.record ->> 'noticeCode' = x.external_code) or (x.subject_type = 'RESULT' and r.kind = 'RESULT' and r.record ->> 'resultCode' = x.external_code)))
        order by x.subject_id`,
      [importId],
    );
    return rows.map((row) => row.package_id);
  }

  /** Gives one package the dates its approved mappings point to, in the transaction of the caller. `actor` is the member the milestones and the evidence are written for (never a person who did not act). */
  async applyToPackage(tx: TenantTx, packageId: string, actor: string, now: Date): Promise<EgpMilestoneResult | undefined> {
    const packs = await tx.query<PackageSql>('select id, code, status, version::text as version, project_id from machvon.procurement_package where id = $1::uuid for update', [packageId]);
    const pack = packs[0];
    if (pack === undefined) return undefined;
    const codes = await tx.query<CodeSql>(
      `select subject_type, external_code from machvon.master_crosswalk where subject_id = $1::uuid and source_system = 'MUASAMCONG' and status = 'ACTIVE' and subject_type in ('NOTICE', 'RESULT') order by subject_type, external_code`,
      [packageId],
    );
    const wanted: Array<{ type: 'EGP_NOTICE' | 'EGP_RESULT'; code: string; importId: string; dates: EgpMilestoneDate[] }> = [];
    for (const code of codes) {
      if (code.subject_type === 'NOTICE') {
        // The invitation of the notice: the earliest version that invites (a modification or a cancellation does not give a date to the milestones).
        const rows = await tx.query<RecordSql<EgpNoticeRecord>>(
          `select import_id, record from machvon.egp_record where kind = 'TBMT' and record ->> 'noticeCode' = $1 and record ->> 'noticeKind' = 'INVITATION' order by (record ->> 'noticeVersion')::int, created_at, id limit 1`,
          [code.external_code],
        );
        if (rows[0] !== undefined) wanted.push({ type: 'EGP_NOTICE', code: code.external_code, importId: rows[0].import_id, dates: egpNoticeMilestones(rows[0].record) });
      } else {
        const rows = await tx.query<RecordSql<EgpResultRecord>>(`select import_id, record from machvon.egp_record where kind = 'RESULT' and record ->> 'resultCode' = $1 order by created_at, id limit 1`, [code.external_code]);
        if (rows[0] !== undefined) wanted.push({ type: 'EGP_RESULT', code: code.external_code, importId: rows[0].import_id, dates: egpResultMilestones(rows[0].record) });
      }
    }
    const fills: EgpMilestoneFill[] = [];
    const held = await tx.query<HeldSql>(
      `select id, milestone_kind, to_char(planned_at at time zone 'UTC', ${ISO}) as planned_at, to_char(actual_at at time zone 'UTC', ${ISO}) as actual_at from machvon.procurement_milestone where package_id = $1::uuid for update`,
      [packageId],
    );
    const dates: Partial<Record<MilestoneKind, MilestoneDates>> = {};
    for (const row of held) dates[row.milestone_kind] = { plannedAt: row.planned_at, actualAt: row.actual_at };
    let changed = false;
    for (const source of wanted) {
      for (const date of [...source.dates].sort((a, b) => MILESTONE_KINDS.indexOf(a.kind) - MILESTONE_KINDS.indexOf(b.kind))) {
        const fill: EgpMilestoneFill = { packageId: pack.id, packageCode: pack.code, projectId: pack.project_id, kind: date.kind, at: date.at, outcome: 'FILLED', milestoneId: null, externalType: source.type, externalCode: source.code, importId: source.importId };
        const current = held.find((row) => row.milestone_kind === date.kind);
        if (PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status)) fill.outcome = 'PACKAGE_CLOSED';
        else if (Date.parse(date.at) > now.getTime()) fill.outcome = 'IN_THE_FUTURE';
        else if (current?.actual_at !== null && current?.actual_at !== undefined) fill.outcome = vietnamDayOf(current.actual_at) === vietnamDayOf(date.at) ? 'SAME_DAY' : 'KEPT_OURS';
        else if (milestoneOrderIssue(dates, { kind: date.kind, actualAt: date.at }) !== undefined) fill.outcome = 'ORDER_REFUSED';
        else if (date.kind === 'BID_OPENING' && (await this.reseals(tx, pack.id, date.at))) fill.outcome = 'ORDER_REFUSED';
        if (fill.outcome === 'FILLED') {
          const batch = await this.batchOf(tx, source.importId, actor);
          if (current === undefined) {
            fill.milestoneId = randomUUID();
            await tx.query(
              `insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, actual_at, source, import_batch_id, created_by, updated_by, version) values (${TENANT}, $1::uuid, $2::uuid, $3, $4::timestamptz, 'IMPORT', $5::uuid, $6::uuid, $6::uuid, 1)`,
              [fill.milestoneId, pack.id, date.kind, date.at, batch, actor],
            );
            held.push({ id: fill.milestoneId, milestone_kind: date.kind, planned_at: null, actual_at: date.at });
          } else {
            fill.milestoneId = current.id;
            await tx.query(`update machvon.procurement_milestone set actual_at = $2::timestamptz, source = 'IMPORT', import_batch_id = $3::uuid, updated_at = now(), updated_by = $4::uuid, version = version + 1 where id = $1::uuid`, [current.id, date.at, batch, actor]);
            current.actual_at = date.at;
          }
          dates[date.kind] = { plannedAt: current?.planned_at ?? null, actualAt: date.at };
          changed = true;
        }
        fills.push(fill);
      }
    }
    if (changed) await tx.query('update machvon.procurement_package set version = version + 1 where id = $1::uuid', [pack.id]);
    const itemsCompleted = await this.workflows.syncMilestonesOfPackage(tx, pack.id, actor, now);
    return { packageId: pack.id, packageCode: pack.code, fills, itemsCompleted };
  }

  /** Whether the date would close again sealed proposals that were released: a date that comes after the release is refused as the commands of BID-17 refuse it (OPENING_ALREADY_RELEASED). */
  private async reseals(tx: TenantTx, packageId: string, at: string): Promise<boolean> {
    try {
      await assertOpeningNotResealed(tx, packageId, at, 'actual_at');
      return false;
    } catch (error) {
      if ((error as { code?: string }).code === 'OPENING_ALREADY_RELEASED') return true;
      throw error;
    }
  }
}
