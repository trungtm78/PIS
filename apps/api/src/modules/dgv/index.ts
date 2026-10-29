import { defineModule } from '../module-descriptor';
import { DgvCatalogController, DgvDatasetController } from './dgv-dataset.controller';
import { DgvIncidentCommandsController, QualityExceptionReadsController, QualityIncidentReadsController } from './dgv-incident.controller';
import { DgvMappingCommandsController, DgvMappingReadsController, DgvReconciliationController } from './dgv-source.controller';
import { DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController } from './dgv-quality.controller';

/** DGV, data governance: the dataset catalogue with a distinct owner and steward (ST-DGV-001); quality rules, runs and scorecards (ST-DGV-002); incidents and exceptions with a handler, an SLA and an independent verification (ST-DGV-003); source mappings that an owner confirms and the reconciliation of two sources (ST-DGV-004). */
export const dgvModule = defineModule({
  code: 'DGV',
  controllers: [DgvDatasetController, DgvCatalogController, DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController, DgvIncidentCommandsController, QualityIncidentReadsController, QualityExceptionReadsController, DgvMappingCommandsController, DgvMappingReadsController, DgvReconciliationController],
});
