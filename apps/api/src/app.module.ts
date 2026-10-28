import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ControlDatabase, EntitlementStore, LicenseStore, TenantDatabase, TenantRegistry } from '@machvon/db';
import type { AuthzCache, EntitlementCache } from '@machvon/db';
import type { RegisteredError } from '@machvon/kernel';
import { AuthModule } from './auth/auth.module';
import type { AuthGuardOptions } from './auth/auth.guard';
import { CommandModule } from './command.module';
import { EntitlementsController } from './entitlements/entitlements.controller';
import { BI_DRILL_SECRET } from './modules/bi/tokens';
import { ORCHESTRATION_OPTIONS } from './modules/orchestration';
import type { OrchestrationOptions } from './modules/orchestration';
import { controllersOf, providersOf } from './modules/registry';
import { LicenseController, LicenseReadsController, SystemLicenseReadsController } from './modules/sas/license.controller';
import { LICENSE_KEYS } from './modules/sas/license-signer';
import type { LicenseKeyStore } from './modules/sas/license-signer';
import { CacheTenantStateEffects, TENANT_STATE_EFFECTS } from './modules/sas/tenant-state-effects';
import { OrganizationUnitsController } from './organization-units.controller';
import { OrgUnitCommandsController } from './org-units.commands.controller';
import { PolicyModule } from './policy.module';
import type { PolicyModuleOptions } from './policy.module';
import { ProblemFilter } from './problem.filter';
import { RoleDefinitionsController } from './role-definitions.controller';
import { RoleGrantReadsController, RoleGrantsController } from './role-grants.controller';
import { RolesController } from './roles.controller';
import { MembershipsController } from './session/memberships.controller';
import type { TenantRuntimeSource } from './session/tenant-runtime';
import { SessionModule } from './session/session.module';
import type { SessionModuleOptions } from './session/session.module';
import { SystemTenantsController } from './system-tenants.controller';

export interface AppModuleOptions {
  database: TenantDatabase;
  registry: ReadonlyMap<string, RegisteredError>;
  /** Authenticates every route that is not @Public (Bearer tokens through the TokenVerifier port); it runs before the policy guard. */
  auth?: AuthGuardOptions;
  /** Enables the policy decision point for every route; omit it only where authorisation is tested separately. */
  policy?: PolicyModuleOptions;
  /** Registers tenant selection (selectTenantContext) and the membership reads; needs the control-plane database and the token ports. */
  session?: SessionModuleOptions;
  /** Registers the entitlement reads (getMyEntitlements, getTenantEntitlements); omit it where no control-plane database is available. */
  entitlements?: { store: EntitlementStore; control: ControlDatabase };
  /** Registers the control-plane tenant registry commands and reads (requestTenantProvisioning and friends); omit it where no control-plane database is available. */
  control?: { database: ControlDatabase; registry: TenantRegistry };
  /** Registers the license commands (post_licenses, post_licenses_id_revoke) and the license reads; needs `control`, whose database the commands run on. */
  licenses?: { store: LicenseStore; keys: LicenseKeyStore };
  /**
   * The live state of tenants. With it a suspension refuses the very next request of a session issued before it (the
   * authentication module judges every tenant request by it), and the suspend and resume commands drop what this process caches.
   */
  tenantState?: { runtime: TenantRuntimeSource; entitlementCache: EntitlementCache; authzCache: AuthzCache };
  /** Provides the orchestration port (ORCHESTRATOR) with the in-process adapter; the key signs the tenant contexts of background work. */
  orchestration?: OrchestrationOptions;
  /** The secret the drill tokens of BI are signed from (at least 32 bytes); every replica must be given the same, or a token made by one is refused by another. */
  biDrillSecret?: Buffer;
}

/**
 * The API shell. It registers no authentication: the host adds a guard that sets the verified
 * TenantContext on the request (tests use TestAuthGuard; real authentication arrives with ST-IAM-002).
 * Without one, every tenant-scoped request fails with TENANT_CONTEXT_INVALID.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CommandModule.register({ database: options.database, control: options.control?.database ?? options.entitlements?.control }),
        ...(options.auth === undefined ? [] : [AuthModule.register(options.auth, options.tenantState?.runtime)]),
        ...(options.policy === undefined ? [] : [PolicyModule.register(options.policy)]),
        ...(options.session === undefined ? [] : [SessionModule.register(options.session)]),
      ],
      controllers: [
        OrganizationUnitsController,
        MembershipsController,
        OrgUnitCommandsController,
        RolesController,
        RoleGrantsController,
        RoleGrantReadsController,
        RoleDefinitionsController,
        ...controllersOf(options),
        ...(options.entitlements === undefined ? [] : [EntitlementsController]),
        ...(options.control === undefined ? [] : [SystemTenantsController]),
        ...(options.licenses === undefined ? [] : [LicenseController, LicenseReadsController]),
        // The control-plane license reads need the control database, which the tenant-plane reads alone do not.
        ...(options.licenses === undefined || (options.control === undefined && options.entitlements === undefined) ? [] : [SystemLicenseReadsController]),
      ],
      providers: [
        ...providersOf(options),
        ...(options.orchestration === undefined ? [] : [{ provide: ORCHESTRATION_OPTIONS, useValue: options.orchestration }]),
        ...(options.biDrillSecret === undefined ? [] : [{ provide: BI_DRILL_SECRET, useValue: options.biDrillSecret }]),
        ...(options.licenses === undefined
          ? []
          : [
              { provide: LicenseStore, useValue: options.licenses.store },
              { provide: LICENSE_KEYS, useValue: options.licenses.keys },
            ]),
        ...(options.tenantState === undefined ? [] : [{ provide: TENANT_STATE_EFFECTS, useValue: new CacheTenantStateEffects(options.tenantState) }]),
        { provide: TenantDatabase, useValue: options.database },
        ...(options.entitlements === undefined
          ? []
          : [
              { provide: EntitlementStore, useValue: options.entitlements.store },
              { provide: ControlDatabase, useValue: options.entitlements.control },
            ]),
        ...(options.control === undefined ? [] : [{ provide: TenantRegistry, useValue: options.control.registry }]),
        ...(options.control === undefined || options.entitlements !== undefined ? [] : [{ provide: ControlDatabase, useValue: options.control.database }]),
        { provide: APP_FILTER, useValue: new ProblemFilter(options.registry) },
      ],
    };
  }
}
