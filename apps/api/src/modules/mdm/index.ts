import { defineModule } from '../module-descriptor';
import { MasterDataController, MasterDataReadsController } from './master-data.controller';

/** MDM, master data: versioned master records with maker-checker change requests (ST-MDM-001). */
export const mdmModule = defineModule({
  code: 'MDM',
  controllers: [MasterDataController, MasterDataReadsController],
});
