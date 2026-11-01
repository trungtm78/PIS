import { defineModule } from '../module-descriptor';
import { DgvContractCommandsController, DataContractVersionReadsController, DatasetContractReadsController } from './dgv-contract.controller';
import { DgvCatalogController, DgvDatasetController } from './dgv-dataset.controller';
import { DgvGlossaryController } from './dgv-glossary.controller';
import { DgvLineageController } from './dgv-lineage.controller';
import { DgvMaturityCommandsController, DgvMaturityReadsController } from './dgv-maturity.controller';
import { DgvProductController } from './dgv-product.controller';
import { DgvIncidentCommandsController, QualityExceptionReadsController, QualityIncidentReadsController } from './dgv-incident.controller';
import { DgvMappingCommandsController, DgvMappingReadsController, DgvReconciliationController } from './dgv-source.controller';
import { DgvQualityCommandsController, DgvScorecardController, QualityRuleReadsController, QualityRunReadsController } from './dgv-quality.controller';

/** DGV, data governance: the dataset catalogue with a distinct owner and steward (ST-DGV-001); quality rules, runs and scorecards (ST-DGV-002); incidents and exceptions with a handler, an SLA and an independent verification (ST-DGV-003); source mappings that an owner confirms and the reconciliation of two sources (ST-DGV-004); the glossary bound to datasets (ST-DGV-007); the certification of data products (ST-DGV-009); the lineage graph with a check of each node (ST-DGV-006); the data contracts of ODCS with the approval of the consumers for a breaking change (ST-DGV-005); the maturity of data governance - the rubric, the assessment with its evidence and its score, the roadmap (ST-DGV-008). */
export const dgvModule = defineModule({
  code: 'DGV',
  controllers: [
    DgvMaturityCommandsController,
    DgvMaturityReadsController,
    DgvContractCommandsController,
    DatasetContractReadsController,
    DataContractVersionReadsController,
    DgvLineageController,
    DgvProductController,
    DgvGlossaryController,
    DgvDatasetController,
    DgvCatalogController,
    DgvQualityCommandsController,
    DgvScorecardController,
    QualityRuleReadsController,
    QualityRunReadsController,
    DgvIncidentCommandsController,
    QualityIncidentReadsController,
    QualityExceptionReadsController,
    DgvMappingCommandsController,
    DgvMappingReadsController,
    DgvReconciliationController,
  ],
});
