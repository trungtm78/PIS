import { Inject, Injectable, Module, SetMetadata } from '@nestjs/common';
import type { CanActivate, DynamicModule, ExecutionContext } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { FeatureFlagStore } from '@machvon/db';
import type { ControlDatabase } from '@machvon/db';
import { DECLARED_FLAGS, DomainError } from '@machvon/kernel';
import { principalOf } from '../principal';

const REQUIRES_FLAG_KEY = 'machvon:requires-flag';

/**
 * Puts a route (or every route of a controller) behind a release flag (ST-KERNEL-014, ST-SAS-020): while the flag is not on for the tenant of the caller the route answers 503 `FEATURE_UNAVAILABLE`, and the
 * release can switch it on, for a cohort first, without a deploy or a schema change. The flag must be one the code declares (`DECLARED_FLAGS`), so a misspelt key stops the application when it starts
 * instead of leaving the route open. A flag decides a code path only: it never grants a right, which stays with the permission and the entitlements checked before it.
 */
export function RequiresFlag(flagKey: string): MethodDecorator & ClassDecorator {
  if (!DECLARED_FLAGS.some((flag) => flag.key === flagKey)) throw new Error(`RequiresFlag: ${flagKey} is not a declared release flag`);
  return SetMetadata(REQUIRES_FLAG_KEY, flagKey);
}

export const FEATURE_FLAG_SOURCE = Symbol('FEATURE_FLAG_SOURCE');

/** Where the guard asks whether a flag is on for a tenant. */
export interface FeatureFlagSource {
  isOn(tenantId: string, flagKey: string): Promise<boolean>;
}

/** The flags of the control plane: status and rollout against the tenant and the cohort (region) it is in. A flag the database does not hold is off. */
export class ControlFeatureFlagSource implements FeatureFlagSource {
  private readonly flags = new FeatureFlagStore();

  constructor(private readonly control: ControlDatabase) {}

  async isOn(tenantId: string, flagKey: string): Promise<boolean> {
    const flags = await this.control.withControl((tx) => this.flags.enabledFor(tx, tenantId));
    return flags.some((flag) => flag.key === flagKey && flag.enabled);
  }
}

/** Without a control plane no flag is on: a route behind a flag stays closed rather than open. */
export class NoFeatureFlags implements FeatureFlagSource {
  isOn(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Refuses a route behind a release flag while the flag is off for the caller's tenant. It runs after the authentication and the policy guard, so a caller without the permission is told 403 and learns
 * nothing about the flag; a route with no flag costs no read.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FEATURE_FLAG_SOURCE) private readonly flags: FeatureFlagSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.getAllAndOverride<string | undefined>(REQUIRES_FLAG_KEY, [context.getHandler(), context.getClass()]);
    if (flagKey === undefined) return true;
    const principal = principalOf(context.switchToHttp().getRequest<{ principal?: unknown }>());
    if (!(await this.flags.isOn(principal.tenant.tenantId, flagKey))) throw new DomainError('FEATURE_UNAVAILABLE', 503);
    return true;
  }
}

/**
 * Enables the flag guard for every route of the application. Import it after AuthModule and PolicyModule: the guards of a module run in the order the modules are imported, and this one needs the Principal
 * the authentication guard sets and must not answer before the policy guard has judged the permission.
 */
@Module({})
export class FeatureFlagModule {
  static register(source: FeatureFlagSource): DynamicModule {
    return {
      module: FeatureFlagModule,
      providers: [
        { provide: FEATURE_FLAG_SOURCE, useValue: source },
        { provide: APP_GUARD, useClass: FeatureFlagGuard },
      ],
    };
  }
}
