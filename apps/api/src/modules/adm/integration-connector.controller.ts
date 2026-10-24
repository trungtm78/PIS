import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IntegrationConnectorStore } from '@machvon/db';
import type { ConnectorChange, ConnectorRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { ADM_ENVIRONMENT } from './tokens';
import { holdsOnWholeTenant } from './tenant-authority';

const MANAGE_PERMISSION = PERMISSIONS.createIntegrationConnector;
const RESOURCE_TYPE = 'integration_connector';

/** Connectors are tenant administration (ADM 3.13): they are not owned by one organisation unit, so only a grant on the whole tenant reaches them. */
function assertHolds(access: EffectiveAccess): void {
  if (!holdsOnWholeTenant(access, MANAGE_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
}

/** What the audit trail keeps of the settings of a connector: which members the configuration has, never their values, and whether a credential is referenced. */
function settingsOf(row: ConnectorRow): Record<string, unknown> {
  return { config_keys: Object.keys(row.config).sort(), has_credential: row.credentialSecretRef !== null, mapping_version: row.mappingVersion };
}

/**
 * Integration connectors (ST-ADM-018, ADM 3.13, BR-ADM-10). A connector is declared as a draft with the honest status of its adapter and can be
 * Active only with a VERIFIED adapter, or a MOCK one outside production: no connector claims to be live without a verified adapter. Its
 * configuration never carries a secret; a credential is a reference to the vault.
 */
@Controller('integration-connectors')
export class IntegrationConnectorsController {
  private readonly store = new IntegrationConnectorStore();
  private readonly environment: string | undefined;

  constructor(@Optional() @Inject(ADM_ENVIRONMENT) environment?: string) {
    this.environment = environment;
  }

  @Post()
  @OperationId('createIntegrationConnector')
  @Command({ operation: 'createIntegrationConnector' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ConnectorCreate']): Promise<CommandResult> {
    assertHolds(access);
    const created = await this.store.create(
      scope.tx,
      {
        connectorCode: body.connector_code,
        mode: body.mode,
        adapterStatus: body.adapter_status,
        config: body.config as Record<string, unknown>,
        credentialSecretRef: body.credential_secret_ref,
        mappingVersion: body.mapping_version,
      },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'integration.connector_created',
      resourceType: RESOURCE_TYPE,
      resourceId: created.id,
      classification: 'INTERNAL',
      diff: { connector_code: created.connectorCode, mode: created.mode, adapter_status: created.adapterStatus, ...settingsOf(created) },
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Put(':connectorId')
  @HttpCode(200)
  @OperationId('updateIntegrationConnector')
  @Command({ operation: 'updateIntegrationConnector', versioned: true })
  async update(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('connectorId', ParseUUIDPipe) connectorId: string,
    @Body() body: Schemas['ConnectorUpdate'],
  ): Promise<CommandResult> {
    assertHolds(access);
    const change: ConnectorChange = {
      config: body.config as Record<string, unknown> | undefined,
      credentialSecretRef: body.credential_secret_ref,
      mappingVersion: body.mapping_version,
      status: body.status,
    };
    const { before, row } = await this.store.update(scope.tx, connectorId, scope.expectedVersion ?? 0, change, scope.tenant.membershipId, this.environment);
    await scope.audit({
      action: 'integration.connector_updated',
      resourceType: RESOURCE_TYPE,
      resourceId: connectorId,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: {
        connector_code: row.connectorCode,
        adapter_status: row.adapterStatus,
        status_before: before.status,
        status_after: row.status,
        changed: [change.config !== undefined ? 'config' : null, change.credentialSecretRef !== undefined ? 'credential_secret_ref' : null, change.mappingVersion !== undefined ? 'mapping_version' : null].filter((name) => name !== null),
        ...settingsOf(row),
      },
    });
    return commandResult(scope, row.status, row.version, connectorId);
  }
}
