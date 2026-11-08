import { InboxHandlerRegistry, IntegrationInboxProcessor, TenantDatabase } from '@machvon/db';
import { defineModule } from '../module-descriptor';
import { ApprovalCommandsController, ApprovalTaskReadsController, WorkflowInstanceReadsController, WorkflowVersionReadsController } from './approval.controller';
import { APPROVAL_FINAL_COMMANDS, ApprovalBootGuard, ApprovalService, FinalCommandRegistry } from './approval.service';
import { AuditEventsController } from './audit-events.controller';
import { AuditExportsController } from './audit-export.controller';
import { SigningCertificateReadsController, SigningCertificatesController } from './certificates.controller';
import { DelegationCommandsController, DelegationReadsController } from './delegation.controller';
import { DoaMatricesController, DoaMatrixReadsController } from './doa-matrix.controller';
import { GovernanceRuleReadsController, GovernanceRulesController, AlertTypeReadsController } from './governance-rule.controller';
import { GuestContractorController } from './guest-contractor.controller';
import { INVITATION_MAILER, MockInvitationMailer } from './invitation-mailer';
import { IntegrationConnectorsController } from './integration-connector.controller';
import { IntegrationInboxController } from './integration-inbox.controller';
import { IntegrationConnectorReadsController, IntegrationInboxReadsController } from './integration-reads.controller';
import { LegalHoldReadsController, LegalHoldsController } from './legal-holds.controller';
import { MembersController } from './members.controller';
import { MigrationBatchReadsController, MigrationBatchesController } from './migration-batch.controller';
import { RetentionPoliciesController } from './retention-policy.controller';
import { RetentionPolicyReadsController, RetentionReviewReadsController } from './retention-reads.controller';
import { SecurityPoliciesController, SecurityPolicyReadsController } from './security-policy.controller';
import { SodAuditReadsController, SodExceptionsController, SodReadsController } from './sod.controller';
import { ADM_ENVIRONMENT, ADM_INBOX_HANDLERS, ADM_INBOX_PROCESSOR } from './tokens';
import { REORGANIZATION_PROJECT_PORT, UnboundProjectTransferPort } from './unit-reorganization.port';
import { UnitReorganizationCommandsController, UnitReorganizationReadsController } from './unit-reorganization.controller';
import { WorkCalendarReadsController, WorkCalendarsController } from './work-calendar.controller';

/**
 * ADM, the tenant administration: the audit trail (ST-ADM-002), its sealed export (ST-ADM-016), legal holds (ST-ADM-003), retention policy versions (ST-ADM-017), integration connectors and the inbox replay (ST-ADM-018), members and invitations
 * (ST-ADM-006), guest contractors (ST-ADM-007), signing certificates (ST-ADM-008), security policy versions (ST-ADM-009), working calendar versions (ST-ADM-010) the delegation-of-authority matrix (ST-ADM-011) and the approval workflows (ST-ADM-012).
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
    MigrationBatchesController,
    MigrationBatchReadsController,
    GuestContractorController,
    SigningCertificatesController,
    SigningCertificateReadsController,
    SecurityPoliciesController,
    SecurityPolicyReadsController,
    SodExceptionsController,
    SodReadsController,
    SodAuditReadsController,
    WorkCalendarsController,
    WorkCalendarReadsController,
    DoaMatricesController,
    DoaMatrixReadsController,
    GovernanceRulesController,
    GovernanceRuleReadsController,
    AlertTypeReadsController,
    ApprovalCommandsController,
    WorkflowVersionReadsController,
    WorkflowInstanceReadsController,
    ApprovalTaskReadsController,
    DelegationCommandsController,
    DelegationReadsController,
    UnitReorganizationCommandsController,
    UnitReorganizationReadsController,
  ],
  // The email channel belongs to OMNI (R1); until then invitations are kept in memory by the MOCK adapter.
  providers: [
    // The approval engine (ST-ADM-012): the business modules call ApprovalService.start inside their submit, and register the final commands of their business types in the registry (test doubles exist in a test build only).
    { provide: APPROVAL_FINAL_COMMANDS, useFactory: () => new FinalCommandRegistry() },
    ApprovalService,
    // Stops the process at boot when an enabled business type has no real final command (R14).
    ApprovalBootGuard,
    // The module that owns projects is not bound to the reorganisation saga yet (XM-ADM-02): the saga stops at the first project it has to move.
    { provide: REORGANIZATION_PROJECT_PORT, useValue: new UnboundProjectTransferPort() },
    { provide: INVITATION_MAILER, useValue: new MockInvitationMailer() },
    // The adapters of inbound provider events are registered here by the module that owns the provider (ST-ADM-018; NOT registers its channels, ST-NOT-002).
    // One registry per application, not per process: an application started twice in one process (the tests do) must not find the handlers of the first.
    { provide: ADM_INBOX_HANDLERS, useFactory: () => new InboxHandlerRegistry() },
    { provide: ADM_INBOX_PROCESSOR, useFactory: (database: TenantDatabase, registry: InboxHandlerRegistry) => new IntegrationInboxProcessor(database, registry), inject: [TenantDatabase, ADM_INBOX_HANDLERS] },
    // MACHVON_ENVIRONMENT names the deployment (infra/environments); unset or unknown means production, where a MOCK adapter is never Active.
    { provide: ADM_ENVIRONMENT, useFactory: () => process.env.MACHVON_ENVIRONMENT },
  ],
});
