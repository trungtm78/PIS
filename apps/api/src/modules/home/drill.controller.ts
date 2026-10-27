import { randomBytes, randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { AuditWriter, DisSnapshotStore, HomeDrillStore, HomeStore, TenantDatabase, projectScope, scopePredicate } from '@machvon/db';
import type { PeriodSnapshotLineRow as SnapshotLineRow, ScopeBuilder } from '@machvon/db';
import { DomainError, addSums, drillChildTile, drillDimensions, drillLevelOf, expiredHomeContext, parseHomeContext, reconcileChildren, signHomeContext } from '@machvon/kernel';
import type { DrillDimension, EffectiveAccess, HomeContext, HomeTile, RateSums, SignedHomeContext, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_READ_PERMISSION, scopeHashOf } from './scope-hash';
import { HOME_CLOCK, HOME_CONTEXT_KEY } from './tokens';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DRILL_DENIED_ACTION = 'home.drill_denied';
const RESOURCE_TYPE = 'home_drill';
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const unitScope =
  (access: EffectiveAccess, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, HOME_READ_PERMISSION, now, { unitPath: 'u.path', unitId: 'u.id' }, first);

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = typeof value === 'string' && /^[0-9]{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) throw invalid('limit');
  return parsed;
}

const encode = (parts: readonly string[]): string => Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
function decode(cursor: unknown, size: number): string[] | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || cursor === '') throw invalid('cursor');
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === size && parts.every((part) => typeof part === 'string')) return parts as string[];
  } catch {
    // falls through to the refusal below
  }
  throw invalid('cursor');
}

interface Child {
  dimension: DrillDimension;
  id: string;
  code: string;
  name: string;
  tile: HomeTile;
  context: Pick<HomeContext, 'unitId' | 'unitExact' | 'projectId' | 'lineId'>;
}

const sumsOfLine = (line: SnapshotLineRow): RateSums => ({
  projects: 1,
  planPmVnd: line.planPmAssignedVnd,
  planLocalVnd: line.planLocalAddedVnd,
  treasuryVnd: line.disbursedTreasuryVnd,
  reportedVnd: line.disbursedReportedVnd,
  ctmtqgVnd: line.ctmtqgSubsetVnd,
  allNone: line.treasuryCoverage === 'NONE',
  allComplete: line.treasuryCoverage === 'COMPLETE',
});

/**
 * The drill of a figure of the command center (ST-HOME-002, HOME 3 F2, HOME-10, BR-HOME-03, BR-HOME-08): the token of a tile (or of a child of a drill) says which metric, over which snapshot, narrowed to which unit, project and
 * cell. Each step reads the token back (400 for a token that was altered, of another tenant or another member; 409 SNAPSHOT_EXPIRED for one that is old, with the snapshot to ask again for), keeps the snapshot (a newer
 * one is never taken), and judges the right to read again as it is now: a unit or a project that is no longer in the scope of the reader is a 403 SCOPE_DENIED that names nothing, and is recorded (`home.drill_denied`).
 * The children are of one dimension (units, projects, cells of a project), each with its figure, numerator and denominator and a token to go on; for money the server says whether they add up to the parent to the dong,
 * for a ratio it says that they do not (`RATIO`). From a project or a cell the way goes on to the report revisions the figures came from and the Treasury transactions up to the cutoff of the snapshot.
 */
@Controller()
export class HomeDrillController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly home = new HomeStore();
  private readonly drill = new HomeDrillStore();
  private readonly audit: AuditWriter;
  private readonly clock: () => Date;
  private readonly key: Buffer;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
    @Optional() @Inject(HOME_CONTEXT_KEY) key?: Buffer,
  ) {
    this.audit = new AuditWriter(database);
    this.clock = clock ?? ((): Date => new Date());
    this.key = key ?? randomBytes(32);
  }

  @Get('home/drill')
  @OperationId('explainHomeMetric')
  async explain(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('context_token') contextToken?: unknown,
    @Query('child_dimension') childDimension?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<Record<string, unknown>> {
    if (typeof contextToken !== 'string' || contextToken === '') throw invalid('context_token');
    const page = limitOf(limit);
    const now = this.clock();
    const seconds = (): number => Math.floor(now.getTime() / 1000);
    const context = parseHomeContext(contextToken, this.key);
    // A token is the member's own, of this tenant: another member's or another tenant's is a token that is not valid, old or not, and says nothing more (it is not told where to ask again either).
    if (context.tenantId !== tenant.tenantId || context.membershipId !== tenant.membershipId) throw new DomainError('INVALID_REQUEST', 400);
    if (context.exp <= seconds()) throw expiredHomeContext(context);
    const level = drillLevelOf(context);
    const allowed = drillDimensions(level, context.unitExact);
    if (childDimension !== undefined && (typeof childDimension !== 'string' || !(allowed as readonly string[]).includes(childDimension))) throw invalid('child_dimension');
    const dimension = (childDimension as DrillDimension | undefined) ?? allowed[0];
    // The cursor pages the children where there can be many (the units and the projects of a scope), and the Treasury transactions where the way goes on to the sources (a project, a cell).
    const pagesChildren = level === 'SCOPE' || level === 'UNIT';
    const after = decode(cursor, 2);
    // Below a unit the cursor is the moment and the id of the last transaction: what is not one is refused here, and does not reach the database.
    if (!pagesChildren && after !== undefined && (!ISO_INSTANT.test(after[0] ?? '') || !UUID.test(after[1] ?? ''))) throw invalid('cursor');
    const projects = projectScope(access, HOME_READ_PERMISSION, now);
    const units = unitScope(access, now);

    const read = await this.database.withTenant(tenant, async (tx) => {
      const snapshot = await this.snapshots.find(tx, context.snapshotId);
      if (snapshot === undefined || (snapshot.status !== 'FROZEN' && snapshot.status !== 'SUPERSEDED')) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
      // The right is judged again, as it is now, at the unit and at the project the token names.
      // A unit is the reader's by a grant of units, or by the projects of it that they may read (a grant of one project, an investor unit): the second gives no more than those projects.
      if (context.unitId !== null && !(await this.home.unitReadable(tx, units, context.unitId)) && !(await this.drill.unitContributes(tx, projects, { snapshotId: snapshot.id, unitId: context.unitId, exact: context.unitExact }))) return { denied: true as const };
      const project = context.projectId === null ? undefined : await this.drill.project(tx, projects, context.projectId);
      if (context.projectId !== null && project === undefined) return { denied: true as const };
      // The unit of a child of a drill is that unit alone; the unit of a tile of the center is that unit and the units under it.
      const query = { basis: 'CURRENT_YEAR' as const, ...(context.unitExact ? { unitId: context.unitId ?? undefined } : { underUnitId: context.unitId ?? undefined }) };
      let line: SnapshotLineRow | undefined;
      let lines: SnapshotLineRow[] = [];
      if (context.projectId !== null) {
        lines = await this.snapshots.lines(tx, snapshot.id, projects, { projectId: context.projectId }, { limit: 200, after: undefined });
        if (context.lineId !== null) {
          line = lines.find((candidate) => candidate.id === context.lineId);
          if (line === undefined) return { denied: true as const };
        }
      }
      const parentSums =
        line !== undefined
          ? sumsOfLine(line)
          : context.projectId !== null
            ? addSums(lines.filter((candidate) => candidate.bucket === 'CURRENT_YEAR').map(sumsOfLine))
            : addSums((await this.snapshots.rateSums(tx, snapshot.id, projects, { ...query, groupBy: 'NONE' })).map((row) => row.sums));
      let groups: Array<{ id: string | null; code: string | null; name: string | null; sums: RateSums }> = [];
      if (dimension === 'unit') groups = await this.snapshots.rateSums(tx, snapshot.id, projects, { ...query, groupBy: 'UNIT' });
      else if (dimension === 'project') groups = await this.snapshots.rateSums(tx, snapshot.id, projects, { ...query, groupBy: 'PROJECT' });
      const revisions = project === undefined ? [] : await this.drill.revisions(tx, { snapshotId: snapshot.id, projectId: project.id, lineId: context.lineId ?? undefined });
      const fiscalYear = project === undefined ? undefined : await this.drill.fiscalYearOf(tx, snapshot.periodId);
      const transactions =
        project === undefined || fiscalYear === undefined
          ? { items: [], more: false }
          : await this.drill.transactions(tx, { projectId: project.id, fiscalYear, cutoffDate: snapshot.treasuryCutoffDate, observedAt: snapshot.createdAt, limit: page, after: pagesChildren || after === undefined ? undefined : { confirmedAt: after[0] ?? '', id: after[1] ?? '' } });
      const unit = context.unitId === null ? undefined : await this.home.unitName(tx, context.unitId);
      return { denied: false as const, snapshot, project, unit, line, lines, parentSums, groups, revisions, transactions };
    });

    if (read.denied) {
      // Nothing of the place is told: the refusal is recorded without a name, and the screen says the right is gone.
      await this.audit.recordDenied(tenant, {
        action: DRILL_DENIED_ACTION,
        resourceType: RESOURCE_TYPE,
        resourceId: context.snapshotId,
        diff: { metric_code: context.metricCode, level },
        correlationId: randomUUID(),
        requestId: randomUUID(),
      });
      throw new DomainError('SCOPE_DENIED', 403);
    }
    const { snapshot } = read;
    const definition = snapshot.definitionStatus;
    const parent = drillChildTile(context.metricCode, read.parentSums, definition);
    const children: Child[] = [];
    const mint = (inherited: Pick<HomeContext, 'unitId' | 'unitExact' | 'projectId' | 'lineId'>, metricCode: string): string =>
      signHomeContext({ tenantId: tenant.tenantId, membershipId: tenant.membershipId, snapshotId: snapshot.id, scopeHash: scopeHashOf(tenant, access, inherited.unitId, now), metricCode, ...inherited }, this.key, seconds);
    if (dimension === 'unit') {
      for (const group of read.groups) children.push({ dimension, id: group.id ?? '', code: group.code ?? '', name: group.name ?? '', tile: drillChildTile(context.metricCode, group.sums, definition), context: { unitId: group.id, unitExact: true, projectId: null, lineId: null } });
    } else if (dimension === 'project') {
      for (const group of read.groups) children.push({ dimension, id: group.id ?? '', code: group.code ?? '', name: group.name ?? '', tile: drillChildTile(context.metricCode, group.sums, definition), context: { unitId: context.unitId, unitExact: context.unitExact, projectId: group.id, lineId: null } });
    } else if (dimension === 'cell') {
      for (const line of read.lines.filter((candidate) => candidate.bucket === 'CURRENT_YEAR')) {
        children.push({ dimension, id: line.id, code: `${line.bucket}|${line.budgetLevel}`, name: `${line.bucket} · ${line.budgetLevel}`, tile: drillChildTile(context.metricCode, sumsOfLine(line), definition), context: { unitId: context.unitId, unitExact: context.unitExact, projectId: context.projectId, lineId: line.id } });
      }
    }
    children.sort((left, right) => left.code.localeCompare(right.code, 'en') || left.id.localeCompare(right.id, 'en'));
    // The check is over every child, whatever page is shown: the server says whether they add up (BR-HOME-03).
    const reconciliation = reconcileChildren(parent.unit, parent.value, children.map((child) => child.tile.value));
    const start = !pagesChildren || after === undefined ? 0 : Math.max(children.findIndex((child) => child.code === after[0] && child.id === after[1]) + 1, 0);
    // Below a unit the cursor pages the sources, so the cells are given once, with the first page (a page that follows does not repeat them).
    const shown = pagesChildren ? children.slice(start, start + page) : after === undefined ? children : [];
    const last = shown[shown.length - 1];
    const more = pagesChildren && start + shown.length < children.length;
    const exclusions: Array<Record<string, unknown>> = children.filter((child) => child.tile.value === null).map((child) => ({ dimension: child.dimension, id: child.id, code: child.code, reason: child.tile.nullReason }));
    if (parent.value === null) exclusions.unshift({ dimension: null, id: null, code: context.metricCode, reason: parent.nullReason });
    const sources: Array<Record<string, unknown>> = [];
    if (cursor === undefined) for (const revision of read.revisions) sources.push({ kind: 'REPORT_REVISION', id: revision.id, revision: revision.revision, status: revision.status, submitted_at: revision.submittedAt, accepted_at: revision.acceptedAt });
    for (const transaction of read.transactions.items) sources.push({ kind: 'TREASURY_TRANSACTION', id: transaction.id, external_id: transaction.externalId, amount_vnd: transaction.amountVnd, contribution_vnd: transaction.reversalOfId === null ? transaction.amountVnd : (-BigInt(transaction.amountVnd)).toString(), confirmed_at: transaction.confirmedAt, reversal_of_id: transaction.reversalOfId });
    const lastTransaction = read.transactions.items[read.transactions.items.length - 1];
    const nextCursor = pagesChildren ? (more && last !== undefined ? encode([last.code, last.id]) : null) : read.transactions.more && lastTransaction !== undefined ? encode([lastTransaction.confirmedAt, lastTransaction.id]) : null;
    const expectedHash = scopeHashOf(tenant, access, context.unitId, now);
    return {
      context_token: mint({ unitId: context.unitId, unitExact: context.unitExact, projectId: context.projectId, lineId: context.lineId }, context.metricCode),
      metric_code: context.metricCode,
      level,
      snapshot_id: snapshot.id,
      as_of_date: snapshot.asOfDate,
      treasury_cutoff_date: snapshot.treasuryCutoffDate,
      definition_status: definition,
      // A token made under another scope is still read, over the scope the reader has now; the screen is told, so that it offers a new reading.
      scope_changed: context.scopeHash !== expectedHash,
      // The scope the reader is read in now: two pages of one reading that name different scopes are not one reading.
      scope_hash: expectedHash,
      scope: { unit_id: context.unitId, unit_name: read.unit ?? null, project_id: context.projectId, project_code: read.project?.code ?? null, project_name: read.project?.name ?? null, line_id: context.lineId },
      formula: parent.formula,
      unit: parent.unit,
      value: parent.value,
      numerator: parent.numerator,
      denominator: parent.denominator,
      null_reason: parent.nullReason,
      child_dimension: dimension ?? null,
      child_dimensions: allowed,
      exclusions,
      children: shown.map((child) => ({
        dimension: child.dimension,
        id: child.id,
        code: child.code,
        name: child.name,
        value: child.tile.value,
        numerator: child.tile.numerator,
        denominator: child.tile.denominator,
        null_reason: child.tile.nullReason,
        context_token: mint(child.context, context.metricCode),
      })),
      // A cell has no children to add up; there is nothing that fails to.
      reconciles_to_parent: children.length === 0 ? true : reconciliation.reconcilesToParent,
      non_additive_reason: reconciliation.nonAdditiveReason,
      source_records: sources,
      next_cursor: nextCursor,
    };
  }
}

export type { SignedHomeContext };
