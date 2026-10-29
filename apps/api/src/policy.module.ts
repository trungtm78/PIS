import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditWriter } from '@machvon/db';
import type { EffectiveAccessStore, TenantDatabase } from '@machvon/db';
import type { MetricsSink } from '@machvon/kernel';
import { DelegationDoor } from './delegated-door';
import type { EntitlementGate } from './entitlements/entitlement-gate';
import { SupportGate } from './support-gate';
import { POLICY_OPTIONS, PolicyGuard, operationPolicies } from './policy.guard';
import type { OperationPolicy, PolicyOptions } from './policy.guard';
import { InMemorySessionDenyList } from './session-deny-list';
import type { SessionDenyList } from './session-deny-list';

export interface PolicyModuleOptions {
  database: TenantDatabase;
  access: EffectiveAccessStore;
  /** Defaults to an empty in-memory deny-list. */
  denyList?: SessionDenyList;
  metrics?: MetricsSink;
  entitled?: (tenantId: string, permission: string) => boolean;
  /** The entitlement gate of the plan and license; omit it only where entitlements are tested separately. */
  entitlements?: EntitlementGate;
  now?: () => Date;
  /** Policies for operations that are not in openapi.json (tests, internal routes); never overrides a design operation. */
  extraOperations?: Readonly<Record<string, OperationPolicy>>;
}

/**
 * Enables the policy decision point for every route of the application. Import it after the module that
 * provides the authentication guard, so that guard runs first and has set the Principal.
 */
@Module({})
export class PolicyModule {
  static register(options: PolicyModuleOptions): DynamicModule {
    const policy: PolicyOptions = {
      access: options.access,
      denyList: options.denyList ?? new InMemorySessionDenyList(),
      audit: new AuditWriter(options.database),
      operations: operationPolicies(options.extraOperations),
      metrics: options.metrics,
      entitled: options.entitled,
      entitlements: options.entitlements,
      delegations: new DelegationDoor(options.database),
      support: new SupportGate(options.database),
      now: options.now,
    };
    return {
      module: PolicyModule,
      providers: [
        { provide: POLICY_OPTIONS, useValue: policy },
        { provide: APP_GUARD, useClass: PolicyGuard },
      ],
    };
  }
}
