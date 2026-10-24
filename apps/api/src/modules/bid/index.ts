import { defineModule } from '../module-descriptor';
import { ContractorController, ContractorReadsController } from './contractor.controller';
import { UnboundIdentityPort } from './identity-port';
import { ProcurementPackageReadsController, ProcurementPlanController, ProcurementPlanReadsController } from './plan.controller';
import { CONTRACTOR_IDENTITY_PORT } from './tokens';

/**
 * BID, procurement: the contractor registry with the tax id verified on evidence and the restrictions on participation (ST-BID-002), and the
 * procurement plan with its packages, checked against the lines of capital and approved on a decision (ST-BID-001).
 * The official lookup of a tax id is a port; until an agency confirms a contract for it the adapter says MISSING.
 */
export const bidModule = defineModule({
  code: 'BID',
  controllers: [ContractorController, ContractorReadsController, ProcurementPlanController, ProcurementPlanReadsController, ProcurementPackageReadsController],
  providers: [{ provide: CONTRACTOR_IDENTITY_PORT, useValue: new UnboundIdentityPort() }],
});
