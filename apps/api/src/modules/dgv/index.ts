import { defineModule } from '../module-descriptor';
import { DgvCatalogController, DgvDatasetController } from './dgv-dataset.controller';

/** DGV, data governance: the dataset catalogue with a distinct owner and steward (ST-DGV-001). */
export const dgvModule = defineModule({
  code: 'DGV',
  controllers: [DgvDatasetController, DgvCatalogController],
});
