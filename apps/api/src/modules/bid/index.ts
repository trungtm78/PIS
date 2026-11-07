import { defineModule } from '../module-descriptor';
import { AnalysisController } from './analysis.controller';
import { BidAnalysisService } from './analysis.service';
import { ClarificationController } from './clarification.controller';
import { ConflictController } from './conflict.controller';
import { ContractorController, ContractorReadsController } from './contractor.controller';
import { ContractorHistoryController } from './contractor-history.controller';
import { CriteriaVersionController, CriteriaVersionReadsController } from './criteria.controller';
import { UnboundIdentityPort } from './identity-port';
import { MilestoneController, MilestoneReadsController } from './milestone.controller';
import { OcrController } from './ocr.controller';
import { PetitionController } from './petition.controller';
import { ProcurementImportController } from './procurement-import.controller';
import { ProposalController, ProposalReadsController } from './proposal.controller';
import { ProcurementPackageReadsController, ProcurementPlanController, ProcurementPlanReadsController } from './plan.controller';
import { ReportController } from './report.controller';
import { ResultController } from './result.controller';
import { ReviewController } from './review.controller';
import { CONTRACTOR_IDENTITY_PORT } from './tokens';
import { PackageWorkflowController, PackageWorkflowReadsController } from './workflow.controller';

/**
 * BID, procurement: the contractor registry with the tax id verified on evidence and the restrictions on participation (ST-BID-002), and the
 * procurement plan with its packages, checked against the lines of capital and approved on a decision (ST-BID-001), and the evaluation
 * criteria of a package, weighted to 100, screened for what nobody may ask and locked on approval (ST-BID-003), and the milestones of the choice of a contractor with the
 * file of the national bidding system that fills them and the differences it leaves for a person to settle (ST-BID-005), and the sealed proposals of the contractors, locked until
 * the opening of the bids and read by the evaluators who declared that no conflict of interest stands between them and the bidder (ST-BID-004), and the result of the choice, submitted by
 * a proposer, within the price of the package and for a winner no restriction stops, and approved on a decision document by someone else (ST-BID-006), and the petitions of contractors, with the last day to answer taken from rule data, answered with a document by someone who has no conflict of interest (ST-BID-007), and the OCR of the pages of a proposal, whose pages below the confidence threshold or with a table that does not add up are confirmed or corrected by a member of the evaluation team before the financial analysis runs (ST-BID-008), and the immutable AI analysis of a proposal, whose data goes only to domestic or self-hosted models and whose findings keep the citations that are on their pages (ST-BID-009), and the review of those findings by the experts, each decision a record of its own with the decision of a person about an answer of the AI, and the comparison of the proposals of a package on one version of the criteria from what the experts decided (ST-BID-010), and the clarification requests of the evaluation team to the contractors, a question with a deadline and a letter of DOC that the contractor (a guest of their own contractor) or the clerk who took their letter answers with a document before the deadline (ST-BID-011), and the evaluation report of a package, made from what the experts decided and signed by every member of the evaluation team with the dissent they hold, whose minutes are issued through DOC only when DOC says so (ST-BID-012).
 * The official lookup of a tax id is a port; until an agency confirms a contract for it the adapter says MISSING.
 */
export const bidModule = defineModule({
  code: 'BID',
  controllers: [ContractorController, ContractorReadsController, ContractorHistoryController, ProcurementPlanController, ProcurementPlanReadsController, ProcurementPackageReadsController, CriteriaVersionController, CriteriaVersionReadsController, MilestoneController, MilestoneReadsController, ProcurementImportController, ProposalController, ProposalReadsController, ConflictController, OcrController, AnalysisController, ReviewController, ClarificationController, ReportController, ResultController, PetitionController, PackageWorkflowController, PackageWorkflowReadsController],
  providers: [{ provide: CONTRACTOR_IDENTITY_PORT, useValue: new UnboundIdentityPort() }, BidAnalysisService],
});
