import { defineModule } from '../module-descriptor';
import { DgvCatalogController, DgvDatasetController } from './dgv-dataset.controller';
import { DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController } from './dgv-quality.controller';

/** DGV, data governance: the dataset catalogue with a distinct owner and steward (ST-DGV-001); quality rules, runs and scorecards (ST-DGV-002). */
export const dgvModule = defineModule({
  code: 'DGV',
  controllers: [DgvDatasetController, DgvCatalogController, DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController],
});
