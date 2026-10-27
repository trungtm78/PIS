import { defineModule } from '../module-descriptor';
import { MetricReadsController, MetricRegistryController, TenantMetricController } from './metric.controller';

/** BI, business intelligence: the metrics as data, a registry the platform fills from files of the repository and a tenant fills with its own drafts (ST-BI-001). */
export const biModule = defineModule({
  code: 'BI',
  controllers: [MetricRegistryController, TenantMetricController, MetricReadsController],
});
