import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DisPeriodReopenPort, HpmFileWriter, ReportStoreIssuedReports } from '@machvon/edition-enterprise/src/server.ts';
import type { HpmFileSink, HpmPort, PeriodReopenPort } from '@machvon/edition-enterprise/src/server.ts';
import { APPROVAL_PUSH_PORT } from '../../modules/adm/approval-hold.service';
import { defineModule } from '../../modules/module-descriptor';
import { HpmApprovalPush } from './approval-push';
import { EbsImportController, EbsReadsController, EbsReconciliationController } from './ebs.controller';
import { directoryFileSink } from './file-sink';
import { OrgPackController } from './org-pack.controller';
import { HpmCorrectionController, HpmPushController, HpmReadsController } from './hpm.controller';
import { HPM_FILE_SINK, HPM_ISSUED_REPORTS, HPM_PERIOD_REOPEN, HPM_PORT } from './tokens';

/** Where the file writer that stands for HPM puts its packages when the environment names no folder. */
const DEFAULT_OUTBOX = join(tmpdir(), 'machvon-hpm-outbox');

/**
 * HPM, the push of the issued reports to the reporting platform of the customer (ENT-2): the connection, the push log keyed by (organisation, period, revision), the receipt of the receiver and the corrections that let an
 * accepted period be replaced. The adapter is a file writer (`HPM_PORT`) and never calls the network: HPM's technical interface is unknown (PENDING-EXTERNAL, eng-review R18). The module exists in the enterprise edition only.
 */
export const hpmModule = defineModule({
  code: 'HPM',
  editions: ['enterprise'],
  controllers: [HpmReadsController, HpmPushController, HpmCorrectionController],
  providers: [
    { provide: HPM_FILE_SINK, useFactory: (): HpmFileSink => directoryFileSink(process.env.MACHVON_HPM_OUTBOX_DIR ?? DEFAULT_OUTBOX) },
    { provide: HPM_PORT, useFactory: (sink: HpmFileSink) => new HpmFileWriter(sink), inject: [HPM_FILE_SINK] },
    { provide: HPM_PERIOD_REOPEN, useValue: new DisPeriodReopenPort() },
    { provide: HPM_ISSUED_REPORTS, useValue: new ReportStoreIssuedReports() },
    // The PUSH step of the staged approval hands its package to HPM and waits for the receipt (ENT-3c, R22).
    { provide: APPROVAL_PUSH_PORT, useFactory: (port: HpmPort, reopen: PeriodReopenPort) => new HpmApprovalPush(port, reopen), inject: [HPM_PORT, HPM_PERIOD_REOPEN] },
  ],
});

/**
 * Oracle EBS, the file import and the reconciliation by project code (ENT-2): the connection, the files a person hands over (dry run, then apply, once per hash) and the differences with our figures, each an item with an owner
 * who is not one of its makers and an explanation. The layout of the file is a working assumption (PENDING-EXTERNAL, eng-review R18). The module exists in the enterprise edition only.
 */
export const ebsModule = defineModule({
  code: 'EBS',
  editions: ['enterprise'],
  controllers: [EbsReadsController, EbsImportController, EbsReconciliationController],
});

/**
 * The organisation and the roles of the edition (ENT-3d): the PVFCCo template pack, the plan and verification against the tenant, and the command that turns an applied batch of the pack file into units, roles and proposals for approval.
 * The module exists in the enterprise edition only.
 */
export const orgPackModule = defineModule({
  code: 'ORG',
  editions: ['enterprise'],
  controllers: [OrgPackController],
});

/** The modules of the enterprise edition, in the order the registry mounts them after its own. */
export const ENTERPRISE_API_MODULES = [hpmModule, ebsModule, orgPackModule];
