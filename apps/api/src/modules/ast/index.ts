import { defineModule } from '../module-descriptor';
import { AssetController, AssetReadsController } from './asset.controller';
import { ClaimController, ClaimReadsController } from './claim.controller';
import { EvaluationController, EvaluationReadsController } from './evaluation.controller';
import { HandoverController, HandoverReadsController } from './handover.controller';
import { WarrantyController, WarrantyReadsController } from './warranty.controller';

/**
 * AST, the handover of assets and the warranty: the handover of a work to the unit that receives it, with the punch list of what is still wrong with it and the acceptance decision of the
 * receiving unit (ST-AST-001); and the assets that work produces, registered after the acceptance and transferred to the unit that operates them (ST-AST-002); and the warranty obligation of a handed-over work, closed when it has run out with no claim open (ST-AST-003); and the trigger of the evaluation after the investment, set 12 or 24 months after an acceptance, fired by a job on its day and acknowledged by the evaluation of MNE (ST-AST-006); and the claims against a warranty, answered by the contractor, verified by somebody other than who reported or fixed, and escalated through ISS when nobody answers (ST-AST-004).
 */
export const astModule = defineModule({ code: 'AST', controllers: [HandoverController, HandoverReadsController, AssetController, AssetReadsController, WarrantyController, WarrantyReadsController, EvaluationController, EvaluationReadsController, ClaimController, ClaimReadsController] });
