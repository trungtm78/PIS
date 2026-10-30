import { defineModule } from '../module-descriptor';
import { IssIssueAssigneesController } from './iss-issue-assignees.controller';
import { IssEscalationController } from './iss-escalation.controller';
import { IssEscalationReadsController } from './iss-escalation-reads.controller';
import { IssIssueClosureController } from './iss-issue-closure.controller';
import { IssIssueController } from './iss-issue.controller';
import { IssIssueReadsController, IssWeeklyMatrixController } from './iss-issue-reads.controller';
import { IssSlaPolicyController } from './iss-sla-policy.controller';
import { IssSlaPolicyReadsController } from './iss-sla-policy-reads.controller';

/** ISS, issues and field work: the SLA policies by category, severity and unit (ST-ISS-001), the lifecycle of an issue (ST-ISS-002) and its verification, closure, reopening and extension (ST-ISS-003), and the weekly matrix of the issues by unit and group (ST-ISS-006). */
export const issModule = defineModule({
  code: 'ISS',
  controllers: [IssSlaPolicyController, IssSlaPolicyReadsController, IssIssueController, IssIssueClosureController, IssEscalationController, IssEscalationReadsController, IssIssueReadsController, IssIssueAssigneesController, IssWeeklyMatrixController],
});
