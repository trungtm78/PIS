import { InboxHandlerRegistry, IntegrationInboxProcessor, TenantDatabase } from '@machvon/db';
import { defineModule } from '../module-descriptor';
import { AuditEventsController } from './audit-events.controller';
import { AuditExportsController } from './audit-export.controller';
import { SigningCertificateReadsController, SigningCertificatesController } from './certificates.controller';
import { DoaMatricesController, DoaMatrixReadsController } from './doa-matrix.controller';
import { GuestContractorController } from './guest-contractor.controller';
import { INVITATION_MAILER, MockInvitationMailer } from './invitation-mailer';
import { IntegrationConnectorsController } from './integration-connector.controller';
import { IntegrationInboxController } from './integration-inbox.controller';
import { IntegrationConnectorReadsController, IntegrationInboxReadsController } from './integration-reads.controller';
import { LegalHoldReadsController, LegalHoldsController } from './legal-holds.controller';
import { MembersController } from './members.controller';
import { RetentionPoliciesController } from './retention-policy.controller';
import { RetentionPolicyReadsController, RetentionReviewReadsController } from './retention-reads.controller';
import { SecurityPoliciesController, SecurityPolicyReadsController } from './security-policy.controller';
import { ADM_ENVIRONMENT, ADM_INBOX_HANDLERS, ADM_INBOX_PROCESSOR } from './tokens';
import { WorkCalendarReadsController, WorkCalendarsController } from './work-calendar.controller';

/**
 * ADM, the tenant administration: the audit trail (ST-ADM-002), its sealed export (ST-ADM-016), legal holds (ST-ADM-003), retention policy versions (ST-ADM-017), integration connectors and the inbox replay (ST-ADM-018), members and invitations
 * (ST-ADM-006), guest contractors (ST-ADM-007), signing certificates (ST-ADM-008), security policy versions (ST-ADM-009), working calendar versions (ST-ADM-010) and the delegation-of-authority matrix (ST-ADM-011).
 */
export const admModule = defineModule({
  code: 'ADM',
  controllers: [
    AuditEventsController,
    AuditExportsController,
    LegalHoldsController,
    LegalHoldReadsController,
    RetentionPoliciesController,
    RetentionPolicyReadsController,
    RetentionReviewReadsController,
    IntegrationConnectorsController,
    IntegrationConnectorReadsController,
    IntegrationInboxController,
    IntegrationInboxReadsController,
    MembersController,
    GuestContractorController,
    SigningCertificatesController,
    SigningCertificateReadsController,
    SecurityPoliciesController,
    SecurityPolicyReadsController,
    WorkCalendarsController,
    WorkCalendarReadsController,
    DoaMatricesController,
    DoaMatrixReadsController,
  ],
  // The email channel belongs to OMNI (R1); until then invitations are kept in memory by the MOCK adapter.
  providers: [
    { provide: INVITATION_MAILER, useValue: new MockInvitationMailer() },
    // The adapters of inbound provider events are registered here by the module that owns the provider (ST-ADM-018); none exists yet.
    { provide: ADM_INBOX_HANDLERS, useValue: new InboxHandlerRegistry() },
    { provide: ADM_INBOX_PROCESSOR, useFactory: (database: TenantDatabase, registry: InboxHandlerRegistry) => new IntegrationInboxProcessor(database, registry), inject: [TenantDatabase, ADM_INBOX_HANDLERS] },
    // MACHVON_ENVIRONMENT names the deployment (infra/environments); unset or unknown means production, where a MOCK adapter is never Active.
    { provide: ADM_ENVIRONMENT, useFactory: () => process.env.MACHVON_ENVIRONMENT },
  ],
});
