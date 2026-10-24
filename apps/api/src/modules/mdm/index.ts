import { defineModule } from '../module-descriptor';
import { MasterDataController, MasterDataReadsController } from './master-data.controller';
import { MasterCrosswalkController, MasterCrosswalkReadsController } from './master-crosswalk.controller';
import { GlossaryController, GlossaryReadsController } from './glossary.controller';
import { MasterImportController, MasterImportReadsController } from './master-import.controller';
import { MasterSuccessionController, MasterSuccessionReadsController } from './master-succession.controller';

/** MDM, master data: versioned master records with maker-checker change requests (ST-MDM-001). */
export const mdmModule = defineModule({
  code: 'MDM',
  controllers: [MasterDataController, MasterDataReadsController, MasterImportController, MasterImportReadsController, MasterCrosswalkController, MasterCrosswalkReadsController, GlossaryController, GlossaryReadsController, MasterSuccessionController, MasterSuccessionReadsController],
});
