import { createHmac, randomBytes } from 'node:crypto';
import { defineModule } from '../module-descriptor';
import { ORCHESTRATION_OPTIONS } from '../orchestration';
import type { OrchestrationOptions } from '../orchestration';
import { DashboardController, DashboardReadsController, DashboardVersionReadsController } from './dashboard.controller';
import { DatasetBuildController, DatasetReadsController } from './dataset.controller';
import { PolicyController } from './policy.controller';
import { DashboardPublishController, PublicationController } from './publication.controller';
import { BiQueryController } from './query.controller';
import { BI_DRILL_KEY, BI_DRILL_SECRET } from './tokens';
import { MetricReadsController, MetricRegistryController, TenantMetricController } from './metric.controller';

/** BI, business intelligence: the metrics as data, a registry the platform fills from files of the repository and a tenant fills with its own drafts (ST-BI-001), the versions of its datasets by period (ST-BI-002) and the row and column policies that open them (ST-BI-003). */
export const biModule = defineModule({
  code: 'BI',
  controllers: [MetricRegistryController, TenantMetricController, MetricReadsController, DatasetBuildController, DatasetReadsController, PolicyController, BiQueryController, DashboardController, DashboardReadsController, DashboardVersionReadsController, PublicationController, DashboardPublishController],
  providers: [
    {
      provide: BI_DRILL_KEY,
      // The configured secret is the same in every replica and after a restart, so a token made by one is read by another; without one (tests, a single process) a key lives as long as the process.
      useFactory: (secret?: Buffer, options?: OrchestrationOptions): Buffer => {
        const source = secret ?? options?.contextKey;
        return source === undefined ? randomBytes(32) : createHmac('sha256', source).update('machvon:bi:drill-key').digest();
      },
      inject: [{ token: BI_DRILL_SECRET, optional: true }, { token: ORCHESTRATION_OPTIONS, optional: true }],
    },
  ],
});
