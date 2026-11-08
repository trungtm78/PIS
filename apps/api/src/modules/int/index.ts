import { defineModule } from '../module-descriptor';
import { BiReaderController, BiReaderReadsController } from './bi-reader.controller';
import { ExportDatasetController, ExportDatasetReadsController } from './export-dataset.controller';
import { MachineAuthGuard, OPEN_RATE_LIMITER, OpenApiService } from './machine-auth';
import { MachineAccountController, MachineAccountReadsController } from './machine-account.controller';
import { OpenApiController } from './open-api.controller';
import { ProjectCodeController, ProjectCodeReadsController } from './project-code.controller';
import { MachineRateLimiter } from '@machvon/kernel';

/**
 * INT, the open interface of the platform (INT-1): machine accounts with client credentials, scopes, a rate limit and an access log of every read (the open API under /open/v1); the datasets the organization has
 * certified and switched on for external readers; the database logins of BI tools, one per organization, bound to it by their own name; and the codes of our projects in the other systems of the organization,
 * kept on master_crosswalk. The signer of the machine tokens is the issuer of the tenant tokens (the same keys), provided by the application options.
 */
export const intModule = defineModule({
  code: 'INT',
  controllers: [
    MachineAccountController,
    MachineAccountReadsController,
    ExportDatasetController,
    ExportDatasetReadsController,
    BiReaderController,
    BiReaderReadsController,
    ProjectCodeController,
    ProjectCodeReadsController,
    OpenApiController,
  ],
  providers: [OpenApiService, MachineAuthGuard, { provide: OPEN_RATE_LIMITER, useFactory: (): MachineRateLimiter => new MachineRateLimiter() }],
});
