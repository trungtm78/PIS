import { defineModule } from '../module-descriptor';
import { AuditConclusionController, AuditConclusionReadsController } from './conclusion.controller';
import { AuditEngagementController, AuditEngagementReadsController } from './engagement.controller';
import { AuditRecommendationController, AuditRecommendationReadsController } from './recommendation.controller';
import { AuditRecoveryController, AuditRecoveryReadsController } from './recovery.controller';

/**
 * AUD, inspections, audits and the follow-up of their recommendations: the engagements with their scope and the legal hold that covers it (ST-AUD-001), and what an authority
 * concluded: the conclusion, its findings and its recommendations with the financial total check (ST-AUD-002). The data are CONFIDENTIAL and visible only through the scope of the
 * engagement; and what is done about the recommendations: the assignment, the actions with their evidence, the dispute and the separated verification (ST-AUD-003). The ledger of the recoveries with its reconciliation with PAY (ST-AUD-004) is here too; the follow-up
 * report is added by the story that follows.
 */
export const audModule = defineModule({
  code: 'AUD',
  controllers: [AuditEngagementController, AuditEngagementReadsController, AuditConclusionController, AuditConclusionReadsController, AuditRecommendationController, AuditRecommendationReadsController, AuditRecoveryController, AuditRecoveryReadsController],
});
