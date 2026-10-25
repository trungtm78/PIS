import { defineModule } from '../module-descriptor';
import { AssetController, AssetReadsController } from './asset.controller';
import { HandoverController, HandoverReadsController } from './handover.controller';

/**
 * AST, the handover of assets and the warranty: the handover of a work to the unit that receives it, with the punch list of what is still wrong with it and the acceptance decision of the
 * receiving unit (ST-AST-001); and the assets that work produces, registered after the acceptance and transferred to the unit that operates them (ST-AST-002).
 */
export const astModule = defineModule({ code: 'AST', controllers: [HandoverController, HandoverReadsController, AssetController, AssetReadsController] });
