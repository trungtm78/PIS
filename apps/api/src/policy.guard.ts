import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext, OnApplicationBootstrap } from '@nestjs/common';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { PERMISSIONS, PLANES, STEP_UP } from '@machvon/contracts';
import { NIL_RESOURCE_ID } from '@machvon/db';
import type { AuditWriter, EffectiveAccessStore } from '@machvon/db';
import { DomainError, asUuid, controlAccessOf, decide } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, Plane } from '@machvon/kernel';
import { COMMAND_METADATA_KEY } from './command.decorator';
import { operationIdOf } from './operation-id.decorator';
import { PUBLIC_METADATA_KEY } from './public.decorator';
import { principalOf } from './principal';
import type { EntitlementGate, EntitlementVerdict } from './entitlements/entitlement-gate';
import type { SessionDenyList } from './session-deny-list';

/** Request property that the guard fills with the EffectiveAccess it decided on, for handlers that narrow by scope. */
export const ACCESS_REQUEST_KEY = 'effectiveAccess';
export const POLICY_OPTIONS = Symbol('POLICY_OPTIONS');

const NEST_ROUTE_PATH = 'path';
const NEST_ROUTE_METHOD = 'method';

export interface OperationPolicy {
  permission: string;
  plane: Plane;
  stepUp?: 'aal2';
}

export interface PolicyOptions {
  access: EffectiveAccessStore;
  denyList: SessionDenyList;
  audit: AuditWriter;
  operations: ReadonlyMap<string, OperationPolicy>;
  metrics?: MetricsSink;
  entitled?: (tenantId: string, permission: string) => boolean;
  /** Entitlement of the tenant's plan and license (BR-SAS-10): asked on the tenant plane, before the permission decision. */
  entitlements?: EntitlementGate;
  now?: () => Date;
}

/** The policy of every operation of openapi.json (permission, plane, step-up) plus test-only extras. */
export function operationPolicies(extra: Readonly<Record<string, OperationPolicy>> = {}): Map<string, OperationPolicy> {
  const operations = new Map<string, OperationPolicy>();
  const stepUp = STEP_UP as Readonly<Record<string, 'aal2'>>;
  for (const [operationId, permission] of Object.entries(PERMISSIONS)) {
    const plane = (PLANES as Readonly<Record<string, Plane>>)[operationId] ?? 'tenant';
    operations.set(operationId, stepUp[operationId] === undefined ? { permission, plane } : { permission, plane, stepUp: stepUp[operationId] });
  }
  for (const [operationId, policy] of Object.entries(extra)) {
    // An extra mapping must never weaken or replace a design operation.
    if (operations.has(operationId)) throw new Error(`extra operation ${operationId} is already defined in openapi.json`);
    operations.set(operationId, policy);
  }
  return operations;
}

interface PolicyRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  principal?: unknown;
  [ACCESS_REQUEST_KEY]?: EffectiveAccess;
}

/**
 * The policy decision point of IAM 3.4 as a global guard: plane, session deny-list, permission,
 * entitlement and step-up for every route, in the order of the kernel `decide`. A route needs an
 * @OperationId that has a policy, or @Public(); the application refuses to start otherwise.
 * It must run after the authentication guard that sets the Principal.
 */
@Injectable()
export class PolicyGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(PolicyGuard.name);
  // The same scanner Nest routes with: it walks the prototype chain, so inherited handlers count and overridden ones resolve to the override.
  private readonly scanner = new MetadataScanner();

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModulesContainer) private readonly modules: ModulesContainer,
    @Inject(POLICY_OPTIONS) private readonly options: PolicyOptions,
  ) {}

  /** Fails the start-up when a route handler has neither @Public() nor an operationId with a policy. */
  onApplicationBootstrap(): void {
    const offenders: string[] = [];
    for (const module of this.modules.values()) {
      for (const wrapper of module.controllers.values()) {
        const prototype = (wrapper.metatype as { prototype?: object } | null)?.prototype;
        if (prototype === undefined) continue;
        for (const name of this.scanner.getAllMethodNames(prototype)) {
          const handler: unknown = (prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function' || Reflect.getMetadata(NEST_ROUTE_PATH, handler) === undefined || Reflect.getMetadata(NEST_ROUTE_METHOD, handler) === undefined) continue;
          if (this.reflector.get(PUBLIC_METADATA_KEY, handler) === true) continue;
          const operationId = operationIdOf(handler);
          if (operationId === undefined) offenders.push(`${wrapper.metatype?.name ?? 'controller'}.${name} has neither @OperationId nor @Public()`);
          else if (!this.options.operations.has(operationId)) offenders.push(`${wrapper.metatype?.name ?? 'controller'}.${name}: operationId ${operationId} has no policy`);
        }
      }
    }
    if (offenders.length > 0) throw new Error(`Unprotected routes: ${offenders.join('; ')}`);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    if (this.reflector.get(PUBLIC_METADATA_KEY, handler) === true) return true;
    const operationId = operationIdOf(handler);
    const policy = operationId === undefined ? undefined : this.options.operations.get(operationId);
    // Unreachable once the start-up check has passed; failing closed keeps a missed route from being open.
    if (operationId === undefined || policy === undefined) throw new Error('route has no operation policy');

    const request = context.switchToHttp().getRequest<PolicyRequest>();
    const principal = principalOf(request);
    const now = (this.options.now ?? (() => new Date()))();
    // A control-plane operation is judged on the realm roles of the token; there are no tenant grants behind it.
    // A control operation never falls back to tenant grants: a principal without roles has no access at all.
    const controlRoles = policy.plane === 'control' ? (principal.roles ?? []) : undefined;
    const [access, sessionRevoked] = await Promise.all([
      controlRoles === undefined ? this.options.access.load(principal.tenant) : controlAccessOf(controlRoles, principal.tenant.membershipId),
      this.options.denyList.isRevoked(principal.sessionId),
    ]);
    const { entitled, entitlements } = this.options;
    // The plan gate is evaluated before the decision (it reads a cache or the database); the decision applies it after the permission check.
    const verdict: EntitlementVerdict | undefined =
      entitlements !== undefined && principal.audience === 'tenant' ? await entitlements.check(principal.tenant, policy.permission, request.method, now) : undefined;
    const decision = decide({
      required: { permission: policy.permission, plane: policy.plane, stepUp: policy.stepUp },
      principal: {
        audience: principal.audience,
        assurance: principal.assurance,
        aal2At: principal.aal2At,
        sessionRevoked,
        tokenScopeVersion: principal.tenant.scopeVersion,
      },
      access,
      now,
      entitled:
        entitled === undefined && verdict === undefined
          ? undefined
          : (permission) => verdict?.allowed !== false && (entitled === undefined || entitled(principal.tenant.tenantId, permission)),
    });
    this.options.metrics?.increment('authz_decision_total', {
      outcome: decision.allow ? 'allow' : 'deny',
      reason: decision.allow ? 'ALLOWED' : decision.reason,
    });
    if (decision.allow) {
      request[ACCESS_REQUEST_KEY] = access;
      return true;
    }
    const correlationId = asUuid(request.headers['x-correlation-id']) ?? randomUUID();
    // The Problem filter reads the same header, so the id in the answer finds the audit row.
    request.headers['x-correlation-id'] = correlationId;
    // A refused command is audited; so is a call of the wrong plane, whatever it asks: an operator of the platform who reaches for the business data of a tenant leaves a trace even when it only reads (IAM 3.6, NFR-PRIVACY-02).
    if (decision.status === 403 && (Reflect.getMetadata(COMMAND_METADATA_KEY, handler) !== undefined || decision.reason === 'PLANE')) {
      await this.recordDenied(principal.tenant, operationId, decision.reason, correlationId);
    }
    // The reason of an entitlement denial (FEATURE_OFF, LICENSE_GRACE, ...) is safe to show: it names no data of anyone.
    throw new DomainError(decision.code, decision.status, decision.reason === 'ENTITLEMENT' ? verdict?.reason : undefined);
  }

  // The denial answer is what matters to the caller; a failed audit write is logged and does not hide it.
  private async recordDenied(tenant: Parameters<AuditWriter['recordDenied']>[0], operationId: string, reason: string, correlationId: string): Promise<void> {
    try {
      await this.options.audit.recordDenied(tenant, {
        action: `authz.denied:${operationId}`,
        resourceType: 'operation',
        resourceId: NIL_RESOURCE_ID,
        diff: { reason },
        correlationId,
        requestId: randomUUID(),
      });
    } catch (error) {
      this.logger.error(error, correlationId);
    }
  }
}
