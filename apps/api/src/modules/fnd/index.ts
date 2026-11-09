import { defineModule } from '../module-descriptor';
import { EnterpriseSnapshotController } from './enterprise-snapshot.controller';
import { FndFigureApprovalBinding } from './figure-approval.binding';
import { FundingFigureController } from './figure.controller';
import { FundingFigureReadsController } from './figure-reads.controller';

/**
 * FND, the funding model (docs/fnd-funding-model.md): the stored figures of the plan phasing, the estimates and the actuals with their lineage and the conversion of an estimate into an actual (ST-FND-001), and the reads of
 * the figures and indicators of the pack in force (the public pack keeps the funding sources and the two rates of the disbursement reports as they are; the enterprise pack counts own equity, borrowings and other).
 */
export const fndModule = defineModule({
  code: 'FND',
  // Binds the final command and the PUSH source of the staged approval of figure batches (ENT-3c).
  providers: [FndFigureApprovalBinding],
  controllers: [FundingFigureController, FundingFigureReadsController, EnterpriseSnapshotController],
});
