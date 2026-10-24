import { defineModule } from '../module-descriptor';
import { IssIssueAssigneesController } from './iss-issue-assignees.controller';
import { IssIssueController } from './iss-issue.controller';
import { IssIssueReadsController } from './iss-issue-reads.controller';
import { IssSlaPolicyController } from './iss-sla-policy.controller';
import { IssSlaPolicyReadsController } from './iss-sla-policy-reads.controller';

/** ISS, issues and field work: the SLA policies by category, severity and unit (ST-ISS-001) and the lifecycle of an issue (ST-ISS-002). */
export const issModule = defineModule({
  code: 'ISS',
  controllers: [IssSlaPolicyController, IssSlaPolicyReadsController, IssIssueController, IssIssueReadsController, IssIssueAssigneesController],
});
