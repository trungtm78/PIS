import { defineModule } from '../module-descriptor';
import { LandParcelController } from './parcel.controller';
import { LandParcelImportController } from './parcel-import.controller';
import { LandReadsController } from './read.controller';
import { LandSectionController } from './section.controller';
import { LandStageProgressController } from './stage-progress.controller';

/**
 * LND, land clearance: the sections that land is handed over in, the parcels of a project that carry no owner or user of the land, the import of a
 * parcel list that never creates a parcel twice, and the notice of recovery that starts the 90 or 180 days after which a decision may be taken
 * (ST-LND-001), and the progress of the stages that an external unit executes (ST-LND-010).
 */
export const lndModule = defineModule({
  code: 'LND',
  controllers: [LandSectionController, LandParcelController, LandParcelImportController, LandReadsController, LandStageProgressController],
});
