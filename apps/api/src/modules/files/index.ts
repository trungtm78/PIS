import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { defineModule } from '../module-descriptor';
import { FileService } from './file.service';
import { FsObjectStorage } from './fs-object-storage';
import { scanPortFromEnvironment } from './clamd-scan';

/** Where the MOCK adapter keeps objects when the environment names no folder. */
const DEFAULT_ROOT = join(tmpdir(), 'machvon-objects');

const scanLog = new Logger('FileScan');

/**
 * FILES, the shared upload pipeline (ST-KERNEL-024). It has no endpoints of its own: DOC, SAS and PAY take their files
 * through `FileService`. The antivirus is chosen by the environment (`scanPortFromEnvironment`): ClamAV through clamd, closed by default in
 * production (an unconfigured or failing scanner leaves the file PENDING, never CLEAN); the MOCK object storage stands in until the S3 adapter exists. The presign key is random per process, so a link never outlives the process.
 */
export const filesModule = defineModule({
  code: 'FILES',
  controllers: [],
  providers: [
    {
      provide: FileService,
      useFactory: () =>
        new FileService({
          storage: new FsObjectStorage(process.env.MACHVON_OBJECT_ROOT ?? DEFAULT_ROOT),
          scanner: scanPortFromEnvironment(),
          urlSecret: randomBytes(32),
          onScanEvent: (event) => scanLog.warn(`${event.kind} tenant=${event.tenantId} key=${event.key}${event.reason === undefined ? '' : ` reason=${event.reason}`}`),
        }),
    },
  ],
});

export { FileService } from './file.service';
