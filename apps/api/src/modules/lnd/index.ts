import { defineModule } from '../module-descriptor';
import { createFieldCipher } from './field-cipher';
import { AffectedHouseholdController, AffectedHouseholdReadsController } from './household.controller';
import { LandInventoryController, LandInventoryReadsController } from './inventory.controller';
import { LandParcelController } from './parcel.controller';
import { CompensationPlanController, CompensationPlanReadsController } from './plan.controller';
import { LandParcelImportController } from './parcel-import.controller';
import { LandReadsController } from './read.controller';
import { LandSectionController } from './section.controller';
import { LandStageProgressController } from './stage-progress.controller';
import { FIELD_CIPHER } from './tokens';

/**
 * LND, land clearance: the sections that land is handed over in, the parcels of a project that carry no owner or user of the land, the import of a
 * parcel list that never creates a parcel twice, and the notice of recovery that starts the 90 or 180 days after which a decision may be taken
 * (ST-LND-001), and the progress of the stages that an external unit executes (ST-LND-010), and the households affected by a recovery with their personal data sealed and masked (ST-LND-002), the requests of the people whose data they hold (ST-LND-003), and the inventory of their assets at the price decision in force, confirmed by someone other than the person who counted (ST-LND-004), and the plan of compensation, support and resettlement composed from confirmed inventory and revised into new revisions (ST-LND-005).
 */
export const lndModule = defineModule({
  code: 'LND',
  controllers: [LandSectionController, LandParcelController, LandParcelImportController, LandReadsController, LandStageProgressController, AffectedHouseholdController, AffectedHouseholdReadsController, LandInventoryController, LandInventoryReadsController, CompensationPlanController, CompensationPlanReadsController],
  providers: [{ provide: FIELD_CIPHER, useFactory: () => createFieldCipher() }],
});
