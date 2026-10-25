import { defineModule } from '../module-descriptor';
import { ConflictController } from './conflict.controller';
import { ContractorController, ContractorReadsController } from './contractor.controller';
import { CriteriaVersionController, CriteriaVersionReadsController } from './criteria.controller';
import { UnboundIdentityPort } from './identity-port';
import { MilestoneController, MilestoneReadsController } from './milestone.controller';
import { ProcurementImportController } from './procurement-import.controller';
import { ProposalController, ProposalReadsController } from './proposal.controller';
import { ProcurementPackageReadsController, ProcurementPlanController, ProcurementPlanReadsController } from './plan.controller';
import { CONTRACTOR_IDENTITY_PORT } from './tokens';

/**
 * BID, procurement: the contractor registry with the tax id verified on evidence and the restrictions on participation (ST-BID-002), and the
 * procurement plan with its packages, checked against the lines of capital and approved on a decision (ST-BID-001), and the evaluation
 * criteria of a package, weighted to 100, screened for what nobody may ask and locked on approval (ST-BID-003), and the milestones of the choice of a contractor with the
 * file of the national bidding system that fills them and the differences it leaves for a person to settle (ST-BID-005), and the sealed proposals of the contractors, locked until
 * the opening of the bids and read by the evaluators who declared that no conflict of interest stands between them and the bidder (ST-BID-004).
 * The official lookup of a tax id is a port; until an agency confirms a contract for it the adapter says MISSING.
 */
export const bidModule = defineModule({
  code: 'BID',
  controllers: [ContractorController, ContractorReadsController, ProcurementPlanController, ProcurementPlanReadsController, ProcurementPackageReadsController, CriteriaVersionController, CriteriaVersionReadsController, MilestoneController, MilestoneReadsController, ProcurementImportController, ProposalController, ProposalReadsController, ConflictController],
  providers: [{ provide: CONTRACTOR_IDENTITY_PORT, useValue: new UnboundIdentityPort() }],
});
