import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS } from '@machvon/contracts';
import { DomainError, featureOf } from '@machvon/kernel';
import { AUTH_TOKEN_REQUEST_KEY } from '../auth/auth.guard';
import type { AuthenticatedToken } from '../auth/auth.guard';
import { operationIdOf } from '../operation-id.decorator';
import { PRINCIPAL_REQUEST_KEY } from '../principal';
import type { Principal } from '../principal';
import { PUBLIC_METADATA_KEY } from '../public.decorator';
import { TENANT_RUNTIME, runtimeVerdict } from './tenant-runtime';
import type { TenantRuntimeSource } from './tenant-runtime';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXPORT_FEATURE = 'export';
/** Exports that no plan feature gates: the export of all the data of a tenant is the tenant's own right while it is read-only, suspended or leaving (ST-SAS-016). */
const TENANT_DATA_EXPORTS: ReadonlySet<string> = new Set(['post_tenants_id_export']);

/**
 * A session issued while the tenant is suspended carries `mode = READ_ONLY` (IAM 3.2, SAS 3.6): it may read and
 * export, never change anything. This guard runs after the authentication guard and before the policy guard, and
 * answers 403 TENANT_SUSPENDED for every command that is not an export (an operation whose permission belongs to
 * the `export` feature).
 *
 * A token is issued for the state the tenant had at that time, so with a live tenant state (TENANT_RUNTIME) the guard
 * also judges every tenant-plane request by the state the tenant has now: a tenant suspended after the token was issued
 * is refused at once, a security incident (NO_ACCESS) refuses even reads, and a placement cutover refuses commands with
 * a retryable 503.
 */
@Injectable()
export class ReadOnlyModeGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(TENANT_RUNTIME) private readonly runtime?: TenantRuntimeSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_METADATA_KEY, [context.getHandler(), context.getClass()]) === true) return true;
    const request = context.switchToHttp().getRequest<{ method: string; [AUTH_TOKEN_REQUEST_KEY]?: AuthenticatedToken; [PRINCIPAL_REQUEST_KEY]?: Principal }>();
    const token = request[AUTH_TOKEN_REQUEST_KEY];
    if (token === undefined) return true;
    const exporting = isExport(operationIdOf(context.getHandler()));
    if (token.mode === 'READ_ONLY' && !READ_METHODS.has(request.method.toUpperCase()) && !exporting) throw new DomainError('TENANT_SUSPENDED', 403);
    const principal = request[PRINCIPAL_REQUEST_KEY];
    if (this.runtime !== undefined && token.audience === 'tenant' && principal !== undefined) {
      const refusal = runtimeVerdict(await this.runtime.of(principal.tenant.tenantId), { method: request.method, isExport: exporting }, new Date());
      if (refusal !== undefined) throw refusal;
    }
    return true;
  }
}

function isExport(operationId: string | undefined): boolean {
  if (operationId === undefined) return false;
  if (TENANT_DATA_EXPORTS.has(operationId)) return true;
  const permission = (PERMISSIONS as Record<string, string>)[operationId];
  return permission !== undefined && featureOf(permission) === EXPORT_FEATURE;
}
