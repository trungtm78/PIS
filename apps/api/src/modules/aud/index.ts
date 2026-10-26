import { defineModule } from '../module-descriptor';
import { AuditConclusionController, AuditConclusionReadsController } from './conclusion.controller';
import { AuditEngagementController, AuditEngagementReadsController } from './engagement.controller';

/**
 * AUD, inspections, audits and the follow-up of their recommendations: the engagements with their scope and the legal hold that covers it (ST-AUD-001), and what an authority
 * concluded: the conclusion, its findings and its recommendations with the financial total check (ST-AUD-002). The data are CONFIDENTIAL and visible only through the scope of the
 * engagement; the assignment, the remediation, the recoveries and the follow-up report are added by the stories that follow.
 */
export const audModule = defineModule({
  code: 'AUD',
  controllers: [AuditEngagementController, AuditEngagementReadsController, AuditConclusionController, AuditConclusionReadsController],
});
