import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { TenantTokenIssuer } from './auth/tenant-token-issuer';
import { SUPPORT_TOKEN_ISSUER } from './modules/sas/support-token.controller';
import { ControlDatabase, EntitlementStore, LicenseStore, TenantDatabase, TenantRegistry } from '@machvon/db';
import type { AuthzCache, EntitlementCache } from '@machvon/db';
import type { EditionManifest, RegisteredError } from '@machvon/kernel';
import { AuthModule } from './auth/auth.module';
import type { AuthGuardOptions } from './auth/auth.guard';
import { CommandModule } from './command.module';
import { EntitlementsController } from './entitlements/entitlements.controller';
import { ControlFeatureFlagSource, FeatureFlagModule, NoFeatureFlags } from './entitlements/feature-flag.guard';
import { MyFeatureFlagsController } from './entitlements/my-feature-flags.controller';
import { ADM_METRICS, ADM_MOUNTED_MODULES } from './modules/adm/tokens';
import { BI_DRILL_SECRET } from './modules/bi/tokens';
import { ORCHESTRATION_OPTIONS } from './modules/orchestration';
import type { OrchestrationOptions } from './modules/orchestration';
import { activeModuleCodes, controllersOf, providersOf } from './modules/registry';
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
import { IDENTITY_LOGOUT, NoIdentityLogout, SESSION_REVOCATION, SelfServiceController } from './session/self.controller';
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
  /** The issuer of the support tokens of the exchange `issueSupportAccessToken` (ST-SAS-015); defaults to the issuer of the session module. Without either the exchange answers 503 SIGNING_KEY_UNAVAILABLE. */
  supportIssuer?: TenantTokenIssuer;
  /** The secret the drill tokens of BI are signed from (at least 32 bytes); every replica must be given the same, or a token made by one is refused by another. */
  biDrillSecret?: Buffer;
  /**
   * The manifest of the product edition this process serves (ENT-0). The module registry mounts only the modules the manifest lists; omit it
   * for the public edition, which lists them all, so every caller that knows nothing of editions is unchanged.
   */
  edition?: EditionManifest;
}

/**
 * The API shell. It registers no authentication: the host adds a guard that sets the verified
 * TenantContext on the request (tests use TestAuthGuard; real authentication arrives with ST-IAM-002).
 * Without one, every tenant-scoped request fails with TENANT_CONTEXT_INVALID.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const control = options.control?.database ?? options.entitlements?.control;
    return {
      module: AppModule,
      imports: [
        CommandModule.register({ database: options.database, control }),
        ...(options.auth === undefined ? [] : [AuthModule.register(options.auth, options.tenantState?.runtime)]),
        ...(options.policy === undefined ? [] : [PolicyModule.register(options.policy)]),
        ...(options.session === undefined ? [] : [SessionModule.register(options.session)]),
        // Last of the guards: a route behind a release flag is judged after the caller is authenticated and holds the permission.
        FeatureFlagModule.register(control === undefined ? new NoFeatureFlags() : new ControlFeatureFlagSource(control)),
      ],
      controllers: [
        OrganizationUnitsController,
        MembershipsController,
        // What a person does with their own profile, sessions and devices (IAM-05, IAM-06).
        SelfServiceController,
        OrgUnitCommandsController,
        RolesController,
        RoleGrantsController,
        RoleGrantReadsController,
        RoleDefinitionsController,
        ...controllersOf(options),
        ...(options.entitlements === undefined ? [] : [EntitlementsController]),
        // The flags live in the control plane: the read of the flags that are on for a tenant needs the control database, from either option.
        ...(options.entitlements === undefined && options.control === undefined ? [] : [MyFeatureFlagsController]),
        ...(options.control === undefined ? [] : [SystemTenantsController]),
        ...(options.licenses === undefined ? [] : [LicenseController, LicenseReadsController]),
        // The control-plane license reads need the control database, which the tenant-plane reads alone do not.
        ...(options.licenses === undefined || (options.control === undefined && options.entitlements === undefined) ? [] : [SystemLicenseReadsController]),
      ],
      providers: [
        ...providersOf(options),
        { provide: ADM_MOUNTED_MODULES, useValue: activeModuleCodes(options) },
        // The sink the policy guard counts the decisions in is the one the ADM controllers count their alerts in (`workflow_guard_rejected_total`); without one they stay silent.
        ...(options.policy?.metrics === undefined ? [] : [{ provide: ADM_METRICS, useValue: options.policy.metrics }]),
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
        // A session revoked here reaches the deny-list the authentication guard consults, and the identity provider's logout where it is connected.
        { provide: SUPPORT_TOKEN_ISSUER, useValue: options.supportIssuer ?? options.session?.issuer },
        { provide: SESSION_REVOCATION, useValue: options.session?.denyList ?? { revoke: () => undefined } },
        { provide: IDENTITY_LOGOUT, useValue: options.session?.identityLogout ?? new NoIdentityLogout() },
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
