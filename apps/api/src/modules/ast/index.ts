import { defineModule } from '../module-descriptor';
import { HandoverController, HandoverReadsController } from './handover.controller';

/**
 * AST, the handover of assets and the warranty: the handover of a work to the unit that receives it, with the punch list of what is still wrong with it and the acceptance decision of the
 * receiving unit (ST-AST-001).
 */
export const astModule = defineModule({ code: 'AST', controllers: [HandoverController, HandoverReadsController] });
