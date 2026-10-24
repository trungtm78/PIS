import { defineModule } from '../module-descriptor';
import { MasterDataController, MasterDataReadsController } from './master-data.controller';
import { MasterImportController, MasterImportReadsController } from './master-import.controller';

/** MDM, master data: versioned master records with maker-checker change requests (ST-MDM-001). */
export const mdmModule = defineModule({
  code: 'MDM',
  controllers: [MasterDataController, MasterDataReadsController, MasterImportController, MasterImportReadsController],
});
