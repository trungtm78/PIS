import { Inject, Injectable } from '@nestjs/common';
import type { CallHandler, CanActivate, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs';
import type { Observable } from 'rxjs';
import { DomainError } from '@machvon/kernel';

/** Injection token of the slots that bound how many batches run at once. */
export const SYNC_BATCH_SLOTS = Symbol('SYNC_BATCH_SLOTS');

/**
 * How many batches may run at once in this process. A batch runs inside one tenant transaction (one pooled connection) and, while it runs, each of its commands is carried out by a request that needs a connection of
 * the same pool. If every connection were held by a batch waiting for its commands, none of them could go on: so the batches are limited to well under the pool (the default 3 is for a pool of 10), and the others wait
 * for a slot, and are refused with 503 `PROVIDER_UNAVAILABLE` if none frees up in time.
 */
export class BatchSlots {
  private free: number;
  private readonly waiting: Array<{ grant(): void; timer: NodeJS.Timeout }> = [];

  constructor(
    readonly limit: number = 3,
    private readonly waitMs: number = 30_000,
  ) {
    this.free = limit;
  }

  /** Takes a slot, waiting for one if all are taken; the function that gives it back is returned. */
  async acquire(): Promise<() => void> {
    if (this.free > 0) {
      this.free -= 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          resolve(this.releaser());
        },
        timer: setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(entry), 1);
          reject(new DomainError('PROVIDER_UNAVAILABLE', 503));
        }, this.waitMs),
      };
      this.waiting.push(entry);
    });
  }

  get inUse(): number {
    return this.limit - this.free;
  }

  private releaser(): () => void {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.waiting.shift();
      if (next === undefined) this.free += 1;
      else next.grant();
    };
  }
}

const SLOT_KEY = 'syncBatchSlot';
interface Held {
  release(): void;
  /** The batch work has begun: from then on the slot is given back when that work is over, not when the client goes away. */
  started: boolean;
}
type Carrier = { [SLOT_KEY]?: Held };

/**
 * Takes a slot before the batch opens its transaction. The slot is given back when the work of the batch is over (`SyncSlotInterceptor`), whether or not the client is still there to read the answer; and when the work
 * never begins (the request is refused before it reaches the handler, or the client goes away while it waits), when the response is over.
 */
@Injectable()
export class SyncSlotGuard implements CanActivate {
  constructor(@Inject(SYNC_BATCH_SLOTS) private readonly slots: BatchSlots) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Carrier>();
    const response = http.getResponse<{ once(event: string, listener: () => void): unknown }>();
    const state: { held: Held | undefined; closed: boolean } = { held: undefined, closed: false };
    // Watched before the wait, so a client that goes away while it waits is seen.
    response.once('close', () => {
      state.closed = true;
      if (state.held !== undefined && !state.held.started) state.held.release();
    });
    const release = await this.slots.acquire();
    state.held = { release, started: false };
    request[SLOT_KEY] = state.held;
    if (state.closed) {
      release();
      throw new DomainError('PROVIDER_UNAVAILABLE', 503);
    }
    return true;
  }
}

/** Marks the work of the batch as begun, and gives the slot back when it is over, however it ended. */
@Injectable()
export class SyncSlotInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const held = context.switchToHttp().getRequest<Carrier>()[SLOT_KEY];
    if (held === undefined) return next.handle();
    held.started = true;
    return next.handle().pipe(finalize(() => held.release()));
  }
}
