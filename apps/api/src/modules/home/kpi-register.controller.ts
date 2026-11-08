import { createHash, randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { AnalyticsGovernanceStore, AuditWriter, TenantDatabase } from '@machvon/db';
import { DomainError, buildHomeExportDocument, csvOf, isRuleDay, message, vietnamDateOf, xlsxOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HomeFigureReader } from './figures';
import type { Figure } from './figures';
import { DOCX_MEDIA_TYPE, docxOf } from '../reports';
import { HOME_CLOCK } from './tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ['CSV', 'XLSX', 'DOCX'] as const;
type Format = (typeof FORMATS)[number];
const MEDIA_TYPE: Readonly<Record<Format, string>> = { CSV: 'text/csv; charset=utf-8', XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', DOCX: DOCX_MEDIA_TYPE };
const EXTENSION: Readonly<Record<Format, string>> = { CSV: 'csv', XLSX: 'xlsx', DOCX: 'docx' };
const EXPORT_ACTION = 'home.figures_exported';
const RESOURCE_TYPE = 'home_figures';
const DENOMINATORS = ['PM_ASSIGNED', 'TOTAL'] as const;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/**
 * The KPI register of HOME and BI (G0-4): one definition for each indicator (formula, numerator, denominator, what is left out, period, source, owner, how late it may be), kept as `KPI_DEFINITION` rules of the
 * governance store with their versions, read here with the certification of the version in force. And the file of the figures of the command center: the lines carry the text of the value exactly as the screen and the phone
 * write it, so a number taken out of the system is the number on the screen.
 */
@Controller()
export class KpiRegisterController {
  private readonly register = new AnalyticsGovernanceStore();
  private readonly figures: HomeFigureReader;
  private readonly audit: AuditWriter;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.figures = new HomeFigureReader(database);
    this.audit = new AuditWriter(database);
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/kpi-register')
  @OperationId('getKpiRegister')
  async list(@CurrentTenant() tenant: TenantContext, @Query('as_of') asOf?: unknown): Promise<Record<string, unknown>> {
    if (asOf !== undefined && (typeof asOf !== 'string' || !isRuleDay(asOf))) throw invalid('as_of');
    const day = (asOf as string | undefined) ?? vietnamDateOf(this.clock());
    const read = await this.database.withTenant(tenant, async (tx) => {
      const definitions = await this.register.kpiDefinitions(tx, day);
      return { definitions, certifications: await this.register.kpiCertifications(tx, definitions.values()) };
    });
    const items = [...read.definitions.values()]
      .sort((left, right) => left.code.localeCompare(right.code, 'en'))
      .map((definition) => {
        const certification = read.certifications.get(definition.code);
        return {
          code: definition.code,
          name: definition.name,
          formula: definition.formula,
          numerator: definition.numerator,
          denominator: definition.denominator,
          exclusions: definition.exclusions,
          unit: definition.unit,
          period: definition.period,
          source: definition.source,
          owner: definition.owner,
          decimals: definition.decimals,
          refresh_hours: definition.refreshHours,
          allowed_lag_days: definition.allowedLagDays,
          rag_code: definition.ragCode,
          version: definition.version,
          origin: definition.origin,
          unverified: definition.unverified,
          certification: certification === undefined ? null : { status: certification.status, version: certification.version, origin: certification.origin, certified_by: certification.status === 'CERTIFIED' ? (certification.actor?.name ?? null) : null, at: certification.at },
        };
      });
    return { as_of: day, definitions: items };
  }

  @Get('home/command-center/export')
  @OperationId('exportHomeFigures')
  async exportFigures(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('format') format?: unknown,
    @Query('snapshot_id') snapshotId?: unknown,
    @Query('unit_id') unitId?: unknown,
    @Query('denominator_kind') denominatorKind?: unknown,
  ): Promise<Record<string, unknown>> {
    const kind = (format ?? 'XLSX') as Format;
    if (typeof kind !== 'string' || !(FORMATS as readonly string[]).includes(kind)) throw invalid('format');
    if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !UUID.test(snapshotId))) throw invalid('snapshot_id');
    if (unitId !== undefined && (typeof unitId !== 'string' || !UUID.test(unitId))) throw invalid('unit_id');
    if (denominatorKind !== undefined && (typeof denominatorKind !== 'string' || !(DENOMINATORS as readonly string[]).includes(denominatorKind))) throw invalid('denominator_kind');
    const now = this.clock();
    const today = vietnamDateOf(now);
    const read = await this.figures.read(tenant, access, { snapshotId: snapshotId as string | undefined, unitId: unitId as string | undefined }, now, today);
    const all: Figure[] = [...read.tiles, ...read.countTiles];
    const document = buildHomeExportDocument({
      snapshotId: read.snapshot.id,
      asOfDate: read.snapshot.asOfDate,
      treasuryCutoffDate: read.snapshot.treasuryCutoffDate,
      definitionStatus: read.snapshot.definitionStatus,
      scopeText: unitId === undefined ? message('home.kpi_register.scope_all') : `unit:${unitId as string}`,
      createdAt: now,
      rows: all.map((figure) => ({
        code: figure.metric_code,
        name: figure.kpi?.name ?? figure.metric_code,
        displayValue: figure.display_value,
        unit: figure.unit,
        numerator: figure.numerator,
        denominator: figure.denominator,
        nullReason: figure.null_reason,
        flags: figure.flags,
        certification: figure.certification?.status ?? '',
        definitionVersion: figure.kpi?.version ?? 0,
        asOfDate: figure.kpi?.asOf ?? read.snapshot.asOfDate,
        formula: figure.kpi?.formula ?? figure.formula,
        source: figure.kpi?.source ?? '',
        owner: figure.kpi?.owner ?? '',
      })),
    });
    const bytes: Uint8Array = kind === 'CSV' ? new Uint8Array(Buffer.from(csvOf(document), 'utf8')) : kind === 'DOCX' ? await docxOf(document) : xlsxOf(document);
    // A file of figures leaves the system: it is a record of who took which figures out (classification of the figures, not their content).
    await this.audit.record(tenant, {
      action: EXPORT_ACTION,
      resourceType: RESOURCE_TYPE,
      resourceId: read.snapshot.id,
      classification: 'CONFIDENTIAL',
      diff: { snapshot_id: read.snapshot.id, format: kind, rows: all.length, unit_id: unitId ?? null, size_bytes: bytes.length, file_sha256: createHash('sha256').update(bytes).digest('hex') },
      correlationId: randomUUID(),
      requestId: randomUUID(),
    });
    return {
      file_name: `chi-tieu-trung-tam-dieu-hanh-${read.snapshot.asOfDate}.${EXTENSION[kind]}`,
      media_type: MEDIA_TYPE[kind],
      format: kind,
      snapshot_id: read.snapshot.id,
      as_of_date: read.snapshot.asOfDate,
      rows: all.length,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content_base64: Buffer.from(bytes).toString('base64'),
    };
  }
}
