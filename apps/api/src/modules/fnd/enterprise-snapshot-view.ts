import { PERMISSIONS } from '@machvon/contracts';
import type { EnterpriseReadiness, EnterpriseSnapshotRow } from '@machvon/db';
import { DomainError, asUuid, effectivePermissions, holdsPermission } from '@machvon/kernel';
import type { EffectiveAccess, EnterpriseFigureReader, FundingMeasure, FundingPack, SnapshotIndicator } from '@machvon/kernel';
import { cellDto, moneyDto, periodDto, rateDto } from './figure-view';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** A query value that must be one non-empty string or absent. */
export function queryText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') throw invalid(field);
  return value;
}

export function queryUuid(value: unknown, field: string): string | undefined {
  const raw = queryText(value, field);
  if (raw === undefined) return undefined;
  const id = asUuid(raw);
  if (id === undefined) throw invalid(field);
  return id.toLowerCase();
}

export function queryLimit(value: unknown, fallback: number, max: number): number {
  const raw = queryText(value, 'limit');
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw invalid('limit');
  return Number(raw);
}

/** What the caller may do with a snapshot, from the permissions it holds in any grant (the command judges again with the scope of the whole tenant and the rule that the builder does not freeze). */
export function snapshotActions(access: EffectiveAccess, now: Date, row: EnterpriseSnapshotRow | null, member: string): { build: boolean; freeze: boolean } {
  const held = effectivePermissions(access, now);
  return {
    build: holdsPermission(held, PERMISSIONS.buildEnterpriseSnapshot),
    freeze: row !== null && row.status === 'BUILDING' && row.createdBy !== member && holdsPermission(held, PERMISSIONS.freezeEnterpriseSnapshot),
  };
}

export function snapshotDto(row: EnterpriseSnapshotRow): Record<string, unknown> {
  return {
    id: row.id,
    period_id: row.periodId,
    period_code: row.periodCode,
    status: row.status,
    revision: row.revision,
    version: row.version,
    payload_sha256: row.payloadSha256,
    taxonomy_pack: row.taxonomyPack,
    taxonomy_version: row.taxonomyVersion,
    hash_schema: row.hashSchema,
    definition_status: row.definitionStatus,
    row_count: row.rowCount,
    figure_count: row.figureCount,
    indicator_count: row.indicatorCount,
    as_of_at: row.asOfAt,
    as_of_date: row.asOfDate,
    supersedes_id: row.supersedesId,
    frozen_by: row.frozenBy,
    frozen_at: row.frozenAt,
    created_at: row.createdAt,
    created_by: row.createdBy,
  };
}

export function readinessDto(ready: EnterpriseReadiness, canBuild: boolean): Record<string, unknown> {
  return {
    period: ready.period,
    pack: { code: ready.pack.code, version: ready.pack.version, unverified: ready.pack.unverified },
    complete: ready.completeness.complete,
    planned_cells: ready.completeness.plannedCells,
    projects: ready.completeness.projects,
    missing_units: ready.completeness.missingUnits.map((unit) => ({
      unit_id: unit.unitId,
      unit_code: unit.unitCode,
      projects: unit.projects.map((project) => ({
        project_id: project.projectId,
        project_code: project.projectCode,
        cells: project.cells.map((cell) => ({ class_code: cell.classCode, tier_code: cell.tierCode, measure: cell.measure, months: cell.months })),
      })),
    })),
    waiting_batches: ready.waitingBatches.map((batch) => ({ project_id: batch.projectId, project_code: batch.projectCode, batch_id: batch.batchId })),
    frozen: ready.frozen === null ? null : { id: ready.frozen.id, revision: ready.frozen.revision, payload_sha256: ready.frozen.payloadSha256 },
    rebuild_allowed: ready.rebuildAllowed,
    actions: { build: canBuild },
  };
}

export const indicatorDto = (row: SnapshotIndicator, projectCode: string, unitCode: string): Record<string, unknown> => ({
  project_id: row.projectId,
  project_code: projectCode,
  unit_id: row.unitId,
  unit_code: unitCode,
  indicator_code: row.indicatorCode,
  value: row.value,
  unit: row.unit,
  definition_version: row.definitionVersion,
  revision: row.revision,
  source_figure_id: row.sourceFigureId,
});

export interface NamedRow {
  id: string;
  code: string;
  name: string;
}

/** The body of the detail read: every number comes from the one reader, in total, by class, by unit and by project, each rate with its numerator and denominator. */
export function detailDto(input: {
  row: EnterpriseSnapshotRow;
  reader: EnterpriseFigureReader;
  pack: FundingPack;
  measure: FundingMeasure;
  projectIds: readonly string[];
  projectNames: ReadonlyMap<string, NamedRow>;
  unitNames: ReadonlyMap<string, NamedRow>;
  lineage: readonly EnterpriseSnapshotRow[];
  hashVerified: boolean | null;
  actions: { build: boolean; freeze: boolean };
  partial: boolean;
}): Record<string, unknown> {
  const { reader, measure, pack } = input;
  const all = { projectIds: input.projectIds };
  const unitIds = [...new Set(input.projectIds.map((id) => reader.unitOfProject(id)).filter((id): id is string => id !== undefined))].sort();
  const nameOf = (map: ReadonlyMap<string, NamedRow>, id: string): NamedRow => map.get(id) ?? { id, code: id, name: id };
  return {
    snapshot: snapshotDto(input.row),
    period: { ...periodDto(reader.view.period), code: input.row.periodCode },
    pack: { code: pack.packCode, label: pack.label, version: input.row.taxonomyVersion, measures: [...pack.measures], classes: pack.classes.map((one) => ({ code: one.code, label: one.label, additive: one.additive })) },
    measure,
    partial: input.partial,
    totals: {
      money: reader.money(all, measure).map(moneyDto),
      by_class: pack.classes.map((one) => ({ class_code: one.code, money: reader.money(all, measure, one.code).map(moneyDto) })),
      rates: reader.rates(all, measure).map(rateDto),
      total_investment_vnd: reader.totalInvestment(all),
      rate_since_start: reader.rateSinceStart(all, measure),
    },
    by_unit: unitIds.map((unitId) => {
      const scope = { projectIds: input.projectIds.filter((id) => reader.unitOfProject(id) === unitId) };
      const unit = nameOf(input.unitNames, unitId);
      return { unit_id: unitId, unit_code: unit.code, unit_name: unit.name, projects: scope.projectIds.length, money: reader.money(scope, measure).map(moneyDto), rates: reader.rates(scope, measure).map(rateDto) };
    }),
    projects: input.projectIds.map((projectId) => {
      const scope = { projectIds: [projectId] };
      const project = nameOf(input.projectNames, projectId);
      const unitId = reader.unitOfProject(projectId) ?? '';
      const own = reader.figures(scope, measure)[0];
      return {
        project_id: projectId,
        project_code: project.code,
        project_name: project.name,
        unit_id: unitId,
        unit_code: nameOf(input.unitNames, unitId).code,
        tmdt_in_force_vnd: reader.totalInvestment(scope),
        cells: own === undefined ? [] : own.cells.map(cellDto),
        money: reader.money(scope, measure).map(moneyDto),
        rates: reader.rates(scope, measure).map(rateDto),
      };
    }),
    indicators: reader.indicatorFigures(all).map((one) => indicatorDto(one, nameOf(input.projectNames, one.projectId).code, nameOf(input.unitNames, one.unitId).code)),
    lineage: input.lineage.map((one) => ({ id: one.id, revision: one.revision, status: one.status, payload_sha256: one.payloadSha256, frozen_at: one.frozenAt, supersedes_id: one.supersedesId })),
    hash_verified: input.hashVerified,
    actions: input.actions,
    as_of: reader.view.asOfDate,
  };
}
