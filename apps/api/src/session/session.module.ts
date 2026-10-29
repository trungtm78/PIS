import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { AuditWriter, IdempotencyStore, TenantDatabase } from '@machvon/db';
import type { ControlDatabase, UserSessionStore } from '@machvon/db';
import type { MetricsSink } from '@machvon/kernel';
import type { TenantTokenIssuer } from '../auth/tenant-token-issuer';
import type { TokenVerifier } from '../auth/token-verifier';
import { AcceptInvitationController } from './accept-invitation.controller';
import { AcceptInvitationService } from './accept-invitation.service';
import { IDENTITY_OPTIONS, IdentityGuard } from './identity.guard';
import { InviteeGuard } from './invitee.guard';
import type { IdentityLogout } from './self.controller';
import { SelectTenantController } from './select-tenant.controller';
import { SelectTenantService } from './select-tenant.service';
import type { UserSessionDenyList } from './user-session-deny-list';

export interface SessionModuleOptions {
  verifier: TokenVerifier;
  control: ControlDatabase;
  tenants: TenantDatabase;
  sessions: UserSessionStore;
  issuer: TenantTokenIssuer;
  /** The deny-list the authentication guard also consults: a tenant switch revokes in it at once. */
  denyList: UserSessionDenyList;
  /** The identity provider's end of a sign-out (Keycloak back-channel logout), for the sign-outs of IAM-06; none until it is connected. */
  identityLogout?: IdentityLogout;
  metrics?: MetricsSink;
  now?: () => Date;
}

/** Tenant selection (IAM-003) and the acceptance of an invitation: the routes a person uses between signing in and working. The membership reads live in AppModule. */
@Module({})
export class SessionModule {
  static register(options: SessionModuleOptions): DynamicModule {
    const idempotency = new IdempotencyStore(options.tenants);
    const audit = new AuditWriter(options.tenants);
    const service = new SelectTenantService({
      control: options.control,
      tenants: options.tenants,
      sessions: options.sessions,
      idempotency,
      audit,
      issuer: options.issuer,
      denyList: options.denyList,
      metrics: options.metrics,
      now: options.now,
    });
    const acceptance = new AcceptInvitationService({ control: options.control, tenants: options.tenants, idempotency, audit, select: service });
    return {
      module: SessionModule,
      controllers: [SelectTenantController, AcceptInvitationController],
      providers: [
        { provide: TenantDatabase, useValue: options.tenants },
        { provide: IDENTITY_OPTIONS, useValue: { verifier: options.verifier, control: options.control } },
        IdentityGuard,
        InviteeGuard,
        { provide: SelectTenantService, useValue: service },
        { provide: AcceptInvitationService, useValue: acceptance },
      ],
    };
  }
}
