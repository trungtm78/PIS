import { defineModule } from '../module-descriptor';
import { MonitoringController, MonitoringReadsController } from './monitoring.controller';
import { PortalController, PortalReadsController } from './portal.controller';
import { PortalPublicController } from './portal-public.controller';
import { ProjectAccountabilityController } from './accountability.controller';
import { ExplanationController } from './explanation.controller';
import { AccountabilityReadsController } from './accountability-reads.controller';
import { ProjectAppraisalController } from './appraisal.controller';
import { InvestmentAppraisalController, InvestmentAppraisalReadsController } from './fin-appraisal.controller';
import { ProjectBaselineController, ProjectBaselineReadsController } from './baseline.controller';
import { ProjectEvmController, ProjectEvmReadsController } from './evm.controller';
import { LessonsController } from './lessons.controller';
import { LookAheadController } from './look-ahead.controller';
import { NationalCodeController } from './national-code.controller';
import { NationalCodeFileController } from './national-code-file.controller';
import { ProjectController, ProjectReadsController } from './project.controller';
import { ProjectReserveController, ProjectReserveReadsController } from './reserve.controller';
import { ProjectRevisionController, ProjectRevisionReadsController } from './revision.controller';
import { ProjectRiskController, ProjectRiskReadsController } from './risk.controller';
import { ProjectRiskAlertController, ProjectRiskSignalReadsController } from './risk-signal.controller';
import { ProjectLifecycleReadsController, ProjectStageController } from './stage.controller';
import { TaskForceController } from './task-force.controller';
import { TransferController } from './transfer.controller';
import { ProjectWbsController, ProjectWbsReadsController } from './wbs.controller';

/**
 * PRJ, the project register: projects are created in CONCEPT and described within an allowlist, read in the scope of the caller (ST-PRJ-001),
 * and move along the PIMA life cycle only through guarded commands, with the history and the project bank to read (ST-PRJ-002); a project is
 * appraised by scored sheets and admitted to the project bank by a decision (ST-PRJ-003), and given its national code by hand or from the file of the
 * national system (ST-PRJ-004); who answers for a project and the task forces that press its disbursement are administered for the whole tenant (ST-PRJ-005); a leader asks the
 * person who answers for a project or a unit to explain, and someone else accepts the answer or returns it (ST-PRJ-006); a project passes from one unit to another by a request and a decision of someone else,
 * from a day, with the reports and snapshots before it kept under the old unit (ST-PRJ-007); the risks of a project are scored by the server and ended with a reason (ST-PRJ-010); the figures of a project change only by a revision that another person approves with a decision document (ST-PRJ-008); the work breakdown and the milestones of a project, with their delays counted from the baseline (ST-PRJ-009). The effectiveness of an investment is appraised by inputs that people answer for and results that only the server computes with the verified formula module, approved by someone other than the maker and frozen with their hash and the formula version (FIN-1, AI.06).
 */
export const prjModule = defineModule({
  code: 'PRJ',
  controllers: [ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectAppraisalController, NationalCodeController, NationalCodeFileController, ProjectAccountabilityController, AccountabilityReadsController, TaskForceController, ExplanationController, TransferController, ProjectRiskController, ProjectRiskReadsController, ProjectRevisionController, ProjectRevisionReadsController, ProjectWbsController, ProjectWbsReadsController, ProjectReserveController, ProjectReserveReadsController, ProjectBaselineController, ProjectBaselineReadsController, ProjectEvmController, ProjectEvmReadsController, InvestmentAppraisalController, InvestmentAppraisalReadsController, LookAheadController, LessonsController, ProjectRiskAlertController, ProjectRiskSignalReadsController],
=======
  controllers: [MonitoringController, MonitoringReadsController, PortalController, PortalReadsController, ProjectController, ProjectReadsController, ProjectStageController, ProjectLifecycleReadsController, ProjectAppraisalController, NationalCodeController, NationalCodeFileController, ProjectAccountabilityController, AccountabilityReadsController, TaskForceController, ExplanationController, TransferController, ProjectRiskController, ProjectRiskReadsController, ProjectRevisionController, ProjectRevisionReadsController, ProjectWbsController, ProjectWbsReadsController, ProjectReserveController, ProjectReserveReadsController, ProjectBaselineController, ProjectBaselineReadsController, ProjectEvmController, ProjectEvmReadsController, InvestmentAppraisalController, InvestmentAppraisalReadsController],
  // The public portal reads through the control database: it exists only where the process holds the control plane.
  controlPlane: { controllers: [PortalPublicController] },
});
