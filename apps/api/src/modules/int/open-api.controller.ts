import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ExportDatasetStore, OpenReads } from '@machvon/db';
import type { OpenPage } from '@machvon/db';
import { DomainError, OPEN_DATASET_DEFINITIONS, OPEN_DATASETS, asUuid } from '@machvon/kernel';
import { IdentityCommand } from '../../session/identity.guard';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import type { PageAnchor } from '../../pagination';
import { OPEN_API_DOCUMENT } from './open-api-document.generated';
import { CurrentMachine, MachineAuthGuard, OpenApiService } from './machine-auth';
import type { MachineContext } from './machine-auth';
import { queryText } from './machine-account.controller';

interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  url?: string;
  query?: Record<string, unknown>;
}

const correlationOf = (request: HttpRequest): string => asUuid(request.headers['x-correlation-id']) ?? randomUUID();

const nextCursor = <T>(page: OpenPage<T>): string | null => (page.next === undefined ? null : encodeCursor(page.next as PageAnchor));

/** A filter that must be a uuid or be absent. */
function uuidFilter(value: unknown, field: string): string | undefined {
  const text = queryText(value, field, 40);
  if (text === undefined) return undefined;
  const id = asUuid(text);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/**
 * The open API for machines (INT-1): `/open/v1`. The routes are @Public(): no session of a person reaches them and no token of a person is accepted. The token route exchanges client credentials; every data route
 * is behind the machine guard (token, account, credential and rate limit judged on every call), needs the scope its operation names, and writes the access log in the transaction of the read. A dataset leaves only
 * while it is switched on and its data product is CERTIFIED (403 `OPEN_DATASET_NOT_CERTIFIED` otherwise).
 */
@Controller()
export class OpenApiController {
  private readonly reads = new OpenReads();
  private readonly datasets = new ExportDatasetStore();

  constructor(@Inject(OpenApiService) private readonly service: OpenApiService) {}

  @Post('open/v1/token')
  @HttpCode(200)
  @Public()
  @OperationId('issueOpenApiToken')
  @IdentityCommand('issueOpenApiToken')
  async token(@Body() body: unknown, @Req() request: HttpRequest): Promise<Record<string, unknown>> {
    return this.service.token(body, request, correlationOf(request));
  }

  @Get('open/v1/openapi.json')
  @Public()
  @OperationId('getOpenApiDocument')
  document(): Readonly<Record<string, unknown>> {
    return OPEN_API_DOCUMENT;
  }

  @Get('open/v1/projects')
  @Public()
  @UseGuards(MachineAuthGuard)
  @OperationId('listOpenProjects')
  async projects(@CurrentMachine() machine: MachineContext, @Req() request: HttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.service.serve(machine, request, correlationOf(request), { operation: 'listOpenProjects', scope: 'open.projects.read' }, async (tx) => {
      const status = queryText(query.status, 'status', 30);
      const page = await this.reads.projects(tx, { status }, parsePageRequest(query.limit, query.cursor));
      return { body: { items: page.items, next_cursor: nextCursor(page), as_of: new Date().toISOString() }, rows: page.items.length };
    });
  }

  @Get('open/v1/project-codes')
  @Public()
  @UseGuards(MachineAuthGuard)
  @OperationId('listOpenProjectCodes')
  async projectCodes(@CurrentMachine() machine: MachineContext, @Req() request: HttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.service.serve(machine, request, correlationOf(request), { operation: 'listOpenProjectCodes', scope: 'open.project-codes.read' }, async (tx) => {
      const page = await this.reads.projectCodes(
        tx,
        { sourceSystem: queryText(query.source_system, 'source_system', 30), externalCode: queryText(query.external_code, 'external_code'), projectCode: queryText(query.project_code, 'project_code') },
        parsePageRequest(query.limit, query.cursor),
      );
      return { body: { items: page.items.map(({ sort_key: _key, ...rest }) => rest), next_cursor: nextCursor(page), as_of: new Date().toISOString() }, rows: page.items.length };
    });
  }

  @Get('open/v1/datasets')
  @Public()
  @UseGuards(MachineAuthGuard)
  @OperationId('listOpenDatasets')
  async datasetList(@CurrentMachine() machine: MachineContext, @Req() request: HttpRequest): Promise<Record<string, unknown>> {
    return this.service.serve(machine, request, correlationOf(request), { operation: 'listOpenDatasets', scope: machine.scopes[0] ?? 'open.projects.read' }, async (tx) => {
      const now = new Date();
      const states = await this.datasets.state(tx, now);
      const items = OPEN_DATASETS.filter((code) => machine.scopes.includes(OPEN_DATASET_DEFINITIONS[code].scope)).map((code) => {
        const definition = OPEN_DATASET_DEFINITIONS[code];
        const state = states.find((row) => row.datasetCode === code);
        return {
          dataset_code: code,
          scope: definition.scope,
          grain: definition.grain,
          columns: [...definition.columns],
          open: state?.gate.open === true,
          reason: state === undefined || state.gate.open ? null : state.gate.reason,
          certification_expires_on: state?.certificationExpiresOn ?? null,
        };
      });
      return { body: { items, as_of: now.toISOString() }, rows: items.length };
    });
  }

  @Get('open/v1/disbursement-lines')
  @Public()
  @UseGuards(MachineAuthGuard)
  @OperationId('listOpenDisbursementLines')
  async disbursementLines(@CurrentMachine() machine: MachineContext, @Req() request: HttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.service.serve(machine, request, correlationOf(request), { operation: 'listOpenDisbursementLines', scope: 'open.disbursement.read', dataset: 'DS-DISB' }, async (tx, certifiedUntil) => {
      const page = await this.reads.disbursementLines(tx, { periodId: uuidFilter(query.period_id, 'period_id'), snapshotId: uuidFilter(query.snapshot_id, 'snapshot_id') }, parsePageRequest(query.limit, query.cursor), certifiedUntil);
      return { body: { items: page.items, next_cursor: nextCursor(page), as_of: new Date().toISOString() }, rows: page.items.length };
    });
  }

  @Get('open/v1/contract-lines')
  @Public()
  @UseGuards(MachineAuthGuard)
  @OperationId('listOpenContractLines')
  async contractLines(@CurrentMachine() machine: MachineContext, @Req() request: HttpRequest, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.service.serve(machine, request, correlationOf(request), { operation: 'listOpenContractLines', scope: 'open.contracts.read', dataset: 'DS-CTR' }, async (tx, certifiedUntil) => {
      const page = await this.reads.contractLines(tx, { periodId: uuidFilter(query.period_id, 'period_id'), snapshotId: uuidFilter(query.snapshot_id, 'snapshot_id') }, parsePageRequest(query.limit, query.cursor), certifiedUntil);
      return { body: { items: page.items, next_cursor: nextCursor(page), as_of: new Date().toISOString() }, rows: page.items.length };
    });
  }
}
