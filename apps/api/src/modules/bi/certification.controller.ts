import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
import { AnalyticsGovernanceStore, TenantDatabase } from '@machvon/db';
import type { CertPerson, CertificationView } from '@machvon/db';
import { CERT_SUBJECTS, DomainError, isCertStatus, isCertSubject, vietnamDateOf } from '@machvon/kernel';
import type { CertStatus, CertSubject, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_CLOCK } from '../home/tokens';

const RESOURCE_TYPE = 'analytics_certification';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const personView = (person: CertPerson | null): { id: string; name: string } | null => (person === null ? null : { id: person.id, name: person.name });
const stateView = (view: CertificationView): Record<string, unknown> => ({ status: view.status, version: view.version, origin: view.origin, certified_by: personView(view.actor !== null && view.status === 'CERTIFIED' ? view.actor : null), confirmed_by: personView(view.confirmedBy), note: view.note, at: view.at });

/**
 * The certification of figures and data (G3-1, BI and HOME): a definition of the KPI register and a BI dataset are Nháp, Đã xác nhận, Đã chứng nhận or Lỗi thời, with who moved it, when, and for which version. The leader's
 * dashboards and the command center give a leader only a figure whose definition is certified; a dataset that is not certified says so on the numbers made of it. The metrics keep the certification they already have in their
 * registry (a publication request decided by someone other than its author, ST-BI-006): this list reads them in the same four words and does not certify them a second time. A person confirms, another certifies (maker is
 * not checker, in the code and in the table); sending back and making obsolete need words; the version must be the one in force now; and every move is an append-only line with an audit row and an event.
 */
@Controller()
export class AnalyticsCertificationController {
  private readonly store = new AnalyticsGovernanceStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('bi/certifications')
  @OperationId('listAnalyticsCertifications')
  async list(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const today = vietnamDateOf(this.clock());
    const read = await this.database.withTenant(tenant, async (tx) => {
      const definitions = await this.store.kpiDefinitions(tx, today);
      return { definitions, certifications: await this.store.kpiCertifications(tx, definitions.values()), datasets: await this.store.datasetCertifications(tx), metrics: await this.store.metricCertifications(tx) };
    });
    return {
      as_of: today,
      kpis: [...read.definitions.values()]
        .sort((left, right) => left.code.localeCompare(right.code, 'en'))
        .map((definition) => {
          const certification = read.certifications.get(definition.code) as CertificationView;
          return { code: definition.code, name: definition.name, unverified: definition.unverified, definition_origin: definition.origin, ...stateView(certification) };
        }),
      datasets: read.datasets.map((dataset) => ({ dataset_id: dataset.datasetId, code: dataset.code, title: dataset.title, dataset_status: dataset.datasetStatus, last_certified_version: dataset.lastCertifiedVersion, ...stateView(dataset) })),
      // The metrics are read from the registry of BI: certify them through a publication request there.
      metrics: read.metrics.map((metric) => ({ metric_id: metric.id, code: metric.code, revision: metric.revision, status: metric.status, registry_status: metric.registryStatus, origin: metric.origin, certified_by: personView(metric.certifiedBy), at: metric.certifiedAt })),
    };
  }

  @Get('bi/certifications/:subject/:key/log')
  @OperationId('getAnalyticsCertificationLog')
  async log(@CurrentTenant() tenant: TenantContext, @Param('subject') subject: string, @Param('key') key: string): Promise<Record<string, unknown>> {
    if (!isCertSubject(subject)) throw invalid('subject');
    if (!KEY.test(key) || (subject === 'DATASET' && !UUID.test(key))) throw invalid('key');
    const lines = await this.database.withTenant(tenant, (tx) => this.store.log(tx, subject, key));
    return { subject, key, lines: lines.map((line) => ({ version: line.version, seq: line.seq, status: line.status, actor: personView(line.actor), confirmed_by: personView(line.confirmedBy), note: line.note, at: line.at })) };
  }

  @Post('bi/certifications/transitions')
  @HttpCode(200)
  @OperationId('transitionAnalyticsCertification')
  @Command({ operation: 'transitionAnalyticsCertification' })
  async transition(@Scope() scope: CommandScope, @Body() body: Schemas['AnalyticsCertificationTransition']): Promise<CommandResult> {
    const now = this.clock();
    const subject = body.subject as CertSubject;
    if (!(CERT_SUBJECTS as readonly string[]).includes(subject)) throw invalid('subject');
    const to = body.to as CertStatus;
    if (!isCertStatus(to)) throw invalid('to');
    if (typeof body.key !== 'string' || !KEY.test(body.key) || (subject === 'DATASET' && !UUID.test(body.key))) throw invalid('key');
    if (!Number.isInteger(body.version) || body.version < 0) throw invalid('version');
    const key = subject === 'DATASET' ? body.key.toLowerCase() : body.key;
    // The version a certificate is for must be the one in force: a certificate of a definition that is no longer the one that governs is not given, and the built-in default is certified by the review of the repository.
    if (subject === 'KPI') {
      const definition = await this.store.kpiDefinition(scope.tx, key, vietnamDateOf(now));
      if (definition === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'key');
      if (definition.version === 0 || definition.version !== body.version) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'version');
    } else {
      const current = await this.store.datasetVersion(scope.tx, key);
      if (current === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'key');
      if (current !== body.version) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'version');
    }
    const moved = await this.store.transition(scope.tx, { subject, key, version: body.version, to, actor: scope.tenant.membershipId, note: body.note, now });
    const facts = { subject, key, version: body.version, from_status: moved.previous, to_status: moved.line.status, confirmed_by: moved.line.confirmedBy, seq: moved.seq };
    await scope.audit({ action: 'bi.certification_moved', resourceType: RESOURCE_TYPE, resourceId: moved.id, ...(moved.line.note === null ? {} : { reason: moved.line.note }), diff: facts });
    await scope.emit({ aggregateType: RESOURCE_TYPE, aggregateId: moved.id, aggregateVersion: moved.seq, type: 'bi.certification_moved.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...facts }, eventKey: `analytics_certification:${moved.id}` });
    return commandResult(scope, moved.line.status, moved.seq, moved.id);
  }
}
