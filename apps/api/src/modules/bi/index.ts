import { defineModule } from '../module-descriptor';
import { DatasetBuildController, DatasetReadsController } from './dataset.controller';
import { PolicyController } from './policy.controller';
import { MetricReadsController, MetricRegistryController, TenantMetricController } from './metric.controller';

/** BI, business intelligence: the metrics as data, a registry the platform fills from files of the repository and a tenant fills with its own drafts (ST-BI-001), the versions of its datasets by period (ST-BI-002) and the row and column policies that open them (ST-BI-003). */
export const biModule = defineModule({
  code: 'BI',
  controllers: [MetricRegistryController, TenantMetricController, MetricReadsController, DatasetBuildController, DatasetReadsController, PolicyController],
});
