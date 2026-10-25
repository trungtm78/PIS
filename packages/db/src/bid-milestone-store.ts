import { randomUUID } from 'node:crypto';
import { DomainError, MILESTONE_KINDS, milestoneOrderIssue, momentOf, versionConflict, vietnamDayOf } from '@machvon/kernel';
import type { MilestoneDates, MilestoneKind, MilestoneSource } from '@machvon/kernel';
import { BidExternalLinks, diffWithMilestone } from './bid-external-link.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** A package takes milestones once its plan is approved; a package in a plan still in work, one the plan replaced or one it dropped has no tender to follow. */
export const PACKAGE_STATUSES_WITHOUT_MILESTONES: readonly string[] = ['DRAFT', 'IN_REVIEW', 'SUPERSEDED', 'CANCELLED'];

export interface NewMilestone {
  packageId: string;
  expectedVersion: number;
  kind: MilestoneKind;
  plannedAt?: string | undefined;
  actualAt?: string | undefined;
}

/** What a record left, as the audit row, the event and the answer are written from: the stored values, never the request. */
export interface RecordedMilestone {
  packageId: string;
  packageCode: string;
  projectId: string;
  kind: MilestoneKind;
  plannedAt: string | null;
  actualAt: string | null;
  source: MilestoneSource;
  /** The version of the package after the record: the If-Match of the next one. */
  version: number;
  created: boolean;
  /** The source and the dates before, null for a milestone that was not there. */
  previous: { plannedAt: string | null; actualAt: string | null; source: MilestoneSource } | null;
  /** The difference with the file of the national network that this date settled, or null. */
  settledDifference: boolean;
}

export interface ProcurementMilestoneLine {
  id: string;
  packageId: string;
  kind: MilestoneKind;
  plannedAt: string | null;
  actualAt: string | null;
  source: MilestoneSource;
  importBatchId: string | null;
  version: number;
}

interface PackageSql {
  id: string;
  code: string;
  status: string;
  version: string;
  project_id: string;
  created_by: string | null;
}

interface MilestoneSql {
  id: string;
  milestone_kind: MilestoneKind;
  planned_at: string | null;
  actual_at: string | null;
  source: MilestoneSource;
  import_batch_id: string | null;
  version: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const MILESTONE_COLUMNS = `id, milestone_kind, to_char(planned_at at time zone 'UTC', ${ISO}) as planned_at, to_char(actual_at at time zone 'UTC', ${ISO}) as actual_at, source, import_batch_id, version::text as version`;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A date-time of the request in UTC: ISO 8601 with its offset (the contract's `date-time`), refused otherwise. */
function moment(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  // Only a date-time (the contract's format) is a moment of the request: a bare day or a day in the Vietnamese order is the layout of a file, not of this command.
  const at = /^\d{4}-\d{2}-\d{2}T/.test(value.trim()) ? momentOf(value) : undefined;
  if (at === undefined) throw invalid(field);
  return at;
}

const toLine = (packageId: string, row: MilestoneSql): ProcurementMilestoneLine => ({
  id: row.id,
  packageId,
  kind: row.milestone_kind,
  plannedAt: row.planned_at,
  actualAt: row.actual_at,
  source: row.source,
  importBatchId: row.import_batch_id,
  version: Number(row.version),
});

/**
 * The milestones of a package (ST-BID-005, BID 3 F8): the invitation, the clarification deadline, the closing and opening of the bid, the evaluation, the approval and the
 * publication of the result, and the contract. A planner records the planned and the actual date of each by hand; the file of the national bidding system fills the actual date
 * of a milestone that has none (see `BidProcurementImport`). The dates of a package keep the order of the milestones, the package row is locked first and its version is the
 * If-Match of every record, so two planners editing one package never both win.
 */
export class BidMilestoneStore {
  private readonly links = new BidExternalLinks();

  /**
   * Records the planned and/or the actual date of one milestone of a package. Refusals in order: the shape (422), the package (404 outside the scope of the caller, 409
   * VERSION_CONFLICT, 409 PACKAGE_STATE_INVALID), the order of the dates (409 MILESTONE_ORDER_INVALID, naming the two kinds). A milestone that was written by a file becomes the
   * planner's (source MANUAL) the moment they record it. A date that was a difference with the file of the national network, and is now the file's day, settles the difference.
   */
  async record(tx: TenantTx, input: NewMilestone, actor: string, scope: ScopeBuilder, now: Date): Promise<RecordedMilestone> {
    if (!(MILESTONE_KINDS as readonly string[]).includes(input.kind)) throw invalid('milestone_kind');
    const plannedAt = moment(input.plannedAt, 'planned_at');
    const actualAt = moment(input.actualAt, 'actual_at');
    if (plannedAt === undefined && actualAt === undefined) throw invalid('planned_at');
    // A milestone that has happened is not in the future.
    if (actualAt !== undefined && Date.parse(actualAt) > now.getTime()) throw invalid('actual_at');
    const pack = await this.lockPackage(tx, input.packageId, scope);
    if (Number(pack.version) !== input.expectedVersion) throw versionConflict(Number(pack.version));
    if (PACKAGE_STATUSES_WITHOUT_MILESTONES.includes(pack.status)) throw new DomainError('PACKAGE_STATE_INVALID', 409, 'package_id', { extensions: { package_status: pack.status } });

    const held = await tx.query<MilestoneSql>(`select ${MILESTONE_COLUMNS} from machvon.procurement_milestone where package_id = $1::uuid order by milestone_kind for update`, [pack.id]);
    const dates: Partial<Record<MilestoneKind, MilestoneDates>> = {};
    for (const row of held) dates[row.milestone_kind] = { plannedAt: row.planned_at, actualAt: row.actual_at };
    const issue = milestoneOrderIssue(dates, { kind: input.kind, plannedAt, actualAt });
    if (issue !== undefined) throw new DomainError('MILESTONE_ORDER_INVALID', 409, issue.field, { extensions: { field: issue.field, earlier_kind: issue.earlier, later_kind: issue.later } });

    const current = held.find((row) => row.milestone_kind === input.kind);
    const nextPlanned = plannedAt ?? current?.planned_at ?? null;
    const nextActual = actualAt ?? current?.actual_at ?? null;
    if (current === undefined) {
      await tx.query(
        `insert into machvon.procurement_milestone (tenant_id, id, package_id, milestone_kind, planned_at, actual_at, source, created_by, updated_by, version)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, 'MANUAL', $6::uuid, $6::uuid, 1)`,
        [randomUUID(), pack.id, input.kind, nextPlanned, nextActual, actor],
      );
    } else {
      await tx.query(
        `update machvon.procurement_milestone
            set planned_at = $2::timestamptz, actual_at = $3::timestamptz, source = 'MANUAL', import_batch_id = null, updated_at = now(), updated_by = $4::uuid, version = version + 1
          where id = $1::uuid`,
        [current.id, nextPlanned, nextActual, actor],
      );
    }
    const version = Number(pack.version) + 1;
    await tx.query('update machvon.procurement_package set version = $2::bigint where id = $1::uuid', [pack.id, version]);
    const settledDifference = await this.settle(tx, pack, input.kind, nextActual, actor);
    return {
      packageId: pack.id,
      packageCode: pack.code,
      projectId: pack.project_id,
      kind: input.kind,
      plannedAt: nextPlanned,
      actualAt: nextActual,
      source: 'MANUAL',
      version,
      created: current === undefined,
      previous: current === undefined ? null : { plannedAt: current.planned_at, actualAt: current.actual_at, source: current.source },
      settledDifference,
    };
  }

  /** A difference of this milestone with the file of the national network is settled when the register now has the day the file gave. */
  private async settle(tx: TenantTx, pack: PackageSql, kind: MilestoneKind, actualAt: string | null, actor: string): Promise<boolean> {
    const link = await this.links.lock(tx, pack.id);
    const disagreement = link?.diff.milestones?.[kind];
    if (link === undefined || disagreement === undefined || actualAt === null) return false;
    if (vietnamDayOf(actualAt) !== vietnamDayOf(disagreement.file)) {
      // The register still disagrees, now with the date the planner gave.
      await this.links.save(tx, link, diffWithMilestone(link.diff, kind, { register: actualAt, file: disagreement.file }), link.diffOwnerId ?? actor, actor);
      return false;
    }
    await this.links.save(tx, link, diffWithMilestone(link.diff, kind, undefined), link.diffOwnerId ?? actor, actor);
    return true;
  }

  private async lockPackage(tx: TenantTx, packageId: string, scope: ScopeBuilder): Promise<PackageSql> {
    const predicate = scope(2);
    const rows = await tx.query<PackageSql>(
      `select k.id, k.code, k.status, k.version::text as version, k.project_id, k.created_by
         from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
        where k.id = $1::uuid and ${predicate.sql} for update of k`,
      [packageId, ...predicate.params],
    );
    // A package of another tenant or outside the scope of the caller does not exist for them.
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  /** The milestones of the packages of the projects in the scope of the caller, optionally of one package or one project, by package and the order of the milestones. */
  async list(tx: TenantTx, scope: ScopeBuilder, filter: { projectId?: string | undefined; packageId?: string | undefined }): Promise<ProcurementMilestoneLine[]> {
    const predicate = scope(3);
    const rows = await tx.query<MilestoneSql & { package_id: string }>(
      `select m.id, m.package_id, m.milestone_kind, to_char(m.planned_at at time zone 'UTC', ${ISO}) as planned_at, to_char(m.actual_at at time zone 'UTC', ${ISO}) as actual_at,
              m.source, m.import_batch_id, m.version::text as version
         from ${SCOPE_FROM} join machvon.procurement_package k on k.tenant_id = p.tenant_id and k.project_id = p.id
         join machvon.procurement_milestone m on m.tenant_id = k.tenant_id and m.package_id = k.id
        where ($1::uuid is null or p.id = $1::uuid) and ($2::uuid is null or k.id = $2::uuid) and ${predicate.sql}
        order by k.code, k.id, array_position(array[${MILESTONE_KINDS.map((kind) => `'${kind}'`).join(',')}], m.milestone_kind)`,
      [filter.projectId ?? null, filter.packageId ?? null, ...predicate.params],
    );
    return rows.map((row) => toLine(row.package_id, row));
  }
}
