import { defineModule } from '../module-descriptor';
import { AuditEngagementController, AuditEngagementReadsController } from './engagement.controller';

/**
 * AUD, inspections, audits and the follow-up of their recommendations: the engagements with their scope and the legal hold that covers it (ST-AUD-001). The data are
 * CONFIDENTIAL and visible only through the scope of the engagement; the conclusions, the recommendations and the recoveries are added by the stories that follow.
 */
export const audModule = defineModule({
  code: 'AUD',
  controllers: [AuditEngagementController, AuditEngagementReadsController],
});
