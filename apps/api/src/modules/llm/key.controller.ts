import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, LlmKeyStore, LlmKeySweepJob, TenantDatabase } from '@machvon/db';
import type { KeyRow } from '@machvon/db';
import { DomainError, asUuid, assertKeyDraft, fingerprintOf, rotationDeadline, scrubSecrets, secretRefOf } from '@machvon/kernel';
import type { EffectiveAccess, KeyScope, LiteLlmAdminPort, SecretVaultPort, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { LLM_ADMIN, LLM_VAULT } from './tokens';

const RESOURCE_TYPE = 'ai_virtual_key';
const MIN_REASON = 10;

/** A key that was made at LiteLLM and written to the vault, with what is needed to take it back. */
interface Issued {
  id: string;
  keyRef: string;
  fingerprint: string;
  secretRef: string;
  alias: string;
  scopeKind: KeyScope;
}

/** A key as it is shown: the alias, the fingerprint and the state. The references to the secret and to the key at LiteLLM are the server's and are not in any view (BR-LLM-09). */
export function keyView(row: KeyRow): Record<string, unknown> {
  return {
    id: row.id,
    key_alias: row.alias,
    fingerprint: row.fingerprint,
    scope_kind: row.scopeKind,
    budget_id: row.budgetId,
    allowed_model_ids: row.allowedModelIds,
    rpm_limit: row.rpmLimit,
    tpm_limit: row.tpmLimit,
    status: row.status,
    expires_at: row.expiresAt,
    rotated_from_id: row.rotatedFromId,
    revoked_reason: row.revokedReason,
    created_by: row.createdBy,
    created_at: row.createdAt,
    version: row.version,
  };
}

/** The failure of a service the keys depend on is a 503 that says which service and nothing it said: its message can carry a key. */
function unavailable(service: 'litellm' | 'vault', cause: unknown, log: (line: string) => void): DomainError {
  log(scrubSecrets(`llm key: ${service} failed with ${cause instanceof Error ? cause.constructor.name : 'UnknownError'}`));
  return new DomainError('PROVIDER_UNAVAILABLE', 503, service);
}

/**
 * The virtual keys of the AI gateway (ST-LLM-002, LLM F5, BR-LLM-09, LLM-06): a key is made at LiteLLM, its secret is written to the vault and not kept anywhere else, and what the application keeps and shows is the
 * alias, the fingerprint and the state. A rotation makes a new key ACTIVE and leaves the old one ROTATING for a day, then the sweep revokes it; a revocation stops the key at LiteLLM before anything is recorded. All of it is
 * the tenant's: who holds the right over a unit only is refused.
 */
@Controller()
export class LlmKeyController {
  private readonly keys = new LlmKeyStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(LLM_ADMIN) private readonly litellm: LiteLlmAdminPort,
    @Inject(LLM_VAULT) private readonly vault: SecretVaultPort,
  ) {}

  private whole(access: EffectiveAccess, permission: string): void {
    if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
  }

  private readonly log = (line: string): void => void process.stderr.write(`${line}\n`);

  /** Makes the key at LiteLLM and puts its secret in the vault; on any failure after the key exists, it is stopped and the secret removed, so no key is left that nobody records. */
  private async issue(scope: CommandScope, keyId: string, scopeKind: KeyScope, input: { alias: string; models: readonly string[]; rpmLimit: number | null; tpmLimit: number | null; expiresAt: Date }): Promise<Issued> {
    const { tenant } = scope;
    let made: { keyRef: string; secret: string };
    try {
      made = await this.litellm.createKey(input);
    } catch (error) {
      throw unavailable('litellm', error, this.log);
    }
    const issued: Issued = { id: keyId, keyRef: made.keyRef, fingerprint: fingerprintOf(made.secret), secretRef: secretRefOf(tenant.tenantId, keyId), alias: input.alias, scopeKind };
    // From here on the key exists outside the database: if the command does not commit, whatever the reason, it is taken back after the rollback.
    scope.afterRollback(() => this.undo(tenant, issued));
    try {
      await this.vault.put(issued.secretRef, made.secret);
    } catch (error) {
      throw unavailable('vault', error, this.log);
    }
    return issued;
  }

  /**
   * What undoes `issue` when the rest of the command fails. What cannot be undone now is not forgotten: the transaction of the command is rolled back, so the key is written down in one of its own and the sweep
   * stops it (and takes its secret out of the vault) as soon as it can.
   */
  private async undo(tenant: TenantContext, issued: Issued): Promise<void> {
    let clean = true;
    await this.litellm.revokeKey(issued.keyRef).catch(() => void (clean = false));
    await this.vault.remove(issued.secretRef).catch(() => void (clean = false));
    if (clean) return;
    try {
      await this.database.withTenant(tenant, (tx) => this.keys.recordOrphan(tx, { id: this.keys.newId(), alias: issued.alias, litellmKeyRef: issued.keyRef, fingerprint: issued.fingerprint, secretRef: issued.secretRef, scopeKind: issued.scopeKind, actor: tenant.membershipId }));
    } catch (error) {
      this.log(scrubSecrets(`llm key: the key ${issued.id} could not be written down for the sweep (${error instanceof Error ? error.constructor.name : 'UnknownError'})`));
    }
  }

  // ---- create ------------------------------------------------------------------------------------------------------------------------------

  @Post('ai-virtual-keys')
  @HttpCode(200)
  @OperationId('createAiVirtualKey')
  @Command({ operation: 'createAiVirtualKey' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['LlmVirtualKeyCreate']): Promise<CommandResult & { key_alias: string; fingerprint: string }> {
    this.whole(access, PERMISSIONS.createAiVirtualKey);
    const now = new Date();
    const alias = body.key_alias.trim();
    const expiresAt = new Date(body.expires_at);
    const modelIds = body.allowed_model_ids.map((id) => asUuid(id));
    if (modelIds.some((id) => id === undefined)) throw new DomainError('VALIDATION_FAILED', 422, 'allowed_model_ids');
    const budgetId = body.budget_id === undefined ? null : (asUuid(body.budget_id) ?? null);
    if (body.budget_id !== undefined && budgetId === null) throw new DomainError('VALIDATION_FAILED', 422, 'budget_id');
    assertKeyDraft({ alias, scopeKind: body.scope_kind, allowedModelIds: modelIds as string[], rpmLimit: body.rpm_limit ?? null, tpmLimit: body.tpm_limit ?? null, expiresAt, now });
    const { tx, tenant } = scope;
    await this.keys.lockAlias(tx, alias);
    if (await this.keys.aliasHeld(tx, alias)) throw new DomainError('KEY_ALIAS_DUPLICATE', 409, 'key_alias');
    const models = await this.keys.approvedModels(tx, modelIds as string[]);
    if (budgetId !== null && !(await this.keys.budgetExists(tx, budgetId))) throw new DomainError('VALIDATION_FAILED', 422, 'budget_id');
    const id = this.keys.newId();
    const issued = await this.issue(scope, id, body.scope_kind, { alias, models, rpmLimit: body.rpm_limit ?? null, tpmLimit: body.tpm_limit ?? null, expiresAt });
    const created = await this.keys.insert(tx, {
      id,
      alias,
      litellmKeyRef: issued.keyRef,
      fingerprint: issued.fingerprint,
      secretRef: issued.secretRef,
      scopeKind: body.scope_kind,
      budgetId,
      allowedModelIds: modelIds as string[],
      rpmLimit: body.rpm_limit ?? null,
      tpmLimit: body.tpm_limit ?? null,
      expiresAt,
      rotatedFromId: null,
      actor: tenant.membershipId,
    });
    await scope.audit({ action: 'llm.key_created', resourceType: RESOURCE_TYPE, resourceId: id, diff: { key_alias: alias, fingerprint: created.fingerprint, scope_kind: created.scopeKind, models: created.allowedModelIds.length, expires_at: created.expiresAt } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: created.version,
      type: 'llm.key.created.v1',
      schemaVersion: 1,
      payload: { key_id: id, key_alias: alias, fingerprint: created.fingerprint, scope_kind: created.scopeKind },
      eventKey: `${RESOURCE_TYPE}:${id}:${created.version}`,
    });
    return { ...commandResult(scope, 'ACTIVE', created.version, id), key_alias: alias, fingerprint: created.fingerprint };
  }

  // ---- rotate ------------------------------------------------------------------------------------------------------------------------------

  @Post('ai-virtual-keys/:id/rotation')
  @HttpCode(200)
  @OperationId('rotateAiVirtualKey')
  @Command({ operation: 'rotateAiVirtualKey', versioned: true })
  async rotate(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult & { key_alias: string; fingerprint: string; rotated_from_id: string; old_key_ends_at: string }> {
    this.whole(access, PERMISSIONS.rotateAiVirtualKey);
    const { tx, tenant } = scope;
    const old = await this.keys.find(tx, id, true);
    if (old === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (old.version !== (scope.expectedVersion ?? 0)) throw new DomainError('VERSION_CONFLICT', 409);
    if (old.status !== 'ACTIVE') throw new DomainError('KEY_STATE_INVALID', 409, 'status');
    const now = new Date();
    if (new Date(old.expiresAt).getTime() <= now.getTime()) throw new DomainError('KEY_STATE_INVALID', 409, 'expires_at');
    const models = await this.keys.approvedModels(tx, old.allowedModelIds);
    const newId = this.keys.newId();
    const endsAt = rotationDeadline(now, new Date(old.expiresAt));
    const issued = await this.issue(scope, newId, old.scopeKind, { alias: old.alias, models, rpmLimit: old.rpmLimit, tpmLimit: old.tpmLimit, expiresAt: new Date(old.expiresAt) });
    try {
      await this.litellm.limitLifetime(old.litellmKeyRef, endsAt);
      // The old key ends within the day at LiteLLM from now on: if the rotation does not commit, its own end is put back, so the key that is ACTIVE again does not die.
      scope.afterRollback(() => this.litellm.limitLifetime(old.litellmKeyRef, new Date(old.expiresAt)).catch((cause: unknown) => this.log(scrubSecrets(`llm key: litellm failed with ${cause instanceof Error ? cause.constructor.name : 'UnknownError'}`))));
    } catch (error) {
      throw unavailable('litellm', error, this.log);
    }
    // The old key leaves the alias first (only the ACTIVE key holds it), then the new one takes it.
    const rotating = await this.keys.markRotating(tx, id, endsAt, tenant.membershipId);
    const created = await this.keys.insert(tx, {
      id: newId,
      alias: old.alias,
      litellmKeyRef: issued.keyRef,
      fingerprint: issued.fingerprint,
      secretRef: issued.secretRef,
      scopeKind: old.scopeKind,
      budgetId: old.budgetId,
      allowedModelIds: old.allowedModelIds,
      rpmLimit: old.rpmLimit,
      tpmLimit: old.tpmLimit,
      expiresAt: new Date(old.expiresAt),
      rotatedFromId: id,
      actor: tenant.membershipId,
    });
    await scope.audit({ action: 'llm.key_rotated', resourceType: RESOURCE_TYPE, resourceId: newId, diff: { key_alias: old.alias, old_fingerprint: old.fingerprint, new_fingerprint: created.fingerprint, old_key_ends_at: endsAt.toISOString() } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: newId,
      aggregateVersion: created.version,
      type: 'llm.key.rotated.v1',
      schemaVersion: 1,
      payload: { key_id: newId, old_key_id: id, key_alias: old.alias, old_key_ends_at: endsAt.toISOString(), old_version: rotating.version },
      eventKey: `${RESOURCE_TYPE}:${newId}:${created.version}`,
    });
    return { ...commandResult(scope, 'ACTIVE', created.version, newId), key_alias: old.alias, fingerprint: created.fingerprint, rotated_from_id: id, old_key_ends_at: endsAt.toISOString() };
  }

  // ---- revoke ------------------------------------------------------------------------------------------------------------------------------

  @Post('ai-virtual-keys/:id/revocation')
  @HttpCode(200)
  @OperationId('revokeAiVirtualKey')
  @Command({ operation: 'revokeAiVirtualKey', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['LlmKeyRevoke']): Promise<CommandResult> {
    this.whole(access, PERMISSIONS.revokeAiVirtualKey);
    const { tx, tenant } = scope;
    const key = await this.keys.find(tx, id, true);
    if (key === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (key.version !== (scope.expectedVersion ?? 0)) throw new DomainError('VERSION_CONFLICT', 409);
    if (key.status === 'REVOKED') throw new DomainError('KEY_STATE_INVALID', 409, 'status');
    // The reason is judged as it will be kept: ten spaces are no reason, and a revocation cannot be undone.
    const reason = scrubSecrets(body.reason.trim());
    if (body.reason.trim().length < MIN_REASON) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    // A revocation takes effect at once: the key is stopped at LiteLLM before it is recorded, so the record never says a key is dead while it still works.
    try {
      await this.litellm.revokeKey(key.litellmKeyRef);
    } catch (error) {
      throw unavailable('litellm', error, this.log);
    }
    // A reason is written by a person who may have the key in front of them: whatever looks like a key is taken out before it is kept, answered or sent.
    // The key is dead from here on: if the command does not commit, the record is made to say so after the rollback.
    scope.afterRollback(async () => {
      await this.database.withTenant(tenant, (inner) => new LlmKeySweepJob(new AuditWriter(this.database), this.litellm, this.vault, this.log).reconcileRevocation(inner, tenant.membershipId, id, reason));
    });
    const revoked = await this.keys.markRevoked(tx, id, reason, tenant.membershipId);
    // The secret is no longer needed. A vault that cannot let go of it now does not undo a key that is already stopped: the row says the secret is still there and the sweep asks again.
    try {
      await this.vault.remove(key.secretRef);
      await this.keys.markSecretRemoved(tx, id);
    } catch (error) {
      this.log(scrubSecrets(`llm key: vault failed with ${error instanceof Error ? error.constructor.name : 'UnknownError'}`));
    }
    await scope.audit({ action: 'llm.key_revoked', resourceType: RESOURCE_TYPE, resourceId: id, diff: { key_alias: key.alias, fingerprint: key.fingerprint, reason: revoked.revokedReason } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: revoked.version,
      type: 'llm.key.revoked.v1',
      schemaVersion: 1,
      payload: { key_id: id, key_alias: key.alias, reason: revoked.revokedReason },
      eventKey: `${RESOURCE_TYPE}:${id}:${revoked.version}`,
    });
    return commandResult(scope, 'REVOKED', revoked.version, id);
  }

  // ---- list --------------------------------------------------------------------------------------------------------------------------------

  @Get('ai-virtual-keys')
  @OperationId('listAiVirtualKeys')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<{ items: Array<Record<string, unknown>>; next_cursor: null; as_of: string }> {
    this.whole(access, PERMISSIONS.listAiVirtualKeys);
    const rows = await this.database.withTenant(tenant, (tx) => this.keys.list(tx));
    return { items: rows.map(keyView), next_cursor: null, as_of: new Date().toISOString() };
  }
}
