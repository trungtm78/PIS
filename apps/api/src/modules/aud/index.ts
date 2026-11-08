import { defineModule } from '../module-descriptor';
import { GiftController, GiftReadsController } from './gift.controller';
import { InvestorStandingReadsController } from './standing.controller';
import { WhistleController, WhistlePublicController, WhistleReadsController } from './whistle.controller';
import { AuditConclusionController, AuditConclusionReadsController } from './conclusion.controller';
import { AuditEngagementController, AuditEngagementReadsController } from './engagement.controller';
import { RedFlagController, RedFlagReadsController } from './red-flag.controller';
import { AuditRecommendationController, AuditRecommendationReadsController } from './recommendation.controller';
import { AuditRecoveryController, AuditRecoveryReadsController } from './recovery.controller';
import { AuditReportController, AuditReportReadsController } from './report.controller';

/**
 * AUD, inspections, audits and the follow-up of their recommendations: the engagements with their scope and the legal hold that covers it (ST-AUD-001), and what an authority
 * concluded: the conclusion, its findings and its recommendations with the financial total check (ST-AUD-002). The data are CONFIDENTIAL and visible only through the scope of the
 * engagement; and what is done about the recommendations: the assignment, the actions with their evidence, the dispute and the separated verification (ST-AUD-003). The ledger of the recoveries with its reconciliation with PAY (ST-AUD-004) is here too, and the report of the results
 * that DOC issues with the closure of the engagement (ST-AUD-005).
 */
export const audModule = defineModule({
  code: 'AUD',
  controllers: [RedFlagController, RedFlagReadsController, AuditEngagementController, AuditEngagementReadsController, AuditConclusionController, AuditConclusionReadsController, AuditRecommendationController, AuditRecommendationReadsController, AuditRecoveryController, AuditRecoveryReadsController, AuditReportController, AuditReportReadsController],
=======
  controllers: [WhistleController, WhistleReadsController, GiftController, GiftReadsController, InvestorStandingReadsController, AuditEngagementController, AuditEngagementReadsController, AuditConclusionController, AuditConclusionReadsController, AuditRecommendationController, AuditRecommendationReadsController, AuditRecoveryController, AuditRecoveryReadsController, AuditReportController, AuditReportReadsController],
  // The anonymous channel of the reporter works through the control database and holds no identity.
  controlPlane: { controllers: [WhistlePublicController] },
});
