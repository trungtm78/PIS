import { HttpSyncOperationInvoker, SYNC_OPERATION_INVOKER } from '../../sync/operation-invoker';
import { BatchSlots, SYNC_BATCH_SLOTS, SyncSlotGuard, SyncSlotInterceptor } from '../../sync/batch-slots';
import { SyncController } from '../../sync/sync.controller';
import { defineModule } from '../module-descriptor';

/**
 * MOB, the phone: the sync endpoints that a phone uses to send the commands it queued offline and to look up one whose answer it lost (ST-MOB-005). The code is in apps/api/src/sync. The app itself, the encrypted local
 * store and the sync rules of the phone are not in this repository (TODOS.md).
 */
export const mobModule = defineModule({
  code: 'MOB',
  controllers: [SyncController],
  providers: [
    { provide: SYNC_OPERATION_INVOKER, useClass: HttpSyncOperationInvoker },
    // A batch holds a database connection while its commands, each needing one, are carried out: few batches at once (SYNC_MAX_CONCURRENT_BATCHES, 3 for a pool of 10; keep it under half the pool).
    { provide: SYNC_BATCH_SLOTS, useFactory: () => new BatchSlots(Math.max(1, Number(process.env.SYNC_MAX_CONCURRENT_BATCHES ?? '3') || 3)) },
    SyncSlotGuard,
    SyncSlotInterceptor,
  ],
});
